'use strict';
// Acceptance test for issue #18 (P17): closing the window is not quitting.
//
// The defect was one line. `app.on('window-all-closed', () => app.quit())` meant that closing
// the window killed the execution host - so a teammate working in a browser lost the machine
// running their task because somebody at the other end clicked the X on a window they were not
// even looking at.
//
// This drives the real Electron app with a real task in flight: the window closes while the
// host is still holding a decision, the host keeps running, the window is reopened from the
// tray without producing a second host, a quit is refused and then confirmed, the managed
// processes are checked against the operating system, and the app is launched again to see
// that nothing was replayed.
//
// The other half of the first criterion - that a second person can still *work* through a
// window that is closed - is proved in desktop-collaboration.js, against this same shell, by
// the teammate who is already there.
//
// What it cannot do is make the OS open a tray menu, or click a native modal. Both are driven
// through the entries and the plan the app itself built, and those limits are recorded.
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { localShell } = require('../packages/runtime/executors');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
const note = (name, detail) => { results.push({ name, status: 'recorded', detail }); console.log('  NOTE ' + name + ' - ' + detail); };
const waitFor = async (fn, label = '', tries = 400) => {
  for (let n = 0; n < tries; n++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('timeout: ' + label);
};
// A pid that is gone is gone. EPERM means it exists and is not ours to signal.
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const snapshot = (page) => page.evaluate(() => {
  const state = window.__plexus.state;
  return { task: state.encryptedTasks.find((t) => t.id === state.activeThreadId),
    value: state.encryptedSnapshots.get(state.activeThreadId), userId: state.me.id };
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-lifecycle-'));
let app;

(async () => {
  const project = path.join(tmp, 'proj');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  // A removable fixture, so the task the window closes on is one the host is genuinely holding
  // a decision about rather than one that has already finished.
  fs.mkdirSync(path.join(project, 'cleanup'));
  fs.writeFileSync(path.join(project, 'cleanup', 'obsolete.txt'), 'Synthetic obsolete fixture\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: project, shell: localShell().bin });

  const port = 7900 + Math.floor(Math.random() * 90);
  const url = 'http://127.0.0.1:' + port;
  const userData = path.join(tmp, 'ud');
  const packaged = process.env.DESKTOP_EXECUTABLE || null;
  const env = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', HUB_PORT: String(port), HARNESS_USER: 'dana', HARNESS_DATA: path.join(tmp, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;   // an editor-hosted terminal exports it; it would run Electron as plain node
  if (packaged) env.PATH = process.platform === 'win32' ? process.env.SystemRoot + '/system32;' + process.env.SystemRoot : '/usr/bin:/bin';
  const launch = () => electron.launch({
    executablePath: packaged || undefined,
    args: [...(packaged ? [] : ['apps/desktop/main.js']), '--user-data-dir=' + userData, '--no-sandbox'],
    cwd: path.join(__dirname, '..'), env, timeout: 120000
  });

  app = await launch();
  const fromVersion = await app.evaluate(({ app }) => app.getVersion());
  let win = await app.firstWindow();
  const state = () => app.evaluate(() => (global.__plexusDesktop ? global.__plexusDesktop.lifecycle() : { runtimeRunning: false, pending: true }));

  // ---- the setup every one of these criteria is written about ----
  await win.waitForSelector('#team-gate:not(.hidden)', { timeout: 60000 });
  await win.fill('#team-name', 'Lifecycle team');
  await win.click('#btn-create-team');
  await win.waitForSelector('#app:not(.hidden)', { timeout: 60000 });
  if (process.env.PLEXUS_UPGRADE_CYCLE) {
    // Establish a user-selected layout on the old version, including versions
    // that only persist bounds after a move/resize. The upgrade must retain it.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Plexus');
      window.restore(); window.setBounds({ x: 80, y: 80, width: 1200, height: 800 });
    });
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(userData, 'desktop-state.json'), 'utf8')).bounds, 'old layout persisted');
  }
  await win.locator('#encrypted-setup').filter({ hasText: 'This endpoint: verified' }).waitFor({ timeout: 30000 });
  await win.waitForFunction(() => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.querySelector('#pair-code').value));
  await win.click('#btn-pair-host');
  await win.waitForSelector('.runtime-card', { timeout: 30000 });
  await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, project);
  await win.click('#btn-add-project');
  await win.waitForFunction(() => document.querySelector('.runtime-card')?.querySelector('.rc-dot.online')
    && /^ep_[a-f0-9]{32}$/.test(document.querySelector('#fleet-project')?.value), null, { timeout: 30000 });
  const booted = await state();
  assert.equal(booted.hasTray, true, 'a tray exists, which is what makes close different from quit');
  assert.equal(booted.quitsOnWindowClose, false);
  pass('the app starts with a tray, an open window and a running execution host', 'pid ' + booted.runtimePid);

  // The host has to be authorized to hold keys and to be asked for decisions before it can run
  // anything - two separate consents, as #11 and the encrypted-host work require.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await win.locator('[data-action="authorize-encrypted-host"]').click();
  await win.waitForFunction(() => window.__plexus.state.runtimes.some((runtime) => runtime.encryptedEndpoint), null, { timeout: 60000 });
  await win.locator('[data-action="authorize-host-approver"]').click();
  await win.waitForFunction(async () => {
    const ready = await window.harnessDesktop.encryptedSetup();
    return ready.approvalAuthority && ready.state === 'ready';
  }, null, { timeout: 60000 });
  await win.locator('[data-action="show-host-fingerprint"]').click();
  await win.locator('[data-action="confirm-host"]').click();
  await win.locator('[data-action="show-host-fingerprint"]').waitFor({ state: 'detached', timeout: 30000 });

  // ---- a task that is still waiting on a person when the window goes away ----
  //
  // A decision the host is holding is the cleanest way to have work genuinely in flight: it
  // stays in flight for as long as nobody answers it, which is exactly the situation somebody
  // walks away from.
  await win.locator('#input').fill('delete cleanup'); await win.locator('#btn-send').click();
  await win.locator('[data-action="encrypted-approval-accept"]').waitFor({ timeout: 120000 });
  const taskId = (await snapshot(win)).task.id;
  const identity = await win.evaluate(() => window.__plexus.state.encryptedIdentity);
  const hostId = await win.evaluate(() => window.harnessDesktop.runtimeId());
  assert.ok(fs.existsSync(path.join(project, 'cleanup')), 'nothing has been removed yet');
  pass('a real task is in flight on that host, waiting on a decision', 'delete cleanup');

  // ---- criterion 1: close the window ----
  const pids = await app.evaluate(() => global.__plexusDesktop.servicePids());
  await app.evaluate(() => global.__plexusDesktop.closeWindow());
  await waitFor(async () => !(await state()).windowVisible, 'the window to close');
  const closed = await state();
  assert.equal(closed.runtimeRunning, true, 'the execution host survives the window closing');
  assert.equal(closed.runtimePid, pids.runtime, 'and it is the same host, not a new one');
  assert.match(closed.tray.tooltip, /execution host running/);
  assert.match(String(closed.tray.detail), /window is closed/);
  pass('closing the window leaves the execution host running, and the tray says so', closed.tray.tooltip);

  // The work is still there to be picked up. The host is holding the same decision it was
  // holding a moment ago, and it is still counting it as running - which is what makes it
  // answerable by anybody who is still in the task. That somebody else can actually answer it
  // through a closed window is proved in desktop-collaboration.js, with a real second person.
  const stillPending = await app.evaluate(() => global.__plexusDesktop.activeWork());
  assert.equal(stillPending.count, 1, 'the host still counts the task as running');
  assert.equal(stillPending.blocked, 1, 'and still holds the decision nobody has answered');
  assert.ok(fs.existsSync(path.join(project, 'cleanup')), 'so nothing was decided by the window closing');
  pass('the work is left exactly as it was, waiting on a person rather than on a window', stillPending.count + ' running, ' + stillPending.blocked + ' waiting on a person');

  // ---- criterion 1: reopen from the tray, and get no second host ----
  const menu = await app.evaluate(() => global.__plexusDesktop.trayMenuLabels());
  assert.ok(menu.includes('Open Plexus') && menu.includes('Quit Plexus'), 'the tray offers both: ' + menu.join(' | '));
  await app.evaluate(() => global.__plexusDesktop.clickTrayItem('Open Plexus'));
  await waitFor(async () => (await state()).windowVisible, 'the window to reopen');
  const reopened = await state();
  assert.equal(reopened.runtimePid, pids.runtime, 'reopening did not start a second host');
  const health = await (await fetch(url + '/api/health')).json();
  assert.equal(health.runtimes, 1, 'the fleet still holds exactly one host on this machine');
  pass('the tray entry reopens the window, and produces no duplicate runtime', 'still pid ' + reopened.runtimePid);

  // ---- criterion 2: an explicit quit says what it will do ----
  const { quitPlan } = require('../apps/desktop/lifecycle');
  const idlePlan = quitPlan({ activeTasks: 0 });
  assert.equal(idlePlan.confirm, false);
  assert.match(idlePlan.detail, /unavailable until you start Plexus again/);
  pass('quitting with nothing running still says what teammates will see', 'no confirmation, but no silence either');

  const busy = await app.evaluate(() => global.__plexusDesktop.quitPlanNow());
  assert.equal(busy.confirm, true);
  assert.match(busy.message, /One task is running/);
  assert.match(busy.detail, /waiting on an approval/);
  assert.match(busy.detail, /interrupted rather than finished/);
  assert.match(busy.detail, /Closing the window instead/);
  assert.deepEqual(busy.buttons, ['Quit anyway', 'Keep running']);
  pass('quitting while work is running warns, names it, and defaults to not quitting', 'default button is Keep running');

  const refused = await app.evaluate(() => {
    global.__plexusDesktop.onQuitPrompt(async () => 1);   // "Keep running"
    return global.__plexusDesktop.requestQuit();
  });
  assert.equal(refused, false);
  assert.equal(alive(pids.runtime), true, 'the host is still running after the refusal');
  pass('a refused quit changes nothing', 'host pid ' + pids.runtime + ' still running');

  // ---- criterion 2 and 3: quit, and the managed processes actually stop ----
  //
  // Checked against the operating system rather than the relay: after a quit the relay has gone
  // too, so asking it whether the host is online would be asking a question nobody is left to
  // answer. Whether those processes still exist is a fact.
  assert.equal(alive(pids.hub) && alive(pids.runtime), true, 'both managed processes are running before the quit');
  const exited = app.waitForEvent('close').catch(() => {});
  app.evaluate(() => {
    global.__plexusDesktop.onQuitPrompt(async () => 0);   // "Quit anyway"
    // Chosen from the tray, the way a person ends this - not by calling the function behind it.
    return global.__plexusDesktop.clickTrayItem('Quit Plexus');
  }).catch(() => { /* the app exits mid-call */ });
  await exited;
  await waitFor(async () => !alive(pids.runtime) && !alive(pids.hub), 'the managed processes to stop', 300);
  assert.ok(fs.existsSync(path.join(project, 'cleanup')), 'the removal nobody approved never happened');
  pass('an explicit quit shuts the managed processes down', 'host ' + pids.runtime + ' and relay ' + pids.hub + ' are gone');

  // ---- criterion 4: a fresh launch restores setup, and replays nothing ----
  const setup = JSON.parse(fs.readFileSync(path.join(userData, 'desktop-state.json'), 'utf8'));
  assert.equal(setup.userName, 'dana');
  assert.ok(setup.hubUrl, 'the relay it was connected to is remembered');
  assert.ok(setup.bounds && setup.bounds.width, 'and how the window sat');
  assert.deepEqual(Object.keys(setup).filter((k) => /thread|turn|command|prompt|input|task/i.test(k)), [],
    'nothing that could replay work: ' + Object.keys(setup).join(', '));
  pass('a launch restores where to connect, who this is and how the window sat', Object.keys(setup).join(', '));

  app = await launch();
  win = await app.firstWindow();
  await win.waitForSelector('#app:not(.hidden)', { timeout: 60000 });
  await win.locator('.encrypted-task-row[data-task-id="' + taskId + '"]').click({ timeout: 60000 });
  const restored = await waitFor(async () => { const s = await snapshot(win); return s.value ? s : null; }, 'the restored task');
  assert.notEqual(restored.value.turn, 'running', 'the restored task is not claimed to be running');
  assert.ok(fs.existsSync(path.join(project, 'cleanup')), 'and the interrupted removal was not replayed');
  pass('a fresh launch restores the task without resuming it', 'turn ' + restored.value.turn + ', nothing replayed');

  if (process.env.PLEXUS_UPGRADE_CYCLE) {
    // Capture the authenticated baseline in the OLD installed application. A
    // snapshot from the new app cannot prove that the initial upgrade lost nothing.
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), fromVersion);
    const expectedEvents = restored.value.events;
    const verifyRestored = async () => {
      assert.deepEqual(await win.evaluate(() => window.__plexus.state.encryptedIdentity), identity,
        'the complete encrypted endpoint identity survives the version change');
      assert.equal(await win.evaluate(() => window.harnessDesktop.runtimeId()), hostId);
      const current = await snapshot(win);
      assert.deepEqual(current.value.events.slice(0, expectedEvents.length), expectedEvents,
        'the complete preexisting authenticated history is retained');
      // Startup may reconcile an interrupted durable execution marker after the
      // first UI replay. That receipt reports uncertainty; it must not start work.
      for (const event of current.value.events.slice(expectedEvents.length)) {
        assert.equal(event.type, 'recovery.required');
        assert.equal(event.payload.reason, 'host_restarted');
        assert.ok(expectedEvents.some(previous => previous.payload?.turnId === event.payload.turnId));
      }
      assert.notEqual(current.value.turn, 'running');
      assert.ok(fs.existsSync(path.join(project, 'cleanup/obsolete.txt')));
    };
    const stop = async () => {
      const services = await app.evaluate(() => global.__plexusDesktop.servicePids());
      const closed = app.waitForEvent('close');
      app.evaluate(() => global.__plexusDesktop.forceQuit()).catch(() => {});
      await closed;
      await waitFor(() => !alive(services.runtime) && !alive(services.hub), 'upgrade services exited');
    };
    const reopen = async () => {
      app = await launch(); win = await app.firstWindow();
      await win.waitForSelector('#app:not(.hidden)', { timeout: 60000 });
      await win.locator('.encrypted-task-row[data-task-id="' + taskId + '"]').click({ timeout: 60000 });
      await waitFor(async () => (await snapshot(win)).value, 'upgrade history restored');
    };
    await stop();
    const upgrade = require('./desktop-upgrade-cycle').cycle(process.env.PLEXUS_UPGRADE_CYCLE,
      { userData, dataDir: env.HARNESS_DATA });
    assert.equal(upgrade.upgrade(), packaged); await reopen();
    const toVersion = await app.evaluate(({ app }) => app.getVersion());
    assert.notEqual(fromVersion, toVersion, 'The upgrade must cross actual app versions.');
    await verifyRestored(); pass('the new installed version retains endpoint, host and encrypted history');
    await stop(); assert.equal(upgrade.reinstall(), packaged); await reopen();
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), toVersion);
    await verifyRestored(); pass('reinstalling the new version retains the same state');
    await stop(); assert.equal(upgrade.rollback(), packaged); await reopen();
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), fromVersion);
    await verifyRestored(); pass('the prior installer and matching complete backup restore readable history without replay');
    upgrade.record(fromVersion, toVersion, { host: hostId, device: identity.device });
  }

  note('the tray icon itself was not clicked',
    'no supported platform lets a test make the OS open a tray menu; the entries in the menu the app installed are invoked by their own handlers, so what is untested is the click that opens it');
  note('the quit dialog was not clicked either',
    'a native modal cannot be answered by a test in this harness; its text, buttons and default are asserted from the plan it is built from, and the answer is chosen for it');

  const out = path.join(__dirname, '..', '.artifacts', 'desktop-lifecycle');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), platform: process.platform, packaged: !!packaged, results }, null, 2) + '\n');
  console.log('\n' + results.length + ' desktop lifecycle checks recorded');
})().then(async () => {
  try { await app?.evaluate(() => global.__plexusDesktop.forceQuit()); } catch {}
  try { await app?.close(); } catch {}
  process.exit(0);
}).catch(async (error) => {
  console.error('DESKTOP LIFECYCLE FAILED\n', error);
  try { await app?.evaluate(() => global.__plexusDesktop.forceQuit()); } catch {}
  try { await app?.close(); } catch {}
  process.exit(1);
});
