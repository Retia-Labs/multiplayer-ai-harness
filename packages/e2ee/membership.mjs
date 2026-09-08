// Authenticated membership policy, shared by the relay and authorized endpoints.
// Signatures use the Matrix device Ed25519 key; verification uses WebCrypto.
// The relay stores these records but cannot author them or choose the host's trust root.
import { canonical, digest, matrixUser, PROJECT_ID } from '../protocol/encrypted-task.mjs';
export const GENESIS = '0'.repeat(64);
export const identityKey = (id) => id.user + '/' + id.device;
export const accountId = (user) => /^@([^:]+):plexus\.local$/.exec(user || '')?.[1] || null;
export const sameIdentity = (a, b) => !!a && !!b && ['user', 'device', 'curve25519', 'ed25519'].every((k) => a[k] === b[k]);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function verifySignature(identity, message, signature) {
  try {
    const key = await crypto.subtle.importKey('raw', bytes(identity.ed25519), 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, bytes(signature), new TextEncoder().encode(canonical(message)));
  } catch { return false; }
}
export const operationBody = (record) => {
  const { signature, ...body } = record;
  return body;
};
export const initialMembership = (teamId) => ({ teamId, seq: 0, hash: GENESIS, owner: null, endpoints: [], grants: [], revocations: [] });
const endpointFor = (state, signer) => state.endpoints.find((e) => sameIdentity(e, signer) && e.state === 'verified');
export function applyOperation(current, body) {
  const { teamId, seq, previous, signer, action, payload } = body || {};
  if (body?.version !== 1 || teamId !== current.teamId || seq !== current.seq + 1 || previous !== current.hash ||
      !signer || !accountId(signer.user) || !/^[A-Za-z0-9_-]{1,64}$/.test(signer.device || '') || !payload) fail('membership_sequence_conflict');
  const next = structuredClone(current);
  const actor = accountId(signer.user);
  const isOwner = current.owner && accountId(current.owner.user) === actor;
  const verified = endpointFor(current, signer);
  const liveGrant = (project, user) => next.grants.find((g) => g.projectId === project && g.userId === user && !g.revoked);
  if (action === 'bootstrap') {
    if (current.seq || current.owner || !sameIdentity(signer, { user: matrixUser(actor), ...payload.endpoint })) fail('membership_bootstrap_refused');
    next.owner = signer;
    next.endpoints.push({ ...signer, userId: actor, state: 'verified', confirmedBy: identityKey(signer) });
  } else {
    if (!verified) fail('confirming_endpoint_unverified');
    if (action === 'confirm') {
      if (payload.device !== signer.device) fail('confirming_endpoint_unverified');
      const target = payload.target;
      if (!target || !target.userId || !/^[A-Za-z0-9_-]{1,64}$/.test(target.device || '')) fail('invalid_endpoint_fingerprint');
      const existing = next.endpoints.find((e) => e.userId === target.userId && e.device === target.device);
      const identity = { user: matrixUser(target.userId), device: target.device, curve25519: target.curve25519, ed25519: target.ed25519 };
      if (existing && (!sameIdentity(existing, identity) || existing.state === 'revoked')) fail('endpoint_revoked');
      if (!existing) next.endpoints.push({ ...identity, userId: target.userId, state: 'verified', confirmedBy: identityKey(signer) });
    } else if (action === 'revoke-endpoint') {
      const target = payload.target;
      if (!target || (!isOwner && actor !== target.userId)) fail('endpoint_revocation_refused');
      const existing = next.endpoints.find((e) => e.userId === target.userId && e.device === target.device);
      if (!existing) fail('endpoint_not_verified');
      if (sameIdentity(existing, current.owner)) fail('membership_authority_rotation_required');
      existing.state = 'revoked';
      next.revocations.push({ userId: target.userId, device: target.device, seq });
    } else if (action === 'own-project') {
      if (!PROJECT_ID.test(payload.projectId || '')) fail('invalid_project');
      if (next.grants.some((g) => g.projectId === payload.projectId)) {
        if (!liveGrant(payload.projectId, actor)) fail('project_already_owned');
      } else next.grants.push({ projectId: payload.projectId, userId: actor, role: 'owner', grantedBy: actor, revoked: false });
    } else if (action === 'grant') {
      if (!liveGrant(payload.projectId, actor)) fail('not_a_project_participant');
      if (!['owner', 'participant'].includes(payload.role || 'participant')) fail('invalid_project_role');
      const prior = next.grants.find((g) => g.projectId === payload.projectId && g.userId === payload.userId);
      const grant = { projectId: payload.projectId, userId: payload.userId, role: payload.role || 'participant', grantedBy: actor, revoked: false };
      if (prior) Object.assign(prior, grant); else next.grants.push(grant);
    } else if (action === 'revoke-grant') {
      if (!liveGrant(payload.projectId, actor)) fail('not_a_project_participant');
      const prior = liveGrant(payload.projectId, payload.userId);
      if (!prior) fail('not_a_project_participant');
      if (prior.role === 'owner' && actor !== payload.userId) fail('project_owner_grant_retained');
      prior.revoked = true;
      next.revocations.push({ userId: payload.userId, projectId: payload.projectId, seq });
    } else fail('unsupported_membership_operation');
  }
  next.seq = seq;
  return next;
}
export async function replayMembership(records, { teamId, authority, checkpoint } = {}) {
  if (!authority) fail('membership_authority_required');
  if (!Array.isArray(records) || records.length > 100000) fail('invalid_membership_log');
  let state = initialMembership(teamId);
  let checkedFloor = !checkpoint || checkpoint.seq === 0;
  for (const record of records) {
    const body = operationBody(record);
    if (!state.seq && !sameIdentity(body.signer, authority)) fail('membership_authority_mismatch');
    if (!await verifySignature(body.signer, body, record.signature)) fail('enrollment_signature_invalid');
    state = applyOperation(state, body);
    state.hash = await digest(record);
    if (checkpoint && state.seq === checkpoint.seq) {
      if (state.hash !== checkpoint.hash) fail('membership_rollback');
      checkedFloor = true;
    }
  }
  if (!checkedFloor || state.seq < (checkpoint?.seq || 0)) fail('membership_rollback');
  return state;
}
export async function signMembership(endpoint, head, action, payload) {
  const identity = endpoint.identity();
  const signer = Object.fromEntries(['user', 'device', 'curve25519', 'ed25519'].map((key) => [key, identity[key]]));
  const body = { version: 1, teamId: head.teamId, seq: head.seq + 1, previous: head.hash, signer, action, payload };
  return { ...body, signature: await endpoint.sign(canonical(body)) };
}
export function currentMembershipBody(teamId, challenge, head) {
  return { type: 'plexus.membership.current.v1', teamId, challenge, seq: head.seq, hash: head.hash };
}
