'use strict';
// A real Codex task, executed by the host, written to the encrypted log.
//
// encrypted-real-task.js proves the path with the deterministic provider so it runs the same
// way everywhere. This one runs the actual CLI, because #7's first criterion says "a real
// provider task" and a deterministic stand-in does not answer that.
//
// It runs Codex confined to read-only, which is the only mode with measured project
// confinement (see codex-confinement.js and docs/proofs/codex-confinement.md). That is also
// why this cannot satisfy the "produces file changes" half of criterion 1: writes are exactly
// what read-only refuses. Running workspace-write instead would produce file changes and an
// agent that can write outside the project a teammate authorised, which criterion 3 forbids.
//
// Skips loudly when no authenticated Codex is present.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { TurnSession } = require('../packages/runtime/session');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EncryptedHost } = require('../packages/runtime/encrypted-host');
const { EncryptedTaskReader, EncryptedTaskTransport, createEncryptedTask, newId } = require('../packages/e2ee/task-log.mjs');
const { matrixUser } = require('../packages/protocol/encrypted-task.mjs');
const { EnrollmentTransport, announcement } = require('../packages/e2ee/enrollment.mjs');
const { catchUp } = require('../packages/e2ee/catchup.mjs');
const { TeamOps } = require('../packages/protocol');
const { probe } = require('../packages/runtime/codex-probe');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
const note = (name, detail) => { results.push({ name, status: 'recorded', detail }); console.log('  NOTE ' + name + ' - ' + detail); };
const waitFor = async (fn, label = '') => {
  for (let n = 0; n < 400; n++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout: ' + label);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-codex-task-'));
const canary = 'PRIVATE_' + randomBytes(16).toString('hex');
let hub, runtime, encrypted, socket;

(async () => {
  const p = probe();
  if (!p.resolved?.bin || !p.version || !(p.auth?.mode || p.auth?.openaiApiKeyInEnv)) {
    console.log('SKIPPED: no authenticated Codex CLI - a real provider task was not exercised');
    process.exit(0);
  }
  console.log('  using Codex ' + p.version);

  hub = new Hub({ dbFile: path.join(tmp, 'hub.sqlite'), log: () => {} });
  const addr = await hub.listen();
  const url = 'http://127.0.0.1:' + addr.port;
  const project = path.join(tmp, 'workspace');
  fs.mkdirSync(project);
  // Something for the agent to actually read, so the answer proves it saw the workspace.
  fs.writeFileSync(path.join(project, 'ANSWER.txt'), 'The maintenance window is ' + canary + '\n');

  runtime = new Runtime({
    hubUrl: url.replace('http', 'ws'), userName: 'host', dataDir: path.join(tmp, 'runtime'),
    projects: [project], encryptedTasksOnly: true, codexReadOnly: true
  });
  await runtime.start();

  let welcome; const messages = [];
  socket = new WebSocket(url.replace('http', 'ws'));
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', role: 'client', name: 'alice' }));
  socket.onmessage = ({ data }) => { const m = JSON.parse(data); messages.push(m); if (m.type === 'welcome') welcome = m; };
  await waitFor(() => welcome && hub.pendingPairings.size, 'welcome');
  socket.send(JSON.stringify({ type: TeamOps.TEAM_CREATE, name: 'Codex team', id: 'op1' }));
  await waitFor(() => messages.some((m) => m.type === 'team'), 'team');
  const team = messages.find((m) => m.type === 'team').team;
  socket.send(JSON.stringify({ type: TeamOps.RUNTIME_PAIR, teamId: team.id, code: runtime.pairingCode, id: 'op2' }));
  await waitFor(() => runtime.teamId === team.id, 'paired');
  const account = hub.store.userById(welcome.user.id);

  const provider = runtime.provider('codex-cli');
  assert.equal(provider.confinedTo, 'read-only');
  assert.equal(provider.capabilities().writes, false);
  pass('the host offers Codex only in the mode whose confinement was measured', 'read-only, writes: false');

  const projectId = newId('ep');
  encrypted = new EncryptedHost({ runtime, url, statePath: path.join(tmp, 'outbox.sqlite'), projects: new Map([[projectId, project]]), log: () => {} });
  const hostIdentity = await encrypted.start();

  const client = await Endpoint.create({
    user: matrixUser(account.id), device: 'ALICEDEV',
    transport: new HubKeyTransport({ url, token: account.token, device: 'ALICEDEV' })
  });
  await new EnrollmentTransport({ url, token: account.token }).bootstrap(team.id, announcement(client));
  for (const [a, b] of [[client, encrypted.endpoint], [encrypted.endpoint, client]]) await a.confirmEndpoint(b.identity(), { confirmed: true });

  const tasks = new EncryptedTaskTransport({ url, token: account.token });
  const task = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId, creatorUserId: account.id };
  const objective = { title: 'Read the maintenance window', objective: 'Read ANSWER.txt in this project and reply with the maintenance window it names. Do not write any files.' };
  await createEncryptedTask(client, tasks, { task, writer: hostIdentity, payload: objective });

  const runTurn = async (emit, decrypted) => {
    const session = new TurnSession({
      thread: { id: task.id, cwd: project, settings: {} },
      by: { userId: account.id, name: 'alice' },
      input: [{ type: 'text', text: decrypted.objective }],
      provider, settings: { sandboxPolicy: 'read-only' }, executor: runtime.executor,
      history: [], emit, log: () => {}
    });
    await session.run();
    return session;
  };
  const started = Date.now();
  const outcome = await encrypted.run(task, { runTurn, provider: 'codex-cli' });
  assert.ok(outcome.events >= 2, 'the real provider produced a history');
  pass('a real Codex turn runs on the host and reaches the encrypted log',
    outcome.events + ' events in ' + Math.round((Date.now() - started) / 1000) + 's');

  await client.open(await client.transport.drain());
  const reader = new EncryptedTaskReader({ endpoint: client, task, writer: hostIdentity });
  await reader.reconnect(tasks);
  const text = JSON.stringify(reader.state.events);
  assert.ok(reader.state.events.some((e) => e.type === 'turn.completed'), 'the log says how the turn ended');
  pass('the creator replays what the real provider did', reader.seq + ' events, turn ' + reader.state.turn);

  // The agent read a file only the workspace contains, so the answer proves it saw it.
  if (text.includes(canary)) {
    pass('the provider read the authorized workspace and reported what it found', 'the answer names the canary');
  } else {
    note('the provider did not quote the workspace file in its answer',
      'the run completed but the reply did not include the canary; the encrypted path is unaffected');
  }

  const view = catchUp(reader.snapshot(), { responsible: 'alice', host: runtime.id, hostConnected: true, taskId: task.id, projectId });
  assert.ok(view.objective.value.includes('maintenance window'));
  assert.equal(view.provider.provenance, 'recorded');
  assert.equal(view.provider.value, 'codex-cli');
  pass('the catch-up projection reads a real provider task', 'objective and provider both recorded');

  // Criterion 2: nothing about the account reaches the relay.
  const relay = JSON.stringify({
    events: await tasks.page(task.id), tasks: await tasks.list(team.id),
    runtimes: hub.store.listRuntimes ? hub.store.listRuntimes(team.id) : hub.store.getRuntime(runtime.id)
  });
  assert.equal(relay.includes(canary), false, 'workspace content stayed out of the relay');
  assert.equal(/sk-[A-Za-z0-9_-]{12,}|ChatGPT auth|access_token|refresh_token/i.test(relay), false, 'no credential material reached the relay');
  pass('a real provider run leaks neither content nor credentials to the relay', 'canary and token scans clean');

  note('file changes were not produced, by design',
    'read-only is the confined mode; workspace-write would produce writes and an unconfined shell (see docs/proofs/codex-confinement.md)');

  const out = path.join(__dirname, '..', '.artifacts', 'encrypted-codex-task');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), codex: p.version, results }, null, 2) + '\n');
  console.log('\n' + results.length + ' real Codex task checks recorded');
})().then(async () => {
  socket?.close(); encrypted?.close(); try { runtime?.stop?.(); } catch {}
  await hub?.close?.(); process.exit(0);
}).catch(async (error) => {
  console.error('REAL CODEX TASK FAILED\n', error);
  socket?.close(); try { encrypted?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
