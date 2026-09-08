'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createLocalRuntimeRpc, createFreshnessConfirmation } = require('../apps/desktop/local-runtime-rpc');

class Child extends EventEmitter {
  constructor(handle = () => {}) {
    super(); this.connected = true; this.exitCode = null; this.signalCode = null; this.sent = []; this.handle = handle;
  }
  send(message, callback) { this.sent.push(message); queueMicrotask(() => this.handle(message, this)); callback?.(); }
  answer(request, result) { this.emit('message', { type: 'runtime.local.response', id: request.id, result }); }
}
test('local RPC correlates responses and ignores the separate crypto channel', async t => {
  const child = new Child(), rpc = createLocalRuntimeRpc(child);
  t.after(() => rpc.close());
  const first = rpc.request('freshness.prepare', { teamId: 'one' });
  const second = rpc.request('freshness.commit', { proposalId: 'two' });
  assert.equal(child.sent[0].type, 'runtime.local.request');
  assert.notEqual(child.sent[0].id, child.sent[1].id);
  child.emit('message', { type: 'plexus.crypto.response', id: child.sent[0].id, result: 'must be ignored' });
  child.answer(child.sent[1], { activationId: 'second' });
  child.answer(child.sent[0], { proposalId: 'first' });
  assert.deepEqual(await first, { proposalId: 'first' });
  assert.deepEqual(await second, { activationId: 'second' });
});
test('local RPC rejects unsupported methods and oversized requests before sending', async t => {
  const child = new Child(), rpc = createLocalRuntimeRpc(child, { maxBytes: 256 }); t.after(() => rpc.close());
  await assert.rejects(rpc.request('shell', {}), { code: 'local_runtime_method_unsupported' });
  await assert.rejects(rpc.request('freshness.prepare', { text: 'x'.repeat(300) }), { code: 'local_runtime_message_too_large' });
  assert.equal(child.sent.length, 0);
});
test('local RPC bounds responses and exposes only fixed error codes', async t => {
  for (const [response, code] of [[{ result: 'x'.repeat(300) }, 'local_runtime_message_too_large'],
    [{ error: 'membership_rollback' }, 'membership_rollback'],
    [{ error: 'SECRET child stderr or arbitrary provider details' }, 'local_runtime_request_failed'],
    [{ error: 'freshness_commit_failed', result: {} }, 'local_runtime_invalid_message']]) {
    const child = new Child(), rpc = createLocalRuntimeRpc(child, { maxBytes: 256 }); t.after(() => rpc.close());
    const pending = rpc.request('freshness.prepare', {});
    child.emit('message', { type: 'runtime.local.response', id: child.sent[0].id, ...response });
    await assert.rejects(pending, { message: code });
  }
});
test('timeouts, disconnects and send failures settle pending work without reflecting errors', async t => {
  const silent = new Child(), timeout = createLocalRuntimeRpc(silent, { timeoutMs: 10 }); t.after(() => timeout.close());
  await assert.rejects(timeout.request('freshness.prepare', {}), { code: 'local_runtime_timeout' });
  silent.answer(silent.sent[0], { late: true });
  for (const event of ['exit', 'disconnect', 'error']) {
    const child = new Child(), rpc = createLocalRuntimeRpc(child); t.after(() => rpc.close());
    const pending = rpc.request('freshness.prepare', {});
    child.emit(event, new Error('SECRET failure detail'));
    await assert.rejects(pending, { code: 'local_runtime_unavailable' });
    assert.equal(child.listenerCount('message'), 0);
  }
  const broken = new Child(); broken.send = (_, callback) => callback(new Error('SECRET send detail'));
  const rpc = createLocalRuntimeRpc(broken); t.after(() => rpc.close());
  await assert.rejects(rpc.request('freshness.prepare', {}), { code: 'local_runtime_send_failed' });
});
test('the channel works through an actual local Node child IPC pipe', async t => {
  const child = spawn(process.execPath, ['-e', `process.on('message', message => {
    process.send({type:'plexus-crypto.response',id:message.id,result:'not the response'});
    process.send({type:'runtime.local.response',id:message.id,result:{method:message.method}});
  });`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const rpc = createLocalRuntimeRpc(child);
  t.after(async () => { rpc.close(); const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; });
  assert.deepEqual(await rpc.request('freshness.prepare', {}), { method: 'freshness.prepare' });
});

const candidate = { user: '@owner:fixture', device: 'NEW', curve25519: 'c'.repeat(43), ed25519: 'e'.repeat(43) };
const previousSigner = { ...candidate, device: 'OLD', curve25519: 'a'.repeat(43), ed25519: 'b'.repeat(43) };
function ceremony(options = {}) {
  const clock = { now: 1000 }, checkpoint = { seq: 5, hash: 'f'.repeat(64) };
  const proposal = { proposalId: 'proposal-one', teamId: 'team-one', runtimeId: 'runtime-one', candidate, previousSigner,
    checkpoint, priorCheckpoint: { seq: 3, hash: 'd'.repeat(64) }, expiresAt: 121000,
    accessSummary: { verifiedEndpoints: 3, projectGrants: 2 } };
  const receipt = { activationId: 'activation-one', runtimeId: proposal.runtimeId, teamId: proposal.teamId, signer: candidate, checkpoint };
  let current; const prompts = [], restarts = [];
  const child = new Child((message, child) => {
    if (options.handle?.(message, child, proposal, receipt)) return;
    child.answer(message, message.method === 'freshness.prepare' ? proposal : receipt);
  });
  current = { child, runtimeId: proposal.runtimeId };
  const run = createFreshnessConfirmation({ getRuntime: () => current, now: () => clock.now, timeoutMs: options.timeoutMs,
    confirm: async dialog => { prompts.push(dialog); return options.confirm ? options.confirm(dialog) : true; },
    restart: async captured => { assert.equal(captured.child, child); restarts.push(captured); } });
  return { run, child, proposal, receipt, prompts, restarts, clock, replace: value => { current = value; } };
}
test('native confirmation displays the reviewed scope and commits only its proposal on the same runtime', async () => {
  const f = ceremony();
  assert.deepEqual(await f.run({ teamId: 'team-one', identity: candidate }), { confirmed: true, receipt: f.receipt });
  assert.equal(f.prompts.length, 1); assert.equal(f.restarts.length, 1);
  for (const text of ['team-one', 'runtime-one', candidate.user, candidate.device, candidate.ed25519,
    f.proposal.checkpoint.hash, f.proposal.priorCheckpoint.hash, '3 verified endpoints', '2 project grants',
    'withheld', 'approval', 'provider']) assert.ok(f.prompts[0].detail.includes(text), text);
  assert.deepEqual(f.child.sent.map(({ method, params }) => ({ method, params })), [
    { method: 'freshness.prepare', params: { teamId: 'team-one', candidate } },
    { method: 'freshness.commit', params: { proposalId: 'proposal-one' } }
  ]);
  assert.equal(f.child.listenerCount('message'), 0);
});
test('cancellation never commits, restarts or sends an authority configuration change', async () => {
  const f = ceremony({ confirm: () => false });
  assert.deepEqual(await f.run({ teamId: 'team-one', identity: candidate }), { confirmed: false });
  assert.deepEqual(f.child.sent.map(message => message.method), ['freshness.prepare']);
  assert.equal(f.restarts.length, 0);
});
test('a runtime restart or identity change during native confirmation invalidates the proposal', async () => {
  for (const replacement of ['child', 'runtimeId']) {
    const f = ceremony({ confirm: () => {
      f.replace({ child: replacement === 'child' ? new Child() : f.child,
        runtimeId: replacement === 'runtimeId' ? 'changed-runtime' : 'runtime-one' });
      return true;
    } });
    await assert.rejects(f.run({ teamId: 'team-one', identity: candidate }), { code: 'freshness_host_unavailable' });
    assert.deepEqual(f.child.sent.map(message => message.method), ['freshness.prepare']);
    assert.equal(f.restarts.length, 0);
  }
});
test('concurrent confirmations are refused and a cancelled dialog releases the local guard', async () => {
  let finish, opened;
  const shown = new Promise(resolve => { opened = resolve; });
  const f = ceremony({ confirm: () => { opened(); return new Promise(resolve => { finish = resolve; }); } });
  const first = f.run({ teamId: 'team-one', identity: candidate }); await shown;
  await assert.rejects(f.run({ teamId: 'team-one', identity: candidate }), { code: 'freshness_host_busy' });
  finish(false); assert.deepEqual(await first, { confirmed: false });
  const next = f.run({ teamId: 'team-one', identity: candidate });
  await new Promise(resolve => setImmediate(resolve)); finish(false);
  assert.deepEqual(await next, { confirmed: false });
});
test('an expired proposal is refused before commit even if its native dialog was accepted', async () => {
  const f = ceremony({ confirm: () => { f.clock.now = f.proposal.expiresAt; return true; } });
  await assert.rejects(f.run({ teamId: 'team-one', identity: candidate }), { code: 'freshness_confirmation_expired' });
  assert.deepEqual(f.child.sent.map(message => message.method), ['freshness.prepare']);
  assert.equal(f.restarts.length, 0);
});
test('changed candidate, team, host or checkpoint cannot be presented as the requested confirmation', async () => {
  for (const change of [proposal => { proposal.candidate = { ...candidate, device: 'WRONG' }; },
    proposal => { proposal.teamId = 'wrong-team'; }, proposal => { proposal.runtimeId = 'wrong-runtime'; },
    proposal => { proposal.checkpoint = { seq: 2, hash: 'd'.repeat(64) }; },
    proposal => { proposal.accessSummary.projectGrants = -1; }]) {
    const f = ceremony({ handle: (request, child, proposal) => {
      change(proposal); child.answer(request, proposal); return true;
    } });
    await assert.rejects(f.run({ teamId: 'team-one', identity: candidate }), { code: 'freshness_state_invalid' });
    assert.equal(f.prompts.length, 0); assert.equal(f.restarts.length, 0);
  }
});
test('commit errors and mismatched receipts cannot report a successful activation or restart', async () => {
  for (const mode of ['error', 'changed-receipt']) {
    const f = ceremony({ handle: (request, child, proposal, receipt) => {
      if (request.method !== 'freshness.commit') return false;
      if (mode === 'error') child.emit('message', { type: 'runtime.local.response', id: request.id, error: 'freshness_confirmation_changed' });
      else child.answer(request, { ...receipt, signer: previousSigner });
      return true;
    } });
    await assert.rejects(f.run({ teamId: 'team-one', identity: candidate }), {
      code: mode === 'error' ? 'freshness_confirmation_changed' : 'freshness_state_invalid' });
    assert.equal(f.restarts.length, 0);
  }
});
test('a timed-out local proposal does not open a dialog or attempt a commit', async () => {
  const f = ceremony({ handle: () => true, timeoutMs: 10 });
  await assert.rejects(f.run({ teamId: 'team-one', identity: candidate }), { code: 'local_runtime_timeout' });
  assert.equal(f.prompts.length, 0); assert.equal(f.restarts.length, 0);
});
