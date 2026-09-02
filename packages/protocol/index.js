'use strict';
// Harness protocol — an independent JavaScript implementation modeled on the shape
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
  TURN_START: 'turn/start',           // { input: [{type:'text',text}|{type:'image',url}], settings? } → { turnId }
  TURN_STEER: 'turn/steer',           // { input, expectedTurnId } → { turnId }
  TURN_INTERRUPT: 'turn/interrupt',   // { turnId }
  APPROVAL_RESOLVE: 'approval/resolve', // { requestId, decision }
  MODEL_LIST: 'model/list',           // { provider? } → { models }
  PROJECT_ADD: 'project/add',         // { dir } → { project }
  GIT_DIFF: 'git/diff',               // {} → { files }
  GIT_COMMIT: 'git/commit',           // { message } → { ok }
  GIT_REVERT_FILE: 'git/revertFile',  // { path, untracked } → { ok }
  GIT_PATCH: 'git/patch'              // {} → { patch }
};

// ---- Hub transport envelopes (client ↔ hub, runtime ↔ hub) ----
// client→hub:   hello, threads.list, runtimes.list, users.list, thread.subscribe{threadId, afterSeq},
//               thread.unsubscribe, command{id, threadId|runtimeId, command}
// runtime→hub:  hello(role:'runtime', runtime{...}), thread.upsert{thread}, append{threadId, event},
//               command.result{id, ok, result|error}, runtime.update{runtime}
// hub→client:   welcome, threads, runtimes, users, thread.snapshot{thread, events}, event{...},
//               presence{threadId, viewers}, thread.updated{thread}, thread.deleted, command.result, error
// hub→runtime:  welcome, command{id, threadId, by, command}

module.exports = { Events, ItemTypes, ItemStatus, TurnStatus, ApprovalPolicy, SandboxPolicy, ApprovalDecision, ThreadStatus, Commands };
