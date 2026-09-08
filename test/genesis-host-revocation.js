'use strict';
// Real Hub, EnrollmentTransport, EncryptedHost and Matrix ciphertext boundaries.
// Host reconstruction reopens SQLite while retaining an injected SDK store. It is
// deliberately not an Electron/OS-key persistence or provider execution proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Hub } = require('../packages/hub/server');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EnrollmentTransport, announcement, verifyRevocationReceipts } = require('../packages/e2ee/enrollment.mjs');
const { EncryptedTaskTransport, createEncryptedTask, newId } = require('../packages/e2ee/task-log.mjs');
const { sendTaskControl } = require('../packages/e2ee/task-control.mjs');
const { EncryptedHost } = require('../packages/runtime/encrypted-host');
const { matrixUser, roomFor } = require('../packages/protocol/encrypted-task.mjs');

const identity = endpoint => Object.fromEntries(['user', 'device', 'curve25519', 'ed25519']
  .map(key => [key, endpoint.identity()[key]]));

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-genesis-host-'));
  const hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite'), log() {} });
  const endpoints = [], openedHosts = [];
  let proxy;
  t.after(async () => {
    for (const host of openedHosts) await host.close();
    for (const endpoint of endpoints) endpoint.close();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    await hub.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const address = await hub.listen(), hubUrl = 'http://127.0.0.1:' + address.port;
  const relay = { hiddenTasks: new Set(), replay: new Map() };
  proxy = http.createServer(async (req, res) => {
    try {
      const runtimeId = req.headers['x-plexus-runtime'];
      if (relay.hiddenTasks.has(runtimeId) && req.method === 'GET' && req.url.startsWith('/api/encrypted-tasks?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"tasks":[]}'); return;
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(hubUrl + req.url, { method: req.method, headers: req.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      let value = await response.text();
      if (relay.replay.has(runtimeId) && req.method === 'GET' && req.url.startsWith('/api/enrollment?')) {
        value = JSON.stringify({ ...JSON.parse(value), authorityLog: relay.replay.get(runtimeId) });
      }
      res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(value);
    } catch { res.writeHead(502); res.end('{}'); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + proxy.address().port;
  const owner = hub.store.createAccount('owner'), team = hub.store.createTeam('Two host original removal', owner.id);
  const client = async device => {
    const endpoint = await Endpoint.create({ user: matrixUser(owner.id), device,
      transport: new HubKeyTransport({ url, token: owner.token, device }) });
    endpoints.push(endpoint);
    return { endpoint, enrollment: new EnrollmentTransport({ url, token: owner.token, endpoint }) };
  };
  const original = await client('ORIGINAL'), replacement = await client('REPLACEMENT');
  await original.enrollment.bootstrap(team.id, announcement(original.endpoint));
  await replacement.enrollment.pinAuthority(team.id, original.endpoint.identity());
  await replacement.enrollment.announce(team.id, announcement(replacement.endpoint));
  await original.enrollment.confirm(team.id, 'ORIGINAL', { userId: owner.id, ...announcement(replacement.endpoint) });
  const project = path.join(dir, 'project'); fs.mkdirSync(project);
  const projectId = newId('ep'); await original.enrollment.ownProject(team.id, projectId);
  const reconcile = async (host, signer) => {
    await host.beginReconcile(); await signer.enrollment.answerChallenges(team.id); return host.reconcileMembership();
  };
  const activate = async (host, signer = replacement) => {
    const proposal = await host.prepareFreshnessAuthority(signer.endpoint.identity());
    const activated = await host.commitFreshnessAuthority(proposal.proposalId);
    await reconcile(host, signer); return activated;
  };
  const tasks = new EncryptedTaskTransport({ url, token: owner.token });
  const makeHost = async (name, selected) => {
    const runtime = { id: 'rt_genesis_' + name, teamId: team.id, runtimeToken: 'synthetic-token-' + name,
      encryptedTasksOnly: true, projects: new Map([[project, {}]]) };
    hub.store.pairRuntime(runtime.id, team.id, owner.id, runtime.runtimeToken);
    hub.store.upsertRuntime(team.id, { id: runtime.id, taskProtocol: 'encrypted-v1' });
    const endpoint = await Endpoint.create({ user: matrixUser(runtime.id), device: 'HOST',
      transport: new HubKeyTransport({ url, token: runtime.runtimeToken, device: 'HOST', runtimeId: runtime.id }) });
    endpoints.push(endpoint);
    const retainedStore = new Proxy(endpoint, { get(target, key) {
      if (key === 'close') return async () => {};
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const open = async () => {
      const host = new EncryptedHost({ runtime, url, statePath: path.join(dir, name + '.sqlite'),
        projects: new Map([[projectId, project]]), authority: original.endpoint.identity(), endpointFactory: async () => retainedStore });
      openedHosts.push(host); await host.start(); return host;
    };
    const host = await open();
    for (const member of [original, replacement]) await member.endpoint.confirmEndpoint(endpoint.identity(), { confirmed: true });
    await reconcile(host, original);
    if (selected) await activate(host);
    const route = { version: 1, id: newId('et'), projectId, runtimeId: runtime.id, teamId: team.id, creatorUserId: owner.id };
    await createEncryptedTask(original.endpoint, tasks, { task: route, writer: endpoint.identity(),
      payload: { title: 'Host ' + name, objective: 'Keep future content private after removal' } });
    const task = (await tasks.list(team.id)).tasks.find(task => task.id === route.id);
    await host.run(task, { runTurn: async emit => emit({ method: 'turn/completed', status: 'completed' }) });
    await host.admitParticipants(task);
    for (const member of [original, replacement]) await member.endpoint.open(await member.endpoint.transport.drain());
    const prior = (await tasks.page(task.id)).events.at(-1);
    await original.endpoint.decryptTask(roomFor(task.id), prior.envelope);
    return { host, open, runtime, task, identity: identity(endpoint) };
  };
  const a = await makeHost('a', true), b = await makeHost('b', false);
  const before = (await replacement.enrollment.state(team.id)).authorityLog;
  const remove = () => replacement.enrollment.revokeEndpoint(team.id, { userId: owner.id, device: 'ORIGINAL' });
  const receipts = async () => {
    const state = await replacement.enrollment.state(team.id);
    return verifyRevocationReceipts(state.revocations, { authorityLog: state.authorityLog,
      hosts: [a, b].map(item => ({ runtimeId: item.runtime.id, identity: item.identity })) });
  };
  const futureContent = async (item, label) => {
    await item.host.admitParticipants(item.task);
    const opened = await item.host.openTask(item.task);
    await opened.writer.append({ type: 'message.added', payload: { id: label, role: 'assistant', text: label } }, newId('ev'));
    for (const member of [original, replacement]) await member.endpoint.open(await member.endpoint.transport.drain());
    const record = (await tasks.page(item.task.id)).events.at(-1);
    assert.equal((await replacement.endpoint.decryptTask(roomFor(item.task.id), record.envelope)).content.event.payload.text, label);
    await assert.rejects(() => original.endpoint.decryptTask(roomFor(item.task.id), record.envelope),
      'the actual SDK cannot decrypt post-application ciphertext with the removed original device keys');
  };
  const refuseOriginalControl = async item => {
    await sendTaskControl(original.endpoint, item.identity, { task: item.task, action: 'help.request',
      payload: { id: 'help_removed_original', question: 'This must not apply', recipient: owner.id } });
    const result = await item.host.collect();
    assert.equal(result.applied.length, 0); assert.equal(result.refused[0].code, 'endpoint_revoked');
  };
  return { dir, hub, relay, owner, team, original, replacement, tasks, a, b, before, remove, receipts,
    reconcile, activate, futureContent, refuseOriginalControl };
}

test('an appointed host rotates even an omitted durable room after original removal; its acknowledgment leaves the other host pending', async t => {
  const f = await fixture(t);
  const selected = f.a.host.freshness.record();
  await f.a.host.close(); f.a.host = await f.a.open();
  await f.reconcile(f.a.host, f.replacement);
  await f.remove();
  f.relay.hiddenTasks.add(f.a.runtime.id);
  const applied = await f.a.host.applyRevocations();
  assert.equal(applied.requiresAuthority, false);
  assert.ok(applied.rotated.includes(f.a.task.id));
  assert.deepEqual(f.a.host.freshness.record(), selected, 'removing genesis does not remove the separately selected replacement');
  const [shown] = await f.receipts();
  assert.equal(shown.applied, false);
  assert.deepEqual(shown.appliedBy, [f.a.runtime.id]); assert.deepEqual(shown.pendingHosts, [f.b.runtime.id]);
  assert.equal(f.b.host.freshness.record(), null, 'an uncontacted host has not silently learned removal from another host receipt');
  f.relay.hiddenTasks.delete(f.a.runtime.id);
  await f.futureContent(f.a, 'future-on-appointed-host');
  await f.refuseOriginalControl(f.a);
  await sendTaskControl(f.replacement.endpoint, f.a.identity, { task: f.a.task, action: 'help.request',
    payload: { id: 'help_replacement', question: 'Still functional', recipient: f.owner.id } });
  const accepted = await f.a.host.collect();
  assert.equal(accepted.refused.length, 0); assert.equal(accepted.applied[0].state, 'delivered');
});

for (const disconnected of [false, true]) test('an ' + (disconnected ? 'offline' : 'online') + ' implicit-original host cancels, remains disabled across reopen, and needs its own local appointment', async t => {
  const f = await fixture(t);
  let cancellations = 0;
  f.b.runtime.encryptedExecution = { close: async () => { cancellations++; } };
  if (disconnected) f.b.host.disconnect();
  await f.remove(); await f.a.host.applyRevocations();
  const applied = await f.b.host.applyRevocations();
  assert.ok(cancellations > 0); assert.equal(applied.requiresAuthority, true);
  assert.ok(applied.rotated.includes(f.b.task.id));
  const disabled = f.b.host.freshness.record();
  assert.equal(disabled.kind, 'implicit-genesis'); assert.equal(disabled.state, 'revoked');
  assert.equal(Object.hasOwn(disabled, 'activationId'), false, 'disabling an implicit signer does not fabricate a local appointment');
  assert.deepEqual(disabled.genesis, identity(f.original.endpoint));
  assert.deepEqual(disabled.signer, disabled.genesis);
  assert.equal(f.b.host.challenge, null);
  await assert.rejects(() => f.b.host.collect(), /membership_freshness_authority_revoked/);
  await f.b.host.close(); f.b.host = await f.b.open();
  assert.deepEqual(f.b.host.freshness.record(), disabled);
  await assert.rejects(() => f.b.host.beginReconcile(), /membership_freshness_authority_revoked/);
  await assert.rejects(() => f.b.host.collect(), /membership_freshness_authority_revoked/);
  assert.equal((await f.b.host.applyRevocations()).requiresAuthority, true);
  const floor = f.b.host.state.load('authorization:' + f.team.id);
  f.relay.replay.set(f.b.runtime.id, f.before);
  await assert.rejects(() => f.b.host.prepareFreshnessAuthority(f.replacement.endpoint.identity()), /membership_rollback/);
  assert.deepEqual(f.b.host.state.load('authorization:' + f.team.id), floor);
  assert.deepEqual(f.b.host.freshness.record(), disabled);
  f.relay.replay.delete(f.b.runtime.id);
  await f.activate(f.b.host);
  const active = f.b.host.freshness.record();
  assert.equal(active.state, 'active'); assert.equal(active.kind, undefined);
  assert.deepEqual(active.genesis, disabled.genesis); assert.deepEqual(active.checkpoint, floor);
  assert.deepEqual(active.signer, identity(f.replacement.endpoint));
  await f.futureContent(f.b, 'future-after-local-appointment-' + disconnected);
  await f.refuseOriginalControl(f.b);
  const [shown] = await f.receipts();
  assert.equal(shown.applied, true); assert.deepEqual(shown.pendingHosts, []);
});
