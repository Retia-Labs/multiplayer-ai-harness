'use strict';
// A local UI endpoint is lost while the real desktop execution host and a trusted
// teammate survive. Only account sign-in, native dialogs and that storage loss are
// fixtures: all key stores, membership proofs, runtime controls and writes are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron: electron, chromium } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { desktopProfile } = require('../apps/desktop/profile');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.artifacts/desktop-authority-recovery');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-desktop-authority-'));
const userData = path.join(temp, 'desktop'), dataRoot = path.join(temp, 'host-data');
const project = path.join(temp, 'project');
const checks = [], captures = [], errors = { desktop: [], browser: [] };
let app, win, browser, bob, hub, url, profile;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (read, label, timeout = 45000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(150); }
  throw new Error('Timed out: ' + label);
};
const pass = label => { checks.push(label); console.log('PASS ' + label); };
const snapshot = page => page.evaluate(() => {
  const state = window.__plexus.state;
  return { identity: state.encryptedIdentity, enrolment: state.encryptedState, taskId: state.activeThreadId,
    value: state.encryptedSnapshots.get(state.activeThreadId), me: state.me.id };
});
const config = () => JSON.parse(fs.readFileSync(path.join(profile.dataDir, 'runtime.json'), 'utf8'));
const setup = () => win.evaluate(() => window.harnessDesktop.encryptedSetup());
const exactIdentity = (a, b) => ['user', 'device', 'curve25519', 'ed25519'].every(key => a?.[key] === b?.[key]);
async function capture(page, name, mobile = false) {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1487, height: 1058 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.querySelectorAll('#toasts .toast').length === 0, null, { timeout: 10000 });
  if (/replacement|appointed|revoked-signer/.test(name)) {
    const section = page.locator('#encrypted-setup [data-state]');
    await section.waitFor({ state: 'visible' });
    await section.evaluate(node => node.scrollIntoView({ block: 'start' }));
  }
  await page.screenshot({ path: path.join(out, name + '.png') }); captures.push(name + '.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'capture has no horizontal document overflow');
}
async function launch(savedSession) {
  const env = { ...process.env, HUB_HTTP_URL: url, HARNESS_USER: 'Alice', HARNESS_DATA: dataRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['apps/desktop/main.js', '--user-data-dir=' + userData, '--no-sandbox'], cwd: root, env });
  win = await app.firstWindow();
  win.on('pageerror', error => errors.desktop.push(error.message));
  await win.setViewportSize({ width: 1487, height: 1058 });
  await win.emulateMedia({ reducedMotion: 'reduce' });
  if (savedSession) {
    // Account authentication is outside this recovery test. Restoring this bearer
    // session does not restore a device ID, key, trust pin or membership checkpoint.
    await win.addInitScript(value => {
      if (location.protocol === 'plexus-app:') localStorage.setItem('harness.session', JSON.stringify(value));
    }, savedSession);
    await win.waitForURL('plexus-app://app/**', { timeout: 30000 });
    await win.reload();
  }
  await app.evaluate(({ dialog }, selectedProject) => {
    global.fixtureDialogs = []; global.fixtureDialogResponse = 1;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedProject] });
    dialog.showMessageBox = async (_window, options) => {
      global.fixtureDialogs.push(options);
      return { response: global.fixtureDialogResponse };
    };
  }, project);
}
async function confirmListedHost(page) {
  await page.locator('[data-action="show-host-fingerprint"]').click();
  await page.locator('[data-action="confirm-host"]').click();
  await page.locator('[data-action="show-host-fingerprint"]').waitFor({ state: 'detached' });
}
async function waitCompleted(page) {
  await page.locator('#ew-target').filter({ hasText: 'Start a follow-up on this task' }).waitFor({ timeout: 45000 });
  assert.equal((await snapshot(page)).value.turn, 'completed');
}
(async () => {
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(project);
  fs.mkdirSync(path.join(project, 'cleanup')); fs.writeFileSync(path.join(project, 'cleanup/old.txt'), 'Disposable approval fixture\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  execFileSync('git', ['add', '-A'], { cwd: project });
  execFileSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-qm', 'fixture'], { cwd: project });
  hub = new Hub({ dbFile: path.join(temp, 'hub.sqlite'), staticDir: path.join(root, 'apps/web'), log: () => {} });
  const address = await hub.listen(); url = 'http://127.0.0.1:' + address.port;
  profile = desktopProfile({ userData, hubUrl: url, dataRoot });
  await launch();
  await win.locator('#team-gate:not(.hidden)').waitFor({ timeout: 30000 });
  await win.locator('#team-name').fill('Surviving teammate recovery'); await win.locator('#btn-create-team').click();
  await win.locator('#encrypted-setup').filter({ hasText: 'This endpoint: verified' }).waitFor({ timeout: 30000 });
  await win.waitForFunction(() => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.querySelector('#pair-code').value));
  await win.locator('#btn-pair-host').click(); await win.locator('.runtime-card').waitFor();
  await win.locator('#btn-add-project').click();
  await win.waitForFunction(() => /^ep_[a-f0-9]{32}$/.test(document.querySelector('#fleet-project').value));
  await win.locator('[data-action="authorize-encrypted-host"]').click();
  await win.waitForFunction(() => window.__plexus.state.runtimes.some(runtime => runtime.encryptedEndpoint));
  await win.locator('[data-action="authorize-host-approver"]').click();
  await win.waitForFunction(async () => (await window.harnessDesktop.encryptedSetup()).state === 'ready');
  await confirmListedHost(win);
  const original = await snapshot(win);
  const savedSession = await win.evaluate(() => JSON.parse(localStorage.getItem('harness.session')));
  const originalConfig = config();
  const runtimeId = await win.evaluate(() => window.harnessDesktop.runtimeId());
  const originalHost = await win.evaluate(() => window.__plexus.state.encrypted.confirmedHost(window.__plexus.state.runtimes[0].id));
  assert.equal(exactIdentity(originalConfig.encryptionAuthority, original.identity), true);
  assert.equal(exactIdentity(originalConfig.approvalAuthority, original.identity), true);
  await win.locator('#provider-select').selectOption('demo');
  await win.locator('#input').fill('create BEFORE-LOSS.txt'); await win.locator('#btn-send').click();
  await win.locator('.ew-file h4').filter({ hasText: 'BEFORE-LOSS.txt' }).waitFor({ timeout: 45000 });
  await waitCompleted(win); const taskId = (await snapshot(win)).taskId;
  const originalText = fs.readFileSync(path.join(project, 'BEFORE-LOSS.txt'), 'utf8');
  await win.locator('#btn-recovery').click(); await win.locator('[data-action="start-recovery"]').click();
  const recoveryKey = await win.locator('.rec-key').innerText();
  await win.locator('.rec-input').fill(recoveryKey); await win.locator('[data-action="confirm-recovery"]').click();
  await win.locator('[data-action="replace-recovery"]').waitFor({ timeout: 30000 });
  pass('real desktop endpoint creates a task and confirms a customer-held history backup');

  browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' }), headless: true, args: ['--no-sandbox'] });
  bob = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
  bob.on('pageerror', error => errors.browser.push(error.message)); await bob.emulateMedia({ reducedMotion: 'reduce' });
  await bob.goto(url); await bob.locator('#login-name').fill('Bob'); await bob.locator('#login-form button').click();
  await bob.locator('#team-gate').waitFor({ state: 'visible' }); const bobId = await bob.locator('#team-gate-account-id').inputValue();
  await win.locator('#nav-fleet').click(); await win.locator('#invitee-user-id').fill(bobId); await win.locator('#btn-invite').click();
  await win.locator('#invite-row').waitFor({ state: 'visible' });
  await bob.locator('#join-code').fill(await win.locator('#invite-code').inputValue()); await bob.locator('#btn-join-team').click();
  await bob.locator('#enrollment-badge').waitFor({ state: 'visible' });
  await win.locator('#btn-access').click();
  const bobCard = win.locator('#access-view .ew-device').filter({ hasText: 'Bob' });
  await bobCard.locator('input[type="checkbox"]').check(); await bobCard.locator('[data-action="verify-teammate"]').click();
  await bobCard.locator('[data-action="grant-project"]').click();
  await bob.locator('#btn-access').click();
  assert.ok((await bob.locator('[data-action="confirm-team-authority"]').locator('..').innerText()).includes(original.identity.fingerprint));
  await bob.locator('[data-action="confirm-team-authority"]').click();
  await until(async () => (await snapshot(bob)).enrolment.membershipIdentity?.state === 'verified', 'Bob authenticates original membership');
  assert.equal(await bob.locator('[data-action="authorize-freshness-authority"]').count(), 0);
  assert.equal(await bob.evaluate(() => typeof window.harnessDesktop?.confirmFreshnessAuthority), 'undefined');
  await bob.locator('.encrypted-task-row[data-task-id="' + taskId + '"]').click();
  await bob.locator('[data-action="verify-task-host"]').click(); await bob.locator('[data-action="confirm-host"]').click();
  await bob.locator('.ew-file h4').filter({ hasText: 'BEFORE-LOSS.txt' }).waitFor({ timeout: 45000 });
  pass('surviving Bob is verified and reads history; remote browser has no native appointment capability');

  // Lose only the app user's renderer storage. The independent durable host broker,
  // native config, original membership genesis and its applied checkpoint survive.
  const rendererStorage = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('plexus-app://app/')).webContents.session.getStoragePath());
  assert.ok(rendererStorage.startsWith(userData + path.sep));
  await app.close(); app = null; fs.rmSync(rendererStorage, { recursive: true, force: true });
  await launch(savedSession);
  await win.locator('#encrypted-setup').filter({ hasText: 'This endpoint: pending' }).waitFor({ timeout: 30000 });
  const replacement = await snapshot(win);
  assert.equal(replacement.me, original.me); assert.notEqual(replacement.identity.device, original.identity.device);
  assert.notEqual(replacement.identity.ed25519, original.identity.ed25519);
  assert.equal(await win.evaluate(() => window.harnessDesktop.runtimeId()), runtimeId);
  assert.equal(await win.locator('[data-action="authorize-freshness-authority"]').count(), 0);
  await capture(win, 'pending-replacement-desktop');
  pass('cleared renderer store creates a pending same-account device while preserving the actual execution host');

  await win.locator('#btn-recovery').click(); await win.locator('[name="restore-recovery-key"]').fill(recoveryKey);
  await win.locator('[data-action="restore-history"]').click();
  await win.locator('#toasts .toast').filter({ hasText: 'History restored' }).waitFor({ timeout: 45000 });
  await win.locator('.encrypted-task-row[data-task-id="' + taskId + '"]').click();
  await win.locator('.ew-file h4').filter({ hasText: 'BEFORE-LOSS.txt' }).waitFor({ timeout: 45000 });
  assert.equal((await snapshot(win)).enrolment.state, 'pending');
  assert.equal(await win.locator('#btn-send').isDisabled(), true);
  assert.equal(fs.readFileSync(path.join(project, 'BEFORE-LOSS.txt'), 'utf8'), originalText);
  await capture(win, 'history-only-desktop');
  pass('customer material restores readable prior history while the new endpoint still has no task controls');

  await win.locator('#btn-access').click();
  assert.ok((await win.locator('[data-action="confirm-team-authority"]').locator('..').innerText()).includes(original.identity.fingerprint));
  await win.locator('[data-action="confirm-team-authority"]').click();
  await bob.locator('#btn-access').click();
  const candidate = bob.locator('#access-view .ew-device[data-device="' + replacement.identity.device + '"]');
  assert.ok((await candidate.innerText()).includes(replacement.identity.fingerprint));
  await candidate.locator('input[type="checkbox"]').check(); await candidate.locator('[data-action="verify-teammate"]').click();
  await until(async () => (await snapshot(win)).enrolment.membershipIdentity?.state === 'verified', 'Bob verifies replacement against signed membership');
  await win.locator('#nav-fleet').click();
  const appoint = win.locator('[data-action="authorize-freshness-authority"]');
  await appoint.waitFor();
  assert.equal(await win.locator('[data-action="authorize-encrypted-host"]').count(), 0, 'replacement recovery does not offer to change the original genesis');
  await capture(win, 'verified-replacement-desktop');
  await app.evaluate(() => { global.fixtureDialogResponse = 0; }); await appoint.click();
  await until(async () => (await app.evaluate(() => global.fixtureDialogs.length)) === 1, 'native cancellation dialog is actually answered');
  await until(() => appoint.isEnabled(), 'canceled appointment returns to an available action');
  assert.equal((await setup()).freshnessAuthority || null, null, 'cancel retains the prior native authority configuration');
  pass('a surviving teammate verifies the replacement; canceling native appointment leaves original trust intact');
  await app.evaluate(() => { global.fixtureDialogResponse = 1; }); await appoint.click();
  await win.locator('#toasts .toast').filter({ hasText: 'This host now uses the replacement membership signer' }).waitFor({ timeout: 45000 });
  const appointment = await until(async () => {
    const record = (await setup()).freshnessAuthority;
    return record?.signer?.device === replacement.identity.device ? record : null;
  }, 'native appointment persists selected signer');
  const appointed = config();
  assert.match(appointment.activationId, /^[a-f0-9]{32}$/);
  assert.equal(exactIdentity(appointed.encryptionAuthority, original.identity), true);
  assert.equal(exactIdentity(appointed.approvalAuthority, original.identity), true);
  assert.equal(appointed.codexHostTools, originalConfig.codexHostTools);
  await win.waitForFunction(async () => (await window.harnessDesktop.encryptedSetup()).state === 'ready', null, { timeout: 45000 });
  await win.waitForFunction(id => window.__plexus.state.connected &&
    window.__plexus.state.runtimes.some(runtime => runtime.id === id && runtime.online), runtimeId, { timeout: 45000 });
  await win.waitForFunction(() => document.querySelectorAll('#toasts .toast').length === 0, null, { timeout: 10000 });
  await win.locator('#nav-fleet').click();
  await win.locator('#encrypted-setup [data-state="active"]').waitFor({ timeout: 45000 });
  assert.equal(await win.evaluate(() => window.harnessDesktop.runtimeId()), runtimeId);
  const newHost = await win.evaluate(() => window.__plexus.state.encrypted.confirmedHost(window.__plexus.state.runtimes[0].id));
  assert.equal(exactIdentity(newHost, originalHost), true);
  const dialogs = await app.evaluate(() => global.fixtureDialogs);
  assert.ok(dialogs.length >= 2); assert.match(JSON.stringify(dialogs), /membership/i);
  await capture(win, 'appointed-desktop'); await capture(win, 'appointed-mobile', true);
  await win.setViewportSize({ width: 1487, height: 1058 });
  assert.equal((await snapshot(win)).taskId, null, 'appointment captures retain Fleet context');
  pass('native appointment keeps genesis, host keys, prior checkpoints and separate approval/provider authority');

  await win.waitForFunction(id => window.__plexus.state.connected &&
    window.__plexus.state.runtimes.some(runtime => runtime.id === id && runtime.online), runtimeId, { timeout: 45000 });
  await win.locator('#provider-select').selectOption('demo');
  await win.locator('#input').fill('create AFTER-RECOVERY.txt'); await win.locator('#btn-send').click();
  const recoveredTaskId = await until(async () => {
    const value = await win.evaluate(() => ({ taskId: window.__plexus.state.activeThreadId,
      error: document.querySelector('#ew-error')?.textContent }));
    if (value.error) throw new Error('New task refused: ' + value.error);
    return value.taskId;
  }, 'public composer creates the recovered task');
  assert.notEqual(recoveredTaskId, taskId, 'the recovered write is a new task, not a follow-up on restored history');
  await win.locator('.ew-file h4').filter({ hasText: 'AFTER-RECOVERY.txt' }).waitFor({ timeout: 45000 });
  await waitCompleted(win); assert.match(fs.readFileSync(path.join(project, 'AFTER-RECOVERY.txt'), 'utf8'), /create AFTER-RECOVERY.txt/);
  pass('replacement signs fresh reconciliation and the real desktop runtime carries out a new demo file write');
  await win.locator('#input').fill('delete cleanup'); await win.locator('#btn-send').click();
  await win.locator('[data-action="encrypted-approval-accept"]').waitFor({ timeout: 45000 });
  assert.equal(await win.locator('[data-action="encrypted-approval-accept"]').isDisabled(), true);
  assert.equal(fs.existsSync(path.join(project, 'cleanup/old.txt')), true);
  await capture(win, 'approval-not-recovered-desktop');
  await win.locator('[data-action="encrypted-interrupt"]').click();
  await until(async () => (await snapshot(win)).value.turn === 'interrupted', 'unapproved action is interrupted');
  await win.locator('#nav-fleet').click(); await win.locator('[data-action="authorize-host-approver"]').click();
  await until(() => exactIdentity(config().approvalAuthority, replacement.identity), 'separate native approval consent');
  await until(async () => {
    const current = await setup();
    return current.state === 'ready' && exactIdentity(current.approvalAuthority, replacement.identity);
  }, 'new runtime generation publishes independently consented approval authority');
  await win.waitForFunction(id => window.__plexus.state.connected &&
    window.__plexus.state.runtimes.some(runtime => runtime.id === id && runtime.online && runtime.encryptionState === 'ready') &&
    document.querySelector('#fleet-runtime').value === id && document.querySelector('#fleet-project').value,
  runtimeId, { timeout: 45000 });
  await win.locator('#nav-fleet').click();
  assert.equal((await snapshot(win)).taskId, null, 'new approval turn starts from Fleet after native restart');
  await win.locator('#provider-select').selectOption('demo');
  await win.locator('#input').fill('delete cleanup'); await win.locator('#btn-send').click();
  await win.locator('[data-action="encrypted-approval-accept"]').waitFor({ timeout: 45000 });
  const approvalTaskId = (await snapshot(win)).taskId;
  assert.notEqual(approvalTaskId, recoveredTaskId); assert.notEqual(approvalTaskId, taskId);
  assert.equal(await win.locator('[data-action="encrypted-approval-accept"]').isEnabled(), true);
  await win.locator('[data-action="encrypted-approval-accept"]').click();
  await until(() => !fs.existsSync(path.join(project, 'cleanup')), 'new independent approval allows exact removal');
  await waitCompleted(win);
  pass('recovered membership cannot approve; only a separate native approval consent permits a later exact action');
  const originalTask = await win.evaluate(id => window.__plexus.state.encryptedTasks.find(task => task.id === id), taskId);
  const trust = await require('./recovered-host-trust-browser')({ browser, bob, url, savedSession,
    original: original.identity, writer: originalHost, task: originalTask, recoveryKey, until, out });
  captures.push(...trust.captures);
  pass('a separate restored browser refuses changed live host keys for creation and control, retaining its pin and actionable Fleet error');
  await win.locator('#btn-access').click();
  const ownCard = win.locator('#access-view .ew-device[data-device="' + replacement.identity.device + '"]');
  // Fixture the confirmation boundary directly. Electron's native dialog fixture
  // already answers dialogs, so a competing CDP dialog.accept races that answer.
  await win.evaluate(() => { window.confirm = text => { window.fixtureRemovalConfirmation = text; return true; }; });
  await ownCard.locator('[data-action="revoke-device"]').click();
  assert.match(await win.evaluate(() => window.fixtureRemovalConfirmation), /Previously received history cannot be erased/);
  await until(async () => (await win.evaluate(() => window.harnessDesktop.encryptedSetup())).freshnessAuthority?.state === 'revoked', 'self-revoked replacement is no longer a freshness signer');
  await win.locator('#nav-fleet').click();
  await win.locator('#encrypted-setup [data-state="revoked"]').waitFor({ timeout: 30000 });
  assert.equal(await win.locator('[data-action="authorize-freshness-authority"]').count(), 0);
  assert.equal(exactIdentity(config().encryptionAuthority, original.identity), true);
  await capture(win, 'revoked-signer-desktop'); await capture(win, 'revoked-signer-mobile', true);
  pass('revoking the replacement leaves a truthful unavailable state with no fallback to the original signer');
  assert.deepEqual(errors, { desktop: [], browser: [] });
  pass('both actual renderer surfaces report zero uncaught errors');
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: 'pass', checks, captures, errors,
    runtimeId, taskIds: { original: taskId, recovered: recoveredTaskId, approval: approvalTaskId },
    originalDevice: original.identity.device, replacementDevice: replacement.identity.device,
    activationId: appointment.activationId, provider: 'demo', originalAuthorityPreserved: true,
    testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceState: 'working-tree', electron: 'source application (not installed artifact)',
    customerMaterialOnlyRecovery: false, limitation: 'A surviving verified teammate and local execution-host consent are required; full customer-material-only authority recovery is not implemented.' }, null, 2) + '\n');
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  for (const [name, page] of [['desktop', win], ['bob', bob]]) if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(out, 'failure-' + name + '.png') }).catch(() => {});
    fs.writeFileSync(path.join(out, 'failure-' + name + '.txt'), await page.locator('body').innerText().catch(() => ''));
  }
  if (win && !win.isClosed()) {
    const state = await win.evaluate(() => {
      const state = window.__plexus?.state;
      return { connected: state?.connected, runtimes: state?.runtimes, enrolment: state?.encryptedState,
        localSetup: state?.localEncryptedSetup, explanation: state?.catchupExplain,
        taskError: document.querySelector('#ew-error')?.textContent,
        project: document.querySelector('#fleet-project')?.value, runtime: document.querySelector('#fleet-runtime')?.value };
    }).catch(() => null);
    fs.writeFileSync(path.join(out, 'failure-state.json'), JSON.stringify(state, null, 2));
  }
  const log = path.join(userData, 'logs', 'desktop.log');
  if (fs.existsSync(log)) fs.copyFileSync(log, path.join(out, 'failure-desktop.log'));
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: 'fail', error: error.stack, checks, captures, errors }, null, 2) + '\n');
}).finally(async () => {
  await app?.close().catch(() => {}); await browser?.close(); await hub?.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
