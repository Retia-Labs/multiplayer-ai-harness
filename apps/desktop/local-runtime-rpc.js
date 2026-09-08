'use strict';
// This channel exists only between the desktop parent and its own forked runtime.
// Crypto broker messages and remote hub traffic cannot answer these requests.
const { randomBytes } = require('node:crypto');
const METHODS = new Set(['freshness.prepare', 'freshness.commit']);
const REMOTE_ERRORS = new Set(['freshness_host_unavailable', 'freshness_team_mismatch',
  'freshness_candidate_unverified', 'freshness_candidate_not_owner', 'freshness_candidate_unchanged',
  'freshness_confirmation_required', 'freshness_confirmation_expired', 'freshness_confirmation_changed',
  'freshness_host_busy', 'freshness_state_invalid', 'freshness_commit_failed', 'membership_rollback',
  'membership_authority_mismatch', 'membership_freshness_authority_revoked', 'enrollment_unavailable', 'enrollment_signature_invalid']);
const failure = code => Object.assign(new Error(code), { code });
function alive(child) { return child && child.connected !== false && child.exitCode === null && child.signalCode === null; }
function encoded(value, maxBytes) {
  let json;
  try { json = JSON.stringify(value); } catch { throw failure('local_runtime_invalid_message'); }
  if (!json || Buffer.byteLength(json) > maxBytes) throw failure('local_runtime_message_too_large');
  return JSON.parse(json);
}
function createLocalRuntimeRpc(child, { timeoutMs = 10000, maxBytes = 65536 } = {}) {
  const pending = new Map(); let closed = false;
  const settle = (id, error, result) => {
    const request = pending.get(id); if (!request) return;
    pending.delete(id); clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(result);
  };
  const receive = message => {
    if (message?.type !== 'runtime.local.response' || !pending.has(message.id)) return;
    try {
      const response = encoded(message, maxBytes);
      if (Object.hasOwn(response, 'error')) {
        if (Object.hasOwn(response, 'result')) throw failure('local_runtime_invalid_message');
        throw failure(REMOTE_ERRORS.has(response.error) ? response.error : 'local_runtime_request_failed');
      }
      if (!Object.hasOwn(response, 'result')) throw failure('local_runtime_invalid_message');
      settle(message.id, null, response.result);
    } catch (error) { settle(message.id, error); }
  };
  const close = () => {
    if (closed) return; closed = true;
    child.removeListener('message', receive);
    for (const event of ['exit', 'disconnect', 'error']) child.removeListener(event, close);
    for (const id of pending.keys()) settle(id, failure('local_runtime_unavailable'));
  };
  child.on('message', receive);
  for (const event of ['exit', 'disconnect', 'error']) child.on(event, close);
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        if (closed || !alive(child)) return reject(failure('local_runtime_unavailable'));
        if (!METHODS.has(method)) return reject(failure('local_runtime_method_unsupported'));
        if (pending.size >= 8) return reject(failure('local_runtime_request_limit'));
        let message;
        const id = randomBytes(16).toString('hex');
        try { message = encoded({ type: 'runtime.local.request', id, method, params }, maxBytes); }
        catch (error) { return reject(error); }
        const timer = setTimeout(() => settle(id, failure('local_runtime_timeout')), timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { child.send(message, error => { if (error) settle(id, failure('local_runtime_send_failed')); }); }
        catch { settle(id, failure('local_runtime_send_failed')); }
      });
    },
    close
  };
}
const IDENTITY_KEYS = ['user', 'device', 'curve25519', 'ed25519'];
function textValue(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value);
}
function identityValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 4 &&
    IDENTITY_KEYS.every(key => textValue(value[key])) &&
    ['curve25519', 'ed25519'].every(key => /^[A-Za-z0-9+/_=-]{16,128}$/.test(value[key]));
}
function sameIdentity(one, two) { return identityValue(one) && identityValue(two) && IDENTITY_KEYS.every(key => one[key] === two[key]); }
function checkpointValue(value) {
  return value && Number.isSafeInteger(value.seq) && value.seq >= 0 && typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash);
}
function sameCheckpoint(one, two) { return checkpointValue(one) && checkpointValue(two) && one.seq === two.seq && one.hash === two.hash; }
function freshnessDialog(proposal) {
  return { type: 'warning', title: 'Replace this host’s freshness signer?',
    message: 'Trust this recovered owner device to attest current team access?',
    detail: 'Team: ' + proposal.teamId + '\nExecution host: ' + proposal.runtimeId +
      '\n\nNew signer — compare these exact keys with the trusted recovered device:\nUser: ' + proposal.candidate.user +
      '\nDevice: ' + proposal.candidate.device + '\nSigning fingerprint: ' + proposal.candidate.ed25519 +
      '\nEncryption key: ' + proposal.candidate.curve25519 +
      '\n\nPrevious signer: ' + proposal.previousSigner.user + ' / ' + proposal.previousSigner.device +
      '\nPrevious fingerprint: ' + proposal.previousSigner.ed25519 +
      '\n\nReviewed host checkpoint: ' + proposal.checkpoint.seq + ' / ' + proposal.checkpoint.hash +
      '\nPrior trusted checkpoint: ' + proposal.priorCheckpoint.seq + ' / ' + proposal.priorCheckpoint.hash +
      '\nKnown access: ' + proposal.accessSummary.verifiedEndpoints + ' verified endpoints; ' + proposal.accessSummary.projectGrants + ' project grants.' +
      '\n\nUnseen membership changes may be withheld by the service. Confirm only after comparing this state through a trusted channel.' +
      '\n\nThis replaces freshness attestation only. It does not grant action-approval rights, change the original enrollment owner, or authorize provider-account use. This execution host will restart after saving the replacement.',
    buttons: ['Cancel', 'Trust freshness signer'], defaultId: 0, cancelId: 0 };
}
function createFreshnessConfirmation({ getRuntime, confirm, restart, now = Date.now, timeoutMs = 10000 }) {
  let busy = false;
  return async ({ teamId, identity } = {}) => {
    if (busy) throw failure('freshness_host_busy');
    if (!textValue(teamId) || !identityValue(identity)) throw failure('freshness_state_invalid');
    busy = true; let rpc;
    try {
      const captured = getRuntime();
      const current = () => {
        const value = getRuntime();
        if (!captured || !textValue(captured.runtimeId) || !alive(captured.child) ||
            value?.child !== captured.child || value?.runtimeId !== captured.runtimeId) throw failure('freshness_host_unavailable');
      };
      current();
      const candidate = Object.fromEntries(IDENTITY_KEYS.map(key => [key, identity[key]]));
      rpc = createLocalRuntimeRpc(captured.child, { timeoutMs });
      const proposal = await rpc.request('freshness.prepare', { teamId, candidate });
      current();
      if (!proposal || !textValue(proposal.proposalId) || proposal.teamId !== teamId || proposal.runtimeId !== captured.runtimeId ||
          !sameIdentity(proposal.candidate, candidate) || !identityValue(proposal.previousSigner) ||
          !checkpointValue(proposal.checkpoint) || !checkpointValue(proposal.priorCheckpoint) ||
          proposal.checkpoint.seq < proposal.priorCheckpoint.seq ||
          (proposal.checkpoint.seq === proposal.priorCheckpoint.seq && !sameCheckpoint(proposal.checkpoint, proposal.priorCheckpoint)) ||
          !Number.isSafeInteger(proposal.expiresAt) || proposal.expiresAt > now() + 130000 ||
          !['verifiedEndpoints', 'projectGrants'].every(key => Number.isSafeInteger(proposal.accessSummary?.[key]) && proposal.accessSummary[key] >= 0)) {
        throw failure('freshness_state_invalid');
      }
      if (proposal.expiresAt <= now()) throw failure('freshness_confirmation_expired');
      if (await confirm(freshnessDialog(proposal)) !== true) return { confirmed: false };
      current();
      if (proposal.expiresAt <= now()) throw failure('freshness_confirmation_expired');
      const result = await rpc.request('freshness.commit', { proposalId: proposal.proposalId });
      if (!result || !textValue(result.activationId) || result.runtimeId !== captured.runtimeId || result.teamId !== teamId ||
          !sameIdentity(result.signer, candidate) || !sameCheckpoint(result.checkpoint, proposal.checkpoint)) throw failure('freshness_state_invalid');
      current();
      const receipt = { activationId: result.activationId, runtimeId: result.runtimeId, teamId: result.teamId,
        signer: candidate, checkpoint: { seq: result.checkpoint.seq, hash: result.checkpoint.hash } };
      try { await restart(captured); } catch { throw failure('local_runtime_restart_failed'); }
      return { confirmed: true, receipt };
    } finally { rpc?.close(); busy = false; }
  };
}
module.exports = { createLocalRuntimeRpc, createFreshnessConfirmation };
