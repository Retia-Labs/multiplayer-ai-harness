'use strict';
// Key exchange on the real hub, which #6 deferred and #9 turned out to depend on.
//
// Two things are being shown. The mechanism works: two endpoints that have never met can
// publish keys, find each other, establish a session and read an encrypted task log through
// the hub the product already runs. And the authorization holds: membership decides who may
// ask about whom, and it never becomes decryption authority.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EncryptedTaskReader, EncryptedTaskTransport, createEncryptedTask, newId } = require('../packages/e2ee/task-log.mjs');
const { matrixUser } = require('../packages/protocol/encrypted-task.mjs');
const { EncryptedTaskState, EncryptedFixtureHost, fixtureEvents, fixtureEventId } = require('../packages/runtime/encrypted-task');
const { TeamOps } = require('../packages/protocol');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
async function refused(name, code, fn) {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  assert.ok(error, name + ': expected a refusal');
  const got = error.code || String(error.message || error);
  assert.ok(got === code || got.includes(code), name + ': expected ' + code + ', got ' + got);
  results.push({ name, status: 'pass', refusal: code });
  console.log('  PASS ' + name + ' - ' + code);
}
const waitFor = async (fn) => { for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('fixture_timeout'); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-keyex-'));
const canary = 'PRIVATE_' + randomBytes(16).toString('hex');
let hub, runtime, state, sockets = [];

class Client {
  constructor(url, name) { this.url = url; this.name = name; this.waiters = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => this.ws.send(JSON.stringify({ type: 'hello', role: 'client', name: this.name })));
      this.ws.addEventListener('error', reject);
      this.ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'welcome') { this.me = m.user; resolve(m); }
        for (const w of this.waiters.slice()) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
      });
    });
  }
  op(msg) {
    const id = 'op_' + randomBytes(8).toString('hex');
    this.ws.send(JSON.stringify({ ...msg, id }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout: ' + msg.type)), 10000);
      this.waiters.push({ pred: (m) => m.ref === id, resolve: (m) => { clearTimeout(timer); m.type === 'error' ? reject(Object.assign(new Error(m.message || m.code), { code: m.code })) : resolve(m); } });
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  hub = new Hub({ dbFile: path.join(tmp, 'hub.sqlite'), log: () => {} });
  const addr = await hub.listen();
  const url = 'http://127.0.0.1:' + addr.port;
  const project = path.join(tmp, canary + '-workspace');
  fs.mkdirSync(project);
  runtime = new Runtime({ hubUrl: url.replace('http', 'ws'), userName: 'host', dataDir: path.join(tmp, 'runtime'), projects: [project], encryptedTasksOnly: true });
  await runtime.start();

  const alice = new Client(url.replace('http', 'ws'), 'alice');
  const outsider = new Client(url.replace('http', 'ws'), 'outsider');
  sockets = [alice, outsider];
  await Promise.all([alice.connect(), outsider.connect()]);
  await waitFor(() => hub.pendingPairings.size);
  const team = (await alice.op({ type: TeamOps.TEAM_CREATE, name: 'Key team' })).team;
  await alice.op({ type: TeamOps.RUNTIME_PAIR, teamId: team.id, code: runtime.pairingCode });
  await waitFor(() => runtime.teamId === team.id);

  const aliceToken = hub.store.userById(alice.me.id).token;
  const outsiderToken = hub.store.userById(outsider.me.id).token;

  // Both endpoints publish through the real hub, with no directory anywhere in the process.
  const client = await Endpoint.create({
    user: matrixUser(alice.me.id), device: 'CLIENT',
    transport: new HubKeyTransport({ url, token: aliceToken, device: 'CLIENT' })
  });
  const host = await Endpoint.create({
    user: matrixUser(runtime.id), device: 'HOST',
    transport: new HubKeyTransport({ url, token: runtime.runtimeToken, device: 'HOST', runtimeId: runtime.id })
  });
  assert.equal(hub.store.db.prepare('SELECT COUNT(*) AS n FROM e2ee_devices').get().n, 2);
  pass('an account endpoint and a paired execution host both publish through the hub', '2 devices');

  // Finding each other is a query the hub answers because they share a team.
  await client.track([matrixUser(runtime.id)]);
  await host.track([matrixUser(alice.me.id)]);
  assert.ok(await client.getDevice(matrixUser(runtime.id), 'HOST'), 'client sees the host');
  assert.ok(await host.getDevice(matrixUser(alice.me.id), 'CLIENT'), 'host sees the client');
  pass('teammates find each other through the hub directory', 'both directions');

  // An account outside the team is answered with a failure, not with keys.
  const outsiderTransport = new HubKeyTransport({ url, token: outsiderToken, device: 'OUTSIDER' });
  const answer = await outsiderTransport.request('keys', {
    type: 'KeysQuery', user: matrixUser(outsider.me.id), device: 'OUTSIDER',
    body: JSON.stringify({ device_keys: { [matrixUser(runtime.id)]: [] } })
  });
  assert.deepEqual(answer.device_keys, {});
  assert.ok(answer.failures[matrixUser(runtime.id)], 'the query is refused for that user');
  pass('an account outside the team learns nothing about its endpoints', 'M_FORBIDDEN');

  await refused('an endpoint cannot publish under another endpoint\'s name', 'endpoint_mismatch',
    () => outsiderTransport.request('keys', { type: 'KeysUpload', user: matrixUser(alice.me.id), device: 'CLIENT', body: '{}' }));

  await refused('an envelope cannot be delivered to an endpoint outside the caller\'s teams', 'endpoint_not_visible',
    () => outsiderTransport.request('deliver', { user: matrixUser(runtime.id), device: 'HOST', envelope: { type: 'm.room.encrypted', sender: matrixUser(outsider.me.id), content: {} } }));

  // And now the whole point: a real encrypted task, read end to end with the hub as the only
  // thing between the two endpoints.
  for (const [a, b] of [[client, host], [host, client]]) await a.confirmEndpoint(b.identity(), { confirmed: true });
  const tasks = new EncryptedTaskTransport({ url, token: aliceToken });
  const hostTasks = new EncryptedTaskTransport({ url, token: runtime.runtimeToken, runtimeId: runtime.id });
  const task = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId: newId('ep'), creatorUserId: alice.me.id };
  const payload = { title: canary + ' title', objective: canary + ' objective', fixture: { plan: canary + ' plan', path: canary + '/f.txt', result: canary + ' out', diff: canary + ' diff', activity: canary + ' act', answer: canary + ' ans' } };
  const created = await createEncryptedTask(client, tasks, { task, writer: host.identity(), payload });
  state = new EncryptedTaskState(path.join(tmp, 'outbox.sqlite'));
  const adapter = new EncryptedFixtureHost({ runtime, endpoint: host, transport: hostTasks, state, projects: new Map([[task.projectId, project]]), creators: new Map([[alice.me.id, client.identity()]]) });
  const opened = await adapter.open(created.task);
  await client.open(await client.transport.drain());
  const events = fixtureEvents(opened.objective);
  for (let i = 0; i < events.length; i++) await opened.writer.append(events[i], fixtureEventId(task.id, i));

  const reader = new EncryptedTaskReader({ endpoint: client, task, writer: host.identity() });
  await reader.reconnect(tasks);
  assert.equal(reader.seq, events.length);
  assert.equal(reader.state.title, payload.title);
  pass('a task is created, written and replayed with the hub as the only key transport', reader.seq + ' events');

  // The hub held the keys that route messages and none that open them.
  const held = JSON.stringify({
    devices: hub.store.db.prepare('SELECT * FROM e2ee_devices').all(),
    oneTime: hub.store.db.prepare('SELECT * FROM e2ee_one_time_keys').all(),
    mailbox: hub.store.db.prepare('SELECT * FROM e2ee_mailbox').all(),
    events: await tasks.page(task.id)
  });
  assert.equal(held.includes(canary), false);
  pass('nothing the hub stores for key exchange contains the task text', canary.slice(0, 12) + '...');

  // Draining is destructive and only ever for yourself.
  assert.deepEqual(await outsiderTransport.request('drain', {}), []);
  pass('draining a mailbox returns only your own', 'outsider sees nothing');

  fs.mkdirSync(path.join(__dirname, '..', '.artifacts', 'hub-key-exchange'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', '.artifacts', 'hub-key-exchange', 'results.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log('\n' + results.length + ' hub key-exchange checks passed');
})().then(async () => {
  for (const s of sockets) s.close();
  state?.close(); await runtime?.stop?.(); await hub?.close?.(); process.exit(0);
}).catch(async (error) => {
  console.error('HUB KEY EXCHANGE FAILED\n', error);
  for (const s of sockets) s.close();
  try { state?.close(); } catch {}
  try { await runtime?.stop?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
