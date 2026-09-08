'use strict';
// The shared browser renderer drives the installed runtime's encrypted discovery/control
// path. Only the local provider and host key store are deterministic test adapters.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { Endpoint } = require('../packages/e2ee/endpoint');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.artifacts/encrypted-workspace');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-workspace-ui-'));
const checks = [], errors = [], logs = [];
const until = async (read, label) => {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out: ' + label + '\n' + logs.slice(-12).join('\n'));
};
const pass = name => { checks.push(name); console.log('PASS ' + name); };
let hub, runtime, browser, lastPage;
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(workspace, 'build')); fs.writeFileSync(path.join(workspace, 'build/obsolete.txt'), 'disposable');
  hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite'), staticDir: path.join(root, 'apps/web'), log: () => {} });
  const address = await hub.listen(); const url = 'http://127.0.0.1:' + address.port;
  runtime = new Runtime({ hubUrl: url.replace('http', 'ws'), dataDir: path.join(dir, 'runtime'), projects: [workspace],
    encryptedTasksOnly: true, name: 'Shared execution host', encryptedEndpointFactory: options => Endpoint.create(options), log: line => logs.push(line) });
  await runtime.start();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  const alice = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
  await alice.emulateMedia({ reducedMotion: 'reduce' });
  // Exercise the shared renderer's supported local setup bridge with the production
  // runtime's real metadata file; this does not launch Electron or call a provider.
  await alice.route('**/__fixture/encrypted-setup', route => route.fulfill({ contentType: 'application/json',
    body: fs.readFileSync(path.join(runtime.dataDir, 'encrypted-setup.json'), 'utf8') }));
  await alice.addInitScript(() => { window.harnessDesktop = { encryptedSetup: async () =>
    (await fetch('/__fixture/encrypted-setup')).json() }; });
  lastPage = alice;
  alice.on('pageerror', error => errors.push(error.message));
  await alice.goto(url); await alice.locator('#login-name').fill('Alice'); await alice.locator('#login-form button').click();
  await alice.locator('#team-name').fill('Review together'); await alice.locator('#btn-create-team').click();
  await alice.locator('#encrypted-setup').filter({ hasText: 'This endpoint: verified' }).waitFor({ timeout: 30000 });
  await until(() => runtime.pairingCode, 'pairing code');
  await alice.locator('#pair-code').fill(runtime.pairingCode); await alice.locator('#btn-pair-host').click();
  await until(() => runtime.teamId, 'paired runtime');
  // This is the host-local configuration seam. Browser control actions below use visible
  // controls only; no EncryptedHost, reducer, or application command helper is injected.
  const identity = await alice.evaluate(() => window.__plexus.state.encryptedIdentity);
  const aliceId = await alice.evaluate(() => window.__plexus.state.me.id);
  runtime.encryptionAuthority = { ...identity, teamId: runtime.teamId };
  await runtime.ensureEncryptedHost();
  await alice.locator('[data-action="show-host-fingerprint"]').click();
  const originalPrompt = await alice.locator('[aria-label="Confirm the execution host"]').elementHandle();
  const originalFingerprint = await originalPrompt.innerText();
  runtime.approvalAuthority = { ...identity, teamId: runtime.teamId };
  runtime.writeEncryptedSetup();
  await until(async () => JSON.parse(await alice.locator('#encrypted-setup').getAttribute('data-signature'))[2]?.approvalAuthority?.user === identity.user,
    'new local approval consent refreshes setup');
  assert.equal(await originalPrompt.evaluate(node => node.isConnected), false, 'setup actually rerendered during comparison');
  assert.equal(await alice.locator('[aria-label="Confirm the execution host"]').innerText(), originalFingerprint, 'comparison remains bound to the exact displayed host key');
  await alice.locator('[data-action="confirm-host"]').click();
  await alice.locator('[aria-label="Confirm the execution host"]').waitFor({ state: 'detached' });
  pass('setup refresh preserves the open exact host fingerprint comparison until confirmation');
  await alice.locator('#provider-select').selectOption('demo');
  await alice.screenshot({ path: path.join(out, 'setup-desktop.png') });
  await alice.locator('#input').fill('create VERIFIED.txt'); await alice.locator('#btn-send').click();
  await alice.locator('#encrypted-workspace').waitFor({ state: 'visible' });
  await alice.locator('.ew-file h4').filter({ hasText: 'VERIFIED.txt' }).waitFor({ timeout: 45000 });
  assert.match(fs.readFileSync(path.join(workspace, 'VERIFIED.txt'), 'utf8'), /create VERIFIED.txt/);
  const taskId = await alice.locator('.encrypted-task-row[aria-current="page"]').getAttribute('data-task-id');
  assert.match(taskId, /^et_/);
  await alice.locator('[data-action="open-diff-source"]').click();
  await alice.locator('#ew-content .cu-source-pane').filter({ hasText: 'diff.updated' }).waitFor();
  await alice.locator('[data-action="close-source"]').click();
  pass('public composer starts an encrypted task; integrated host writes real bytes and source diff');
  await alice.locator('.ew-main').evaluate(node => node.scrollTop = 0);
  await alice.screenshot({ path: path.join(out, 'review-desktop.png') });
  await alice.locator('[data-action="view-catchup"]').click();
  await alice.locator('#ew-content .cu-objective').filter({ hasText: 'create VERIFIED.txt' }).waitFor();
  await alice.screenshot({ path: path.join(out, 'catchup-desktop.png') });

  // A teammate joins after history exists. Confirming the host only after project sharing
  // exercises retained encrypted mailbox envelopes rather than pre-authorized test state.
  const bob = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
  bob.on('pageerror', error => errors.push(error.message));
  await bob.goto(url); await bob.locator('#login-name').fill('Bob'); await bob.locator('#login-form button').click();
  await bob.locator('#team-gate').waitFor({ state: 'visible' });
  const bobId = await bob.locator('#team-gate-account-id').inputValue();
  await alice.locator('#nav-fleet').click(); await alice.locator('#invitee-user-id').fill(bobId); await alice.locator('#btn-invite').click();
  await alice.locator('#invite-row').waitFor({ state: 'visible' });
  await bob.locator('#join-code').fill(await alice.locator('#invite-code').inputValue()); await bob.locator('#btn-join-team').click();
  await bob.locator('#enrollment-badge').waitFor({ state: 'visible' });
  await alice.locator('#btn-access').click();
  const bobDevice = alice.locator('.ew-device').filter({ hasText: 'Bob' });
  await bobDevice.locator('input[type="checkbox"]').check(); await bobDevice.locator('[data-action="verify-teammate"]').click();
  await bobDevice.locator('[data-action="grant-project"]').click();
  await bob.locator('#encrypted-setup').filter({ hasText: 'This endpoint: verified' }).waitFor({ timeout: 45000 });
  await bob.locator('.encrypted-task-row').click();
  await bob.locator('[data-action="verify-task-host"]').click(); await bob.locator('[data-action="confirm-host"]').click();
  await bob.locator('.ew-file h4').filter({ hasText: 'VERIFIED.txt' }).waitFor({ timeout: 45000 });
  await bob.reload(); await bob.locator('.encrypted-task-row').click();
  await bob.locator('.ew-file h4').filter({ hasText: 'VERIFIED.txt' }).waitFor({ timeout: 45000 });
  pass('late teammate receives prior history, confirms host later, and replays after reload');
  await alice.screenshot({ path: path.join(out, 'access-desktop.png') });
  await alice.locator('.encrypted-task-row').click(); await alice.locator('[data-action="view-review"]').click();

  await alice.locator('summary').filter({ hasText: 'Related work' }).click();
  await alice.getByLabel('Issue or pull request URL').fill('https://github.com/Retia-Labs/multiplayer-ai-harness/issues/7');
  await alice.getByLabel('Link title (optional)').fill('Encrypted task'); await alice.locator('[data-action="add-related-link"]').click();
  await alice.locator('#ew-content a').filter({ hasText: 'Encrypted task' }).waitFor({ timeout: 30000 });
  await alice.locator('[data-action="remove-related-link"]').click();
  await alice.locator('#ew-content a').filter({ hasText: 'Encrypted task' }).waitFor({ state: 'detached', timeout: 30000 });
  await alice.locator('summary').filter({ hasText: 'Ask a teammate' }).click();
  await alice.getByLabel('Help recipient').selectOption(bobId); await alice.getByLabel('Question for your teammate').fill('Can you review this recorded change?');
  await alice.locator('[data-action="ask-for-help"]').click();
  await bob.locator('#btn-inbox').click(); await bob.locator('#inbox-view .cu-help-question').filter({ hasText: 'Can you review' }).waitFor({ timeout: 30000 });
  await bob.locator('[data-action="resolve-help"]').click();
  await alice.locator('#ew-discussion .ew-message').filter({ hasText: 'Human help · resolved' }).waitFor({ timeout: 30000 });
  await alice.locator('summary').filter({ hasText: 'Hand off responsibility' }).click();
  await alice.getByLabel('New responsible teammate').selectOption(bobId); await alice.getByLabel('Handoff note').fill('Review complete; you own the next decision.');
  await alice.locator('[data-action="encrypted-handoff"]').click();
  await alice.locator('.ew-ownership').filter({ hasText: 'Responsible: Bob' }).waitFor({ timeout: 30000 });
  pass('related links add/remove, human inbox resolution and responsibility handoff are host recorded');

  await alice.locator('#input').fill('delete build'); await alice.locator('#btn-send').click();
  await alice.locator('[data-action="encrypted-approval-accept"]').waitFor({ timeout: 45000 });
  await alice.locator('[data-approval-id]').last().evaluate(node => node.scrollIntoView({ block: 'start' }));
  await alice.screenshot({ path: path.join(out, 'approval-desktop.png') });
  await alice.locator('#input').fill('After deletion, summarize the result for Bob.'); await alice.locator('#btn-send').click();
  await alice.locator('#ew-receipts [data-state="queued"]').waitFor({ timeout: 30000 });
  await bob.locator('.encrypted-task-row').click();
  await bob.locator('[data-action="encrypted-approval-accept"]').waitFor({ timeout: 30000 });
  assert.equal(await bob.locator('[data-action="encrypted-approval-accept"]').isDisabled(), true, 'membership alone cannot approve');
  assert.equal(await bob.locator('[data-action="grant-action-approval"]').count(), 0);
  await alice.getByLabel('Delegate this action to').selectOption(bobId); await alice.locator('[data-action="grant-action-approval"]').click();
  await alice.locator('[data-action="revoke-approval-grant"]').waitFor({ timeout: 30000 });
  await until(() => bob.locator('[data-action="encrypted-approval-accept"]').isEnabled(), 'exact grant enables the teammate decision');
  assert.equal(await bob.locator('[data-action="revoke-approval-grant"]').count(), 0, 'delegation does not make the recipient a grant administrator');
  await bob.locator('[data-action="encrypted-approval-accept"]').click();
  await until(() => !fs.existsSync(path.join(workspace, 'build')), 'approved delete applied');
  await bob.locator('#ew-receipts [data-state="delivered"]').filter({ hasText: 'Approve once' }).waitFor({ timeout: 30000 });
  pass('owner delegates exact action; teammate resolves it with a host receipt and real filesystem effect');
  await alice.locator('#ew-receipts .ew-receipt').filter({ hasText: 'Direction from Alice' }).filter({ hasText: 'delivered' }).waitFor({ timeout: 30000 });
  pass('a named direction preserves its turn and advances from queued to delivered');
  fs.mkdirSync(path.join(workspace, 'build')); fs.writeFileSync(path.join(workspace, 'build/keep.txt'), 'keep after interruption');
  await alice.locator('#input').fill('delete build'); await alice.locator('#btn-send').click();
  await alice.locator('[data-action="encrypted-approval-accept"]').waitFor({ timeout: 30000 });
  await alice.locator('[data-action="encrypted-interrupt"]').click();
  await alice.locator('#ew-receipts .ew-receipt').filter({ hasText: 'Interruption requested' }).filter({ hasText: 'accepted' }).waitFor({ timeout: 30000 });
  assert.equal(fs.existsSync(path.join(workspace, 'build/keep.txt')), true);
  pass('interrupt targets the active turn and retains unapproved filesystem content');

  // Separate host-local consent names Bob, who is a team member, as approver. The
  // creation event still names Alice; each new request must carry the current owner.
  await until(() => runtime.sessions.size === 0, 'interrupted turn ended');
  await alice.locator('#ew-target').filter({ hasText: 'Start a follow-up on this task' }).waitFor();
  const bobIdentity = await bob.evaluate(() => window.__plexus.state.encryptedIdentity);
  runtime.approvalAuthority = { ...bobIdentity, teamId: runtime.teamId };
  await alice.locator('#input').fill('delete build'); await alice.locator('#btn-send').click();
  await alice.locator('[data-action="encrypted-approval-accept"]').waitFor({ timeout: 30000 });
  assert.equal(await alice.locator('[data-action="encrypted-approval-accept"]').isDisabled(), true, 'the membership signer is not the new request owner');
  assert.equal(await alice.locator('[data-action="grant-action-approval"]').count(), 0, 'the historical owner cannot delegate the new request');
  await bob.locator('[data-action="grant-action-approval"]').waitFor({ timeout: 30000 });
  await bob.getByLabel('Delegate this action to').selectOption(aliceId);
  await bob.locator('[data-action="grant-action-approval"]').click();
  await until(() => alice.locator('[data-action="encrypted-approval-accept"]').isEnabled(), 'Bob delegates the action to Alice');
  assert.equal(await alice.locator('[data-action="revoke-approval-grant"]').count(), 0, 'team owner cannot revoke another configured approver’s grant');
  await bob.locator('[data-action="revoke-approval-grant"]').waitFor({ timeout: 30000 });
  await bob.locator('[data-approval-id]').last().evaluate(node => node.scrollIntoView({ block: 'start' }));
  await bob.screenshot({ path: path.join(out, 'approval-member-owner-desktop.png') });
  await bob.locator('[data-action="revoke-approval-grant"]').click();
  await until(() => alice.locator('[data-action="encrypted-approval-accept"]').isDisabled(), 'configured member approver revokes the exact grant');
  await bob.locator('[data-action="grant-action-approval"]').click();
  await until(() => alice.locator('[data-action="encrypted-approval-accept"]').isEnabled(), 'fresh scoped grant enables Alice again');
  // A laptop returning after the displayed deadline must not retain enabled controls
  // just because the encrypted event count has not changed in the meantime.
  await alice.clock.setFixedTime(Date.now() + 2 * 60 * 60 * 1000);
  await alice.locator('[data-approval-id]').last().filter({ hasText: 'Expired. This request can no longer authorize an action.' }).waitFor({ timeout: 15000 });
  assert.equal(await alice.locator('[data-action="encrypted-approval-accept"]').count(), 0);
  await alice.clock.setSystemTime(Date.now());
  await alice.locator('[data-action="encrypted-approval-decline"]').click();
  await until(() => runtime.sessions.size === 0, 'delegated refusal ended the turn');
  assert.equal(fs.existsSync(path.join(workspace, 'build/keep.txt')), true);
  pass('current host approver differs from membership owner; delegation, revocation and expiry follow the exact request');
  runtime.approvalAuthority = { ...identity, teamId: runtime.teamId };

  await alice.setViewportSize({ width: 390, height: 844 });
  await alice.locator('.ew-main').evaluate(node => node.scrollTop = 0);
  await alice.screenshot({ path: path.join(out, 'review-mobile.png') });
  assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no mobile page overflow');
  await alice.locator('[data-action="toggle-discussion"]').click();
  await alice.locator('#input').waitFor({ state: 'visible' });
  await alice.screenshot({ path: path.join(out, 'discussion-mobile.png') });
  await alice.locator('[data-action="close-discussion"]').click();
  pass('390px review and composer drawer stay accessible without horizontal page overflow');
  await alice.setViewportSize({ width: 1487, height: 1058 });
  await alice.locator('summary').filter({ hasText: 'Record the task outcome' }).click();
  await alice.locator('[data-action="outcome-completed"]').click();
  await alice.locator('#ew-heading').filter({ hasText: 'Task outcome: completed' }).waitFor({ timeout: 30000 });
  await alice.locator('#btn-recovery').click(); await alice.locator('[data-action="start-recovery"]').click();
  const initialKey = await alice.locator('.rec-key').innerText();
  await alice.locator('.rec-input').fill(initialKey); await alice.locator('[data-action="confirm-recovery"]').click();
  await alice.locator('[data-action="replace-recovery"]').waitFor({ timeout: 30000 });
  await alice.locator('[data-action="replace-recovery"]').click();
  const replacementKey = await alice.locator('.rec-key').innerText(); assert.notEqual(replacementKey, initialKey);
  await alice.locator('.rec-input').fill('incorrect recovery key'); await alice.locator('[data-action="confirm-recovery"]').click();
  assert.equal(await alice.locator('.rec-key').innerText(), replacementKey, 'failed drill keeps setup pending');
  await alice.locator('.rec-input').fill(replacementKey); await alice.locator('[data-action="confirm-recovery"]').click();
  await alice.locator('[data-action="replace-recovery"]').waitFor({ timeout: 30000 });
  const recovered = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
  lastPage = recovered; recovered.on('pageerror', error => errors.push(error.message));
  const session = await alice.evaluate(() => localStorage.getItem('harness.session'));
  await recovered.goto(url); await recovered.evaluate(value => localStorage.setItem('harness.session', value), session); await recovered.reload();
  let releaseListing; const listing = new Promise(resolve => { releaseListing = resolve; });
  await recovered.route('**/api/e2ee/recovery', async route => { if (route.request().postDataJSON().op === 'list') await listing; await route.continue(); });
  await recovered.locator('#btn-recovery').click(); await recovered.getByLabel('Recovery key').fill(replacementKey);
  releaseListing(); await recovered.locator('[data-action="restore-history"]').waitFor();
  assert.equal(await recovered.getByLabel('Recovery key').inputValue(), replacementKey, 'late backup listing preserves the typed customer key');
  await recovered.locator('[data-action="restore-history"]').click();
  await until(async () => { const message = await recovered.locator('#toasts').innerText(); const error = await recovered.locator('.ew-inline-error').allTextContents(); if (error.length) throw new Error('Restore UI: ' + error.join(' ')); return message.includes('History restored'); }, 'restore result');
  await recovered.locator('.encrypted-task-row').click();
  await recovered.locator('.ew-file h4').filter({ hasText: 'VERIFIED.txt' }).waitFor({ timeout: 45000 });
  assert.equal(await recovered.locator('#btn-send').isDisabled(), true, 'recovered history does not verify a new endpoint');
  pass('customer key drill, safe replacement and fresh-endpoint history restore use actual recovery controls');
  lastPage = alice;
  const recoveredIdentity = await recovered.evaluate(() => window.__plexus.state.encryptedIdentity);
  await alice.locator('#btn-access').click();
  const pendingDevice = alice.locator('#access-view .ew-device').filter({ hasText: recoveredIdentity.device });
  await pendingDevice.filter({ hasText: 'This device cannot control tasks or approve actions until it is verified.' }).waitFor();
  assert.equal(await pendingDevice.locator('[data-action="revoke-device"]').count(), 0, 'pending device has no unsupported removal action');
  assert.equal(await pendingDevice.locator('[data-action="verify-teammate"]').isEnabled(), true, 'explicit fingerprint verification remains available');
  await pendingDevice.evaluate(node => node.scrollIntoView({ block: 'center' }));
  await alice.screenshot({ path: path.join(out, 'access-unverified-desktop.png') });
  pass('pending restored device explains unavailable controls and offers verification instead of unsupported removal');
  await alice.locator('#nav-fleet').click();
  await alice.locator('#input').fill('create OFFLINE.txt'); await alice.locator('#btn-send').click();
  await alice.locator('.ew-file h4').filter({ hasText: 'OFFLINE.txt' }).waitFor({ timeout: 30000 });
  assert.equal(await alice.locator('#btn-send').isEnabled(), true, 'open task accepts control while host is online');
  await until(() => runtime.sessions.size === 0, 'initial file turn ended');
  await alice.locator('#ew-target').filter({ hasText: 'Start a follow-up on this task' }).waitFor();
  const provider = runtime.provider.bind(runtime);
  runtime.provider = id => id === 'demo' ? { id: 'fixture-provider', run: async () => { throw new Error('codex_usage_limit'); } } : provider(id);
  await alice.locator('#input').fill('Try one further turn'); await alice.locator('#btn-send').click();
  await alice.locator('[data-provider-failure="codex_usage_limit"]').filter({ hasText: 'Check the provider account’s usage limits' }).waitFor({ timeout: 30000 });
  await alice.locator('#ew-heading').filter({ hasText: 'Provider: fixture-provider' }).waitFor({ timeout: 30000 });
  assert.equal(await alice.locator('#btn-send').isEnabled(), true, 'failed provider turn does not settle the task');
  await alice.locator('.ew-main').evaluate(node => node.scrollTop = 0);
  await alice.screenshot({ path: path.join(out, 'provider-failure-desktop.png') });
  pass('a real encrypted provider failure displays an actionable next step and keeps the task open');
  for (const [code, expected] of [
    ['codex_host_tools_version_unsupported', /Codex 0\.153\.4.*darwin\/arm64.*gpt-5\.4-mini/],
    ['codex_host_tools_login_required', /Sign in with ChatGPT.*local file credential storage/],
    ['codex_host_tools_ambient_config', /Reconfigure the supported isolated host setup.*Keep the isolation checks enabled/]
  ]) {
    await alice.locator('#ew-target').filter({ hasText: 'Start a follow-up on this task' }).waitFor();
    runtime.provider = id => id === 'demo' ? { id: 'fixture-provider', run: async () => { throw new Error(code); } } : provider(id);
    await alice.locator('#input').fill('Retry with the host setup'); await alice.locator('#btn-send').click();
    const failure = alice.locator('[data-provider-failure="' + code + '"]');
    await failure.waitFor({ timeout: 30000 });
    assert.match(await failure.innerText(), expected);
    assert.equal(await alice.locator('#btn-send').isEnabled(), true, 'host setup failure leaves task available for an explicit retry');
  }
  await alice.locator('.ew-main').evaluate(node => node.scrollTop = 0);
  await alice.screenshot({ path: path.join(out, 'provider-setup-failure-desktop.png') });
  pass('host compatibility, local ChatGPT login and isolation errors each provide safe setup guidance');
  runtime.provider = provider;
  await runtime.stop();
  await alice.locator('.ew-ownership').filter({ hasText: 'Disconnected' }).waitFor({ timeout: 30000 });
  assert.equal(await alice.locator('#btn-send').isDisabled(), true);
  pass('task outcome is separate from turn completion; offline host disables controls while retaining history');
  // A relay can lie in its project summary. The real signed revocation remains pending
  // while the host is offline, so this claim must not become an Access success receipt.
  let forgedProjectResponses = 0;
  await alice.route('**/api/enrollment?*', async route => {
    if (!new URL(route.request().url()).searchParams.has('project')) return route.continue();
    const response = await route.fetch(); const body = await response.json();
    body.revocations = [{ userId: bobId, device: bobIdentity.device, applied: true, appliedBy: [runtime.id], pendingHosts: [], receipts: [] }];
    forgedProjectResponses++;
    await route.fulfill({ response, json: body });
  });
  await alice.locator('[data-action="view-access"]').click();
  await until(() => forgedProjectResponses > 0, 'malicious project summary delivered');
  const revokedDevice = alice.locator('#ew-content .ew-device').filter({ hasText: bobIdentity.device });
  alice.once('dialog', dialog => dialog.accept());
  await revokedDevice.locator('[data-action="revoke-device"]').click();
  const removal = alice.locator('#ew-content p').filter({ hasText: 'Removal of ' + bobIdentity.device + ':' });
  await until(async () => {
    const failure = await alice.locator('.ew-inline-error').allTextContents();
    if (failure.length) throw new Error('Removal UI: ' + failure.join(' '));
    return await removal.filter({ hasText: 'pending hosts' }).count();
  }, 'revoked device remains pending at the offline host');
  assert.doesNotMatch(await removal.innerText(), /applied by acknowledged hosts/);
  await removal.evaluate(node => node.scrollIntoView({ block: 'center' }));
  await alice.screenshot({ path: path.join(out, 'access-pending-desktop.png') });
  await alice.unroute('**/api/enrollment?*');
  pass('Access retains offline revocation pending despite a project response claiming host application without signed receipts');
  assert.deepEqual(errors, []);
  for (const stale of ['failure.json', 'failure-page.txt', 'failure.png']) fs.rmSync(path.join(out, stale), { force: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ checks, errors, viewports: ['1487x1058', '390x844'], provider: 'deterministic demo through production Runtime' }, null, 2));
})().catch(async error => { if (lastPage) { await lastPage.screenshot({ path: path.join(out, 'failure.png') }); fs.writeFileSync(path.join(out, 'failure-page.txt'), await lastPage.locator('body').innerText()); } console.error(error); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.stack, logs, checks, errors }, null, 2)); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await runtime?.stop(); await hub?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
