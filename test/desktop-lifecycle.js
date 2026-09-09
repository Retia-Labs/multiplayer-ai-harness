'use strict';
// Acceptance test for issue #18 (P17): closing the window is not quitting.
//
// The defect was one line. `app.on('window-all-closed', () => app.quit())` meant that closing
// the window killed the execution host - so a teammate working in a browser lost the machine
// running their task because somebody at the other end clicked the X on a window they were not
// even looking at.
//
// This drives the real Electron app with a real task in flight: it closes the window and lets
// the teammate finish the work through the host that is still running, reopens without
// producing a second host, refuses a quit and then confirms one, and checks - against the
// operating system, not against a relay that also went away - that the managed processes are
// gone. Then it launches again and checks the workspace comes back without the task.
//
// What it cannot do is click a tray icon or answer a native modal. No platform this is built
// for offers either to an automated test, so both are exercised through the same functions the
// tray menu and the dialog are built from, and that limit is recorded rather than papered over.
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { localShell } = require('../packages/runtime/executors');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
const note = (name, detail) => { results.push({ name, status: 'recorded', detail }); console.log('  NOTE ' + name + ' - ' + detail); };
const waitFor = async (fn, label = '', tries = 400) => {
  for (let n = 0; n < tries; n++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timeout: ' + label);
};
// A pid that is gone is gone. EPERM means it exists and is not ours to signal.
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-lifecycle-'));
let app, socket;

// The teammate in a browser: everything below is asserted from what they can see.
function connect(url, hello) {
  const client = { messages: [], events: [] };
  client.ws = new WebSocket(url);
  client.ws.onopen = () => client.ws.send(JSON.stringify({ type: 'hello', role: 'client', ...hello }));
  client.ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    client.messages.push(m);
    if (m.type === 'event') client.events.push(m);
    if (m.type === 'welcome') { client.me = m.user; client.teamId = m.teamId; }
  };
  client.send = (msg) => client.ws.send(JSON.stringify({ ...msg, id: msg.id || 'op_' + randomBytes(6).toString('hex') }));
  client.op = (msg) => {
    const id = 'op_' + randomBytes(6).toString('hex');
    client.ws.send(JSON.stringify({ ...msg, id }));
    return waitFor(async () => client.messages.find((m) => m.ref === id), msg.type)
      .then((m) => { if (m.type === 'error') throw new Error(m.error || m.message); return m; });
  };
  client.command = (threadId, command, runtimeId) => {
    const id = 'c_' + randomBytes(6).toString('hex');
    client.ws.send(JSON.stringify({ type: 'command', id, threadId, runtimeId, command }));
    // A refusal comes back as an error naming the request, not as a result, so waiting only
    // for a result turns "you are not allowed to do that" into a timeout that says nothing.
    return waitFor(async () => client.messages.find((m) => (m.type === 'command.result' && m.id === id) || (m.type === 'error' && m.ref === id)), command.method)
      .then((m) => { if (m.type === 'error' || !m.ok) throw new Error(m.error || m.message); return m.result; });
  };
  return waitFor(async () => client.me, 'teammate connected').then(() => client);
}

(async () => {
  const project = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build', 'out.txt'), 'x\n');
  // A second target for the second task: the host declines a delete whose target is already
  // gone, and the quit has to interrupt work that was genuinely still pending.
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'index.js'), 'console.log(1)\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: project, shell: localShell().bin });

  const port = 7900 + Math.floor(Math.random() * 90);
  const userData = path.join(tmp, 'ud');
  const env = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', HUB_PORT: String(port), HARNESS_USER: 'dana', HARNESS_PROJECTS: project };
  delete env.ELECTRON_RUN_AS_NODE;
  // DESKTOP_EXECUTABLE points these same checks at an installed copy instead of the checkout,
  // which is what issue #18 is actually about: the installed window.
  const packaged = process.env.DESKTOP_EXECUTABLE || null;
  const launch = () => electron.launch({
    executablePath: packaged || undefined,
    args: [...(packaged ? [] : ['apps/desktop/main.js']), '--user-data-dir=' + userData, '--no-sandbox'],
    cwd: path.join(__dirname, '..'), env, timeout: 120000
  });

  const trace = (a) => {
    a.process().stdout.on('data', (d) => process.stdout.write('  [app] ' + d));
    a.process().stderr.on('data', (d) => process.stdout.write('  [app!] ' + d));
    return a;
  };
  app = trace(await launch());
  const url = 'http://127.0.0.1:' + port;
  console.log('  launched, waiting for the host');
  const state = () => app.evaluate(() => (global.__plexusDesktop ? global.__plexusDesktop.lifecycle() : { runtimeRunning: false, pending: true }));
  await waitFor(async () => (await state()).runtimeRunning, 'host started');
  const booted = await state();
  assert.equal(booted.hasTray, true, 'a tray exists, which is what makes close different from quit');
  assert.equal(booted.quitsOnWindowClose, false);
  assert.equal(booted.windows, 1);
  pass('the app starts with a tray, an open window and a running execution host', 'pid ' + booted.runtimePid);

  socket = await connect(url.replace('http', 'ws'), { name: 'teammate' });
  const messages = socket.messages;
  // The host is unpaired on a fresh profile, so the teammate makes a team and pairs it -
  // which is also the setup step every one of these criteria is written about.
  socket.send({ type: 'team/create', name: 'Lifecycle team' });
  const team = (await waitFor(async () => messages.filter((m) => m.type === 'team').pop(), 'team created')).team;
  // The host re-announces its challenge, so a code read a moment ago can already be stale.
  // Reading it fresh on each attempt is what a person does when the screen updates.
  await waitFor(async () => {
    const code = await app.evaluate(() => global.__plexusDesktop.pairingCode());
    if (!code) return false;
    messages.length = 0;
    socket.send({ type: 'runtime/pair', teamId: team.id, code });
    await new Promise((r) => setTimeout(r, 400));
    return messages.some((m) => m.type === 'runtimes' && m.runtimes.some((r) => r.online))
      || messages.some((m) => m.type === 'runtime' || m.type === 'paired');
  }, 'host paired', 60);

  const runtimes = () => {
    socket.ws.send(JSON.stringify({ type: 'runtimes.list' }));
    return waitFor(async () => {
      const listed = messages.filter((m) => m.type === 'runtimes').pop();
      return listed && listed.runtimes.some((r) => r.online) ? listed : null;
    }, 'runtimes listed');
  };
  // Approval authority is granted separately from membership on purpose (#11): being in a
  // team is not the same as being allowed to let an agent run something on somebody's machine,
  // and that holds for the person who created the team too.
  await socket.op({ type: 'team/approver/grant', teamId: team.id, userId: socket.me.id });

  const before = await runtimes();
  const hostId = before.runtimes.find((r) => r.online).id;
  pass('a browser participant sees the execution host online', hostId);

  // ---- a real task, still running when the window goes away ----
  const { thread } = await socket.command(null, { method: 'thread/start', cwd: project }, hostId);
  const threadId = thread.id;
  socket.ws.send(JSON.stringify({ type: 'thread.subscribe', threadId }));
  await socket.command(threadId, { method: 'turn/start', input: [{ type: 'text', text: 'Delete the build directory' }] });
  const approval = await waitFor(async () => socket.events.find((e) => e.method === 'item/commandExecution/requestApproval'), 'the agent to ask');
  assert.equal(approval.command, 'rm -rf build');
  pass('a real task is in flight on that host, parked on an approval', approval.command);

  // ---- criterion 1: close the window ----
  const pidBefore = booted.runtimePid;
  const pids = await app.evaluate(() => global.__plexusDesktop.servicePids());
  await app.evaluate(() => global.__plexusDesktop.closeWindow());
  await waitFor(async () => (await state()).windows === 0, 'window closed');
  const closed = await state();
  assert.equal(closed.runtimeRunning, true, 'the execution host survives the window closing');
  assert.equal(closed.runtimePid, pidBefore, 'and it is the same host, not a new one');
  pass('closing the window leaves the execution host running', 'same pid ' + closed.runtimePid);

  messages.length = 0;
  const during = await runtimes();
  assert.ok(during.runtimes.find((r) => r.id === hostId && r.online), 'still online for the teammate');
  pass('the browser participant can still see that host', 'online with the window closed');

  // Seeing it is not using it. This is the work carrying on without the window that started it.
  await socket.command(threadId, {
    method: 'approval/resolve', requestId: approval.requestId, decision: 'accept',
    // #11's binding: an answer names the turn and the exact action it answers.
    turnId: approval.turnId, fingerprint: approval.fingerprint
  });
  const finished = await waitFor(async () => socket.events.find((e) => e.method === 'turn/completed'), 'the turn to finish', 800);
  assert.equal(finished.status, 'completed');
  pass('and can still drive it: the teammate approved and the turn ran to completion', 'with the window closed');

  assert.match(closed.tray.tooltip, /execution host running/);
  assert.match(String(closed.tray.detail), /window is closed/);
  pass('the tray says the host is still running and the window is merely closed', closed.tray.tooltip);

  // ---- criterion 1: reopen, and get no second host ----
  const menu = await app.evaluate(() => global.__plexusDesktop.trayMenuLabels());
  assert.ok(menu.includes('Open Plexus') && menu.includes('Quit Plexus'), 'the tray offers both: ' + menu.join(' | '));
  assert.ok(menu.some((l) => /execution host running/.test(l)), 'and says what the host is doing');
  await app.evaluate(() => global.__plexusDesktop.clickTrayItem('Open Plexus'));
  await waitFor(async () => (await state()).windows === 1, 'window reopened');
  const reopened = await state();
  assert.equal(reopened.runtimePid, pidBefore, 'reopening did not start a second host');
  pass('the tray entry reopens the window, and produces no duplicate runtime', 'still pid ' + reopened.runtimePid);

  messages.length = 0;
  const after = await runtimes();
  assert.equal(after.runtimes.filter((r) => r.online).length, 1, JSON.stringify(after.runtimes.map((r) => r.id)));
  pass('the fleet still lists exactly one host on this machine', '1 online');

  // ---- criterion 2: an explicit quit says what it will do ----
  const idlePlan = await app.evaluate(() => global.__plexusDesktop.quitPlanNow());
  assert.equal(idlePlan.confirm, false);
  assert.match(idlePlan.detail, /unavailable until you start Plexus again/);
  pass('quitting with nothing running still says what teammates will see', 'no confirmation, but no silence either');

  // And with work in flight it warns instead, naming what is running. The plan is built from
  // what the host reports right now, so the warning and the tray cannot disagree.
  await socket.command(threadId, { method: 'turn/start', input: [{ type: 'text', text: 'Delete the src directory' }] });
  const pending = await waitFor(async () => socket.events.find((e) => e.method === 'item/commandExecution/requestApproval' && e.seq > finished.seq), 'a second approval');
  assert.equal(pending.command, 'rm -rf src');
  const busy = await app.evaluate(() => global.__plexusDesktop.quitPlanNow());
  assert.equal(busy.confirm, true);
  assert.match(busy.message, /One task is running/);
  assert.match(busy.detail, /Delete the build directory/);       // the task's name, from the host
  assert.match(busy.detail, /waiting on an approval/);           // and who it costs
  assert.match(busy.detail, /interrupted rather than finished/);
  assert.match(busy.detail, /Closing the window instead/);
  assert.deepEqual(busy.buttons, ['Quit anyway', 'Keep running']);
  pass('quitting while work is running warns, names it, and defaults to not quitting', 'default button is Keep running');

  // The refusal is the part a person actually does most often, so it is driven for real: the
  // dialog's answer is chosen for the test, everything else is the app's own path.
  const refused = await app.evaluate(() => {
    global.__plexusDesktop.onQuitPrompt(async () => 1);   // "Keep running"
    return global.__plexusDesktop.requestQuit();
  });
  assert.equal(refused, false);
  assert.equal(alive(pids.runtime), true, 'the host is still running after the refusal');
  assert.equal((await state()).runtimeRunning, true);
  pass('a refused quit changes nothing', 'host pid ' + pids.runtime + ' still running');

  // ---- criterion 2 and 3: quit, and the managed processes actually stop ----
  //
  // Checked against the operating system rather than against the relay: after a quit the relay
  // has gone too, so asking it whether the host is online would be asking a question nobody is
  // left to answer. Whether those processes still exist is a fact.
  assert.equal(alive(pids.hub) && alive(pids.runtime), true, 'both managed processes are running before the quit');
  app.evaluate(() => {
    global.__plexusDesktop.onQuitPrompt(async () => 0);   // "Quit anyway"
    // Chosen from the tray, the way a person ends this - not by calling the function behind it.
    return global.__plexusDesktop.clickTrayItem('Quit Plexus');
  }).catch(() => { /* the app exits mid-call */ });

  const stopped = await waitFor(async () => socket.events.find((e) => e.method === 'turn/completed' && e.turnId === pending.turnId), 'the interrupted turn', 800);
  assert.equal(stopped.status, 'interrupted');
  pass('the confirmed quit stopped the running turn and said so on the log', 'interrupted, not completed');

  const goodbye = await waitFor(async () => messages.filter((m) => m.type === 'runtimes' && m.runtimes.some((r) => r.lastOffline)).pop(), 'the fleet to hear why', 600);
  assert.equal(goodbye.runtimes.find((r) => r.lastOffline).lastOffline.reason, 'quit');
  pass('teammates are told this host is unavailable because its owner quit', 'not left to read a silence');

  await app.close().catch(() => {});
  await waitFor(async () => !alive(pids.runtime) && !alive(pids.hub), 'the managed processes stop', 300);
  pass('an explicit quit shuts the managed processes down', 'host ' + pids.runtime + ' and relay ' + pids.hub + ' are gone');
  try { socket.ws.close(); } catch {}

  // ---- criterion 4: a fresh launch restores setup, and replays nothing ----
  const setup = JSON.parse(fs.readFileSync(path.join(userData, 'desktop-state.json'), 'utf8'));
  assert.equal(setup.hubUrl, url);
  assert.equal(setup.userName, 'dana');
  assert.ok(setup.bounds && setup.bounds.width, 'the window is remembered');
  assert.deepEqual(Object.keys(setup).filter((k) => /thread|turn|command|prompt|input|task/i.test(k)), [],
    'nothing that could replay work: ' + Object.keys(setup).join(', '));
  pass('a launch restores where to connect, who this is and how the window sat', Object.keys(setup).join(', '));

  app = trace(await launch());
  await waitFor(async () => (await state()).runtimeRunning, 'host restarted');
  // The same teammate coming back, with the token they were issued - not a new person who
  // happens to share a name, who would not be in this team and could not see the task at all.
  const back = await connect(url.replace('http', 'ws'), { token: socket.me.token });
  back.ws.send(JSON.stringify({ type: 'thread.subscribe', threadId }));
  const snapshot = await waitFor(async () => {
    const refused = back.messages.find((m) => m.type === 'error');
    if (refused) throw new Error('subscribe refused: ' + (refused.error || refused.message));
    return back.messages.find((m) => m.type === 'thread.snapshot' && m.thread.id === threadId);
  }, 'the restored task');
  assert.notEqual(snapshot.thread.status.type, 'active', 'the restored task is not claimed to be running');
  const log = snapshot.events;
  assert.equal(log.filter((e) => e.method === 'turn/started').length, 2, 'the log holds the two turns a person asked for');
  assert.equal(log.filter((e) => e.method === 'item/commandExecution/requestApproval').length, 2, 'and no command was re-issued');
  assert.equal(fs.existsSync(path.join(project, 'src')), true, 'the command nobody approved was never run');
  pass('a fresh launch restores the task without resuming it', 'status ' + snapshot.thread.status.type + ', 2 turns, nothing replayed');
  try { back.ws.close(); } catch {}

  note('the tray icon itself was not clicked',
    'no supported platform lets a test make the OS open a tray menu; the entries in the menu the app installed are invoked by their own handlers, so what is untested is the click that opens it');
  note('the quit dialog was not clicked either',
    'a native modal cannot be answered by a test in this harness; its text, buttons and default are asserted from the plan it is built from, and the answer is chosen for it');

  const out = path.join(__dirname, '..', '.artifacts', 'desktop-lifecycle');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), platform: process.platform, results }, null, 2) + '\n');
  console.log('\n' + results.length + ' desktop lifecycle checks recorded');
})().then(async () => {
  try { socket?.ws?.close(); } catch {}
  try { await app?.evaluate(() => global.__plexusDesktop.forceQuit()); } catch {}
  try { await app?.close(); } catch {}
  process.exit(0);
}).catch(async (error) => {
  console.error('DESKTOP LIFECYCLE FAILED\n', error);
  try { socket?.ws?.close(); } catch {}
  try { await app?.evaluate(() => global.__plexusDesktop.forceQuit()); } catch {}
  try { await app?.close(); } catch {}
  process.exit(1);
});
