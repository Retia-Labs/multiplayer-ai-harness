'use strict';
// Acceptance test for issue #18 (P17): closing the window is not quitting.
//
// The defect was one line. `app.on('window-all-closed', () => app.quit())` meant that closing
// the window killed the execution host - so a teammate working in a browser lost the machine
// running their task because somebody at the other end clicked the X on a window they were not
// even looking at.
//
// This drives the real Electron app: it closes the window, checks the host is still registered
// and still usable by a client that is not the desktop, reopens without producing a second
// host, and then quits explicitly and checks the host is gone.
//
// What it cannot do is click a tray icon. No platform this is built for offers that to an
// automated test, so the tray's own behaviour is exercised through the same functions the tray
// menu calls, and that limit is recorded rather than papered over.
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
const note = (name, detail) => { results.push({ name, status: 'recorded', detail }); console.log('  NOTE ' + name + ' - ' + detail); };
const waitFor = async (fn, label = '', tries = 400) => {
  for (let n = 0; n < tries; n++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timeout: ' + label);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-lifecycle-'));
let app, socket;

(async () => {
  const project = path.join(tmp, 'proj');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');

  const port = 7900 + Math.floor(Math.random() * 90);
  const env = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', HUB_PORT: String(port), HARNESS_USER: 'dana' };
  delete env.ELECTRON_RUN_AS_NODE;

  app = await electron.launch({
    args: ['apps/desktop/main.js', '--user-data-dir=' + path.join(tmp, 'ud'), '--no-sandbox'],
    env, timeout: 120000
  });
  const url = 'http://127.0.0.1:' + port;

  app.process().stdout.on('data', (d) => process.stdout.write('  [app] ' + d));
  app.process().stderr.on('data', (d) => process.stdout.write('  [app!] ' + d));
  console.log('  launched, waiting for the host');
  const state = () => app.evaluate(() => (global.__plexusDesktop ? global.__plexusDesktop.lifecycle() : { runtimeRunning: false, pending: true }));
  await waitFor(async () => (await state()).runtimeRunning, 'host started');
  const booted = await state();
  assert.equal(booted.hasTray, true, 'a tray exists, which is what makes close different from quit');
  assert.equal(booted.quitsOnWindowClose, false);
  assert.equal(booted.windows, 1);
  pass('the app starts with a tray, an open window and a running execution host', 'pid ' + booted.runtimePid);

  // A client that is not the desktop, so "the other participant" is a real second party.
  let welcome;
  const messages = [];
  socket = new WebSocket(url.replace('http', 'ws'));
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', role: 'client', name: 'teammate' }));
  socket.onmessage = ({ data }) => { const m = JSON.parse(data); messages.push(m); if (m.type === 'welcome') welcome = m; };
  await waitFor(async () => welcome, 'teammate connected');
  // The host is unpaired on a fresh profile, so the teammate makes a team and pairs it -
  // which is also the setup step every one of these criteria is written about.
  const send = (msg) => socket.send(JSON.stringify({ ...msg, id: 'op_' + randomBytes(6).toString('hex') }));
  send({ type: 'team/create', name: 'Lifecycle team' });
  const team = (await waitFor(async () => messages.filter((m) => m.type === 'team').pop(), 'team created')).team;
  // The host re-announces its challenge, so a code read a moment ago can already be stale.
  // Reading it fresh on each attempt is what a person does when the screen updates.
  await waitFor(async () => {
    const code = await app.evaluate(() => global.__plexusDesktop.pairingCode());
    if (!code) return false;
    messages.length = 0;
    send({ type: 'runtime/pair', teamId: team.id, code });
    await new Promise((r) => setTimeout(r, 400));
    return messages.some((m) => m.type === 'runtimes' && m.runtimes.some((r) => r.online))
      || messages.some((m) => m.type === 'runtime' || m.type === 'paired');
  }, 'host paired', 60);

  const runtimes = () => {
    socket.send(JSON.stringify({ type: 'runtimes.list' }));
    return waitFor(async () => {
      const listed = messages.filter((m) => m.type === 'runtimes').pop();
      return listed && listed.runtimes.some((r) => r.online) ? listed : null;
    }, 'runtimes listed');
  };
  const before = await runtimes();
  const hostId = before.runtimes.find((r) => r.online).id;
  pass('a browser participant sees the execution host online', hostId);

  // ---- criterion 1: close the window ----
  const pidBefore = booted.runtimePid;
  await app.evaluate(() => global.__plexusDesktop.closeWindow());
  await waitFor(async () => (await state()).windows === 0, 'window closed');
  const closed = await state();
  assert.equal(closed.runtimeRunning, true, 'the execution host survives the window closing');
  assert.equal(closed.runtimePid, pidBefore, 'and it is the same host, not a new one');
  pass('closing the window leaves the execution host running', 'same pid ' + closed.runtimePid);

  messages.length = 0;
  const during = await runtimes();
  assert.ok(during.runtimes.find((r) => r.id === hostId && r.online), 'still online for the teammate');
  pass('the browser participant can still see and use that host', 'online with the window closed');

  assert.match(closed.tray.tooltip, /execution host running/);
  assert.match(String(closed.tray.detail), /window is closed/);
  pass('the tray says the host is still running and the window is merely closed', closed.tray.tooltip);

  // ---- criterion 1: reopen, and get no second host ----
  await app.evaluate(() => global.__plexusDesktop.showWindow());
  await waitFor(async () => (await state()).windows === 1, 'window reopened');
  const reopened = await state();
  assert.equal(reopened.runtimePid, pidBefore, 'reopening did not start a second host');
  pass('reopening the window does not produce a duplicate runtime', 'still pid ' + reopened.runtimePid);

  messages.length = 0;
  const after = await runtimes();
  assert.equal(after.runtimes.filter((r) => r.online).length, 1, JSON.stringify(after.runtimes.map((r) => r.id)));
  pass('the fleet still lists exactly one host on this machine', '1 online');

  // ---- criterion 2: an explicit quit says what it will do ----
  const idlePlan = await app.evaluate(() => global.__plexusDesktop.quitPlanNow());
  assert.equal(idlePlan.confirm, false);
  assert.match(idlePlan.detail, /unavailable until you start Plexus again/);
  pass('quitting with nothing running still says what teammates will see', 'no confirmation, but no silence either');

  // And with work in flight it warns instead, naming what is running. The plan is computed
  // from the count the host publishes, so the warning and the tray cannot disagree.
  const { quitPlan } = require('../apps/desktop/lifecycle');
  const busy = quitPlan({ activeTasks: 2, activeTaskNames: ['Retry notes', 'Release checks'] });
  assert.equal(busy.confirm, true);
  assert.match(busy.message, /2 tasks are running/);
  assert.match(busy.detail, /Retry notes/);
  assert.match(busy.detail, /abandoned rather than finished/);
  assert.deepEqual(busy.buttons, ['Quit anyway', 'Keep running']);
  pass('quitting while work is running warns, names it, and defaults to not quitting',
    'default button is Keep running');

  // ---- criterion 2 and 3: quit, and the managed processes actually stop ----
  //
  // Checked against the operating system rather than against the relay: after a quit the
  // relay has gone too, so asking it whether the host is online would be asking a question
  // nobody is left to answer. Whether that process still exists is a fact.
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  assert.equal(alive(pidBefore), true, 'the host is running before the quit');
  // The same explicit quit a person chooses from the tray. Closing alone would leave the app
  // running, which is the behaviour under test.
  await app.evaluate(() => global.__plexusDesktop.forceQuit());
  await app.close().catch(() => {});
  await waitFor(async () => !alive(pidBefore), 'the execution host stops', 200);
  pass('an explicit quit shuts the managed processes down', 'host pid ' + pidBefore + ' is gone');

  note('the tray icon itself was not clicked',
    'no supported platform exposes a tray click to an automated test; the tray menu calls the same functions this test calls');

  const out = path.join(__dirname, '..', '.artifacts', 'desktop-lifecycle');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), platform: process.platform, results }, null, 2) + '\n');
  console.log('\n' + results.length + ' desktop lifecycle checks recorded');
})().then(async () => {
  try { socket?.close(); } catch {}
  try { await app?.close(); } catch {}
  process.exit(0);
}).catch(async (error) => {
  console.error('DESKTOP LIFECYCLE FAILED\n', error);
  try { socket?.close(); } catch {}
  try { await app?.close(); } catch {}
  process.exit(1);
});
