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
// check - it is exactly what an attacker would also hand you - and left the question to
// this slice's enrollment contract. The contract: an import is readable only when the
// receiving endpoint opened the handoff itself, sealed by a fingerprint it had already
// confirmed, and only for the session ids that handoff actually contained. Anything else
// stays refused. The trust does not come from the export; it comes from the seal around it.
import { roomFor, matrixUser } from '../protocol/encrypted-task.mjs';

const randomKey = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (v) => v.toString(16).padStart(2, '0')).join('');

export class EnrollmentError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new EnrollmentError(code); };

// The hub's enrollment routes, in the shape the task transport already established.
export class EnrollmentTransport {
  constructor({ url, token }) { this.url = url; this.token = token; }
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
  bootstrap(teamId, endpoint) { return this.request('/bootstrap', { teamId, endpoint }); }
  confirm(teamId, device, target) { return this.request('/confirm', { teamId, device, target }); }
  revokeEndpoint(teamId, target) { return this.request('/revoke-endpoint', { teamId, target }); }
  grant(teamId, projectId, userId, role) { return this.request('/grant', { teamId, projectId, userId, role }); }
  revokeGrant(teamId, projectId, userId) { return this.request('/revoke-grant', { teamId, projectId, userId }); }
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
  const recorded = await transport.confirm(teamId, endpoint.device, target);
  if (recorded.endpoint.state !== 'verified') fail('endpoint_not_verified');
  return recorded;
}

// Two acts that look like one: a relay-side grant deciding who may fetch this project's
// ciphertext, and a key handoff deciding who can open it. Keeping them separate is what
// makes each of them checkable - the grant alone buys bytes nobody can read, and the
// handoff alone has nothing to read.
//
// The export is scoped to this project's rooms and encrypted to a single-use transfer key.
// The blob may cross the relay; the transfer key never does in the clear, and sealControl
// refuses outright to seal for a device this endpoint has not confirmed. That refusal is
// what stops a grant from quietly becoming access.
//
// Events written after this handoff ride the same session and need nothing further. A
// later rotation - which is how removal works - is what makes `EncryptedFixtureHost.admit`
// necessary again.
export async function grantProjectAccess(endpoint, transport, { teamId, projectId, member, taskIds, role = 'participant' }) {
  if (!member || typeof member.userId !== 'string' || typeof member.device !== 'string') fail('project_membership_required');
  if (!Array.isArray(taskIds)) fail('project_membership_required');
  const granted = await transport.grant(teamId, projectId, member.userId, role);

  // Both verdicts have to agree before anything is sealed. Local trust survives a device
  // being revoked - this endpoint confirmed it once and has no reason to forget - so
  // without the relay's view a revoked endpoint would keep receiving history from anyone
  // who had ever trusted it. Asking is what makes revocation mean something.
  const known = await transport.state(teamId);
  const listed = (known.endpoints || []).find((e) => e.userId === member.userId && e.device === member.device);
  if (!listed || listed.state !== 'verified') fail('member_endpoint_unverified');

  const rooms = taskIds.map(roomFor);
  let history = null;
  if (rooms.length) {
    const transferKey = randomKey();
    const blob = await endpoint.exportHistory(rooms, transferKey);
    const envelope = await endpoint.sealControl(matrixUser(member.userId), member.device, {
      type: 'plexus.project.history.v1', teamId, projectId, rooms, transferKey
    });
    history = { blob, envelope, rooms };
  }
  return { ...granted, history };
}

// The joining side. The sealed half authenticates the handoff; the blob is inert without
// it. What comes back is the set of session ids this handoff admitted - the reader needs
// them, because that set is the whole basis on which it will trust an imported session.
export async function acceptProjectAccess(endpoint, { history }) {
  if (!history || typeof history.blob !== 'string' || !history.envelope) fail('project_history_missing');
  const opened = await endpoint.openControl([history.envelope]);
  const content = opened.content;
  if (!content || content.type !== 'plexus.project.history.v1' || !Array.isArray(content.rooms) || typeof content.transferKey !== 'string') {
    fail('project_history_unauthenticated');
  }
  const imported = await endpoint.importHistory(history.blob, content.transferKey, content.rooms);
  return { teamId: content.teamId, projectId: content.projectId, rooms: content.rooms, ...imported };
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
