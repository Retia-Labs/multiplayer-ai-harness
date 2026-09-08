'use strict';
// Can somebody actually turn the Codex provider on, and does a real task then run?
//
// #7 proved Codex could run a real task and #54 proved the host could apply the file changes
// it proposes. Both were reached by constructing a Runtime in code, which is something only a
// test does - so the capability shipped with no way for a person to switch it on. This is that
// switch, and the check that it is off until somebody uses it.
//
// The turn at the end is a real one against the authenticated CLI. It skips loudly without one,
// because a provider test that passes with no provider is worse than one that says it did not run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Hub } = require('../packages/hub/server');
const { Runtime, parseArgs } = require('../packages/runtime');
const { Commands, Errors } = require('../packages/protocol');
const { probe } = require('../packages/runtime/codex-probe');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
const note = (name, detail) => { results.push({ name, status: 'recorded', detail }); console.log('  NOTE ' + name + ' - ' + detail); };
const refuses = (name, code, fn) => {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  assert.ok(error, name + ': expected a refusal');
  const got = String(error.message || error);
  assert.ok(got.includes(code), name + ': expected ' + code + ', got ' + got);
  results.push({ name, status: 'pass', refusal: code });
  console.log('  PASS ' + name + ' - ' + code);
};
const waitFor = async (fn, label = '', tries = 800) => {
  for (let n = 0; n < tries; n++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout: ' + label);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-codex-switch-'));
let hub, runtime, socket;

(async () => {
  const project = path.join(tmp, 'workspace');
  fs.mkdirSync(project, { recursive: true });
  const canary = 'WINDOW_' + randomBytes(8).toString('hex');
  fs.writeFileSync(path.join(project, 'ANSWER.txt'), 'The maintenance window is ' + canary + '\n');

  // ---- the switch exists, in both places somebody would reach for it ----
  assert.equal(parseArgs(['--hub', 'ws://x']).codexReadOnly, undefined);
  assert.equal(parseArgs(['--hub', 'ws://x', '--codex-read-only']).codexReadOnly, true);
  pass('the flag exists on the command line and is absent by default', '--codex-read-only');

  const dataDir = path.join(tmp, 'runtime');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({ codexReadOnly: true }, null, 2));
  pass('and in the host\'s own runtime.json, next to the projects it authorizes', 'codexReadOnly: true');

  // ---- off by default ----
  hub = new Hub({ dbFile: path.join(tmp, 'hub.sqlite'), log: () => {} });
  const addr = await hub.listen();
  const url = 'http://127.0.0.1:' + addr.port;

  const closed = new Runtime({
    hubUrl: url.replace('http', 'ws'), userName: 'host',
    dataDir: path.join(tmp, 'closed'), projects: [project]
  });
  refuses('a host that was not switched on refuses the provider', Errors.PROVIDER_NOT_ISOLATED,
    () => closed.provider('codex-cli'));
  const closedList = closed.descriptor().providers.find((p) => p.id === 'codex-cli');
  assert.equal(closedList.configured, false);
  assert.match(closedList.label, /isolation pending/);
  pass('and says so in the fleet rather than hiding it', closedList.label);

  // ---- on when the operator turns it on ----
  runtime = new Runtime({
    hubUrl: url.replace('http', 'ws'), userName: 'host',
    dataDir, projects: [project], codexReadOnly: true
  });
  const open = runtime.descriptor().providers.find((p) => p.id === 'codex-cli');
  assert.equal(open.configured, true);
  assert.equal(open.writes, true);
  assert.equal(open.providerWrites, false);
  assert.match(open.label, /read-only, host-applied edits/);
  pass('a host whose operator turned it on offers it, with both halves of the truth', open.label);

  const backend = runtime.provider('codex-cli');
  assert.equal(backend.confinedTo, 'read-only');
  pass('and the backend it hands out is the confined one', 'sandbox pinned to read-only');

  // ---- and now a real turn, if there is a real Codex here ----
  const p = probe();
  if (!p.resolved?.bin || !p.version || !(p.auth?.mode || p.auth?.openaiApiKeyInEnv)) {
    note('a real Codex turn was not exercised', 'no authenticated Codex CLI on this machine');
    console.log('\n' + results.length + ' codex switch checks recorded');
    return;
  }
  console.log('  using Codex ' + p.version);

  await runtime.start();
  let welcome; const messages = [];
  socket = new WebSocket(url.replace('http', 'ws'));
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', role: 'client', name: 'kalai' }));
  socket.onmessage = ({ data }) => { const m = JSON.parse(data); messages.push(m); if (m.type === 'welcome') welcome = m; };
  await waitFor(() => welcome && hub.pendingPairings.size, 'welcome');
  socket.send(JSON.stringify({ type: 'team/create', name: 'Codex team', id: 'op1' }));
  await waitFor(() => messages.some((m) => m.type === 'team'), 'team');
  const team = messages.find((m) => m.type === 'team').team;
  socket.send(JSON.stringify({ type: 'runtime/pair', teamId: team.id, code: runtime.pairingCode, id: 'op2' }));
  await waitFor(() => runtime.teamId === team.id, 'paired');

  const command = (threadId, cmd) => {
    const id = 'cmd_' + randomBytes(8).toString('hex');
    socket.send(JSON.stringify({ type: 'command', id, threadId, runtimeId: runtime.id, command: cmd }));
    return waitFor(() => messages.find((m) => (m.type === 'command.result' && m.id === id) || (m.type === 'error' && m.ref === id)), cmd.method)
      .then((m) => { if (m.type === 'error' || !m.ok) throw new Error(m.error || m.message); return m; });
  };

  // Started on the demo agent, then switched to Codex - which is what a person does, and what
  // used to send the demo agent's model name to Codex and get a 400 back.
  const started = await command(null, { method: Commands.THREAD_START, cwd: project, name: 'Maintenance window' });
  const threadId = started.result.thread.id;
  socket.send(JSON.stringify({ type: 'thread.subscribe', threadId }));

  const began = Date.now();
  await command(threadId, {
    method: Commands.TURN_START,
    input: [{ type: 'text', text: 'Read ANSWER.txt in this project. Then record the maintenance window it names in a new file called WINDOW.md.' }],
    settings: { provider: 'codex-cli' }
  });
  // turn/start answers with a turn id the moment the turn begins, not when it ends. Waiting
  // for the thread to go idle again is waiting for the model to actually finish.
  const finished = await waitFor(
    () => messages.filter((m) => m.type === 'thread.updated' && m.thread.id === threadId
      && m.thread.lastTurnStatus).pop(),
    'the turn finishes', 4800);
  const seconds = Math.round((Date.now() - began) / 1000);
  if (finished.thread.lastTurnStatus !== 'completed') {
    const failure = messages.filter((m) => m.type === 'event' && m.method === 'turn/completed').pop();
    console.log('  turn failed: ' + JSON.stringify(failure && failure.error));
  }
  assert.equal(finished.thread.lastTurnStatus, 'completed', 'the turn completed: ' + finished.thread.lastTurnStatus);

  const written = fs.existsSync(path.join(project, 'WINDOW.md'))
    ? fs.readFileSync(path.join(project, 'WINDOW.md'), 'utf8') : null;
  assert.ok(written, 'the task produced WINDOW.md');
  assert.ok(written.includes(canary), 'and it contains what only the authorized workspace could tell it: ' + written.slice(0, 120));
  pass('a real Codex task runs from a switched-on host and changes a file', 'WINDOW.md in ' + seconds + 's, naming the canary');

  const outside = fs.existsSync(path.join(tmp, 'WINDOW.md'));
  assert.equal(outside, false, 'nothing was written outside the authorized project');
  pass('and wrote nothing outside the project it was given', 'the host applied every edit through its own writer');

  const out = path.join(__dirname, '..', '.artifacts', 'codex-provider-switch');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), codex: p.version, results }, null, 2) + '\n');
  console.log('\n' + results.length + ' codex switch checks recorded');
})().then(async () => {
  try { socket?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  await hub?.close?.(); process.exit(0);
}).catch(async (error) => {
  console.error('CODEX SWITCH FAILED\n', error);
  try { socket?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
