'use strict';
// Actual Hub, Matrix endpoint and EncryptedHost control seams. No provider calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../packages/hub/server');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EnrollmentTransport, announcement, acceptProjectAccess } = require('../packages/e2ee/enrollment.mjs');
const { EncryptedTaskTransport, EncryptedTaskReader, createEncryptedTask, newId } = require('../packages/e2ee/task-log.mjs');
const { sendTaskControl, readTaskHistory, HISTORY_TYPE } = require('../packages/e2ee/task-control.mjs');
const { EncryptedHost } = require('../packages/runtime/encrypted-host');
const { matrixUser, roomFor } = require('../packages/protocol/encrypted-task.mjs');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-task-history-'));
  const hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite'), log() {} });
  const endpoints = [];
  let host;
  t.after(async () => { await host?.close(); for (const endpoint of endpoints) endpoint.close(); await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const address = await hub.listen(), url = 'http://127.0.0.1:' + address.port;
  const owner = hub.store.createAccount('owner'), bob = hub.store.createAccount('bob');
  const team = hub.store.createTeam('Fresh history handoff', owner.id);
  const invitation = hub.store.createInvitation(team.id, owner.id, bob.id);
  hub.store.redeemInvitation(invitation.code, bob.id);
  const client = async (account, device) => {
    const endpoint = await Endpoint.create({ user: matrixUser(account.id), device,
      transport: new HubKeyTransport({ url, token: account.token, device }) });
    endpoints.push(endpoint);
    return { endpoint, enrollment: new EnrollmentTransport({ url, token: account.token, endpoint }) };
  };
  const original = await client(owner, 'ORIGINAL'), participant = await client(bob, 'BOB');
  await original.enrollment.bootstrap(team.id, announcement(original.endpoint));
  await participant.enrollment.pinAuthority(team.id, original.endpoint.identity());
  await participant.enrollment.announce(team.id, announcement(participant.endpoint));
  await original.enrollment.confirm(team.id, 'ORIGINAL', { userId: bob.id, ...announcement(participant.endpoint) });
  const project = path.join(dir, 'project'); fs.mkdirSync(project);
  const projectId = newId('ep'), foreignProject = newId('ep');
  for (const id of [projectId, foreignProject]) await original.enrollment.ownProject(team.id, id);
  await original.enrollment.grant(team.id, projectId, bob.id);
  const runtime = { id: 'rt_history', teamId: team.id, runtimeToken: 'synthetic-history-host-token',
    encryptedTasksOnly: true, projects: new Map([[project, {}]]) };
  hub.store.pairRuntime(runtime.id, team.id, owner.id, runtime.runtimeToken);
  hub.store.upsertRuntime(team.id, { id: runtime.id, taskProtocol: 'encrypted-v1' });
  let providerControls = 0;
  host = new EncryptedHost({ runtime, url, statePath: path.join(dir, 'host.sqlite'),
    projects: new Map([[projectId, project], [foreignProject, project]]), authority: original.endpoint.identity(),
    endpointFactory: Endpoint.create.bind(Endpoint),
    onControl: async () => { providerControls++; throw new Error('history_must_not_dispatch_provider'); } });
  const writer = await host.start();
  for (const member of [original, participant]) await member.endpoint.confirmEndpoint(writer, { confirmed: true });
  await host.beginReconcile(); await original.enrollment.answerChallenges(team.id); await host.reconcileMembership();
  const tasks = new EncryptedTaskTransport({ url, token: owner.token });
  const makeTask = async id => {
    const route = { version: 1, id: newId('et'), projectId: id, runtimeId: runtime.id, teamId: team.id, creatorUserId: owner.id };
    await createEncryptedTask(original.endpoint, tasks, { task: route, writer,
      payload: { title: 'History retry', objective: 'This history preceded the participant key share' } });
    const task = (await tasks.list(team.id)).tasks.find(task => task.id === route.id);
    await host.run(task, { runTurn: async emit => emit({ method: 'turn/completed', status: 'completed' }) });
    return task;
  };
  const task = await makeTask(projectId);
  const receive = async (member = participant) => member.endpoint.open(await member.endpoint.transport.drain());
  const historyEvents = events => events.filter(event => event.content?.type === HISTORY_TYPE);
  const request = (value = {}, member = participant) => sendTaskControl(member.endpoint, writer, {
    task, action: 'task.history', payload: {}, ...value
  });
  return { hub, url, dir, owner, bob, team, original, participant, client, host, writer, task, tasks, makeTask,
    foreignProject, receive, historyEvents, request, providerControls: () => providerControls };
}

test('a fresh authenticated history request recovers a consumed handoff without a provider call or fake task event', async t => {
  const f = await fixture(t);
  await f.host.admitParticipants(f.task);
  const first = await f.participant.endpoint.transport.drain();
  assert.equal(f.historyEvents(await f.participant.endpoint.open(first)).length, 1);
  // Simulate a crash after Olm consumed the first handoff but before the app persisted
  // or imported it. Reopening the exact ciphertext cannot recover that lost payload.
  assert.equal(f.historyEvents(await f.participant.endpoint.open(first)).length, 0);
  const reader = new EncryptedTaskReader({ endpoint: f.participant.endpoint, task: f.task, writer: f.writer });
  await assert.rejects(() => reader.reconnect(f.tasks), /task_integrity_failed/);
  const before = await f.tasks.page(f.task.id);
  const command = await f.request();
  const result = await f.host.collect();
  assert.deepEqual(result.refused, []);
  assert.equal(result.applied[0].state, 'accepted', 'mailbox submission is not recipient-processed delivery');
  const events = await f.receive(), [handoff] = f.historyEvents(events);
  const transfer = readTaskHistory(handoff, f.task);
  assert.ok(transfer);
  const imported = await acceptProjectAccess(f.participant.endpoint, transfer, { writer: f.writer });
  assert.deepEqual(imported.rooms, [roomFor(f.task.id)]);
  const restored = new EncryptedTaskReader({ endpoint: f.participant.endpoint, task: f.task,
    writer: f.writer, admittedSessions: imported.sessions });
  assert.equal((await restored.reconnect(f.tasks)).objective, 'This history preceded the participant key share');
  assert.equal(f.providerControls(), 0);
  assert.deepEqual((await f.tasks.page(f.task.id)).events, before.events);

  await f.request({ commandId: command.commandId });
  assert.equal((await f.host.collect()).applied[0].duplicate, true);
  assert.equal(f.historyEvents(await f.receive()).length, 0, 'same command identity does not promise a new handoff');
  await f.request(); await f.host.collect();
  assert.equal(f.historyEvents(await f.receive()).length, 1, 'a new request produces fresh safe ciphertext');
});

test('history requests cannot name another recipient, change task identity, or cross project grants', async t => {
  const f = await fixture(t), foreign = await f.makeTask(f.foreignProject);
  const before = await f.tasks.page(f.task.id);
  for (const [request, code] of [
    [{ payload: { recipient: { userId: f.owner.id, device: 'ORIGINAL' } } }, 'invalid_task_control'],
    [{ task: { ...f.task, creatorUserId: f.bob.id } }, 'unknown_task_control_target'],
    [{ task: foreign }, 'sender_not_in_project']
  ]) {
    await f.request(request);
    const result = await f.host.collect();
    assert.equal(result.applied.length, 0); assert.equal(result.refused[0].code, code);
    assert.equal(f.historyEvents(await f.receive()).length, 0);
  }
  assert.equal(f.providerControls(), 0);
  assert.deepEqual((await f.tasks.page(f.task.id)).events, before.events);
});

test('a removed device and an unverified device of the same account receive no replacement history', async t => {
  const f = await fixture(t);
  const pending = await f.client(f.bob, 'UNVERIFIED');
  await pending.enrollment.announce(f.team.id, announcement(pending.endpoint));
  await pending.endpoint.confirmEndpoint(f.writer, { confirmed: true });
  await f.request({}, pending);
  let result = await f.host.collect();
  assert.equal(result.applied.length, 0); assert.equal(result.refused[0].code, 'task_control_unauthenticated');
  assert.equal(f.historyEvents(await f.receive(pending)).length, 0);

  await f.original.enrollment.revokeEndpoint(f.team.id, { userId: f.bob.id, device: 'BOB' });
  await f.host.applyRevocations();
  await f.request(); result = await f.host.collect();
  assert.equal(result.applied.length, 0); assert.equal(result.refused[0].code, 'endpoint_revoked');
  assert.equal(f.historyEvents(await f.receive()).length, 0);
  assert.equal(f.providerControls(), 0);
});

test('removal applied while history export awaits prevents the fresh handoff from being published', async t => {
  const f = await fixture(t);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const exportHistory = f.host.endpoint.exportHistory.bind(f.host.endpoint);
  t.mock.method(f.host.endpoint, 'exportHistory', async (...args) => {
    const exported = await exportHistory(...args);
    enter(); await gate; return exported;
  });
  try {
    await f.request(); const collecting = f.host.collect();
    await entered;
    await f.original.enrollment.revokeEndpoint(f.team.id, { userId: f.bob.id, device: 'BOB' });
    await f.host.applyRevocations();
    release();
    const result = await collecting;
    assert.equal(result.applied.length, 0); assert.equal(result.refused[0].code, 'endpoint_revoked');
    assert.equal(f.historyEvents(await f.receive()).length, 0);
  } finally { release(); t.mock.restoreAll(); }
});

test('fresh history retains exact writer authentication and explicit imported-session admission', async t => {
  const f = await fixture(t);
  const transfer = async () => {
    await f.request(); await f.host.collect();
    return readTaskHistory(f.historyEvents(await f.receive())[0], f.task);
  };
  const transferForWrongWriter = await transfer();
  await assert.rejects(() => acceptProjectAccess(f.participant.endpoint, transferForWrongWriter, {
    writer: f.original.endpoint.identity()
  }), /project_history_not_from_writer/);
  const raw = await transfer();
  const key = await f.participant.endpoint.openControl([raw.history.envelope]);
  await f.participant.endpoint.importHistory(raw.history.blob, key.content.transferKey, key.content.rooms);
  const unadmitted = new EncryptedTaskReader({ endpoint: f.participant.endpoint, task: f.task, writer: f.writer });
  await assert.rejects(() => unadmitted.reconnect(f.tasks), /task_integrity_failed/,
    'the request cannot make a raw imported session trusted merely by importing keys');
  const admitted = await acceptProjectAccess(f.participant.endpoint, await transfer(), { writer: f.writer });
  const reader = new EncryptedTaskReader({ endpoint: f.participant.endpoint, task: f.task,
    writer: f.writer, admittedSessions: admitted.sessions });
  assert.equal((await reader.reconnect(f.tasks)).objective, 'This history preceded the participant key share');
});
