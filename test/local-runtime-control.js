'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { localControl, attachLocalControl } = require('../packages/runtime/local-control');
const { createLocalRuntimeRpc } = require('../apps/desktop/local-runtime-rpc');

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const calls = [];
  const runtime = { teamId: 'team-local', encryptedTasksOnly: true, encryptedGeneration: 1,
    encryptedExecution: { active: new Map(), pending: new Set() },
    setEncryptionState: state => calls.push(state) };
  // The host is the authorization boundary tested with real signed logs elsewhere.
  // Here the delayed boundary exposes parent IPC/runtime lifecycle races directly.
  runtime.encryptedHost = { freshness: { teamId: runtime.teamId }, running: new Map(),
    prepareFreshnessAuthority: async () => ({ proposalId: 'local-proposal' }),
    commitFreshnessAuthority: async (_id, { beforeCommit, afterCommit }) => { beforeCommit(); calls.push('persist'); afterCommit(); return { activationId: 'saved' }; } };
  return { runtime, calls };
}

test('local appointment cannot proceed while execution is active or pending', async () => {
  for (const state of ['active', 'pending', 'running']) {
    const { runtime, calls } = fixture();
    const collection = state === 'running' ? runtime.encryptedHost.running : runtime.encryptedExecution[state];
    if (collection instanceof Set) collection.add('task'); else collection.set('task', {});
    await assert.rejects(() => localControl(runtime, 'freshness.commit', { proposalId: 'local-proposal' }), { code: 'freshness_host_busy' });
    assert.deepEqual(calls, []);
  }
});

test('a prepared result from an obsolete host or team cannot reach native confirmation', async () => {
  for (const change of [runtime => { runtime.encryptedGeneration++; },
    runtime => { runtime.encryptedHost = { ...runtime.encryptedHost }; },
    runtime => { runtime.teamId = 'other-team'; }, runtime => { runtime.stopped = true; }]) {
    const { runtime } = fixture(), entered = gate(), release = gate();
    runtime.encryptedHost.prepareFreshnessAuthority = async () => { entered.resolve(); await release.promise; return {}; };
    const preparing = localControl(runtime, 'freshness.prepare', { teamId: runtime.teamId });
    await entered.promise; change(runtime); release.resolve();
    await assert.rejects(preparing, { code: 'freshness_host_unavailable' });
  }
});

test('new work or host replacement during commit validation prevents durable activation', async () => {
  for (const change of [runtime => runtime.encryptedExecution.pending.add('new-task'),
    runtime => { runtime.encryptedGeneration++; }]) {
    const { runtime, calls } = fixture(), entered = gate(), release = gate();
    runtime.encryptedHost.commitFreshnessAuthority = async (_id, { beforeCommit }) => {
      entered.resolve(); await release.promise; beforeCommit(); calls.push('persist');
    };
    const committing = localControl(runtime, 'freshness.commit', { proposalId: 'local-proposal' });
    await entered.promise; change(runtime); release.resolve();
    await assert.rejects(committing, error => ['freshness_host_busy', 'freshness_host_unavailable'].includes(error.code));
    assert.deepEqual(calls, []);
  }
});

test('successful durable activation invalidates old polling before returning its receipt', async () => {
  const { runtime, calls } = fixture();
  runtime.encryptedPoll = setTimeout(() => assert.fail('old timer survived appointment'), 10000);
  const result = await localControl(runtime, 'freshness.commit', { proposalId: 'local-proposal' });
  assert.deepEqual(result, { activationId: 'saved' });
  assert.deepEqual(calls, ['persist', 'membership_reconciliation_required']);
  assert.equal(runtime.encryptedGeneration, 2);
  assert.equal(runtime.encryptedPoll, null);
});

test('parent RPC reaches local control and excludes crypto messages and unbounded errors', async () => {
  const { runtime } = fixture();
  const parent = new EventEmitter(), child = new EventEmitter();
  Object.assign(parent, { connected: true, exitCode: null, signalCode: null,
    send: (message, done) => { queueMicrotask(() => child.emit('message', message)); done?.(); } });
  Object.assign(child, { connected: true,
    send: (message, done) => { queueMicrotask(() => parent.emit('message', message)); done?.(); } });
  const detach = attachLocalControl(runtime, child), rpc = createLocalRuntimeRpc(parent);
  try {
    child.emit('message', { type: 'crypto.request', id: 'not-local', method: 'freshness.commit' });
    const proposal = await rpc.request('freshness.prepare', { teamId: runtime.teamId });
    assert.equal(proposal.proposalId, 'local-proposal');
    await assert.rejects(() => rpc.request('freshness.prepare', { teamId: 'other-team' }), { code: 'freshness_team_mismatch' });
    runtime.encryptedHost.prepareFreshnessAuthority = async () => { throw new Error('PRIVATE SYNTHETIC TOKEN'); };
    await assert.rejects(() => rpc.request('freshness.prepare', { teamId: runtime.teamId }), { code: 'local_runtime_request_failed' });
  } finally { rpc.close(); detach(); }
  assert.equal(child.listenerCount('message'), 0);
});

test('duplicate and oversized parent messages cannot invoke the host twice', async () => {
  const { runtime } = fixture(), channel = new EventEmitter(), entered = gate(), release = gate();
  let invocations = 0; const responses = [];
  channel.send = message => responses.push(message);
  runtime.encryptedHost.prepareFreshnessAuthority = async () => { invocations++; entered.resolve(); await release.promise; return {}; };
  const detach = attachLocalControl(runtime, channel);
  try {
    const message = { type: 'runtime.local.request', id: 'same', method: 'freshness.prepare', params: { teamId: runtime.teamId } };
    channel.emit('message', message); await entered.promise;
    channel.emit('message', message);
    channel.emit('message', { ...message, id: 'large', padding: 'x'.repeat(65536) });
    assert.equal(invocations, 1);
    release.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(responses.filter(response => response.id === 'same').length, 1);
    assert.equal(responses.find(response => response.id === 'large').error, 'local_runtime_request_failed');
  } finally { release.resolve(); detach(); }
});

test('a poll queued as durable activation finishes cannot dispatch under the old runtime generation', async () => {
  const { runtime, calls } = fixture(), ready = gate();
  const generation = runtime.encryptedGeneration;
  let starts = 0;
  // This is the poller's final generation gate before execution.startTask. Its
  // continuation can already be queued when the async host commit returns.
  const polling = (async () => {
    await ready.promise;
    if (runtime.encryptedGeneration === generation) starts++;
  })();
  runtime.encryptedHost.commitFreshnessAuthority = async (_id, { beforeCommit, afterCommit }) => {
    beforeCommit(); calls.push('persist');
    ready.resolve();
    afterCommit?.();
    return { activationId: 'saved' };
  };
  try {
    const result = await localControl(runtime, 'freshness.commit', { proposalId: 'local-proposal' });
    await polling;
    assert.deepEqual(result, { activationId: 'saved' });
    assert.equal(starts, 0, 'polling must be fenced before the committed host promise resolves');
    assert.equal(runtime.encryptedGeneration, generation + 1);
    assert.deepEqual(calls, ['persist', 'membership_reconciliation_required']);
  } finally { ready.resolve(); await polling; }
});
