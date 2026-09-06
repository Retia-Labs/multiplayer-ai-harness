'use strict';
const crypto = require('crypto');
// Plexus protocol — an independent JavaScript implementation modeled on the shape
// of OpenAI Codex's app-server protocol (thread → turn → item, item/* notifications,
// approval requests with accept/decline decisions) so that tools speaking Codex's
// vocabulary feel familiar here. Names only; no code is copied from Codex.

// ---- Thread event log (what a runtime appends; what every subscriber sees) ----
// Every entry gets { seq, ts, threadId } from the hub. `method` mirrors Codex notifications.
const Events = {
  TURN_STARTED: 'turn/started',                   // { turnId, by }
  TURN_COMPLETED: 'turn/completed',               // { turnId, status: 'completed'|'interrupted'|'failed', usage?, error? }
  TURN_PLAN_UPDATED: 'turn/plan/updated',         // { turnId, explanation?, plan: [{ step, status: 'pending'|'inProgress'|'completed' }] }
  ITEM_STARTED: 'item/started',                   // { turnId, item }
  ITEM_COMPLETED: 'item/completed',               // { turnId, item }
  AGENT_MESSAGE_DELTA: 'item/agentMessage/delta', // { turnId, itemId, delta }
  REASONING_DELTA: 'item/reasoning/textDelta',    // { turnId, itemId, delta }
  COMMAND_OUTPUT_DELTA: 'item/commandExecution/outputDelta', // { turnId, itemId, delta }
  COMMAND_REQUEST_APPROVAL: 'item/commandExecution/requestApproval', // { turnId, itemId, requestId, command, cwd, reason, availableDecisions }
  FILECHANGE_REQUEST_APPROVAL: 'item/fileChange/requestApproval',   // { turnId, itemId, requestId, changes, reason, availableDecisions }
  SERVER_REQUEST_RESOLVED: 'serverRequest/resolved', // { turnId, requestId, decision, by }
  THREAD_NAME_UPDATED: 'thread/name/updated',     // { name }
  THREAD_SETTINGS_UPDATED: 'thread/settings/updated', // { settings }
  THREAD_ASSIGNEE_UPDATED: 'thread/assignee/updated', // { assignee: {userId,name,color}|null, note?, by }
  ERROR: 'error'                                  // { message }
};

// ---- Item kinds (ThreadItem.type) ----
const ItemTypes = {
  USER_MESSAGE: 'userMessage',        // { id, text, images?, by, delivery?: 'steer' }
  AGENT_MESSAGE: 'agentMessage',      // { id, text }
  REASONING: 'reasoning',             // { id, text }
  COMMAND_EXECUTION: 'commandExecution', // { id, command, cwd, executor, status, aggregatedOutput, exitCode?, durationMs? }
  FILE_CHANGE: 'fileChange'           // { id, changes: [{ path, kind: 'add'|'update'|'delete', additions, deletions, lines }], status }
};

const ItemStatus = { IN_PROGRESS: 'inProgress', COMPLETED: 'completed', FAILED: 'failed', DECLINED: 'declined' };
const TurnStatus = { IN_PROGRESS: 'inProgress', COMPLETED: 'completed', INTERRUPTED: 'interrupted', FAILED: 'failed' };

// ---- Policies (same vocabulary as Codex config) ----
const ApprovalPolicy = { UNTRUSTED: 'untrusted', ON_REQUEST: 'on-request', NEVER: 'never' };
const SandboxPolicy = { READ_ONLY: 'read-only', WORKSPACE_WRITE: 'workspace-write', DANGER_FULL_ACCESS: 'danger-full-access' };
const ApprovalDecision = { ACCEPT: 'accept', ACCEPT_FOR_SESSION: 'acceptForSession', DECLINE: 'decline', CANCEL: 'cancel' };

// ---- Thread status as tracked by the hub ----
//   { type: 'idle' } | { type: 'active', activeFlags: ['waitingOnApproval'] } | { type: 'systemError' }
const ThreadStatus = {
  idle: () => ({ type: 'idle' }),
  active: (flags = []) => ({ type: 'active', activeFlags: flags }),
  systemError: () => ({ type: 'systemError' })
};

// ---- Commands (client → hub → owning runtime). `command.method` mirrors Codex request names. ----
const Commands = {
  THREAD_START: 'thread/start',       // { cwd, worktree?, name?, settings? } → { thread }
  THREAD_DELETE: 'thread/delete',     // { } (threadId in envelope)
  THREAD_NAME_SET: 'thread/name/set', // { name }
  THREAD_SETTINGS_UPDATE: 'thread/settings/update', // { settings }
  THREAD_ASSIGN: 'thread/assign',     // { assignee: {userId,name,color}|null, note? } → { assignee }
  TURN_START: 'turn/start',           // { input: [{type:'text',text}|{type:'image',url}], settings? } → { turnId }
  TURN_STEER: 'turn/steer',           // { input, expectedTurnId } → { turnId }
  TURN_INTERRUPT: 'turn/interrupt',   // { turnId }
  APPROVAL_RESOLVE: 'approval/resolve', // { requestId, decision }
  MODEL_LIST: 'model/list',           // { provider? } → { models }
  PROJECT_ADD: 'project/add',         // { dir } → { project }  (host-local only; see Errors)
  GIT_DIFF: 'git/diff',               // {} → { files }
  GIT_COMMIT: 'git/commit',           // { message } → { ok }
  GIT_REVERT_FILE: 'git/revertFile',  // { path, untracked } → { ok }
  GIT_PATCH: 'git/patch'              // {} → { patch }
};

// ---- Team, membership and pairing (client → hub; never routed to a runtime) ----
// A team is the private boundary: every thread, runtime and project belongs to exactly one,
// and membership is granted by invitation, never asserted by the caller.
const TeamOps = {
  TEAM_CREATE: 'team/create',           // { name } → { team, membership }
  TEAM_LIST: 'team/list',               // {} → { teams }
  TEAM_MEMBERS: 'team/members',         // { teamId } → { members }
  INVITE_CREATE: 'team/invite',         // { teamId, inviteeUserId, role?, ttlMs? } → { code, invitee, expiresAt } (owner only)
  INVITE_ACCEPT: 'team/invite/accept',  // { code } → { team, membership }
  INVITE_REVOKE: 'team/invite/revoke',  // { code } → { ok }
  MEMBER_REMOVE: 'team/member/remove',  // { teamId, userId } → { ok } (owner only)
  RUNTIME_PAIR: 'runtime/pair',         // { teamId, code } → { runtime } (code is shown on the host)
  RUNTIME_UNPAIR: 'runtime/unpair',     // { runtimeId } → { ok } (owner only)
  // Approval authority is granted separately from membership, on purpose: being in a team
  // is not the same as being allowed to let an agent run something on someone's machine.
  APPROVER_GRANT: 'team/approver/grant',   // { teamId, userId } → { ok } (owner only)
  APPROVER_REVOKE: 'team/approver/revoke', // { teamId, userId } → { ok } (owner only)
  APPROVER_LIST: 'team/approver/list'      // { teamId } → { approvers }
};

// ---- Error codes ----
// The boundaries this product claims have to fail *distinguishably*, so a caller can tell
// "you are not signed in" from "you are signed in but not in this team" from "no such
// thing". Anything that collapses these into one message hides a real authorization bug.
const Errors = {
  UNAUTHENTICATED: 'unauthenticated',                 // no valid token on the connection
  NOT_A_MEMBER: 'not_a_member',                       // authenticated, but not in that team
  OWNER_REQUIRED: 'owner_role_required',              // member, but the op needs an owner
  UNKNOWN_TEAM: 'unknown_team',
  UNKNOWN_THREAD: 'unknown_thread',
  UNKNOWN_RUNTIME: 'unknown_runtime',
  FOREIGN_RUNTIME: 'foreign_runtime',                 // that runtime belongs to another team
  RUNTIME_UNPAIRED: 'runtime_unpaired',               // host has not been paired to a team yet
  RUNTIME_AUTHENTICATION: 'runtime_authentication_failed', // paired host did not prove its persisted identity
  FOREIGN_THREAD: 'foreign_thread',                   // thread belongs to another team or runtime
  INVITE_INVALID: 'invitation_invalid',
  INVITE_EXPIRED: 'invitation_expired',
  INVITE_USED: 'invitation_already_accepted',
  INVITE_REVOKED: 'invitation_revoked',
  INVITE_RECIPIENT_MISMATCH: 'invitation_recipient_mismatch', // invite belongs to a different account
  ALREADY_MEMBER: 'already_a_member',               // invitations cannot replace an existing role
  UNKNOWN_USER: 'unknown_user',
  COMMAND_IN_PROGRESS: 'command_already_in_progress',
  COMMAND_ID_CONFLICT: 'command_id_conflict',        // same id was reused for a different action
  COMMAND_OUTCOME_UNKNOWN: 'command_outcome_unknown',// host restarted after accepting the action
  PROVIDER_NOT_ISOLATED: 'provider_not_isolated',    // CLI provider lacks proven project confinement
  PROJECT_OPERATION_UNAVAILABLE: 'project_operation_unavailable',
  PAIRING_INVALID: 'pairing_code_invalid',
  PAIRING_EXPIRED: 'pairing_code_expired',
  PROJECT_NOT_AUTHORIZED: 'project_not_authorized',   // path the host operator never shared
  PROJECT_ADD_LOCAL_ONLY: 'project_add_is_host_local',// remote callers cannot register paths
  POLICY_ESCALATION: 'policy_escalation_refused',     // asked for more access than the host allows
  NOT_APPROVER: 'not_a_delegated_approver'            // membership alone is not approval authority
};

// Roles are about administering the team. They are deliberately NOT decryption access and
// NOT action-approval authority - those are separate grants (issues #3 and #11).
const Roles = { OWNER: 'owner', MEMBER: 'member' };

// Until endpoint enrollment exists, every membership is honestly marked pending.
const EnrollmentState = { PENDING: 'pending', ENROLLED: 'enrolled' };

// Short enough to read from a host's local screen, with ambiguous characters removed.
// The host process is the authority that displays it; this shared helper only keeps the
// desktop shell and standalone runtime on the same format and source of randomness.
function createPairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const byte of crypto.randomBytes(8)) out += alphabet[byte % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

// ---- Hub transport envelopes (client ↔ hub, runtime ↔ hub) ----
// client→hub:   hello, threads.list, runtimes.list, users.list, thread.subscribe{threadId, afterSeq},
//               thread.unsubscribe, command{id, threadId|runtimeId, command}
// runtime→hub:  hello(role:'runtime', runtime{...}), thread.upsert{thread}, append{threadId, event},
//               command.result{id, ok, result|error}, runtime.update{runtime}
// hub→client:   welcome, threads, runtimes, users, thread.snapshot{thread, events}, event{...},
//               presence{threadId, viewers}, thread.updated{thread}, thread.deleted, command.result, error
// hub→runtime:  welcome, command{id, threadId, by, command}

module.exports = { Events, ItemTypes, ItemStatus, TurnStatus, ApprovalPolicy, SandboxPolicy, ApprovalDecision, ThreadStatus, Commands, TeamOps, Errors, Roles, EnrollmentState, createPairingCode };
