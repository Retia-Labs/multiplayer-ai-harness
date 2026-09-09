'use strict';
// Shared renderer + actual SDK + production Runtime. The Node host uses a memory
// SDK test adapter; no browser crypto, membership controller or successful import is replaced.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { Endpoint } = require('../packages/e2ee/endpoint');
const root = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-owner-ui-'));
const out = path.join(root, '.artifacts/owner-recovery-browser'), checks = [], errors = [], logs = [], captures = [];
let hub, runtime, browser, lastPage;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const until = async (read, label) => { const end = Date.now() + 45000; while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(r => setTimeout(r, 150)); } throw new Error('Timed out: ' + label + '\n' + logs.slice(-8).join('\n')); };
async function capture(page, name, selector, mobile = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1487, height: 1058 });
  if (mobile) await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().right <= 0);
  await page.waitForFunction(() => document.querySelectorAll('#toasts .toast').length === 0);
  await page.evaluate(() => document.fonts.ready); await page.locator(selector).waitFor({ state: 'visible' });
  await page.locator(selector).evaluate(node => node.scrollIntoView({ block: 'start' }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(out, name + '.png') }); captures.push(name + '.png');
}
async function recovery(page) { await page.locator('#btn-recovery').click(); await page.locator('#owner-authority-recovery').waitFor(); }
(async () => {
  fs.mkdirSync(out, { recursive: true }); const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
  hub = new Hub({ dbFile: path.join(temp, 'hub.sqlite'), staticDir: path.join(root, 'apps/web'), log: () => {} });
  const address = await hub.listen(), url = 'http://127.0.0.1:' + address.port;
  runtime = new Runtime({ hubUrl: url.replace('http', 'ws'), dataDir: path.join(temp, 'runtime'), projects: [workspace],
    encryptedTasksOnly: true, encryptedEndpointFactory: options => Endpoint.create(options), log: line => logs.push(line) });
  await runtime.start(); browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
  const originalContext = await browser.newContext(); let original = await originalContext.newPage(); lastPage = original;
  original.on('pageerror', error => errors.push(error.message)); original.on('dialog', dialog => dialog.accept());
  await original.goto(url); await original.locator('#login-name').fill('Owner'); await original.locator('#login-form button').click();
  await original.locator('#team-name').fill('Owner kit recovery'); await original.locator('#btn-create-team').click();
  await original.locator('#encrypted-setup').filter({ hasText: 'This endpoint: verified' }).waitFor();
  const genesis = await original.evaluate(() => window.__plexus.state.encryptedIdentity);
  const session = await original.evaluate(() => JSON.parse(localStorage.getItem('harness.session')));
  await original.locator('#pair-code').fill(runtime.pairingCode); await original.locator('#btn-pair-host').click();
  await until(() => runtime.teamId, 'paired'); runtime.encryptionAuthority = { ...genesis, teamId: runtime.teamId }; await runtime.ensureEncryptedHost();
  await original.locator('[data-action="show-host-fingerprint"]').click(); await original.locator('[data-action="confirm-host"]').click();
  await original.locator('#provider-select').selectOption('demo');
  await original.locator('#input').fill('create OWNER-HISTORY.txt'); await original.locator('#btn-send').click();
  await original.locator('.ew-file h4').filter({ hasText: 'OWNER-HISTORY.txt' }).waitFor({ timeout: 45000 });
  await original.locator('#ew-target').filter({ hasText: 'Start a follow-up on this task' }).waitFor();
  assert.match(fs.readFileSync(path.join(workspace, 'OWNER-HISTORY.txt'), 'utf8'), /create OWNER-HISTORY.txt/);
  const taskId = await original.evaluate(() => window.__plexus.state.activeThreadId);
  const historicalEvents = await original.evaluate(() => window.__plexus.state.encryptedSnapshots.get(window.__plexus.state.activeThreadId).events);
  await recovery(original);
  async function provision() {
    await original.locator('[data-action="start-owner-recovery-kit"]').click();
    const key = await until(async () => (await original.locator('#owner-authority-recovery .rec-key').count()) && original.locator('#owner-authority-recovery .rec-key').textContent(), 'issued owner kit key');
    const generation = await original.evaluate(() => window.__plexus.state.ownerRecoveryDrill.generation);
    await original.locator('[name="owner-recovery-drill"]').fill(key);
    await original.locator('[data-action="complete-owner-recovery-kit"]').click();
    const receipt = await until(() => original.evaluate(generation => window.__plexus.state.ownerRecoveryReceipt?.state === 'saved' && window.__plexus.state.ownerRecoveryReceipt.generation === generation && window.__plexus.state.ownerRecoveryReceipt, generation), 'real clean drill and signed descriptor');
    return { key, ...receipt };
  }
  const oldKit = await provision(); assert.equal(oldKit.generation, 1);
  const download = await Promise.all([original.waitForEvent('download'), original.locator('[data-action="download-owner-recovery-kit"]').click()]);
  assert.equal(fs.readFileSync(await download[0].path(), 'utf8'), oldKit.ciphertext);
  pass('visible owner setup performs a clean SDK drill, commits the descriptor and downloads the actual encrypted kit');
  let kit = await provision(); assert.equal(kit.generation, 2);
  assert.notEqual(JSON.parse(kit.ciphertext).ciphertext, JSON.parse(oldKit.ciphertext).ciphertext);
  await original.locator('[data-action="disable-owner-recovery-kit"]').click();
  await until(() => original.evaluate(() => !window.__plexus.state.recoveryState.ownerRecovery.descriptor), 'disabled descriptor');
  kit = await provision(); assert.equal(kit.generation, 3);
  pass('disabling and re-enabling recovery requires a new account signing root and a real drill at the next generation');
  await capture(original, 'kit-saved-desktop', '#owner-authority-recovery');
  await runtime.stop(); await originalContext.close(); original = null;
  pass('explicit authority replacement completes before every trusted customer browser is closed and the host goes offline');

  const cleanContext = await browser.newContext(); let clean = await cleanContext.newPage(); lastPage = clean;
  await clean.addInitScript(value => localStorage.setItem('harness.session', JSON.stringify(value)), session);
  const attach = page => { page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept()); };
  attach(clean); await clean.goto(url); await clean.locator('#encrypted-setup').filter({ hasText: 'This endpoint: pending' }).waitFor();
  const unchanged = await clean.evaluate(() => window.__plexus.state.encrypted.endpoint.identity());
  await recovery(clean); await clean.locator('[name="owner-kit-scope"]').selectOption(oldKit.scope);
  await clean.locator('[name="owner-recovery-key"]').fill(oldKit.key); await clean.locator('[data-action="stage-owner-recovery"]').click();
  await clean.locator('#owner-authority-recovery .ew-inline-error').filter({ hasText: 'owner_recovery_descriptor_inactive' }).waitFor();
  assert.deepEqual(await clean.evaluate(() => window.__plexus.state.encrypted.endpoint.identity()), unchanged);
  await clean.locator('[name="owner-kit-scope"]').selectOption(kit.scope); await clean.locator('[name="owner-recovery-key"]').fill('A'.repeat(43));
  await clean.locator('[data-action="stage-owner-recovery"]').click();
  await clean.locator('#owner-authority-recovery .ew-inline-error').filter({ hasText: 'owner_recovery_material_rejected' }).waitFor();
  assert.deepEqual(await clean.evaluate(() => window.__plexus.state.encrypted.endpoint.identity()), unchanged);
  pass('old authority kit and wrong wrapping key refuse without changing the active device');
  await clean.locator('[name="owner-recovery-key"]').fill(kit.key); await clean.locator('[data-action="stage-owner-recovery"]').click();
  const staged = await until(() => clean.evaluate(() => window.__plexus.state.recoveryState?.ownerRecovery?.stage), 'inactive stage');
  assert.notEqual(staged.identity.device, unchanged.device); assert.notEqual(staged.identity.ed25519, genesis.ed25519);
  const published = await clean.evaluate(() => window.__plexus.state.encrypted.endpoint.peerEndpoints(window.__plexus.state.encrypted.endpoint.user));
  assert.equal(published.some(identity => identity.device === staged.identity.device), false);
  assert.deepEqual(await clean.evaluate(() => window.__plexus.state.encrypted.endpoint.identity()), unchanged);
  await clean.locator('[data-action="inspect-owner-recovery-history"]').click();
  await clean.locator('[data-task-id="' + taskId + '"]').filter({ hasText: 'Verified restored task history' }).waitFor();
  assert.deepEqual(await clean.evaluate(() => window.__plexus.state.ownerRecoveryPreview.snapshot.events), historicalEvents);
  assert.ok((await clean.locator('#owner-authority-recovery [data-task-id="' + taskId + '"]').innerText()).includes('OWNER-HISTORY.txt'));
  await capture(clean, 'staged-history-desktop', '#owner-authority-recovery [data-state="history-restored"]');
  await clean.reload(); await clean.locator('#encrypted-setup').waitFor(); await recovery(clean);
  assert.equal(await clean.locator('[data-action="recover-owner-membership"]').isDisabled(), true);
  await clean.locator('[name="owner-kit-scope"]').selectOption(kit.scope); await clean.locator('[name="owner-recovery-key"]').fill(kit.key);
  await clean.locator('[data-action="stage-owner-recovery"]').click();
  await until(() => clean.evaluate(() => window.__plexus.state.recoveryState?.ownerRecovery?.resumeRequired === false), 'resumed inactive stage');
  assert.equal((await clean.evaluate(() => window.__plexus.state.recoveryState.ownerRecovery.stage)).identity.device, staged.identity.device);
  pass('customer material restores exact history in an unpublished new SDK device; reload requires revalidation and resumes the same staged identity');
  await clean.locator('[data-action="recover-owner-membership"]').click();
  await clean.locator('#owner-authority-recovery [data-state="pending-host"]').waitFor({ timeout: 45000 });
  const recovered = await clean.evaluate(() => ({ identity: window.__plexus.state.encryptedIdentity, membership: window.__plexus.state.encryptedState.membershipIdentity }));
  assert.equal(recovered.identity.device, staged.identity.device); assert.equal(recovered.membership.state, 'verified');
  assert.equal(recovered.membership.owner.ed25519, genesis.ed25519); assert.equal(recovered.membership.grants.every(grant => grant.revoked), true);
  assert.match(recovered.membership.recoveryEpoch, /^[a-f0-9]{32}$/);
  for (const secret of [oldKit.key, kit.key]) assert.equal(await clean.evaluate(value => JSON.stringify(localStorage).includes(value), secret), false);
  assert.equal(await clean.locator('[data-action="activate-owner-recovery-host"]').count(), 0, 'remote browser cannot invoke native activation');
  await capture(clean, 'host-offline-desktop', '#owner-authority-recovery [data-state="pending-host"]');
  await capture(clean, 'host-offline-mobile', '#owner-authority-recovery [data-state="pending-host"]', true);
  await clean.setViewportSize({ width: 1487, height: 1058 });
  await clean.reload(); await recovery(clean);
  assert.equal((await clean.evaluate(() => window.__plexus.state.encryptedIdentity)).device, staged.identity.device);
  pass('explicit dual-signed recovery admits only the new owner, retains genesis, resets access, survives reload and leaves the offline host pending');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: 'pass', checks, captures, errors, provider: 'demo', hostStore: 'Node memory SDK test adapter', survivor: false, nativeActivation: 'not exercised in browser proof' }, null, 2));
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (lastPage && !lastPage.isClosed()) {
    await lastPage.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(out, 'failure.txt'), await lastPage.locator('body').innerText().catch(() => ''));
  }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: 'fail', error: error.stack, checks, errors }, null, 2));
}).finally(async () => { await browser?.close(); await runtime?.stop(); await hub?.close(); fs.rmSync(temp, { recursive: true, force: true }); });
