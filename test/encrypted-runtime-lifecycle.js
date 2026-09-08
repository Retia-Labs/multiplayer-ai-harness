'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EnrollmentTransport, announcement } = require('../packages/e2ee/enrollment.mjs');
const { EncryptedTaskTransport, createEncryptedTask, newId } = require('../packages/e2ee/task-log.mjs');
const { matrixUser } = require('../packages/protocol/encrypted-task.mjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) {
  for (let count = 0; count < 400; count++) {
    if (await read()) return;
    await wait(25);
  }
  throw new Error('Timed out: ' + label);
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-lifecycle-'));
  const hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite') });
  const address = await hub.listen();
  const url = 'http://127.0.0.1:' + address.port;
  const owner = hub.store.createAccount('Owner');
  const team = hub.store.createTeam('Lifecycle proof', owner.id);
  const endpoint = await Endpoint.create({ user: matrixUser(owner.id), device: 'OWNER',
    transport: new HubKeyTransport({ url, token: owner.token, device: 'OWNER' }) });
  const enrollment = new EnrollmentTransport({ url, token: owner.token, endpoint });
  await enrollment.bootstrap(team.id, announcement(endpoint));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  let hostKeys;
  const attempts = [];
  const runtime = new Runtime({ hubUrl: url.replace('http', 'ws'), dataDir: path.join(dir, 'runtime'),
    projects: [workspace], encryptedTasksOnly: true,
    encryptionAuthority: { ...endpoint.identity(), teamId: team.id },
    // Delay the real crypto-store boundary; all hub pairing and lifecycle code is live.
    // Retaining one SDK machine models the durable broker across successive openings.
    encryptedEndpointFactory: async options => {
      hostKeys ||= await Endpoint.create(options);
      hostKeys.transport = options.transport;
      const attempt = { closed: 0 };
      attempts.push(attempt);
      await new Promise(resolve => { attempt.release = resolve; });
      return Object.assign(Object.create(hostKeys), { close: async () => { attempt.closed++; } });
    } });
  let socket, challenges;
  t.after(async () => {
    for (const attempt of attempts) attempt.release();
    clearInterval(challenges); socket?.close(); await runtime.stop();
    hostKeys?.close(); endpoint.close(); await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await runtime.start();
  socket = new WebSocket(url.replace('http', 'ws'));
  let welcomed = false;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', role: 'client', token: owner.token }));
  socket.onmessage = ({ data }) => { if (JSON.parse(data).type === 'welcome') welcomed = true; };
  await until(() => welcomed && hub.pendingPairings.size, 'initial pairing');
  const pair = () => socket.send(JSON.stringify({ type: 'runtime/pair', teamId: team.id, code: runtime.pairingCode }));
  const unpair = () => socket.send(JSON.stringify({ type: 'runtime/unpair', runtimeId: runtime.id }));
  pair(); await until(() => attempts.length === 1, 'crypto startup');
  return { runtime, attempts, pair, unpair, hub, team, enrollment, endpoint, owner, url, workspace,
    answer: () => { challenges = setInterval(() => enrollment.answerChallenges(team.id).catch(() => {}), 50); } };
}

test('unpair invalidates in-flight crypto startup and re-pair starts a fresh host loop', async t => {
  const f = await fixture(t);
  f.unpair(); await until(() => f.runtime.teamId === null, 'unpair');
  f.attempts[0].release();
  await until(() => !f.runtime.encryptedStarting, 'obsolete startup cleanup');
  assert.equal(!!f.runtime.encryptedHost, false);
  assert.equal(f.runtime.encryptionState, 'awaiting-team');
  assert.equal(f.attempts[0].closed, 1);
  await until(() => f.hub.pendingPairings.size, 'new pairing challenge');
  f.pair(); await until(() => f.attempts.length === 2, 'replacement crypto startup');
  f.attempts[1].release();
  await until(() => f.runtime.encryptedHost?.endpoint, 'replacement host');
  assert.notEqual(f.runtime.encryptionState, 'ready', 'published keys alone do not establish reconciled authority');
  f.answer(); await until(() => f.runtime.encryptionState === 'ready', 'fresh owner proof');
  const projectId = f.runtime.descriptor().encryptedProjects[0].id;
  await f.enrollment.ownProject(f.team.id, projectId);
  const writer = f.runtime.encryptedHost.endpoint.identity();
  await f.endpoint.confirmEndpoint(writer, { confirmed: true });
  const task = { version: 1, id: newId('et'), teamId: f.team.id, projectId,
    runtimeId: f.runtime.id, creatorUserId: f.owner.id };
  await createEncryptedTask(f.endpoint, new EncryptedTaskTransport({ url: f.url, token: f.owner.token }), {
    task, writer, payload: { title: 'After re-pair', objective: 'Create CHECK.txt', provider: 'demo' }
  });
  await until(() => fs.existsSync(path.join(f.workspace, 'CHECK.txt')), 'task execution after re-pair');
  assert.equal(f.attempts[1].closed, 0, 'obsolete generation cleanup never closes the new host');
});

test('stopping during crypto startup waits for and closes the unpublished endpoint', async t => {
  const f = await fixture(t);
  const stopping = f.runtime.stop();
  let stopped = false; stopping.then(() => { stopped = true; });
  await wait(30);
  assert.equal(stopped, false);
  f.attempts[0].release(); await stopping;
  assert.equal(f.attempts[0].closed, 1);
  assert.equal(!!f.runtime.encryptedHost, false);
  assert.equal(f.runtime.encryptionState, 'stopped');
});

test('an immediate new pairing waits for the obsolete startup to release the shared store', async t => {
  const f = await fixture(t);
  f.unpair(); await until(() => f.runtime.teamId === null && f.hub.pendingPairings.size, 'unpair and new challenge');
  f.pair(); await until(() => f.runtime.teamId === f.team.id, 'pair before old startup finishes');
  assert.equal(f.attempts.length, 1);
  f.attempts[0].release(); await until(() => f.attempts.length === 2, 'replacement waits for closed old store');
  assert.equal(f.attempts[0].closed, 1);
  f.attempts[1].release(); await until(() => f.runtime.encryptedHost?.endpoint, 'current host');
  f.answer(); await until(() => f.runtime.encryptionState === 'ready', 'reconciled replacement');
  assert.equal(f.attempts[1].closed, 0);
});

test('the production runtime process waits for crypto close before exiting on SIGTERM', async t => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-signal-'));
  const hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite') });
  const address = await hub.listen();
  const url = 'http://127.0.0.1:' + address.port;
  const owner = hub.store.createAccount('Signal owner');
  const team = hub.store.createTeam('Shutdown proof', owner.id);
  const endpoint = await Endpoint.create({ user: matrixUser(owner.id), device: 'OWNER',
    transport: new HubKeyTransport({ url, token: owner.token, device: 'OWNER' }) });
  const enrollment = new EnrollmentTransport({ url, token: owner.token, endpoint });
  await enrollment.bootstrap(team.id, announcement(endpoint));
  const dataDir = path.join(dir, 'runtime');
  const seed = new Runtime({ hubUrl: url.replace('http', 'ws'), dataDir });
  hub.store.pairRuntime(seed.id, team.id, owner.id, seed.runtimeToken);
  seed.store.setKv('teamId', team.id);
  await seed.stop();
  fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({
    encryptionAuthority: { ...endpoint.identity(), teamId: team.id }
  }));
  const child = spawn(process.execPath, [path.join(__dirname, '../packages/runtime/index.js'),
    '--data', dataDir, '--hub', url.replace('http', 'ws'), '--encrypted-tasks-only'],
  { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let hostKeys, published = false, closed = false, stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => { if (String(data).includes('encrypted host endpoint published')) published = true; });
  // This substitutes only the OS broker process: the spawned production CLI still
  // crosses its real crypto IPC seam and has to await the delayed close response.
  child.on('message', async message => {
    if (message.type !== 'crypto.request') return;
    let result, error;
    try {
      if (message.operation === 'create') {
        const options = message.args[0];
        hostKeys = await Endpoint.create({ ...options, transport: new HubKeyTransport(options.transport) });
        result = hostKeys.identity();
      } else if (message.operation === 'close') {
        await wait(75); hostKeys.close(); closed = true;
      } else result = await hostKeys[message.operation](...message.args);
    } catch (failure) { error = failure.message; }
    if (child.connected) child.send({ type: 'crypto.response', id: message.id, result, error }, () => {});
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    hostKeys?.close(); endpoint.close(); await hub.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  await until(() => published, 'child encrypted host ready');
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(closed, true, 'SIGTERM must complete crypto close before process exit');
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
});
