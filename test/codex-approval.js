// Issue #2, criterion 1: "one bounded approval resolution" inside a REAL Codex task.
//
// `codex exec` cannot do this - it enforces its own sandbox and never asks the caller
// anything - so this drives `codex app-server`, whose protocol carries approval requests.
// Bob approves a command Alice's agent wants to run, and the evidence is Codex's own
// request/response on the wire, not the harness's rendering of it.
//
// Needs a working `codex` login. Run with: node test/codex-approval.js [--model gpt-5.4-mini]
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime/index');
const { probe } = require('../packages/runtime/codex-probe');
const { Commands, Events } = require('../packages/protocol');

const args = process.argv.slice(2);
const MODEL = args.includes('--model') ? args[args.indexOf('--model') + 1] : null;
const TIMEOUT = 240000;

class Client {
  constructor(url, name) { this.url = url; this.name = name; this.msgs = []; this.waiters = []; }
  connect() {
    return new Promise((resolve) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => this.ws.send(JSON.stringify({ type: 'hello', role: 'client', name: this.name, org: 'local' })));
      this.ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        if (m.type === 'welcome') { this.me = m.user; resolve(m); }
        for (const w of this.waiters.slice()) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
      });
    });
  }
  close() { try { this.ws.close(); } catch {} }
  wait(pred, ms = 30000, label = '') {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout: ' + label)), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  command(threadId, command, runtimeId) {
    const id = 'c_' + Math.random().toString(36).slice(2);
    this.ws.send(JSON.stringify({ type: 'command', id, threadId, runtimeId, command }));
    return this.wait((m) => m.type === 'command.result' && m.id === id, 60000, command.method)
      .then((m) => { if (!m.ok) throw new Error(m.error); return m.result; });
  }
}

(async () => {
  const p = probe();
  console.log('\nCodex approval through app-server\n');
  console.log(`  codex   ${p.version || 'not found'} (${p.resolved.kind})`);
  console.log(`  auth    ${p.auth ? p.auth.mode : 'n/a'}\n`);
  if (!p.version) { console.log('BLOCKED: no codex binary on this machine.'); process.exit(0); }
  if (p.auth.mode === 'none') { console.log('BLOCKED: codex is not logged in. Run `codex login`.'); process.exit(0); }

  const model = MODEL || (p.models.models.find((m) => /mini/.test(m)) || p.models.models[0]);
  console.log(`  model   ${model || '(cli default)'}\n`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-approval-'));
  const project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build', 'out.txt'), 'x');
  fs.writeFileSync(path.join(project, 'hello.js'), 'console.log(1)\n');
  try {
    const git = (...a) => execFileSync('git', a, { cwd: project, stdio: 'ignore' });
    git('init', '-q', '-b', 'main'); git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  } catch {}

  const hub = new Hub({ dbFile: ':memory:', log: () => {} });
  const addr = await hub.listen(0);
  const url = `ws://127.0.0.1:${addr.port}`;
  const taps = [];
  const rt = new Runtime({ hubUrl: url, userName: 'alice', dataDir: path.join(tmp, 'rt'), projects: [project], log: () => {} });
  if (!rt.providerList().some((provider) => provider.id === 'codex-app-server' && provider.configured)) {
    console.log('BLOCKED: production CLI providers require proven project isolation; the experimental approval proof is not enabled.');
    rt.stop();
    await hub.close();
    return;
  }
  rt.providerTap = (line, msg) => taps.push({ at: Date.now(), line, msg });
  await rt.start();

  const alice = new Client(url, 'alice'); await alice.connect();
  const bob = new Client(url, 'bob'); await bob.connect();
  alice.ws.send(JSON.stringify({ type: 'runtimes.list' }));
  await alice.wait((m) => m.type === 'runtimes' && m.runtimes.some((r) => r.online), 15000, 'runtime');

  const { thread } = await alice.command(null, {
    method: Commands.THREAD_START, cwd: project, name: 'approval through app-server',
    // 'agent-untrusted' maps to Codex's `untrusted` policy, so it asks before running
    // anything rather than only before something it judges risky.
    settings: { provider: 'codex-app-server', model, preset: 'agent-untrusted' }
  }, rt.id);
  alice.ws.send(JSON.stringify({ type: 'thread.subscribe', threadId: thread.id }));
  bob.ws.send(JSON.stringify({ type: 'thread.subscribe', threadId: thread.id }));
  await bob.wait((m) => m.type === 'thread.snapshot' && m.thread.id === thread.id);

  await alice.command(thread.id, {
    method: Commands.TURN_START,
    input: [{ type: 'text', text: 'Run the shell command `ls -la` in this directory. You must actually execute it as a shell command, not describe it. Then reply DONE.' }]
  });
  console.log('  alice started a real Codex turn');

  // The whole point: a second human sees Codex asking, and answers it.
  let approvalEvent;
  try {
    approvalEvent = await bob.wait(
      (m) => m.type === 'event' && m.threadId === thread.id && m.method === Events.COMMAND_REQUEST_APPROVAL,
      TIMEOUT, 'approval request from Codex');
  } catch (err) {
    console.log('\n  ✗ Codex never asked for approval within the timeout.');
    console.log('    provider lines seen:', taps.length);
    const methods = [...new Set(taps.map((t) => t.msg && t.msg.method).filter(Boolean))];
    console.log('    app-server methods:', methods.slice(0, 12).join(', '));
    rt.stop(); await hub.close();
    process.exit(1);
  }

  console.log(`  ✓ Codex asked a human before running: ${String(approvalEvent.command).slice(0, 60)}`);
  assert.ok(approvalEvent.requestId, 'the approval carries a request id');

  await bob.command(thread.id, { method: Commands.APPROVAL_RESOLVE, requestId: approvalEvent.requestId, decision: 'accept' });
  const resolved = await bob.wait((m) => m.type === 'event' && m.method === Events.SERVER_REQUEST_RESOLVED, 30000, 'resolution');
  assert.equal(resolved.by.name, 'bob', 'the resolution is attributed to whoever answered');
  console.log(`  ✓ bob resolved it (${resolved.decision}), attributed to ${resolved.by.name}`);

  const done = await alice.wait((m) => m.type === 'event' && m.method === Events.TURN_COMPLETED, TIMEOUT, 'turn completion');
  console.log(`  ✓ the turn completed (${done.status})`);

  // Provider acknowledgment, not UI-only success: Codex's own request on the wire.
  const askedOnWire = taps.filter((t) => t.msg && t.msg.method === Events.COMMAND_REQUEST_APPROVAL);
  assert.ok(askedOnWire.length >= 1, 'the approval request should appear on the app-server wire');
  console.log(`  ✓ recorded from Codex's own protocol, not the UI (${askedOnWire.length} request${askedOnWire.length > 1 ? 's' : ''} on the wire)`);

  const gone = !fs.existsSync(path.join(project, 'build'));
  console.log(`  ${gone ? '✓' : '·'} the approved command ${gone ? 'ran on the execution host' : 'did not delete build/ (Codex may have chosen another route)'}`);

  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'proofs', 'codex-approval-wire.jsonl'),
    taps.map((t) => t.line).join('\n') + '\n');

  alice.close(); bob.close(); rt.stop(); await hub.close();
  console.log('\napproval through app-server proved ✅');
  process.exit(0);
})().catch((err) => { console.error('\nFAILED:', err && err.message); process.exit(1); });
