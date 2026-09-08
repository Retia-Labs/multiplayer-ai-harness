'use strict';
// Public host and HTTP relay boundaries with real Matrix crypto. Reconstructing the
// host retains an injected SDK store; this is not an Electron persistence proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Hub } = require('../packages/hub/server');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EnrollmentTransport, announcement } = require('../packages/e2ee/enrollment.mjs');
const { EncryptedTaskTransport, createEncryptedTask, newId } = require('../packages/e2ee/task-log.mjs');
const { EncryptedHost } = require('../packages/runtime/encrypted-host');
const { matrixUser, roomFor } = require('../packages/protocol/encrypted-task.mjs');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-authority-revocation-'));
  const hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite'), log() {} });
  const endpoints = [], hosts = [];
  let proxy;
  t.after(async () => {
    for (const host of hosts) await host.close();
    for (const endpoint of endpoints) endpoint.close();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    await hub.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const address = await hub.listen(), hubUrl = 'http://127.0.0.1:' + address.port;
  const relay = { hideTasks: false, refuseFurtherReads: false, reads: 0, trace: [] };
  proxy = http.createServer(async (req, res) => {
    try {
      if (relay.refuseFurtherReads && req.method === 'GET' && req.url.startsWith('/api/enrollment?')) {
        relay.trace.push('membership:get');
        if (relay.reads++ > 0) { res.writeHead(503); res.end('{}'); return; }
      }
      if (relay.hideTasks && req.method === 'GET' && req.url.startsWith('/api/encrypted-tasks?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"tasks":[]}'); return;
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(hubUrl + req.url, { method: req.method, headers: req.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
    } catch { res.writeHead(502); res.end('{}'); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + proxy.address().port;
  const owner = hub.store.createAccount('owner'), team = hub.store.createTeam('Authority revocation', owner.id);
  const client = async device => {
    const endpoint = await Endpoint.create({ user: matrixUser(owner.id), device,
      transport: new HubKeyTransport({ url, token: owner.token, device }) });
    endpoints.push(endpoint);
    return { endpoint, enrollment: new EnrollmentTransport({ url, token: owner.token, endpoint }) };
  };
  const original = await client('ORIGINAL'), selected = await client('SELECTED'), successor = await client('SUCCESSOR');
  await original.enrollment.bootstrap(team.id, announcement(original.endpoint));
  for (const member of [selected, successor]) {
    await member.enrollment.pinAuthority(team.id, original.endpoint.identity());
    await member.enrollment.announce(team.id, announcement(member.endpoint));
    await original.enrollment.confirm(team.id, 'ORIGINAL', { userId: owner.id, ...announcement(member.endpoint) });
  }
  const project = path.join(dir, 'project'); fs.mkdirSync(project);
  const projectId = newId('ep'); await original.enrollment.ownProject(team.id, projectId);
  const runtime = { id: 'rt_selected_revocation', teamId: team.id, runtimeToken: 'synthetic-runtime-token',
    encryptedTasksOnly: true, projects: new Map([[project, {}]]) };
  hub.store.pairRuntime(runtime.id, team.id, owner.id, runtime.runtimeToken);
  hub.store.upsertRuntime(team.id, { id: runtime.id, taskProtocol: 'encrypted-v1' });
  const hostEndpoint = await Endpoint.create({ user: matrixUser(runtime.id), device: 'HOST',
    transport: new HubKeyTransport({ url, token: runtime.runtimeToken, device: 'HOST', runtimeId: runtime.id }) });
  endpoints.push(hostEndpoint);
  const retainedStore = new Proxy(hostEndpoint, { get(target, key) {
    if (key === 'close') return async () => {};
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const openHost = async () => {
    const host = new EncryptedHost({ runtime, url, statePath: path.join(dir, 'host.sqlite'),
      projects: new Map([[projectId, project]]), authority: original.endpoint.identity(), endpointFactory: async () => retainedStore });
    hosts.push(host); await host.start(); return host;
  };
  const reconcile = async (host, signer) => {
    await host.beginReconcile(); await signer.enrollment.answerChallenges(team.id); return host.reconcileMembership();
  };
  const activate = async (host, candidate) => {
    const proposal = await host.prepareFreshnessAuthority(candidate.endpoint.identity());
    await host.commitFreshnessAuthority(proposal.proposalId); await reconcile(host, candidate);
  };
  const host = await openHost();
  for (const member of [original, selected, successor]) await member.endpoint.confirmEndpoint(hostEndpoint.identity(), { confirmed: true });
  await reconcile(host, original); await activate(host, selected);
  const tasks = new EncryptedTaskTransport({ url, token: owner.token });
  const route = { version: 1, id: newId('et'), projectId, runtimeId: runtime.id, teamId: team.id, creatorUserId: owner.id };
  await createEncryptedTask(original.endpoint, tasks, { task: route, writer: hostEndpoint.identity(),
    payload: { title: 'Revocation boundary', objective: 'Keep subsequent content private' } });
  const task = (await tasks.list(team.id)).tasks[0];
  await host.run(task, { runTurn: async emit => emit({ method: 'turn/completed', status: 'completed' }) });
  await host.admitParticipants(task); await selected.endpoint.open(await selected.endpoint.transport.drain());
  return { dir, hub, relay, owner, team, runtime, original, selected, successor, host, openHost, reconcile, activate, task, tasks };
}

test('an applied selected-signer revocation cancels execution before another relay read', async t => {
  const f = await fixture(t);
  await f.original.enrollment.revokeEndpoint(f.team.id, { userId: f.owner.id, device: 'SELECTED' });
  let cancelled = false;
  f.runtime.encryptedExecution = { close: async () => { cancelled = true; f.relay.trace.push('execution:cancelled'); } };
  f.relay.refuseFurtherReads = true;
  try { await f.host.applyRevocations(); }
  catch (error) { assert.equal(error.code, 'enrollment_unavailable'); }
  assert.equal(f.host.freshness.record().state, 'revoked');
  assert.equal(cancelled, true, 'observing and persisting removal must stop active work even if the relay subsequently withholds state');
  const secondRead = f.relay.trace.indexOf('membership:get', 1);
  assert.ok(secondRead < 0 || f.relay.trace.indexOf('execution:cancelled') < secondRead,
    'cancellation precedes any further network dependency');
});

test('an acknowledged revocation covers a durable task omitted after host reconstruction', async t => {
  const f = await fixture(t);
  await f.host.close();
  const restarted = await f.openHost(); await f.reconcile(restarted, f.selected);
  await f.original.enrollment.revokeEndpoint(f.team.id, { userId: f.owner.id, device: 'SELECTED' });
  f.relay.hideTasks = true;
  const applied = await restarted.applyRevocations();
  assert.equal(applied.requiresAuthority, true);
  assert.ok(applied.applied.some(removal => removal.device === 'SELECTED'));
  await f.activate(restarted, f.successor);
  f.relay.hideTasks = false;
  const task = (await restarted.tasks.list(f.team.id)).tasks[0];
  await restarted.admitParticipants(task);
  const opened = await restarted.openTask(task);
  const text = 'New content after this host applied removal';
  await opened.writer.append({ type: 'message.added', payload: { id: 'after-revocation', role: 'assistant', text } }, newId('ev'));
  const record = (await f.tasks.page(task.id)).events.at(-1);
  await f.successor.endpoint.open(await f.successor.endpoint.transport.drain());
  const readable = await f.successor.endpoint.decryptTask(roomFor(task.id), record.envelope);
  assert.equal(readable.content.event.payload.text, text, 'the current endpoint receives the new content');
  await assert.rejects(() => f.selected.endpoint.decryptTask(roomFor(task.id), record.envelope),
    'a removed device cannot read future content just because the relay omitted a durable task during rotation');
});

test('closing execution while task startup yields cannot dispatch a provider afterwards', async t => {
  const f = await fixture(t);
  const { Runtime } = require('../packages/runtime');
  const { EncryptedExecution } = require('../packages/runtime/encrypted-execution');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-cancel-runtime-'));
  const runtime = new Runtime({ dataDir,
    projects: [...f.host.projects.values()], encryptedTasksOnly: true });
  t.after(async () => { await runtime.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let providerRuns = 0;
  runtime.provider = () => ({ id: 'synthetic-cancellation-probe', run: async () => { providerRuns++; } });
  const execution = new EncryptedExecution({ runtime, host: f.host });
  const opened = await f.host.openTask(f.task);
  // startTask yields while ensuring the authenticated creating record exists. Closing
  // in that interval must remain effective when startup resumes on the next microtask.
  const stopped = assert.rejects(() => execution.startTask(f.task, opened, {
    input: [{ type: 'text', text: 'No provider may see this after cancellation' }], settings: { provider: 'synthetic-cancellation-probe' }
  }), /host_stopped/);
  await execution.close();
  await stopped;
  assert.equal(providerRuns, 0);
  assert.equal(execution.state(f.task), null, 'cancelled startup creates no running marker requiring provider recovery');
  assert.equal(execution.pending.size, 0);
  assert.equal(execution.active.size, 0);
});

test('a disconnected host applies selected-signer removal before trying to challenge that removed endpoint', async t => {
  const f = await fixture(t);
  f.host.disconnect();
  await f.original.enrollment.revokeEndpoint(f.team.id, { userId: f.owner.id, device: 'SELECTED' });
  let cancelled = false;
  f.runtime.encryptedExecution = { close: async () => { cancelled = true; } };
  const applied = await f.host.applyRevocations();
  assert.equal(cancelled, true);
  assert.equal(applied.requiresAuthority, true);
  assert.ok(applied.applied.some(removal => removal.device === 'SELECTED'));
  assert.equal(f.host.freshness.record().state, 'revoked');
  assert.equal(f.host.challenge, null, 'a removed signer cannot be offered another challenge');
  await assert.rejects(() => f.host.collect(), /membership_freshness_authority_revoked/);
});
