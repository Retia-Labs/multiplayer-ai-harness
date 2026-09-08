'use strict';
// Customer material restores a lost owner with no surviving trusted teammate.
// Account login, native dialog decisions and deliberate renderer storage loss are
// the only fixture boundaries. Durable SDK, native consent, host and writes are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron: electron, chromium } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { desktopProfile } = require('../apps/desktop/profile');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.artifacts/desktop-owner-recovery');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-desktop-owner-'));
const userData = path.join(temp, 'desktop'), dataRoot = path.join(temp, 'host-data');
const project = path.join(temp, 'project');
const checks = [], captures = [], errors = { desktop: [] };
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
async function capture(page, name, selector, mobile = false) {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1487, height: 1058 });
  if (mobile) await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().right <= 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.querySelectorAll('#toasts .toast').length === 0);
  await page.locator(selector).waitFor({ state: 'visible' });
  await page.locator(selector).evaluate(node => node.scrollIntoView({ block: 'start' }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(out, name + '.png') }); captures.push(name + '.png');
}
async function launch(savedSession) {
  const env = { ...process.env, HUB_HTTP_URL: url, HARNESS_USER: 'Alice', HARNESS_DATA: dataRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['apps/desktop/main.js', '--user-data-dir=' + userData, '--no-sandbox'], cwd: root, env });
  win = await app.firstWindow();
  win.on('pageerror', error => errors.desktop.push(error.message));
  await win.addInitScript(() => { window.confirm = () => true; });
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
  await win.locator('#team-name').fill('Customer material recovery'); await win.locator('#btn-create-team').click();
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
  const original = await snapshot(win), originalConfig = config();
  const savedSession = await win.evaluate(() => JSON.parse(localStorage.getItem('harness.session')));
  const runtimeId = await win.evaluate(() => window.harnessDesktop.runtimeId());
  const originalHost = await win.evaluate(id => window.__plexus.state.encrypted.confirmedHost(id), runtimeId);
  await win.locator('#provider-select').selectOption('demo');
  await win.locator('#input').fill('create BEFORE-LOSS.txt'); await win.locator('#btn-send').click();
  await win.locator('.ew-file h4').filter({ hasText: 'BEFORE-LOSS.txt' }).waitFor({ timeout: 45000 });
  await waitCompleted(win); const taskId = (await snapshot(win)).taskId;
  const history = (await snapshot(win)).value.events;
  const originalText = fs.readFileSync(path.join(project, 'BEFORE-LOSS.txt'), 'utf8');
  await win.locator('#btn-recovery').click(); await win.locator('[data-action="start-owner-recovery-kit"]').click();
  const recoveryKey = await until(async () => (await win.locator('#owner-authority-recovery .rec-key').count()) && win.locator('#owner-authority-recovery .rec-key').textContent(), 'owner kit key');
  await win.locator('[name="owner-recovery-drill"]').fill(recoveryKey);
  await win.locator('[data-action="complete-owner-recovery-kit"]').click();
  const kit = await until(() => win.evaluate(() => window.__plexus.state.ownerRecoveryReceipt?.state === 'saved' && window.__plexus.state.ownerRecoveryReceipt), 'clean drill and saved kit');
  assert.equal(kit.generation, 1);
  await capture(win, 'kit-saved-desktop', '#owner-authority-recovery');
  pass('real desktop prepares a drilled owner kit containing prior authenticated task history');

  const rendererStorage = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('plexus-app://app/')).webContents.session.getStoragePath());
  assert.ok(rendererStorage.startsWith(userData + path.sep));
  await app.close(); app = null; fs.rmSync(rendererStorage, { recursive: true, force: true });
  await launch(savedSession);
  await win.locator('#encrypted-setup').filter({ hasText: 'This endpoint: pending' }).waitFor({ timeout: 30000 });
  const pending = await snapshot(win);
  assert.notEqual(pending.identity.device, original.identity.device);
  assert.equal(await win.evaluate(() => window.harnessDesktop.runtimeId()), runtimeId);
  await win.locator('#btn-recovery').click();
  await win.locator('[name="owner-kit-scope"]').selectOption(kit.scope);
  await win.locator('[name="owner-recovery-key"]').fill(recoveryKey);
  await win.locator('[data-action="stage-owner-recovery"]').click();
  const stage = await until(() => win.evaluate(() => window.__plexus.state.recoveryState?.ownerRecovery?.stage), 'inactive restored endpoint');
  assert.notEqual(stage.identity.device, pending.identity.device);
  assert.equal((await snapshot(win)).identity.device, pending.identity.device);
  await win.locator('[data-action="inspect-owner-recovery-history"]').click();
  await until(() => win.evaluate(() => window.__plexus.state.ownerRecoveryPreview), 'authenticated restored history');
  assert.deepEqual(await win.evaluate(() => window.__plexus.state.ownerRecoveryPreview.snapshot.events), history);
  await capture(win, 'history-restored-desktop', '#owner-authority-recovery [data-state="history-restored"]');
  pass('with the original SDK store deleted and no teammate, the customer kit restores history into a separate inactive endpoint');

  await win.locator('[data-action="recover-owner-membership"]').click();
  const membership = await until(() => win.evaluate(() => window.__plexus.state.encryptedState?.membershipIdentity?.recoveryEpoch && window.__plexus.state.encryptedState.membershipIdentity), 'published owner recovery');
  assert.equal(exactIdentity(membership.owner, original.identity), true);
  assert.equal((await snapshot(win)).identity.device, stage.identity.device);
  assert.equal(membership.grants.every(grant => grant.revoked), true);
  await until(async () => (await setup()).state === 'membership_owner_recovery_required', 'host pauses at the new recovery epoch');
  assert.equal((await setup()).freshnessAuthority?.recoveryEpoch || null, null);
  assert.equal(exactIdentity(config().approvalAuthority, original.identity), true);
  await capture(win, 'host-pending-desktop', '#owner-authority-recovery [data-state="pending-host"]');
  await capture(win, 'host-pending-mobile', '#owner-authority-recovery [data-state="pending-host"]', true);
  await win.setViewportSize({ width: 1487, height: 1058 });
  pass('explicit recovery resets access and pauses the actual durable host without copying its old approval authority');

  await app.evaluate(() => { global.fixtureDialogResponse = 0; });
  await win.locator('[data-action="activate-owner-recovery-host"]').click();
  await until(async () => (await app.evaluate(() => global.fixtureDialogs.length)) === 1, 'native cancel decision');
  assert.equal((await setup()).freshnessAuthority?.recoveryEpoch || null, null);
  await until(() => win.locator('[data-action="activate-owner-recovery-host"]').isEnabled(), 'canceled action available');
  await app.evaluate(() => { global.fixtureDialogResponse = 1; });
  await win.locator('[data-action="activate-owner-recovery-host"]').click();
  const active = await until(async () => {
    const value = await setup();
    return value.state === 'ready' && value.freshnessAuthority?.recoveryEpoch === membership.recoveryEpoch ? value : null;
  }, 'new native runtime generation applies exact recovery epoch');
  assert.equal(exactIdentity(active.freshnessAuthority.signer, stage.identity), true);
  assert.equal(exactIdentity(config().encryptionAuthority, original.identity), true);
  assert.equal(exactIdentity(config().approvalAuthority, original.identity), true);
  assert.deepEqual(config().codexHostTools, originalConfig.codexHostTools);
  const dialogs = await app.evaluate(() => global.fixtureDialogs);
  assert.equal(dialogs.length, 2); assert.match(JSON.stringify(dialogs), /recovery|membership/i);
  assert.equal(JSON.stringify(dialogs).includes(recoveryKey), false);
  await win.waitForFunction(id => window.__plexus.state.runtimes.some(runtime => runtime.id === id && runtime.online && runtime.encryptionState === 'ready'), runtimeId, { timeout: 45000 });
  await win.locator('#nav-fleet').click();
  assert.equal((await snapshot(win)).taskId, null);
  await win.locator('#btn-recovery').click();
  await capture(win, 'locally-active-desktop', '#owner-authority-recovery [data-state="active"]');
  await capture(win, 'locally-active-mobile', '#owner-authority-recovery [data-state="active"]', true);
  await win.setViewportSize({ width: 1487, height: 1058 });
  pass('cancel leaves the host paused; explicit native consent activates only this epoch on this host and preserves separate authority');

  await win.locator('#btn-access').click();
  await win.locator('[data-action="reclaim-recovery-project"]').click();
  await win.locator('[data-action="reclaim-recovery-project"]').waitFor({ state: 'detached' });
  await win.locator('.encrypted-task-row[data-task-id="' + taskId + '"]').click();
  await win.locator('.ew-file h4').filter({ hasText: 'BEFORE-LOSS.txt' }).waitFor({ timeout: 45000 });
  assert.equal(fs.readFileSync(path.join(project, 'BEFORE-LOSS.txt'), 'utf8'), originalText);
  assert.equal(exactIdentity(await win.evaluate(id => window.__plexus.state.encrypted.confirmedHost(id), runtimeId), originalHost), true, 'customer-authenticated kit restores the exact host pin despite reset task discovery');
  await win.locator('#nav-fleet').click(); assert.equal((await snapshot(win)).taskId, null);
  await win.locator('#provider-select').selectOption('demo');
  await win.locator('#input').fill('create AFTER-OWNER-RECOVERY.txt'); await win.locator('#btn-send').click();
  await win.locator('.ew-file h4').filter({ hasText: 'AFTER-OWNER-RECOVERY.txt' }).waitFor({ timeout: 45000 });
  await waitCompleted(win); const recoveredTaskId = (await snapshot(win)).taskId;
  assert.notEqual(recoveredTaskId, taskId);
  assert.match(fs.readFileSync(path.join(project, 'AFTER-OWNER-RECOVERY.txt'), 'utf8'), /create AFTER-OWNER-RECOVERY.txt/);
  pass('explicit project regrant restores catch-up and the recovered client creates a distinct task with real demo file bytes');

  await win.locator('#input').fill('delete cleanup'); await win.locator('#btn-send').click();
  await win.locator('[data-action="encrypted-approval-accept"]').waitFor({ timeout: 45000 });
  assert.equal(await win.locator('[data-action="encrypted-approval-accept"]').isDisabled(), true);
  assert.equal(fs.existsSync(path.join(project, 'cleanup/old.txt')), true);
  await capture(win, 'approval-not-restored-desktop', '#encrypted-workspace');
  await win.locator('[data-action="encrypted-interrupt"]').click();
  await until(async () => (await snapshot(win)).value.turn === 'interrupted', 'unapproved recovered action interrupted');
  await win.locator('#nav-fleet').click(); await win.locator('[data-action="authorize-host-approver"]').click();
  await until(async () => {
    const value = await setup();
    return value.state === 'ready' && exactIdentity(value.approvalAuthority, stage.identity) && value.approvalAuthority.recoveryEpoch === membership.recoveryEpoch;
  }, 'fresh separate approval consent for current epoch');
  await win.waitForFunction(id => window.__plexus.state.runtimes.some(runtime => runtime.id === id && runtime.online && runtime.encryptionState === 'ready'), runtimeId);
  await win.locator('#nav-fleet').click(); assert.equal((await snapshot(win)).taskId, null);
  await win.locator('#provider-select').selectOption('demo');
  await win.locator('#input').fill('delete cleanup'); await win.locator('#btn-send').click();
  await win.locator('[data-action="encrypted-approval-accept"]').waitFor({ timeout: 45000 });
  assert.equal(await win.locator('[data-action="encrypted-approval-accept"]').isEnabled(), true);
  const approvalTaskId = (await snapshot(win)).taskId; assert.notEqual(approvalTaskId, recoveredTaskId); assert.notEqual(approvalTaskId, taskId);
  await win.locator('[data-action="encrypted-approval-accept"]').click();
  await until(() => !fs.existsSync(path.join(project, 'cleanup')), 'exact new approved removal'); await waitCompleted(win);
  assert.equal(await win.evaluate(key => JSON.stringify(localStorage).includes(key), recoveryKey), false);
  assert.deepEqual(errors, { desktop: [] });
  pass('restored membership cannot approve until separate epoch-bound native consent; the actual renderer reports zero uncaught errors');
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: 'pass', checks, captures, errors,
    runtimeId, taskIds: { original: taskId, recovered: recoveredTaskId, approval: approvalTaskId }, recoveryEpoch: membership.recoveryEpoch,
    provider: 'demo', noSurvivingTrustedCustomerDevice: true, hostStore: 'actual OS-protected durable Electron broker',
    sourceState: 'working-tree', testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    electron: 'source application (not installed artifact)', nativeDialogVisual: 'not captured; real native handler with fixture decision' }, null, 2));
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (win && !win.isClosed()) {
    await win.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(out, 'failure.txt'), await win.locator('body').innerText().catch(() => ''));
    const state = await win.evaluate(() => ({ runtimes: window.__plexus?.state.runtimes,
      membership: window.__plexus?.state.encryptedState, local: window.__plexus?.state.localEncryptedSetup,
      receipt: window.__plexus?.state.ownerRecoveryReceipt?.state,
      taskError: document.querySelector('#ew-error')?.textContent })).catch(() => null);
    fs.writeFileSync(path.join(out, 'failure-state.json'), JSON.stringify(state, null, 2));
  }
  const log = path.join(userData, 'logs', 'desktop.log');
  if (fs.existsSync(log)) fs.copyFileSync(log, path.join(out, 'failure-desktop.log'));
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: 'fail', error: error.stack, checks, captures, errors }, null, 2));
}).finally(async () => { await app?.close().catch(() => {}); await hub?.close(); fs.rmSync(temp, { recursive: true, force: true }); });
