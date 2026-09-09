'use strict';
// Two source Electron hosts and a separate browser. Only account login and user
// dialogs are fixtures. SDK stores, native appointments, membership, receipts and
// demo file operations use the production application and durable crypto broker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron: electron, chromium } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { desktopProfile } = require('../apps/desktop/profile');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.artifacts/desktop-genesis-revocation');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-genesis-desktop-'));
const checks = [], captures = [], errors = { original: [], replacement: [], bob: [] }, desktops = [];
let hub, browser, bob, url;
const until = async (read, label, timeout = 45000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error('Timed out: ' + label);
};
const pass = label => { checks.push(label); console.log('PASS ' + label); };
const exact = (a, b) => !!a && !!b && ['user', 'device', 'curve25519', 'ed25519'].every(key => a[key] === b[key]);
const snapshot = page => page.evaluate(() => { const s = window.__plexus.state; return { identity: s.encryptedIdentity,
  membership: s.encryptedState, taskId: s.activeThreadId, value: s.encryptedSnapshots.get(s.activeThreadId) }; });
async function capture(page, name, anchor, mobile = false) {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1487, height: 1058 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.querySelectorAll('#toasts .toast').length === 0, null, { timeout: 10000 });
  const region = page.locator(anchor); await region.waitFor({ state: 'visible' });
  await region.evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(out, name + '.png') }); captures.push(name + '.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}
async function launch(label, savedSession) {
  let device = desktops.find(value => value.label === label);
  if (!device) {
    const userData = path.join(temp, label), dataRoot = path.join(temp, label + '-host');
    const project = path.join(temp, label + '-project'); fs.mkdirSync(project);
    fs.mkdirSync(path.join(project, 'cleanup')); fs.writeFileSync(path.join(project, 'cleanup/old.txt'), 'Disposable approval fixture\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
    execFileSync('git', ['add', '-A'], { cwd: project });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: project });
    device = { label, userData, dataRoot, project, profile: desktopProfile({ userData, dataRoot, hubUrl: url }) };
    desktops.push(device);
  }
  const env = { ...process.env, HUB_HTTP_URL: url, HARNESS_USER: label === 'original' ? 'Alice' : 'Replacement host', HARNESS_DATA: device.dataRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  device.app = await electron.launch({ args: ['apps/desktop/main.js', '--user-data-dir=' + device.userData, '--no-sandbox'], cwd: root, env });
  device.page = await device.app.firstWindow();
  device.page.on('pageerror', error => errors[label].push(error.message));
  await device.page.setViewportSize({ width: 1487, height: 1058 }); await device.page.emulateMedia({ reducedMotion: 'reduce' });
  if (savedSession) {
    await device.page.addInitScript(value => { if (location.protocol === 'plexus-app:') localStorage.setItem('harness.session', JSON.stringify(value)); }, savedSession);
    await device.page.waitForURL('plexus-app://app/**'); await device.page.reload();
  }
  await device.app.evaluate(({ dialog }, project) => {
    global.fixtureDialogs = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
    dialog.showMessageBox = async (_window, options) => { global.fixtureDialogs.push(options); return { response: 1 }; };
  }, device.project);
  device.setup = () => device.page.evaluate(() => window.harnessDesktop.encryptedSetup());
  device.config = () => JSON.parse(fs.readFileSync(path.join(device.profile.dataDir, 'runtime.json'), 'utf8'));
  return device;
}
async function fleet(device, runtimeId = device.runtimeId) {
  const page = device.page;
  await page.setViewportSize({ width: 1487, height: 1058 }); await page.locator('#nav-fleet').click();
  await page.locator('#fleet-view').waitFor({ state: 'visible' });
  if (runtimeId) await page.locator('#fleet-runtime').selectOption(runtimeId);
  assert.equal((await snapshot(page)).taskId, null);
}
async function ready(device, authority, approval) {
  await until(async () => {
    const setup = await device.setup();
    return setup.state === 'ready' && exact(setup.authority, authority) && (approval === undefined || exact(setup.approvalAuthority, approval));
  }, device.label + ' publishes the configured runtime generation');
  await device.page.waitForFunction(id => window.__plexus.state.connected && window.__plexus.state.runtimes.some(value => value.id === id && value.online && value.encryptionState === 'ready'), device.runtimeId, { timeout: 45000 });
  await fleet(device);
}
async function confirmHost(device, runtimeId = device.runtimeId) {
  await fleet(device, runtimeId);
  await device.page.locator('[data-action="show-host-fingerprint"]').click();
  await device.page.locator('[data-action="confirm-host"]').click();
  await device.page.locator('[data-action="show-host-fingerprint"]').waitFor({ state: 'detached' });
  return device.page.evaluate(id => window.__plexus.state.encrypted.confirmedHost(id), runtimeId);
}
async function pairAndProject(device) {
  const page = device.page;
  await page.waitForFunction(() => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.querySelector('#pair-code').value));
  await page.locator('#btn-pair-host').click();
  device.runtimeId = await page.evaluate(() => window.harnessDesktop.runtimeId());
  await until(() => page.locator('#fleet-runtime option[value="' + device.runtimeId + '"]').count(), 'paired host appears');
  await fleet(device); await page.locator('#btn-add-project').click();
  device.projectId = await until(async () => (await device.setup()).projects?.[0]?.id, 'local project authorization');
  await page.waitForFunction(({ runtimeId, projectId }) => window.__plexus.state.runtimes.some(runtime =>
    runtime.id === runtimeId && runtime.online && runtime.encryptedProjects?.some(project => project.id === projectId)),
  { runtimeId: device.runtimeId, projectId: device.projectId }, { timeout: 45000 });
  assert.equal(await page.locator('#fleet-runtime').inputValue(), device.runtimeId, 'native project restart preserves selected machine while another host is online');
  await page.locator('#fleet-project').selectOption(device.projectId);
}
async function completed(page) {
  await page.locator('#ew-target').filter({ hasText: 'Start a follow-up on this task' }).waitFor({ timeout: 45000 });
  assert.equal((await snapshot(page)).value.turn, 'completed');
}
async function create(device, filename) {
  await fleet(device); await device.page.locator('#fleet-project').selectOption(device.projectId);
  await device.page.locator('#provider-select').selectOption('demo');
  await device.page.locator('#input').fill('create ' + filename); await device.page.locator('#btn-send').click();
  const id = await until(async () => {
    const value = await device.page.evaluate(() => ({ id: window.__plexus.state.activeThreadId, error: document.querySelector('#encrypted-composer-error')?.textContent }));
    if (value.error) throw new Error(value.error); return value.id;
  }, 'distinct task creation');
  await device.page.locator('.ew-file h4').filter({ hasText: filename }).waitFor({ timeout: 45000 });
  await completed(device.page);
  assert.match(fs.readFileSync(path.join(device.project, filename), 'utf8'), new RegExp(filename.replace(/\./g, '\\.')));
  return device.page.evaluate(id => window.__plexus.state.encryptedTasks.find(task => task.id === id), id);
}
async function revocation(page, device) {
  return page.evaluate(id => window.__plexus.state.encryptedState?.revocations.find(value => value.device === id), device);
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  hub = new Hub({ dbFile: path.join(temp, 'hub.sqlite'), staticDir: path.join(root, 'apps/web'), log: () => {} });
  const address = await hub.listen(); url = 'http://127.0.0.1:' + address.port;
  const old = await launch('original');
  await old.page.locator('#team-name').fill('Remove the original device'); await old.page.locator('#btn-create-team').click();
  await old.page.locator('#encrypted-setup').filter({ hasText: 'This endpoint: verified' }).waitFor();
  const original = (await snapshot(old.page)).identity;
  const session = await old.page.evaluate(() => JSON.parse(localStorage.getItem('harness.session')));
  await pairAndProject(old); await old.page.locator('[data-action="authorize-encrypted-host"]').click();
  await ready(old, original); await old.page.locator('[data-action="authorize-host-approver"]').click();
  await ready(old, original, original); const oldHost = await confirmHost(old);
  const oldTask = await create(old, 'ORIGINAL-HOST.txt');
  pass('original desktop authorizes immutable genesis and separate exact approval authority, then writes a real task');

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
  bob = await browser.newPage({ viewport: { width: 1487, height: 1058 } }); bob.on('pageerror', error => errors.bob.push(error.message));
  await bob.goto(url); await bob.locator('#login-name').fill('Bob'); await bob.locator('#login-form button').click();
  await bob.locator('#team-gate').waitFor(); const bobId = await bob.locator('#team-gate-account-id').inputValue();
  await fleet(old); await old.page.locator('#invitee-user-id').fill(bobId); await old.page.locator('#btn-invite').click();
  await old.page.locator('#invite-row').waitFor(); await bob.locator('#join-code').fill(await old.page.locator('#invite-code').inputValue());
  await bob.locator('#btn-join-team').click(); await bob.locator('#enrollment-badge').waitFor();
  await old.page.locator('#btn-access').click(); const bobCard = old.page.locator('.ew-device').filter({ hasText: 'Bob' });
  await bobCard.locator('input[type="checkbox"]').check(); await bobCard.locator('[data-action="verify-teammate"]').click();
  await bob.locator('#btn-access').click(); await bob.locator('[data-action="confirm-team-authority"]').click();
  await bob.waitForFunction(() => window.__plexus.state.encryptedState?.membershipIdentity?.state === 'verified');

  const next = await launch('replacement', session);
  await next.page.locator('#encrypted-setup').filter({ hasText: 'This endpoint: pending' }).waitFor();
  const replacement = (await snapshot(next.page)).identity;
  assert.notEqual(replacement.device, original.device);
  const candidate = bob.locator('.ew-device[data-device="' + replacement.device + '"]');
  await candidate.waitFor(); assert.ok((await candidate.innerText()).includes(replacement.fingerprint));
  await candidate.locator('input[type="checkbox"]').check(); await candidate.locator('[data-action="verify-teammate"]').click();
  await next.page.locator('#btn-access').click();
  assert.ok((await next.page.locator('[data-action="confirm-team-authority"]').locator('..').innerText()).includes(original.fingerprint));
  await next.page.locator('[data-action="confirm-team-authority"]').click();
  await next.page.waitForFunction(() => window.__plexus.state.encryptedState?.membershipIdentity?.state === 'verified');
  await fleet(next); await pairAndProject(next);
  await next.page.locator('[data-action="authorize-encrypted-host"]').click(); await ready(next, original);
  assert.equal(exact(next.config().encryptionAuthority, original), true, 'second host pins authenticated genesis, not its new renderer device');
  assert.equal(exact(next.config().encryptionAuthority, replacement), false);
  const dialogs = await next.app.evaluate(() => global.fixtureDialogs);
  assert.ok(dialogs.some(value => value.detail?.includes(original.ed25519)));
  const nextHost = await confirmHost(next); await confirmHost(next, old.runtimeId);
  const nextTask = await create(next, 'BEFORE-REMOVAL.txt'); assert.notEqual(nextTask.id, oldTask.id);
  pass('verified replacement visibly authorizes a second real host with the unchanged historical genesis');

  await old.page.locator('.encrypted-task-row[data-task-id="' + nextTask.id + '"]').click();
  await old.page.locator('[data-action="verify-task-host"]').click(); await old.page.locator('[data-action="confirm-host"]').click();
  await old.page.locator('.ew-file h4').filter({ hasText: 'BEFORE-REMOVAL.txt' }).waitFor({ timeout: 45000 });
  const before = await old.page.evaluate(async task => (await window.__plexus.state.encrypted.tasks.page(task.id)).events[0], nextTask);
  await next.page.locator('#btn-access').click();
  const originalCard = next.page.locator('.ew-device[data-device="' + original.device + '"]');
  assert.equal(await originalCard.locator('[data-action="revoke-original-device"]').isDisabled(), true);
  await fleet(next); await next.page.locator('[data-action="authorize-freshness-authority"]').click();
  await next.page.locator('#toasts .toast').filter({ hasText: 'This host now uses the replacement membership signer' }).waitFor({ timeout: 45000 });
  await ready(next, original);
  await until(async () => exact((await next.setup()).freshnessAuthority?.signer, replacement), 'replacement appointment active');
  await next.page.locator('#btn-access').click();
  await until(() => originalCard.locator('[data-action="revoke-original-device"]').isEnabled(), 'guided removal enabled only after exact local appointment');
  await capture(next.page, 'original-removal-ready-desktop', '.ew-device[data-device="' + original.device + '"]');
  await capture(next.page, 'original-removal-ready-mobile', '.ew-device[data-device="' + original.device + '"]', true);
  await next.page.setViewportSize({ width: 1487, height: 1058 });
  assert.equal(next.config().approvalAuthority || null, null);
  pass('local appointment enables only guided original removal, preserving absent approval authority');

  await old.app.close(); old.app = null;
  await until(() => next.page.evaluate(id => window.__plexus.state.runtimes.find(value => value.id === id)?.online === false, old.runtimeId), 'original host is disconnected');
  await next.page.evaluate(() => { window.confirm = text => { window.fixtureRemovalText = text; return true; }; });
  await originalCard.locator('[data-action="revoke-original-device"]').click();
  await until(async () => (await snapshot(next.page)).membership.endpoints.some(value => value.device === original.device && value.state === 'revoked'), 'signed original removal appears');
  assert.match(await next.page.evaluate(() => window.fixtureRemovalText), /historical public fingerprint/);
  await until(async () => { const row = await revocation(next.page, original.device); return row?.appliedBy.includes(next.runtimeId) && row.pendingHosts.includes(old.runtimeId); }, 'only appointed host has a verified application receipt');
  assert.equal(exact((await snapshot(next.page)).membership.membershipIdentity.owner, original), true);
  assert.equal(exact(next.config().encryptionAuthority, original), true);
  await capture(next.page, 'original-removal-pending-desktop', '[data-revocation-device="' + original.device + '"][data-host-state="pending"]');
  pass('original removal retains genesis; the offline unappointed host stays pending despite the current host receipt');

  await next.page.locator('.encrypted-task-row[data-task-id="' + nextTask.id + '"]').click();
  await next.page.locator('#provider-select').selectOption('demo');
  await next.page.locator('#input').fill('create AFTER-REMOVAL.txt'); await next.page.locator('#btn-send').click();
  await next.page.locator('.ew-file h4').filter({ hasText: 'AFTER-REMOVAL.txt' }).waitFor({ timeout: 45000 }); await completed(next.page);
  assert.match(fs.readFileSync(path.join(next.project, 'AFTER-REMOVAL.txt'), 'utf8'), /AFTER-REMOVAL/);
  const after = await next.page.evaluate(async task => (await window.__plexus.state.encrypted.tasks.page(task.id)).events.at(-1), nextTask);
  assert.notEqual(after.envelope.content.session_id, before.envelope.content.session_id, 'room key rotates after original removal');
  const accepted = await next.page.evaluate(async ({ task, event, writer }) => {
    const client = window.__plexus.state.encrypted;
    return client.endpoint.decryptVerifiedTask(client.m.roomFor(task.id), { ...event.envelope, event_id: '$' + event.id, origin_server_ts: event.seq }, writer);
  }, { task: nextTask, event: after, writer: nextHost });
  assert.ok(accepted);
  await next.page.locator('#input').fill('delete cleanup'); await next.page.locator('#btn-send').click();
  await next.page.locator('[data-action="encrypted-approval-accept"]').waitFor();
  assert.equal(await next.page.locator('[data-action="encrypted-approval-accept"]').isDisabled(), true);
  await capture(next.page, 'approval-remains-separate-desktop', '#ew-content [data-approval-id]');
  await next.page.locator('[data-action="encrypted-interrupt"]').click();
  await until(async () => (await snapshot(next.page)).value.turn === 'interrupted', 'unapproved destructive action stops');
  assert.equal(fs.existsSync(path.join(next.project, 'cleanup/old.txt')), true);
  pass('appointed host continues after rotation but replacement still cannot approve a destructive action');

  await launch('original');
  await old.page.waitForFunction(() => window.__plexus?.state.encryptedState?.state === 'revoked', null, { timeout: 45000 });
  await fleet(old);
  await old.page.locator('#encrypted-setup').filter({ hasText: 'This endpoint: revoked' }).waitFor({ timeout: 45000 });
  await until(async () => (await old.setup()).freshnessAuthority?.kind === 'implicit-genesis' && (await old.setup()).freshnessAuthority?.state === 'revoked', 'unappointed host persists revoked implicit selection');
  assert.equal(exact(old.config().encryptionAuthority, original), true);
  assert.equal(exact(old.config().approvalAuthority, original), true, 'removed approver identity does not transfer');
  const oldIdentity = (await snapshot(old.page)).identity; assert.equal(exact(oldIdentity, original), true);
  const decrypt = await old.page.evaluate(async ({ task, before, after, writer }) => {
    const client = window.__plexus.state.encrypted, room = client.m.roomFor(task.id);
    const admittedSessions = new Set(JSON.parse(localStorage.getItem(client.storageKey('plexus.admitted.', task.id)) || '[]'));
    const retained = await client.endpoint.decryptVerifiedTask(room, { ...before.envelope, event_id: '$' + before.id, origin_server_ts: before.seq }, writer, { admittedSessions });
    let future; try { await client.endpoint.decryptVerifiedTask(room, { ...after.envelope, event_id: '$' + after.id, origin_server_ts: after.seq }, writer, { admittedSessions }); future = { decrypted: true }; }
    catch (error) { future = { decrypted: false, error: error.message || String(error) }; }
    let control; try { await client.startTurn(task, { input: [{ type: 'text', text: 'must not execute' }] }); control = 'accepted'; }
    catch (error) { control = error.code || error.message; }
    return { retained: !!retained, future, control };
  }, { task: nextTask, before, after, writer: nextHost });
  assert.equal(decrypt.retained, true); assert.equal(decrypt.future.decrypted, false); assert.equal(decrypt.control, 'endpoint_revoked');
  await next.page.locator('#btn-access').click();
  await until(async () => { const row = await revocation(next.page, original.device); return row?.appliedBy.includes(old.runtimeId) && row.appliedBy.includes(next.runtimeId) && row.pendingHosts.length === 0; }, 'both hosts have separate authenticated receipts');
  await fleet(old); await capture(old.page, 'unappointed-host-recovery-desktop', '#encrypted-setup [data-state="revoked"]');
  await capture(old.page, 'unappointed-host-recovery-mobile', '#encrypted-setup [data-state="revoked"]', true);
  assert.equal(await old.page.locator('[data-action="authorize-freshness-authority"]').count(), 0);
  await capture(next.page, 'original-removal-applied-desktop', '[data-revocation-device="' + original.device + '"][data-runtime-id="' + old.runtimeId + '"]');
  pass('restarted unappointed host applies removal and requires local recovery; old device keeps old history but cannot decrypt new ciphertext or control');
  assert.deepEqual(errors, { original: [], replacement: [], bob: [] });
  pass('both source Electron clients and the separate browser have zero uncaught renderer errors');
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: 'pass', checks, captures, errors,
    runtimeIds: { unappointed: old.runtimeId, appointed: next.runtimeId }, taskIds: { old: oldTask.id, replacement: nextTask.id },
    originalDevice: original.device, replacementDevice: replacement.device,
    originalGenesisPreserved: true, provider: 'demo', sourceState: 'working-tree', electron: 'two source applications, not installed artifacts',
    testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    customerMaterialOnlyRecovery: false }, null, 2) + '\n');
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  for (const desktop of desktops) if (desktop.app && !desktop.page.isClosed()) {
    await desktop.page.screenshot({ path: path.join(out, 'failure-' + desktop.label + '.png') }).catch(() => {});
    fs.writeFileSync(path.join(out, 'failure-' + desktop.label + '.txt'), await desktop.page.locator('body').innerText().catch(() => ''));
    fs.writeFileSync(path.join(out, 'failure-' + desktop.label + '-setup.json'), JSON.stringify(await desktop.setup().catch(() => null), null, 2));
    const diagnostic = await desktop.page.evaluate(async () => {
      const state = window.__plexus?.state, client = state?.encrypted;
      const task = state?.encryptedTasks?.find(value => value.id === state.activeThreadId);
      if (!task || !client) return { membership: state?.encryptedState, taskId: state?.activeThreadId };
      const writer = client.confirmedHost(task.runtimeId);
      const admitted = JSON.parse(localStorage.getItem(client.storageKey('plexus.admitted.', task.id)) || '[]');
      const page = await client.tasks.page(task.id);
      let decrypt;
      try { const opened = await client.endpoint.decryptVerifiedTask(client.m.roomFor(task.id), { ...page.events[0].envelope, event_id: '$' + page.events[0].id, origin_server_ts: page.events[0].seq }, writer,
        { admittedSessions: new Set(admitted) }); decrypt = { success: true, type: opened.type }; }
      catch (error) { decrypt = { success: false, message: error.message || String(error), description: error.description, code: error.code }; }
      return { taskId: task.id, mailboxError: client.mailboxError, admitted, writer, firstEventSession: page.events[0]?.envelope.content.session_id,
        verified: writer ? await client.endpoint.isEndpointVerified(writer.user, writer.device) : false, decrypt,
        membership: state.encryptedState, snapshotError: state.encryptedSnapshots.get(task.id)?.error };
    }).catch(error => ({ error: error.message }));
    fs.writeFileSync(path.join(out, 'failure-' + desktop.label + '-crypto.json'), JSON.stringify(diagnostic, null, 2));
    const log = path.join(desktop.userData, 'logs', 'desktop.log'); if (fs.existsSync(log)) fs.copyFileSync(log, path.join(out, 'failure-' + desktop.label + '.log'));
  }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: 'fail', error: error.stack, checks, captures, errors }, null, 2) + '\n');
}).finally(async () => {
  for (const desktop of desktops) await desktop.app?.close().catch(() => {});
  await browser?.close(); await hub?.close(); fs.rmSync(temp, { recursive: true, force: true });
});
