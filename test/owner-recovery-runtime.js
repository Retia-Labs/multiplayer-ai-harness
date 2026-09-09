'use strict';
// Real SDK and production Runtime collector; only OS-backed host key persistence is
// replaced with a retained memory SDK store. No surviving customer endpoint or provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { localControl } = require('../packages/runtime/local-control');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EnrollmentTransport, announcement } = require('../packages/e2ee/enrollment.mjs');
const { EncryptedTaskTransport, EncryptedTaskReader, createEncryptedTask, newId, routing } = require('../packages/e2ee/task-log.mjs');
const { sendTaskControl } = require('../packages/e2ee/task-control.mjs');
const { createOwnerRecoveryKey } = require('../packages/e2ee/owner-recovery-kit.mjs');
const { recoveryDescriptorHash } = require('../packages/e2ee/owner-recovery.mjs');
const { matrixUser, roomFor } = require('../packages/protocol/encrypted-task.mjs');
const { TeamOps } = require('../packages/protocol');
const until = async (read, label, logs = []) => {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out: ' + label + '\n' + logs.slice(-12).join('\n'));
};

test('only the customer kit restores owner membership; the real host requires local activation before new encrypted demo work', { timeout: 180000 }, async t => {
  let phase = 'initial runtime setup';
  try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-owner-runtime-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite') });
  const address = await hub.listen(), url = 'http://127.0.0.1:' + address.port;
  const owner = hub.store.createAccount('Owner'), team = hub.store.createTeam('Customer kit recovery', owner.id);
  const original = await Endpoint.create({ user: matrixUser(owner.id), device: 'ORIGINAL',
    transport: new HubKeyTransport({ url, token: owner.token, device: 'ORIGINAL' }) });
  const genesis = original.identity();
  let enrollment = new EnrollmentTransport({ url, token: owner.token, endpoint: original });
  await enrollment.bootstrap(team.id, announcement(original));
  const logs = []; let hostKeys, runtime, restored, socket, timer, secondRuntime, secondKeys;
  const options = { hubUrl: url.replace('http', 'ws'), dataDir: path.join(dir, 'host'), projects: [workspace],
    encryptedTasksOnly: true, encryptionAuthority: { ...genesis, teamId: team.id },
    approvalAuthority: { ...genesis, teamId: team.id },
    encryptedEndpointFactory: async configuration => {
      hostKeys ||= await Endpoint.create(configuration); hostKeys.transport = configuration.transport;
      return Object.assign(Object.create(hostKeys), { close: async () => {} });
    }, log: line => logs.push(line) };
  t.after(async () => {
    clearInterval(timer); socket?.close(); await runtime?.stop(); await secondRuntime?.stop(); original.close(); restored?.close(); hostKeys?.close(); secondKeys?.close();
    await hub.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  runtime = new Runtime(options); await runtime.start();
  socket = new WebSocket(url.replace('http', 'ws')); let welcomed;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', role: 'client', token: owner.token }));
  socket.onmessage = ({ data }) => { if (JSON.parse(data).type === 'welcome') welcomed = true; };
  await until(() => welcomed && hub.pendingPairings.size, 'pairable host', logs);
  socket.send(JSON.stringify({ type: TeamOps.RUNTIME_PAIR, id: 'pair', teamId: team.id, code: runtime.pairingCode }));
  await until(() => runtime.encryptedHost?.endpoint, 'host keys', logs);
  timer = setInterval(() => enrollment.answerChallenges(team.id).catch(() => {}), 100);
  const projectId = runtime.descriptor().encryptedProjects[0].id, writer = hostKeys.identity();
  await enrollment.ownProject(team.id, projectId);
  await original.confirmEndpoint(writer, { confirmed: true });
  const tasks = new EncryptedTaskTransport({ url, token: owner.token });
  const route = () => ({ version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId, creatorUserId: owner.id });
  const before = route();
  await createEncryptedTask(original, tasks, { task: before, writer,
    payload: { title: 'Before recovery', objective: 'create BEFORE.txt', provider: 'demo' } });
  const reader = new EncryptedTaskReader({ endpoint: original, task: before, writer });
  await until(async () => {
    await original.open(await original.transport.drain()); await reader.reconnect(tasks);
    return reader.state.turn === 'completed';
  }, 'first file', logs);
  assert.ok(fs.existsSync(path.join(workspace, 'BEFORE.txt')));
  phase = 'provision and drill kit';
  const historic = await tasks.page(before.id);
  const { masterKey } = await original.ownerRecoveryIdentity();
  const descriptor = { version: 1, purpose: 'owner-endpoint-recovery-with-host-local-activation', service: url,
    teamId: team.id, owner: original.user, genesis, generation: 1, masterKey };
  const prepared = await enrollment.prepareRecovery(team.id, descriptor);
  const recoveryKey = createOwnerRecoveryKey(), expected = { service: url, teamId: team.id, owner: original.user, genesis };
  const kit = await original.provisionOwnerRecoveryKit({ descriptor, log: prepared.log, expected,
    recoveryKey, historyRooms: [roomFor(before.id)] });
  assert.equal(kit.drill.verified, true); await enrollment.commitRecovery(team.id, prepared);
  const secondOptions = { ...options, dataDir: path.join(dir, 'second-host'),
    encryptedEndpointFactory: async configuration => {
      secondKeys ||= await Endpoint.create(configuration); secondKeys.transport = configuration.transport;
      return Object.assign(Object.create(secondKeys), { close: async () => {} });
    } };
  secondRuntime = new Runtime(secondOptions); await secondRuntime.start();
  await until(() => [...hub.pendingPairings.values()].some(entry => entry.runtimeId === secondRuntime.id), 'second host pairing', logs);
  socket.send(JSON.stringify({ type: TeamOps.RUNTIME_PAIR, id: 'pair-second', teamId: team.id, code: secondRuntime.pairingCode }));
  await until(() => secondRuntime.encryptionState === 'ready', 'second host ready before loss', logs);
  await secondRuntime.stop();
  await runtime.stop(); clearInterval(timer);
  phase = 'queue old intent';
  const queued = route();
  await createEncryptedTask(original, tasks, { task: queued, writer,
    payload: { title: 'Old queued request', objective: 'create MUST_NOT_RUN.txt', provider: 'demo' } });
  const oldCommandId = newId('cmd');
  const oldEnvelope = await original.sealControl(writer.user, writer.device, {
    type: 'plexus.task.control.v1', task: routing(before), commandId: oldCommandId,
    action: 'help.request', payload: { id: 'old-help', question: 'Must not replay', recipient: owner.id }
  });
  original.close(); // No trusted customer machine remains, including the original SDK.
  phase = 'restore clean inactive device and authenticate historical content';
  await assert.rejects(() => Endpoint.stageOwnerRecovery({ ciphertext: kit.ciphertext, recoveryKey: createOwnerRecoveryKey(), expected }), /owner_recovery_material_rejected/);
  restored = await Endpoint.stageOwnerRecovery({ ciphertext: kit.ciphertext, recoveryKey, expected });
  assert.notEqual(restored.identity().ed25519, genesis.ed25519);
  const recoveredReader = new EncryptedTaskReader({ endpoint: restored, task: before, writer });
  for (const record of historic.events) await recoveredReader.accept(record);
  assert.deepEqual(recoveredReader.state.events, reader.state.events);
  const publicLog = (await enrollment.state(team.id)).authorityLog;
  phase = 'publish new device and owner claim';
  const transport = new HubKeyTransport({ url, token: owner.token, device: restored.device });
  await restored.publishOwnerRecovery({ transport, log: publicLog });
  enrollment = new EnrollmentTransport({ url, token: owner.token, endpoint: restored });
  await enrollment.pinAuthority(team.id, genesis);
  const epoch = 'd1'.repeat(16);
  await enrollment.recoverOwner(team.id, { descriptorHash: await recoveryDescriptorHash(descriptor), generation: 1,
    epoch, candidate: restored.identity() });
  const recovered = await enrollment.signedHead(team.id, await enrollment.state(team.id));
  assert.equal(recovered.endpoints.filter(row => row.state === 'verified').length, 1);
  assert.equal(recovered.grants.filter(row => !row.revoked).length, 0);
  runtime = new Runtime(options); await runtime.start();
  phase = 'host local activation';
  timer = setInterval(() => enrollment.answerChallenges(team.id).catch(() => {}), 100);
  secondRuntime = new Runtime(secondOptions); await secondRuntime.start();
  await until(() => secondRuntime.encryptionState === 'membership_owner_recovery_required', 'offline host reconciles recovery', logs);
  await until(() => runtime.encryptionState === 'membership_owner_recovery_required', 'host waits for local consent', logs);
  assert.equal(runtime.encryptedHost.freshness.record(), null);
  const confirmation = await localControl(runtime, 'freshness.prepare', { teamId: team.id, candidate: restored.identity() });
  assert.equal(confirmation.recoveryEpoch, epoch);
  const receipt = await localControl(runtime, 'freshness.commit', { proposalId: confirmation.proposalId });
  assert.equal(receipt.recoveryEpoch, epoch);
  await runtime.stop(); runtime = new Runtime(options); await runtime.start();
  await until(() => runtime.encryptionState === 'ready', 'host completes rotation and fresh challenge', logs);
  assert.equal(runtime.encryptedHost.state.load('recovery:' + team.id).state, 'active');
  assert.equal(secondRuntime.encryptionState, 'membership_owner_recovery_required');
  assert.equal(secondRuntime.encryptedHost.freshness.record(), null, 'another host never inherits local recovery confirmation');
  assert.deepEqual(runtime.encryptionAuthority, options.encryptionAuthority);
  assert.equal(runtime.encryptedExecution.approvalOwner(), null);
  await enrollment.ownProject(team.id, projectId);
  phase = 'regrant and reject old intent';
  await enrollment.confirm(team.id, restored.device, { userId: owner.id, ...announcement({ identity: () => genesis }) });
  await restored.confirmEndpoint(writer, { confirmed: true });
  await transport.deliverToDevice(writer.user, writer.device, oldEnvelope);
  await until(() => logs.some(line => line.includes('task_recovery_epoch_mismatch')), 'old queued command refused', logs);
  assert.equal(fs.existsSync(path.join(workspace, 'MUST_NOT_RUN.txt')), false);
  const after = route();
  phase = 'new encrypted demo work';
  await createEncryptedTask(restored, tasks, { task: after, writer, recoveryEpoch: epoch,
    payload: { title: 'After customer recovery', objective: 'create AFTER.txt', provider: 'demo' } });
  const nextReader = new EncryptedTaskReader({ endpoint: restored, task: after, writer });
  await until(async () => {
    await restored.open(await restored.transport.drain()); await nextReader.reconnect(tasks);
    return nextReader.state.turn === 'completed';
  }, 'new epoch file', logs);
  assert.match(fs.readFileSync(path.join(workspace, 'AFTER.txt'), 'utf8'), /create AFTER.txt/);
  assert.equal(fs.existsSync(path.join(workspace, 'MUST_NOT_RUN.txt')), false);
  assert.equal(runtime.encryptedHost.state.load('execution:' + queued.id), null);
  assert.equal(JSON.stringify(await tasks.page(after.id)).includes('AFTER.txt'), false);
  assert.equal(runtime.encryptedHost.freshness.record().recoveryEpoch, epoch);
  const currentControl = await sendTaskControl(restored, writer, { task: after, action: 'task.outcome',
    payload: { outcome: 'completed' }, recoveryEpoch: epoch });
  await until(() => runtime.encryptedHost.state.load('control:' + after.id + ':' + currentControl.commandId)?.state === 'completed', 'new encrypted control', logs);
  } catch (error) { throw new Error(phase + ': ' + String(error?.message || error), { cause: error }); }
});
