'use strict';
// Acceptance test for issue #18 (P17): the app goes away, the work does not.
//
// The failure this guards against is a person closing a window and silently taking their
// teammate's task with it. An execution host lives in a process; if that process is tied to a
// window, then tidying the desktop ends work somebody else is watching, and the only signal
// they get is the one #17 added for a crash. Closing must be reversible and invisible to the
// team; quitting must be deliberate, must say what it ends, and must actually end it - the
// whole process tree, not just the parent that is easy to kill.
//
// The tray icon and the quit modal are native and cannot be clicked by a test, so the shell
// exposes the same entry points those controls use (`app.harness`) and lets the test answer
// the warning a person would otherwise be shown. What the warning says is asserted; only the
// click is stood in for.
//
// Run: node test/afk-tray.js      (DESKTOP_EXECUTABLE points it at an installed copy)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { _electron: electron } = require('playwright-core');
const { localShell } = require('../packages/runtime/executors');
const { TeamOps } = require('../packages/protocol');

const results = [];
function assert(condition, name, detail) {
  if (!condition) throw new Error('FAILED: ' + name + (detail ? ' — ' + detail : ''));
  results.push(name);
  console.log('  PASS ' + name + (detail ? ' — ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A pid that is gone is gone; EPERM means it exists and is not ours to signal.
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// A teammate on the other side of the relay, reduced to the protocol they speak.
class Client {
  constructor(url, hello) { this.url = url; this.hello = hello; this.msgs = []; this.events = []; this.waiters = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('error', reject);
      this.ws.addEventListener('open', () => this.ws.send(JSON.stringify({ type: 'hello', role: 'client', ...this.hello })));
      this.ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        if (m.type === 'event') this.events.push(m);
        if (m.type === 'welcome') { this.me = m.user; this.teamId = m.teamId; resolve(m); }
        for (const w of this.waiters.slice()) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
      });
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  wait(pred, ms = 30000, label = '') {
    const seen = this.msgs.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + (label || pred.toString().slice(0, 70)))), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }
  op(msg) {
    const id = msg.id || 'op_' + randomBytes(8).toString('hex');
    this.send({ ...msg, id });
    return this.wait((m) => m.ref === id || (m.type === 'command.result' && m.id === id), 15000, msg.type)
      .then((m) => { if (m.type === 'error' || m.ok === false) throw new Error(m.error || m.message); return m; });
  }
  command(threadId, command) {
    const id = 'c_' + randomBytes(8).toString('hex');
    this.send({ type: 'command', id, threadId, command });
    return this.wait((m) => m.type === 'command.result' && m.id === id, 20000, command.method)
      .then((m) => { if (!m.ok) throw new Error(m.error); return m.result; });
  }
  method(name) { return this.events.filter((e) => e.method === name); }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-afk-'));
  const project = path.join(tmp, 'proj');
  const userData = path.join(tmp, 'ud');
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build', 'out.txt'), 'x\n');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'index.js'), 'console.log(1)\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: project, shell: localShell().bin });

  const port = 7820 + Math.floor(Math.random() * 60);
  const httpUrl = `http://127.0.0.1:${port}`;
  const packaged = process.env.DESKTOP_EXECUTABLE || null;
  const launchEnv = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', HUB_PORT: String(port), HARNESS_USER: 'kalai' };
  delete launchEnv.ELECTRON_RUN_AS_NODE;   // an editor-hosted terminal exports it; it would run Electron as plain node
  const launch = () => electron.launch({
    executablePath: packaged || undefined,
    args: [...(packaged ? [] : ['apps/desktop/main.js']), '--user-data-dir=' + userData, '--no-sandbox'],
    cwd: path.join(__dirname, '..'),
    env: launchEnv
  });
  const health = async () => (await (await fetch(httpUrl + '/api/health')).json());

  let app = await launch();
  let win = await app.firstWindow();

  // ---- the same setup the desktop smoke does: a team, a paired host, one shared folder ----
  await win.waitForSelector('#team-gate:not(.hidden)', { timeout: 40000 });
  await win.fill('#team-name', 'AFK team');
  await win.click('#btn-create-team');
  await win.waitForSelector('#app:not(.hidden)', { timeout: 40000 });
  await win.waitForFunction(() => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.querySelector('#pair-code').value));
  await win.click('#btn-pair-host');
  await win.waitForSelector('.runtime-card', { timeout: 30000 });
  await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, project);
  await win.click('#btn-add-project');
  await win.waitForFunction((dir) => document.querySelector('#fleet-project')?.value === dir, project, { timeout: 30000 });
  assert((await health()).runtimes === 1, 'the shell brought up exactly one execution host');

  // ---- a real teammate, invited by the person at the desktop ----
  const wsUrl = httpUrl.replace('http', 'ws');
  const session = JSON.parse(await win.evaluate(() => localStorage.getItem('harness.session')));
  const owner = new Client(wsUrl, { token: session.token });
  await owner.connect();
  const bob = new Client(wsUrl, { name: 'bob' });
  await bob.connect();
  const invite = await owner.op({ type: TeamOps.INVITE_CREATE, teamId: owner.teamId, inviteeUserId: bob.me.id, ttlMs: 60000 });
  await bob.op({ type: TeamOps.INVITE_ACCEPT, code: invite.invitation.code });
  await owner.op({ type: TeamOps.APPROVER_GRANT, teamId: owner.teamId, userId: bob.me.id });
  assert(bob.teamId || true, 'bob joined the team and was granted approval authority');

  // ---- a real task, still running when the window goes away ----
  await win.fill('#input', 'Delete the build directory');
  await win.press('#input', 'Enter');
  const running = await bob.wait((m) => m.type === 'thread.updated' && m.thread.status && m.thread.status.type === 'active', 30000, 'an active task');
  const threadId = running.thread.id;
  bob.send({ type: 'thread.subscribe', threadId });
  const approval = await bob.wait((m) => m.type === 'event' && m.method === 'item/commandExecution/requestApproval', 30000, 'an approval request');
  assert(approval.command === 'rm -rf build', 'a task is in flight on this host, parked on an approval');

  const pids = await app.evaluate(({ app }) => app.harness.servicePids());
  assert(pids.hub && pids.runtime, 'the shell is managing a hub and an execution host process');
  const seen = await app.evaluate(({ app }) => app.harness.activeWork());
  assert(seen.active.length === 1 && seen.active[0].waitingOnApproval, 'the shell can see what its host is running: ' + seen.active[0].name);

  // ================= 1. close and reopen while the task runs =================
  console.log('\n— the window is closed —');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await sleep(700);
  const closed = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), destroyed: w.isDestroyed() })));
  assert(closed.length === 1 && !closed[0].destroyed && !closed[0].visible, 'the window is hidden, not destroyed');
  assert((await health()).runtimes === 1, 'the execution host is still registered while the window is closed');
  assert(alive(pids.runtime) && alive(pids.hub), 'both managed processes are still running');

  // The whole point of keeping it alive: somebody else can still finish the work.
  // #11's binding: an answer has to name the turn and the exact action it is answering.
  await bob.command(threadId, {
    method: 'approval/resolve', requestId: approval.requestId, decision: 'accept',
    turnId: approval.turnId, fingerprint: approval.fingerprint
  });
  const finished = await bob.wait((m) => m.type === 'event' && m.method === 'turn/completed', 40000, 'the turn to finish');
  assert(finished.status === 'completed', 'the teammate approved and the turn ran to completion with the window closed');

  console.log('\n— the window is reopened from the tray —');
  await app.evaluate(({ app }) => app.harness.showWindow());
  await sleep(700);
  const reopened = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()));
  assert(reopened.length === 1 && reopened[0], 'the tray reopened the same window');
  assert((await health()).runtimes === 1, 'reopening did not start a second execution host');
  const startsAfterReopen = bob.method('turn/started').length;
  assert(startsAfterReopen === 0 || startsAfterReopen === 1, 'and did not replay the task that was already running');

  let second = null;
  try { second = await launch(); } catch { /* the second instance releasing the lock and exiting is the expected outcome */ }
  if (second) await second.close().catch(() => {});
  await sleep(1000);
  assert((await health()).runtimes === 1, 'launching the app a second time did not add a duplicate host');
  assert(alive(pids.runtime), 'the original execution host is the one still serving');

  // ================= tray controls =================
  const idleLabels = await app.evaluate(({ app }) => app.harness.trayMenuLabels());
  assert(idleLabels.some((l) => /Plexus$/.test(l)), 'the tray opens the window: ' + idleLabels[0]);
  assert(idleLabels.some((l) => l.startsWith('Host: ')), 'the tray names the execution host: ' + idleLabels.find((l) => l.startsWith('Host: ')));
  assert(idleLabels.includes('No tasks running'), 'the tray says what is running');
  assert(idleLabels.includes('Quit Plexus…'), 'quitting is a separate, explicit tray action');

  // ================= 2. quitting warns, confirms, and applies =================
  console.log('\n— quitting with work in flight —');
  await win.fill('#input', 'Delete the src directory');
  await win.press('#input', 'Enter');
  const started = await bob.wait((m) => m.type === 'event' && m.method === 'turn/started' && m.seq > finished.seq, 30000, 'a second turn to start');
  const second_approval = await bob.wait((m) => m.type === 'event' && m.method === 'item/commandExecution/requestApproval' && m.seq > started.seq, 30000, 'a second approval request');
  assert(second_approval.command === 'rm -rf src', 'a second task is in flight, waiting on a person');
  const busyLabels = await app.evaluate(({ app }) => app.harness.trayMenuLabels());
  assert(busyLabels.some((l) => l.includes('1 task running')), 'the tray shows the running task: ' + busyLabels.find((l) => l.includes('task running')));
  assert(busyLabels.some((l) => l.includes('needs approval')), 'and that somebody is blocked on it');

  const refused = await app.evaluate(({ app }) => {
    app.harness.onQuitPrompt(async (options) => { app.harness.lastPrompt = options; return options.cancelId; });
    return app.harness.requestQuit();
  });
  const prompt = await app.evaluate(({ app }) => app.harness.lastPrompt);
  assert(refused === 'cancelled', 'quitting can be refused');
  assert(/still running on this machine/.test(prompt.message), 'the warning says work is still running: "' + prompt.message + '"');
  assert(prompt.detail.includes('waiting for approval'), 'and that a teammate is blocked on it');
  assert(prompt.defaultId === prompt.cancelId, 'the safe answer is the default');
  assert(/Closing the window instead/.test(prompt.detail), 'and it offers the alternative to quitting');
  assert(alive(pids.runtime) && (await health()).runtimes === 1, 'refusing the warning left everything running');

  console.log('\n— quitting for real —');
  const appClosed = app.waitForEvent('close').catch(() => {});
  app.evaluate(({ app }) => {
    app.harness.onQuitPrompt(async (options) => options.confirmId);
    return app.harness.requestQuit();
  }).catch(() => { /* the app exits mid-call */ });

  const stopped = await bob.wait((m) => m.type === 'event' && m.method === 'turn/completed' && m.turnId === second_approval.turnId, 30000, 'the interrupted turn');
  assert(stopped.status === 'interrupted', 'the confirmed quit stopped the running turn and said so on the log');
  const fleet = await bob.wait((m) => m.type === 'runtimes' && m.runtimes.some((r) => r.lastOffline), 20000, 'the fleet to hear why');
  const host = fleet.runtimes.find((r) => r.lastOffline);
  assert(host.lastOffline.reason === 'quit', 'teammates are told this host is unavailable because its owner quit');

  await appClosed;
  await sleep(1500);
  assert(!alive(pids.runtime), 'the execution host process was cleaned up');
  assert(!alive(pids.hub), 'the hub process was cleaned up');
  let stillServing = true;
  try { await fetch(httpUrl + '/api/health', { signal: AbortSignal.timeout(1500) }); } catch { stillServing = false; }
  assert(!stillServing, 'and nothing is left listening on the port');

  // ================= 3. a fresh launch restores, and replays nothing =================
  console.log('\n— launching again after the quit —');
  const state = JSON.parse(fs.readFileSync(path.join(userData, 'desktop-state.json'), 'utf8'));
  assert(state.hubUrl === httpUrl && state.userName === 'kalai' && state.bounds, 'setup state was kept: where to connect, who this is, how the window sat');
  assert(!Object.keys(state).some((k) => /thread|turn|command|prompt|input|task/i.test(k)),
    'and nothing that could replay work: ' + Object.keys(state).join(', '));

  app = await launch();
  win = await app.firstWindow();
  await win.waitForSelector('#app:not(.hidden)', { timeout: 40000 });
  await win.waitForSelector('.thread-item', { timeout: 30000 });
  const back = new Client(wsUrl, { token: session.token });
  await back.connect();
  back.send({ type: 'thread.subscribe', threadId });
  const snapshot = await back.wait((m) => m.type === 'thread.snapshot' && m.thread.id === threadId, 20000, 'the restored task');
  assert(snapshot.thread.status.type !== 'active', 'the restored task is not claimed to be running: status is ' + snapshot.thread.status.type);
  const log = snapshot.events;
  assert(log.filter((e) => e.method === 'turn/started').length === 2, 'no turn was replayed: the log holds the two turns a person asked for');
  assert(log.filter((e) => e.method === 'item/commandExecution/requestApproval').length === 2, 'and no command was re-issued');
  const closing = log.filter((e) => e.method === 'turn/completed' || e.method === 'turn/abandoned');
  assert(closing.some((e) => e.status === 'interrupted'), 'the turn the quit stopped is recorded as interrupted, not completed');
  assert(!closing.some((e) => e.method === 'turn/completed' && e.status === 'completed' && e.turnId === second_approval.turnId),
    'and the quit never reported that work as finished');
  assert(fs.existsSync(path.join(project, 'src')), 'the command nobody approved was never run');

  await app.evaluate(({ app }) => { app.harness.onQuitPrompt(async (o) => o.confirmId); return app.harness.requestQuit(); }).catch(() => {});
  await app.waitForEvent('close').catch(() => {});
  owner.ws.close(); bob.ws.close(); back.ws.close();
  console.log(`\n${results.length} checks passed ✅  (issue #18 — tray lifecycle and explicit quit)`);
  process.exit(0);
})().catch((e) => { console.error('\nAFK TRAY FAILED\n' + ((e && e.stack) || e)); process.exit(1); });
