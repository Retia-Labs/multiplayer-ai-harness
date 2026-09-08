'use strict';
// Only the parent desktop process owns this IPC channel. These operations are never
// registered on the hub's HTTP/WebSocket or encrypted teammate command surfaces.
const { Buffer } = require('node:buffer');
const errors = new Set(['freshness_host_unavailable', 'freshness_team_mismatch', 'freshness_candidate_unverified',
  'freshness_candidate_not_owner', 'freshness_candidate_unchanged', 'freshness_confirmation_required',
  'freshness_confirmation_expired', 'freshness_confirmation_changed', 'freshness_host_busy',
  'freshness_state_invalid', 'freshness_commit_failed', 'membership_rollback', 'membership_authority_mismatch',
  'enrollment_unavailable', 'enrollment_signature_invalid', 'membership_freshness_authority_revoked', 'membership_owner_recovery_required']);
const fail = code => { throw Object.assign(new Error(code), { code }); };

async function localControl(runtime, method, params) {
  const host = runtime.encryptedHost;
  const generation = runtime.encryptedGeneration;
  const guard = () => {
    if (runtime.stopped || !runtime.encryptedTasksOnly || !host || host !== runtime.encryptedHost ||
        generation !== runtime.encryptedGeneration || !runtime.teamId || host.freshness?.teamId !== runtime.teamId) fail('freshness_host_unavailable');
    if (runtime.encryptedExecution?.active.size || runtime.encryptedExecution?.pending.size || host.running.size) fail('freshness_host_busy');
  };
  guard();
  if (method === 'freshness.prepare') {
    if (params?.teamId !== runtime.teamId) fail('freshness_team_mismatch');
    const result = await host.prepareFreshnessAuthority(params.candidate);
    guard();
    return result;
  }
  if (method === 'freshness.commit') {
    return host.commitFreshnessAuthority(params?.proposalId, { beforeCommit: guard, afterCommit: () => {
      // Fence old polling synchronously with durable activation, before resolving
      // the host promise lets any queued continuation dispatch or advertise ready.
      runtime.encryptedGeneration++;
      clearTimeout(runtime.encryptedPoll);
      runtime.encryptedPoll = null;
      runtime.setEncryptionState('membership_reconciliation_required');
    } });
  }
  fail('local_runtime_request_failed');
}

function attachLocalControl(runtime, channel = process) {
  if (typeof channel.send !== 'function') return () => {};
  const pending = new Set();
  const send = message => {
    if (channel.connected !== false) { try { channel.send(message, () => {}); } catch {} }
  };
  const receive = async message => {
    if (message?.type !== 'runtime.local.request') return;
    const id = message.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || pending.has(id)) return;
    if (pending.size >= 4) { send({ type: 'runtime.local.response', id, error: 'local_runtime_request_failed' }); return; }
    pending.add(id);
    let response;
    try {
      if (Buffer.byteLength(JSON.stringify(message)) > 65536) fail('local_runtime_request_failed');
      response = { result: await localControl(runtime, message.method, message.params) };
    } catch (error) { response = { error: errors.has(error.code) ? error.code : 'local_runtime_request_failed' }; }
    finally { pending.delete(id); }
    send({ type: 'runtime.local.response', id, ...response });
  };
  channel.on('message', receive);
  return () => channel.off('message', receive);
}
module.exports = { attachLocalControl, localControl };
