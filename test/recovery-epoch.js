'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FreshnessAuthority } = require('../packages/runtime/freshness-authority');
const { EncryptedTaskState } = require('../packages/runtime/encrypted-task');
const { sendTaskControl, readTaskControl, sendTaskReceipt, readTaskReceipt } = require('../packages/e2ee/task-control.mjs');
const { EncryptedHost } = require('../packages/runtime/encrypted-host');
const epoch = 'ab'.repeat(16);
const owner = { user: '@owner:plexus.local', device: 'NEW', curve25519: 'c'.repeat(43), ed25519: 'd'.repeat(43) };
const head = { teamId: 'team', seq: 7, hash: 'a'.repeat(64), recoveryEpoch: epoch,
  endpoints: [{ ...owner, state: 'verified', userId: 'owner' }], grants: [], revocations: [] };
const task = { version: 1, id: 'et_' + 'a'.repeat(32), teamId: 'team', projectId: 'ep_' + 'b'.repeat(32), runtimeId: 'runtime', creatorUserId: 'owner' };

test('local recovery confirmation binds the epoch and leaves rotation pending across storage reopen', t => {
  const state = new EncryptedTaskState(':memory:'); t.after(() => state.close());
  const authority = new FreshnessAuthority({ state, teamId: 'team', runtimeId: 'runtime', genesis: owner });
  assert.equal(authority.requiresRecovery(head), true);
  const proposal = authority.prepare(owner, head, 1);
  assert.equal(proposal.recoveryEpoch, epoch);
  const result = authority.commit(proposal.proposalId, head, 1);
  assert.equal(result.recoveryEpoch, epoch);
  assert.equal(authority.requiresRecovery(head), false);
  assert.equal(state.load('recovery:team').state, 'rotation-pending');
  assert.equal(new FreshnessAuthority({ state, teamId: 'team', runtimeId: 'runtime', genesis: owner }).record().recoveryEpoch, epoch);
  const altered = { ...authority.record(), recoveryEpoch: 'invalid' };
  state.save('freshness:team', altered);
  assert.throws(() => authority.record(), { code: 'freshness_state_invalid' });
});

test('the host stops execution on an unactivated epoch even if persisting its checkpoint fails', async t => {
  const state = new EncryptedTaskState(':memory:'); t.after(() => state.close());
  let closed = 0;
  const runtime = { teamId: 'team', id: 'runtime', encryptedExecution: { close: async () => { closed++; } } };
  const host = new EncryptedHost({ runtime, authority: owner });
  host.state = state; host.freshness = new FreshnessAuthority({ state, teamId: 'team', runtimeId: 'runtime', genesis: owner });
  host.readMembership = async () => ({ current: head, received: { authorityLog: [] } });
  const save = state.save.bind(state);
  state.save = () => { throw new Error('disk full'); };
  await assert.rejects(() => host.reconcileMembership(), /disk full/);
  assert.equal(closed, 1); assert.equal(host.reconciled, false);
  state.save = save;
  await assert.rejects(() => host.reconcileMembership(), { code: 'membership_owner_recovery_required' });
  assert.equal(state.load('authorization:team').seq, 7);
  assert.equal(host.freshness.record(), null, 'public recovery never fabricates local consent');
});

test('queued commands and receipts retain their issuance epoch instead of inheriting a later grant', async () => {
  let envelope;
  const endpoint = { sealControl: async (user, device, content) => {
    envelope = { type: 'plexus.control.v1', decrypted: true, verified: true, sender: owner.user,
      senderDevice: owner.device, senderKey: owner.curve25519, content }; return envelope;
  }, transport: { deliverToDevice: async () => {} } };
  await sendTaskControl(endpoint, owner, { task, action: 'task.history', payload: {}, recoveryEpoch: epoch });
  const read = readTaskControl(envelope, task);
  assert.equal(read.recoveryEpoch, epoch);
  assert.equal(envelope.content.type, 'plexus.task.control.v2');
  await sendTaskReceipt(endpoint, owner, { task, commandId: read.commandId, state: 'delivered', recoveryEpoch: epoch });
  assert.equal(readTaskReceipt(envelope, task, owner, { recoveryEpoch: epoch }).recoveryEpoch, epoch);
  assert.throws(() => readTaskReceipt(envelope, task, owner, { recoveryEpoch: 'cd'.repeat(16) }), { code: 'task_recovery_epoch_mismatch' });
  await sendTaskControl(endpoint, owner, { task, action: 'task.history', payload: {} });
  assert.equal(readTaskControl(envelope, task).recoveryEpoch, null);
  await assert.rejects(() => sendTaskControl(endpoint, owner, { task, action: 'task.history', payload: {}, recoveryEpoch: 'bad' }), { code: 'invalid_recovery_epoch' });
});

test('rotation covers locally known omitted rooms and a failed rotation cannot clear the durable barrier', async t => {
  const state = new EncryptedTaskState(':memory:'); t.after(() => state.close());
  const host = new EncryptedHost({ runtime: { teamId: 'team', id: 'runtime' }, authority: owner });
  host.state = state; host.freshness = new FreshnessAuthority({ state, teamId: 'team', runtimeId: 'runtime', genesis: owner });
  const proposal = host.freshness.prepare(owner, head, 0); host.freshness.commit(proposal.proposalId, head, 0);
  state.save(task.id, { checkpoint: { seq: 8, hash: 'b'.repeat(64) } });
  state.save('execution:' + task.id, { state: 'running', providerState: { codexAppServerThreadId: 'old-private-handle' },
    grants: { someone: {} }, openApprovals: { approval: { requestId: 'approval' } } });
  let fail = true; const rotations = [];
  host.endpoint = { identity: () => owner, shareVerifiedTaskKey: async (room, members, options) => {
    rotations.push({ room, members, options }); if (fail) throw new Error('storage unavailable');
  } };
  await assert.rejects(() => host.finishOwnerRecovery(head), /storage unavailable/);
  assert.equal(state.load('recovery:team').state, 'rotation-pending');
  fail = false; await host.finishOwnerRecovery(head);
  assert.equal(state.load('recovery:team').state, 'active');
  assert.equal(rotations.length, 2);
  assert.ok(rotations[1].room.includes(task.id)); assert.deepEqual(rotations[1].members, [owner]);
  assert.equal(rotations[1].options.rotate, true);
  assert.deepEqual(state.load(task.id).checkpoint, { seq: 8, hash: 'b'.repeat(64) });
  const execution = state.load('execution:' + task.id);
  assert.equal(execution.state, 'recovery-required'); assert.deepEqual(execution.providerState, {});
  assert.deepEqual(execution.grants, {}); assert.deepEqual(execution.openApprovals, {});
  assert.equal(execution.abandonedApprovals.approval.requestId, 'approval');
});

test('reconfirmation does not restore old approval consent or auto-start an old queued task', async () => {
  const { EncryptedExecution } = require('../packages/runtime/encrypted-execution');
  const runtime = { teamId: 'team', approvalAuthority: owner };
  const execution = new EncryptedExecution({ runtime, host: { membership: head } });
  assert.equal(execution.approvalOwner(), null);
  runtime.approvalAuthority = { ...owner, recoveryEpoch: epoch };
  assert.deepEqual(execution.approvalOwner(), owner);
  await assert.rejects(() => execution.startTask(task, { reader: { state: {} }, creationEpoch: null }), { code: 'task_recovery_epoch_mismatch' });
});

test('recovery shutdown interrupts every live turn even when one provider cleanup reports failure', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { Runtime } = require('../packages/runtime');
  const { EncryptedExecution } = require('../packages/runtime/encrypted-execution');
  const { newId } = require('../packages/e2ee/task-log.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-recovery-close-'));
  const runtime = new Runtime({ dataDir: path.join(dir, 'runtime'), projects: [dir], encryptedTasksOnly: true });
  runtime.teamId = 'team';
  const state = new EncryptedTaskState(path.join(dir, 'host.sqlite'));
  const projectId = newId('ep'), host = { state, projects: new Map([[projectId, dir]]), membership: { endpoints: [] } };
  const execution = new EncryptedExecution({ runtime, host }), sessions = [], tasks = [];
  let release; const gate = new Promise(resolve => { release = resolve; });
  t.after(async () => {
    release(); for (const session of sessions) session.abort.abort();
    await execution.close().catch(() => {}); await runtime.stop(); state.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  runtime.provider = () => ({ id: 'cleanup-fault-fixture', run: async session => {
    sessions.push(session);
    // Inject a provider cleanup fault after genuine interruption. This is not a
    // SQLite reproduction: closed execution intentionally suppresses later writes.
    if (sessions.length === 1) {
      const interrupt = session.interrupt.bind(session);
      session.interrupt = () => { interrupt(); throw new Error('synthetic_provider_cleanup_failure'); };
    }
    await gate;
    await session.writeFile(session.thread.id + '.txt', 'must remain cancelled');
  } });
  for (let index = 0; index < 2; index++) {
    const task = { id: newId('et'), projectId, creatorUserId: 'owner', runtimeId: runtime.id, teamId: 'team' };
    const opened = { creationEpoch: null, reader: { seq: 1, state: { messages: [], approvals: [], decisions: [], diffs: [] } },
      objective: { objective: 'Check shutdown', provider: 'cleanup-fault-fixture' }, writer: { append: async () => {} } };
    tasks.push(task); await execution.startTask(task, opened);
  }
  for (let tries = 0; sessions.length < 2 && tries < 200; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sessions.length, 2);
  const closing = execution.close();
  const refused = assert.rejects(() => closing, /synthetic_provider_cleanup_failure/);
  const cancelled = sessions.map(session => session.cancelled);
  release(); await refused;
  assert.deepEqual(cancelled, [true, true], 'both turns must be cancelled before cleanup is awaited');
  assert.deepEqual(tasks.map(task => fs.existsSync(path.join(dir, task.id + '.txt'))), [false, false]);
});

test('recovery rotation waits for an in-flight SDK share and fences a queued old admission', { timeout: 10000 }, async t => {
  const { Endpoint } = require('../packages/e2ee/endpoint');
  const { KeyDirectory, KeyTransport } = require('../packages/e2ee/key-transport');
  const { roomFor } = require('../packages/protocol/encrypted-task.mjs');
  const directory = new KeyDirectory();
  let pause = false, enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  class DelayedTransport extends KeyTransport {
    async send(type, request) {
      if (pause && type === 'KeysClaim') { pause = false; enter(); await gate; }
      return super.send(type, request);
    }
  }
  const transport = new DelayedTransport(directory);
  const hostEndpoint = await Endpoint.create({ user: '@runtime:plexus.local', device: 'HOST', transport });
  const old = await Endpoint.create({ user: '@owner:plexus.local', device: 'ORIGINAL', transport: new KeyTransport(directory) });
  const replacement = await Endpoint.create({ user: '@owner:plexus.local', device: 'RECOVERED', transport: new KeyTransport(directory) });
  const state = new EncryptedTaskState(':memory:');
  t.after(async () => { release(); await host.keyShareQueue; hostEndpoint.close(); old.close(); replacement.close(); state.close(); });
  const host = new EncryptedHost({ runtime: { teamId: 'team', id: 'runtime' }, authority: old.identity() });
  host.state = state; host.endpoint = hostEndpoint;
  host.freshness = new FreshnessAuthority({ state, teamId: 'team', runtimeId: 'runtime', genesis: old.identity() });
  host.membership = { ...head, recoveryEpoch: null, endpoints: [{ ...old.identity(), state: 'verified', userId: 'owner' }],
    grants: [{ projectId: task.projectId, userId: 'owner', revoked: false }] };
  host.reconciled = true;
  state.save(task.id, { checkpoint: { seq: 1, hash: 'c'.repeat(64) } });
  await hostEndpoint.confirmEndpoint(old.identity(), { confirmed: true });
  await old.confirmEndpoint(hostEndpoint.identity(), { confirmed: true });
  pause = true;
  const inFlight = host.shareTaskKeys(task, roomFor(task.id), [hostEndpoint.identity(), old.identity()], { rotate: false });
  await entered;
  const stale = host.shareTaskKeys(task, roomFor(task.id), [hostEndpoint.identity(), old.identity()], { rotate: false });
  const staleRefusal = assert.rejects(() => stale, { code: 'membership_reconciliation_required' });
  host.disconnect();
  const recovered = { ...head, endpoints: [{ ...old.identity(), state: 'pending', userId: 'owner' },
    { ...replacement.identity(), state: 'verified', userId: 'owner' }], grants: [] };
  host.membership = recovered;
  const proposal = host.freshness.prepare(replacement.identity(), recovered, host.reconcileGeneration);
  host.freshness.commit(proposal.proposalId, recovered, host.reconcileGeneration);
  const rotation = host.finishOwnerRecovery(recovered);
  assert.equal(state.load('recovery:team').state, 'rotation-pending');
  release(); await inFlight; await staleRefusal; await rotation;
  await old.open(directory.drain(old.user, old.device));
  host.membership = { ...recovered, grants: [{ projectId: task.projectId, userId: 'owner', revoked: false }] };
  host.reconciled = true;
  await hostEndpoint.confirmEndpoint(replacement.identity(), { confirmed: true });
  await replacement.confirmEndpoint(hostEndpoint.identity(), { confirmed: true });
  await host.shareTaskKeys(task, roomFor(task.id), [hostEndpoint.identity(), replacement.identity()], { rotate: false });
  await replacement.open(directory.drain(replacement.user, replacement.device));
  const ciphertext = await hostEndpoint.encryptTask(roomFor(task.id), 'm.room.message', { body: 'new authorization epoch' });
  assert.equal((await replacement.decryptTask(roomFor(task.id), ciphertext)).content.body, 'new authorization epoch');
  await assert.rejects(() => old.decryptTask(roomFor(task.id), ciphertext), 'the consumed old share cannot decrypt the session created by recovery rotation');
  assert.equal(state.load('recovery:team').state, 'active');
});
