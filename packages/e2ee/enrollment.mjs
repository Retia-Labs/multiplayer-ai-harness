// Bringing a teammate into a project's encrypted history.
//
// The hub half of this (packages/hub/enrollment.js) decides who may fetch bytes. This half
// decides who can open them, and the two are deliberately not the same decision. A grant
// hands over ciphertext; only the steps here hand over keys, and they refuse to run for an
// endpoint whose fingerprint nobody has confirmed.
//
// Joining late is the whole problem, and megolm decides how it can be solved. A group
// session's key exports at its *current* ratchet index, so admitting a new endpoint to a
// running session buys the next event and never a past one. History has to be handed over
// as an export, and there is no arrangement of the relay that changes this.
//
// #6 refused every imported session, because an export carries no provenance a reader can
// check - it is exactly what an attacker would also hand you - and left the question to this
// slice's enrollment contract. The contract: an import is readable only when the receiving
// endpoint opened the handoff itself, sealed by the execution host that writes the log, and
// only for the session ids that handoff actually contained.
//
// The writer specifically, not merely someone the reader has confirmed. An exported session
// states its sender keys as claimed metadata chosen by whoever exported it, so a confirmed
// teammate could otherwise hand over a session claiming the host's keys and have fabricated
// events read as the host's writing. test/e2ee-import-forgery.js does exactly that, and it
// succeeded until this binding existed. The only party whose account of the writer's
// sessions means anything is the writer.
import { roomFor, matrixUser, canonical, digest } from '../protocol/encrypted-task.mjs';
import { GENESIS, replayMembership, signMembership, currentMembershipBody, sameIdentity, verifySignature } from './membership.mjs';

const randomKey = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (v) => v.toString(16).padStart(2, '0')).join('');

export class EnrollmentError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new EnrollmentError(code); };

// The hub's enrollment routes, in the shape the task transport already established.
export class EnrollmentTransport {
  constructor({ url, token, service = new URL(url).origin, endpoint = null, loadCheckpoint, saveCheckpoint }) {
    this.url = url; this.token = token; this.endpoint = endpoint; this.checkpoints = new Map();
    this.service = service;
    this.loadCheckpoint = loadCheckpoint || ((teamId) => this.checkpoints.get(teamId));
    this.saveCheckpoint = saveCheckpoint || ((teamId, value) => this.checkpoints.set(teamId, value));
  }
  bindEndpoint(endpoint) { this.endpoint = endpoint; return this; }
  async pinAuthority(teamId, authority) {
    const prior = await this.loadCheckpoint(teamId);
    if (prior?.authority && !sameIdentity(prior.authority, authority)) fail('membership_authority_mismatch');
    await this.saveCheckpoint(teamId, { seq: prior?.seq || 0, hash: prior?.hash || GENESIS, authority });
  }
  async signedHead(teamId, state) {
    const records = state.authorityLog || [];
    const prior = await this.loadCheckpoint(teamId);
    const authority = prior?.authority || (sameIdentity(records[0]?.signer, this.endpoint?.identity()) ? this.endpoint.identity() : null);
    if (records.length && !authority) fail('membership_authority_required');
    // An endpoint can establish its own bootstrap root. Other endpoints require an
    // explicitly pinned authority, supplied by the application when enrolling them.
    if (!authority) return { teamId, seq: 0, hash: GENESIS };
    const head = await replayMembership(records, { teamId, authority, checkpoint: prior, service: this.service });
    await this.saveCheckpoint(teamId, { seq: head.seq, hash: head.hash, authority });
    return head;
  }
  async mutate(teamId, action, payload) {
    if (!this.endpoint) fail('enrollment_signature_required');
    const state = await this.state(teamId);
    const head = await this.signedHead(teamId, state);
    const operation = await signMembership(this.endpoint, head, action, payload);
    const response = await this.request('/' + action, { teamId, ...payload, operation });
    await this.saveCheckpoint(teamId, { seq: operation.seq, hash: await digest(operation), authority: head.owner || operation.signer });
    return response;
  }
  async prepareRecovery(teamId, descriptor) {
    if (!this.endpoint) fail('enrollment_signature_required');
    const state = await this.state(teamId);
    const head = await this.signedHead(teamId, state);
    const operation = await signMembership(this.endpoint, head, 'recovery.configure', { descriptor });
    const log = [...state.authorityLog, operation];
    const next = await replayMembership(log, { teamId, authority: head.owner, checkpoint: head, service: this.service });
    return { operation, log, head: next };
  }
  async commitRecovery(teamId, prepared) {
    const operation = prepared?.operation;
    if (operation?.action !== 'recovery.configure' || operation.teamId !== teamId) fail('recovery_descriptor_invalid');
    const result = await this.request('/recovery.configure', { teamId, ...operation.payload, operation });
    await this.signedHead(teamId, await this.state(teamId));
    return result;
  }
  async configureRecovery(teamId, descriptor) { return this.commitRecovery(teamId, await this.prepareRecovery(teamId, descriptor)); }
  revokeRecovery(teamId, payload) { return this.mutate(teamId, 'recovery.revoke', payload); }
  deleteTask(teamId, task) { return this.mutate(teamId, 'task.delete', { taskId: task.id, projectId: task.projectId, runtimeId: task.runtimeId }); }
  deleteProject(teamId, projectId, tasks) { return this.mutate(teamId, 'project.delete', { projectId, tasks }); }
  async recoverOwner(teamId, payload) {
    if (!this.endpoint?.signOwnerRecovery) fail('owner_recovery_material_required');
    const state = await this.state(teamId);
    const head = await this.signedHead(teamId, state);
    const signer = Object.fromEntries(['user', 'device', 'curve25519', 'ed25519'].map(key => [key, this.endpoint.identity()[key]]));
    const body = { version: 1, teamId, seq: head.seq + 1, previous: head.hash, signer, action: 'owner.recover', payload };
    const operation = { ...body, ...await this.endpoint.signOwnerRecovery(body, { log: state.authorityLog }) };
    const response = await this.request('/owner.recover', { teamId, ...payload, operation });
    await this.signedHead(teamId, await this.state(teamId));
    return response;
  }
  async answerChallenges(teamId) {
    if (!this.endpoint) return { answered: 0 };
    const state = await this.state(teamId);
    const head = await this.signedHead(teamId, state);
    const own = this.endpoint.identity();
    if (!head.owner || own.user !== head.owner.user ||
        !head.endpoints.some((entry) => entry.state === 'verified' && sameIdentity(entry, own))) return { answered: 0 };
    let answered = 0;
    for (const request of state.challenges || []) {
      const addressed = request.signer !== undefined || request.activationId !== undefined;
      if (addressed ? !sameIdentity(request.signer, own) : !sameIdentity(head.owner, own)) continue;
      let body;
      try {
        body = currentMembershipBody(teamId, request.challenge, head,
          addressed ? { runtimeId: request.runtimeId, activationId: request.activationId } : undefined);
      } catch { continue; } // Malformed relay routing cannot downgrade an addressed proof to v1.
      await this.request('/answer-challenge', { teamId, runtimeId: request.runtimeId,
        proof: { ...body, signature: await this.endpoint.sign(canonical(body)) } });
      answered++;
    }
    return { answered };
  }
  async request(path, body) {
    let response;
    try {
      response = await fetch(this.url + '/api/enrollment' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + this.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      });
    } catch { fail('relay_unavailable'); }
    let value;
    try { value = await response.json(); } catch { fail('invalid_relay_response'); }
    if (!response.ok) fail(typeof value.error === 'string' && /^[a-z_]{1,64}$/.test(value.error) ? value.error : 'enrollment_request_refused');
    return value;
  }
  state(teamId, projectId) {
    return this.request('?team=' + encodeURIComponent(teamId) + (projectId ? '&project=' + encodeURIComponent(projectId) : ''));
  }
  announce(teamId, endpoint) { return this.request('/announce', { teamId, endpoint }); }
  bootstrap(teamId, endpoint) { return this.mutate(teamId, 'bootstrap', { endpoint }); }
  confirm(teamId, device, target) { return this.mutate(teamId, 'confirm', { device, target }); }
  revokeEndpoint(teamId, target) { return this.mutate(teamId, 'revoke-endpoint', { target }); }
  grant(teamId, projectId, userId, role = 'participant') { return this.mutate(teamId, 'grant', { projectId, userId, role }); }
  revokeGrant(teamId, projectId, userId) { return this.mutate(teamId, 'revoke-grant', { projectId, userId }); }
  ownProject(teamId, projectId) { return this.mutate(teamId, 'own-project', { projectId }); }
}

// What one endpoint publishes about itself. Nothing here is secret, and nothing here is
// trust: it is the material a human compares out of band before confirming.
export const announcement = (endpoint) => {
  const id = endpoint.identity();
  return { device: id.device, curve25519: id.curve25519, ed25519: id.ed25519 };
};

// An account and an invitation link get you exactly this far: a pending row.
export async function announceEndpoint(endpoint, transport, teamId) {
  const result = await transport.announce(teamId, announcement(endpoint));
  if (result.endpoint.state !== 'pending' && result.endpoint.state !== 'verified') fail('endpoint_not_announced');
  return result;
}

// The confirming step, done from an endpoint that is already trusted. The fingerprint must
// have reached the confirmer through a channel the relay does not control - reading it
// aloud, or off the other person's screen. `confirmed` is the caller asserting that
// happened; passing it without having done it is the one thing this cannot detect.
export async function confirmTeammateEndpoint(endpoint, transport, teamId, target, { confirmed = false } = {}) {
  if (!confirmed) fail('endpoint_confirmation_required');
  const expected = { user: matrixUser(target.userId), device: target.device, curve25519: target.curve25519, ed25519: target.ed25519 };
  // Local trust first: if the keys the relay serves do not match what the human compared,
  // this throws and no confirmation is recorded anywhere.
  //
  // Deliberately device-fingerprint trust rather than `verifyEndpoint`. Cross-signing one
  // account's identity with another's requires user-signing keys and a verified account
  // identity, which this adapter does not establish - the same choice `decryptVerifiedTask`
  // already documents when it accepts an explicitly pinned device over an account warning.
  await endpoint.confirmEndpoint(expected, { confirmed: true });
  const recorded = await transport.bindEndpoint(endpoint).confirm(teamId, endpoint.device, target);
  if (recorded.endpoint.state !== 'verified') fail('endpoint_not_verified');
  return recorded;
}

// Two acts that look like one: a relay-side grant deciding who may fetch this project's
// ciphertext, and a key handoff deciding who can open it. Keeping them separate is what
// makes each of them checkable - the grant alone buys bytes nobody can read, and the
// handoff alone has nothing to read.
//
// A grant may be issued by any project participant holding a confirmed endpoint. The key
// handoff may not: see handOffHistory, which only the writing host can perform.
export async function grantProjectAccess(endpoint, transport, { teamId, projectId, member, taskIds, role = 'participant' }) {
  if (!member || typeof member.userId !== 'string' || typeof member.device !== 'string') fail('project_membership_required');
  if (!Array.isArray(taskIds)) fail('project_membership_required');
  const granted = await transport.bindEndpoint(endpoint).grant(teamId, projectId, member.userId, role);

  // Both verdicts have to agree before anything is sealed. Local trust survives a device
  // being revoked - this endpoint confirmed it once and has no reason to forget - so
  // without the relay's view a revoked endpoint would keep receiving history from anyone
  // who had ever trusted it. Asking is what makes revocation mean something.
  const known = await transport.state(teamId);
  const listed = (known.endpoints || []).find((e) => e.userId === member.userId && e.device === member.device);
  if (!listed || listed.state !== 'verified') fail('member_endpoint_unverified');

  return granted;
}

// The writer's side of joining late, performed by the execution host that owns these
// sessions - the only party whose account of them is worth anything.
//
// The export is scoped to the named rooms and encrypted to a single-use transfer key. The
// blob may cross the relay; the transfer key never does in the clear, and sealControl
// refuses outright to seal for a device this endpoint has not confirmed, which is what stops
// a grant from quietly becoming access.
//
// Events written after this handoff ride the same session and need nothing further. A later
// rotation - which is how removal works - is what makes EncryptedFixtureHost.admit necessary
// again.
export async function handOffHistory(endpoint, { teamId, projectId, member, taskIds }) {
  if (!member || typeof member.userId !== 'string' || typeof member.device !== 'string') fail('project_membership_required');
  if (!Array.isArray(taskIds) || !taskIds.length) fail('project_membership_required');
  const rooms = taskIds.map(roomFor);
  const transferKey = randomKey();
  const blob = await endpoint.exportHistory(rooms, transferKey);
  const envelope = await endpoint.sealControl(matrixUser(member.userId), member.device, {
    type: 'plexus.project.history.v1', teamId, projectId, rooms, transferKey
  });
  return { blob, envelope, rooms };
}

// The joining side. The sealed half authenticates the handoff; the blob is inert without
// it. What comes back is the set of session ids this handoff admitted - the reader needs
// them, because that set is the whole basis on which it will trust an imported session.
export async function acceptProjectAccess(endpoint, { history }, { writer } = {}) {
  if (!history || typeof history.blob !== 'string' || !history.envelope) fail('project_history_missing');
  // The writer is required, and is checked against the seal's actual sender. Accepting a
  // handoff from anyone else is the forgery this contract exists to refuse.
  if (!writer || typeof writer.user !== 'string' || typeof writer.device !== 'string') fail('project_history_writer_required');
  const opened = await endpoint.openControl([history.envelope]);
  const content = readProjectHistory(opened, writer);
  const imported = await endpoint.importHistory(history.blob, content.transferKey, content.rooms);
  return { teamId: content.teamId, projectId: content.projectId, rooms: content.rooms, ...imported };
}

// Separate authentication from import so a receiver can encrypt the authenticated
// transfer into its local retry journal before an import consumes further state.
export function readProjectHistory(opened, writer) {
  if (!opened?.decrypted || !opened.verified || opened.type !== 'plexus.control.v1' || !opened.senderDevice) {
    fail('project_history_unauthenticated');
  }
  if (opened.sender !== writer.user || opened.senderDevice !== writer.device || opened.senderKey !== writer.curve25519) {
    fail('project_history_not_from_writer');
  }
  const content = opened.content;
  if (!content || content.type !== 'plexus.project.history.v1' || !Array.isArray(content.rooms) || typeof content.transferKey !== 'string') {
    fail('project_history_unauthenticated');
  }
  return content;
}

// What the relay knows about this team, shaped for display: who participates in a project,
// in what role, and which of their endpoints are still waiting to be confirmed.
export async function participation(transport, teamId, projectId) {
  const state = await transport.state(teamId, projectId);
  const participants = (state.participants || []).map((p) => ({
    userId: p.userId, name: p.name, role: p.role, grantedBy: p.grantedBy,
    endpoints: (p.endpoints || []).map((e) => ({ device: e.device, state: e.state, confirmedBy: e.confirmedBy })),
    pendingEndpoints: (p.endpoints || []).filter((e) => e.state === 'pending').length,
    readable: (p.endpoints || []).some((e) => e.state === 'verified')
  }));
  return {
    teamId, projectId,
    me: state.me,
    projects: state.projects,
    participants,
    // A participant whose endpoints are all pending is granted and cannot read a thing.
    // Saying that plainly is the point: the two states look identical from the relay.
    awaitingConfirmation: participants.filter((p) => !p.readable).map((p) => p.userId)
  };
}

// What revocation does, and the part of it nobody can do.
//
// Written down because the gap between these two is where people get hurt: a product that
// says "removed" without saying "from here on" invites somebody to believe a laptop that was
// taken home has been reached into, and it has not.
export const REVOCATION_LIMITS = {
  future: 'Removing an endpoint rotates the key. Everything written after the host applies it is unreadable to that device.',
  alreadyRead: 'It does not erase anything that device already decrypted. Those events are on that machine, and no key rotation reaches them.',
  participantHistory: 'A teammate who was in a project keeps whatever they had already read. Removal ends access; it does not un-share what was shared.',
  pending: 'Until each execution host has applied the revocation, that device may still be able to read new events on the tasks that host owns. The hosts that have not applied it yet are named rather than counted.',
  distinctFromRole: 'Endpoint keys, team role and paid seats are three separate things. Revoking a device does not change somebody\'s role or their seat, and removing a role does not rotate a key.'
};


// A relay receipt is only a claim. Count a host only after its locally confirmed key
// authenticates a receipt covering the exact signed revocation and accepted log prefix.
export async function verifyRevocationReceipts(revocations, { hosts, authorityLog }) {
  const hashes = new Map();
  for (const record of authorityLog || []) hashes.set(record.seq, await digest(record));
  const result = [];
  for (const revocation of revocations || []) {
    const operation = (authorityLog || []).find((r) => r.action === 'revoke-endpoint' &&
      r.payload.target.userId === revocation.userId && r.payload.target.device === revocation.device);
    const appliedBy = [];
    for (const host of hosts || []) {
      const receipt = (revocation.receipts || []).find((r) => r.runtimeId === host.runtimeId)?.proof;
      if (!operation || !receipt || receipt.type !== 'plexus.membership.applied.v1' || !sameIdentity(host.identity, receipt.signer) || receipt.teamId !== operation.teamId ||
          receipt.runtimeId !== host.runtimeId || receipt.target?.userId !== revocation.userId || receipt.target?.device !== revocation.device ||
          receipt.seq < operation.seq || hashes.get(receipt.seq) !== receipt.hash) continue;
      const { signature, ...body } = receipt;
      if (await verifySignature(host.identity, body, signature)) appliedBy.push(host.runtimeId);
    }
    const pendingHosts = (hosts || []).map((host) => host.runtimeId).filter((id) => !appliedBy.includes(id));
    result.push({ ...revocation, appliedBy, pendingHosts, applied: (hosts || []).length > 0 && pendingHosts.length === 0 });
  }
  return result;
}
