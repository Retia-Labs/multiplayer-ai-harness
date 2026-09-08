// Authenticated membership policy, shared by the relay and authorized endpoints.
// Signatures use the Matrix device Ed25519 key; verification uses WebCrypto.
// Customer owner recovery additionally requires its configured, purpose-limited master.
// The relay stores these records but cannot author them or choose the host's trust root.
import { canonical, digest, matrixUser, PROJECT_ID } from '../protocol/encrypted-task.mjs';
import { validateRecoveryDescriptor, ownerRecoverySigningBody } from './owner-recovery.mjs';
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
  const { signature, masterSignature, ...body } = record;
  return body;
};
export const initialMembership = (teamId) => ({ teamId, seq: 0, hash: GENESIS, owner: null, endpoints: [], grants: [], revocations: [],
  recoveryDescriptor: null, recoveryGeneration: 0, recoveryEpoch: null, recoveryKeys: [], recoveryEpochs: [] });
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
  } else if (action === 'owner.recover') {
    ownerRecoverySigningBody(body);
    if (!isOwner || !current.recoveryDescriptor || payload.generation !== current.recoveryGeneration) fail('owner_recovery_refused');
    if (current.recoveryEpochs.includes(payload.epoch)) fail('recovery_epoch_reused');
    const prior = next.endpoints.find(entry => entry.user === signer.user && entry.device === signer.device);
    if (prior) fail(prior.state === 'revoked' ? 'endpoint_revoked' : 'recovery_candidate_not_new');
    if (next.endpoints.some(entry => entry.user === signer.user &&
        (entry.ed25519 === signer.ed25519 || entry.curve25519 === signer.curve25519))) fail('recovery_candidate_not_new');
    for (const entry of next.endpoints) {
      if (entry.state === 'verified') Object.assign(entry, { state: 'pending', confirmedBy: null, resetByRecovery: payload.epoch });
    }
    for (const grant of next.grants) {
      if (!grant.revoked) Object.assign(grant, { revoked: true, resetByRecovery: payload.epoch });
    }
    next.endpoints.push({ ...signer, userId: actor, state: 'verified', confirmedBy: 'owner-recovery:' + payload.epoch, admittedEpoch: payload.epoch });
    next.recoveryEpoch = payload.epoch;
    next.recoveryEpochs.push(payload.epoch);
  } else {
    if (!verified) fail('confirming_endpoint_unverified');
    if (action === 'recovery.configure') {
      if (!isOwner) fail('recovery_owner_required');
      const descriptor = validateRecoveryDescriptor(payload.descriptor, { teamId, owner: current.owner.user, genesis: current.owner });
      if (Object.keys(payload).length !== 1 || descriptor.generation !== current.recoveryGeneration + 1) fail('recovery_generation_conflict');
      if (current.recoveryKeys.includes(descriptor.masterKey)) fail('recovery_master_key_reused');
      next.recoveryDescriptor = descriptor;
      next.recoveryGeneration = descriptor.generation;
      next.recoveryKeys.push(descriptor.masterKey);
    } else if (action === 'recovery.revoke') {
      if (!isOwner) fail('recovery_owner_required');
      if (Object.keys(payload).length !== 2 || !current.recoveryDescriptor || payload.generation !== current.recoveryGeneration ||
          !/^[a-f0-9]{64}$/.test(payload.descriptorHash || '')) fail('recovery_descriptor_mismatch');
      next.recoveryDescriptor = null;
    } else if (action === 'confirm') {
      if (payload.device !== signer.device) fail('confirming_endpoint_unverified');
      const target = payload.target;
      if (!target || !target.userId || !/^[A-Za-z0-9_-]{1,64}$/.test(target.device || '')) fail('invalid_endpoint_fingerprint');
      const existing = next.endpoints.find((e) => e.userId === target.userId && e.device === target.device);
      const identity = { user: matrixUser(target.userId), device: target.device, curve25519: target.curve25519, ed25519: target.ed25519 };
      if (existing && (!sameIdentity(existing, identity) || existing.state === 'revoked')) fail('endpoint_revoked');
      if (!existing) next.endpoints.push({ ...identity, userId: target.userId, state: 'verified', confirmedBy: identityKey(signer) });
      else if (existing.state === 'pending') {
        Object.assign(existing, { state: 'verified', confirmedBy: identityKey(signer), admittedEpoch: current.recoveryEpoch });
        delete existing.resetByRecovery;
      }
    } else if (action === 'revoke-endpoint') {
      const target = payload.target;
      if (!target || (!isOwner && actor !== target.userId)) fail('endpoint_revocation_refused');
      const existing = next.endpoints.find((e) => e.userId === target.userId && e.device === target.device);
      if (!existing) fail('endpoint_not_verified');
      // The original public identity remains the immutable genesis verifier after its
      // device is removed. Only a different, already verified owner endpoint may remove
      // it; each host applies the removal and chooses its live signer independently.
      if (sameIdentity(existing, current.owner) && (!isOwner || sameIdentity(signer, current.owner))) {
        fail('membership_authority_rotation_required');
      }
      existing.state = 'revoked';
      next.revocations.push({ userId: target.userId, device: target.device, seq });
    } else if (action === 'own-project') {
      if (!PROJECT_ID.test(payload.projectId || '')) fail('invalid_project');
      if (next.grants.some((g) => g.projectId === payload.projectId)) {
        if (!liveGrant(payload.projectId, actor)) {
          const reset = next.grants.filter(g => g.projectId === payload.projectId);
          if (!isOwner || reset.some(g => !g.revoked) || !reset.some(g => g.resetByRecovery)) fail('project_already_owned');
          const prior = reset.find(g => g.userId === actor);
          const grant = { projectId: payload.projectId, userId: actor, role: 'owner', grantedBy: actor, revoked: false };
          if (prior) { Object.assign(prior, grant); delete prior.resetByRecovery; } else next.grants.push(grant);
        }
      } else next.grants.push({ projectId: payload.projectId, userId: actor, role: 'owner', grantedBy: actor, revoked: false });
    } else if (action === 'grant') {
      if (!liveGrant(payload.projectId, actor)) fail('not_a_project_participant');
      if (!['owner', 'participant'].includes(payload.role || 'participant')) fail('invalid_project_role');
      const prior = next.grants.find((g) => g.projectId === payload.projectId && g.userId === payload.userId);
      const grant = { projectId: payload.projectId, userId: payload.userId, role: payload.role || 'participant', grantedBy: actor, revoked: false };
      if (prior) { Object.assign(prior, grant); delete prior.resetByRecovery; } else next.grants.push(grant);
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
export async function replayMembership(records, { teamId, authority, checkpoint, service } = {}) {
  if (!authority) fail('membership_authority_required');
  if (!Array.isArray(records) || records.length > 100000) fail('invalid_membership_log');
  let state = initialMembership(teamId);
  let checkedFloor = !checkpoint || checkpoint.seq === 0;
  for (const record of records) {
    const body = operationBody(record);
    if (!state.seq && !sameIdentity(body.signer, authority)) fail('membership_authority_mismatch');
    if (!await verifySignature(body.signer, body, record.signature)) fail('enrollment_signature_invalid');
    await verifyRecoveryOperation(state, record);
    state = applyOperation(state, body);
    if (state.recoveryDescriptor) validateRecoveryDescriptor(state.recoveryDescriptor, { service });
    state.hash = await digest(record);
    if (checkpoint && state.seq === checkpoint.seq) {
      if (state.hash !== checkpoint.hash) fail('membership_rollback');
      checkedFloor = true;
    }
  }
  if (!checkedFloor || state.seq < (checkpoint?.seq || 0)) fail('membership_rollback');
  return state;
}
// The sole exception to the normal verified-device gate. Both signatures bind the
// complete parent and candidate; possession of this master key grants no other action.
export async function verifyRecoveryOperation(current, record) {
  if (record.action === 'recovery.revoke' && (!current.recoveryDescriptor ||
      record.payload?.descriptorHash !== await digest(current.recoveryDescriptor))) fail('recovery_descriptor_mismatch');
  if (record.action !== 'owner.recover') {
    if (record.masterSignature !== undefined) fail('owner_recovery_purpose_required');
    return;
  }
  const body = operationBody(record), signed = ownerRecoverySigningBody(body);
  const descriptor = current.recoveryDescriptor;
  if (!descriptor || record.payload.descriptorHash !== await digest(descriptor) ||
      record.payload.generation !== descriptor.generation) fail('recovery_descriptor_mismatch');
  if (!await verifySignature({ ed25519: descriptor.masterKey }, signed, record.masterSignature)) fail('recovery_signature_invalid');
}
export async function signMembership(endpoint, head, action, payload) {
  const identity = endpoint.identity();
  const signer = Object.fromEntries(['user', 'device', 'curve25519', 'ed25519'].map((key) => [key, identity[key]]));
  const body = { version: 1, teamId: head.teamId, seq: head.seq + 1, previous: head.hash, signer, action, payload };
  return { ...body, signature: await endpoint.sign(canonical(body)) };
}
export function currentMembershipBody(teamId, challenge, head, context) {
  if (context === undefined) return { type: 'plexus.membership.current.v1', teamId, challenge, seq: head.seq, hash: head.hash };
  if (!context || typeof context.runtimeId !== 'string' || !context.runtimeId || context.runtimeId.length > 256 ||
      typeof context.activationId !== 'string' || !/^[a-f0-9]{32}$/.test(context.activationId) ||
      typeof challenge !== 'string' || !/^[a-f0-9]{48}$/.test(challenge)) fail('invalid_membership_challenge');
  return { type: 'plexus.membership.current.v2', teamId, challenge, runtimeId: context.runtimeId,
    activationId: context.activationId, seq: head.seq, hash: head.hash };
}
