// Public, purpose-limited recovery authorization. Private SDK identity material never
// belongs in these records, and this key is not a normal membership or control signer.
import { canonical, digest, exact } from '../protocol/encrypted-task.mjs';
const fail = code => { throw Object.assign(new Error(code), { code }); };
export const OWNER_RECOVERY_PURPOSE = 'owner-endpoint-recovery-with-host-local-activation';
const key32 = value => {
  try { return typeof value === 'string' && /^[A-Za-z0-9+/]{43}$/.test(value) && atob(value).length === 32 && btoa(atob(value)).replace(/=+$/, '') === value; }
  catch { return false; }
};
export const recoveryIdentity = value => exact(value, ['user', 'device', 'curve25519', 'ed25519']) &&
  typeof value.user === 'string' && /^@[^:]{1,256}:plexus\.local$/.test(value.user) &&
  typeof value.device === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.device) && key32(value.curve25519) && key32(value.ed25519);
export function recoveryService(value) {
  let url;
  try { url = new URL(value); } catch { fail('recovery_service_mismatch'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || value !== url.origin) fail('recovery_service_mismatch');
  return url.origin;
}
export function validateRecoveryDescriptor(value, expected = {}) {
  if (!exact(value, ['version', 'purpose', 'service', 'teamId', 'owner', 'genesis', 'generation', 'masterKey']) ||
      value.version !== 1 || value.purpose !== OWNER_RECOVERY_PURPOSE || !recoveryIdentity(value.genesis) ||
      value.owner !== value.genesis.user || typeof value.teamId !== 'string' || !value.teamId || value.teamId.length > 256 ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 || !key32(value.masterKey)) fail('recovery_descriptor_invalid');
  recoveryService(value.service);
  for (const key of ['service', 'teamId', 'owner', 'genesis']) {
    if (expected[key] !== undefined && canonical(value[key]) !== canonical(expected[key])) fail('recovery_context_mismatch');
  }
  return value;
}
export const recoveryDescriptorHash = descriptor => digest(validateRecoveryDescriptor(descriptor));
export function ownerRecoverySigningBody(body) {
  if (!exact(body, ['version', 'teamId', 'seq', 'previous', 'signer', 'action', 'payload']) || body.version !== 1 ||
      body.action !== 'owner.recover' || typeof body.teamId !== 'string' || !body.teamId || body.teamId.length > 256 ||
      !Number.isSafeInteger(body.seq) || body.seq < 1 || !/^[a-f0-9]{64}$/.test(body.previous || '') || !recoveryIdentity(body.signer) ||
      !exact(body.payload, ['descriptorHash', 'generation', 'epoch', 'candidate']) ||
      !/^[a-f0-9]{64}$/.test(body.payload.descriptorHash || '') || !Number.isSafeInteger(body.payload.generation) || body.payload.generation < 1 ||
      !/^[a-f0-9]{32}$/.test(body.payload.epoch || '') || !recoveryIdentity(body.payload.candidate) ||
      canonical(body.payload.candidate) !== canonical(body.signer)) fail('owner_recovery_claim_invalid');
  return { type: 'plexus.owner-recovery.claim.v1', operation: body };
}
