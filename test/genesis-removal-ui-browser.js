'use strict';
// Public renderer gate: an account and relay-supplied appointment-shaped data do
// not authorize the guided original-device removal in a remote browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-genesis-ui-'));
let hub, browser;
(async () => {
  hub = new Hub({ dbFile: path.join(temp, 'hub.sqlite'), staticDir: path.join(root, 'apps/web'), log: () => {} });
  const address = await hub.listen(), url = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
  const original = await browser.newPage();
  await original.goto(url); await original.locator('#login-name').fill('Alice'); await original.locator('#login-form button').click();
  await original.locator('#team-name').fill('Original device removal'); await original.locator('#btn-create-team').click();
  await original.locator('#encrypted-setup').filter({ hasText: 'This endpoint: verified' }).waitFor();
  const identity = await original.evaluate(() => window.__plexus.state.encryptedIdentity);
  const session = await original.evaluate(() => JSON.parse(localStorage.getItem('harness.session')));
  await original.locator('#btn-access').click();
  const originalCard = original.locator('.ew-device[data-device="' + identity.device + '"]');
  assert.equal(await originalCard.locator('[data-action="revoke-device"]').count(), 0, 'original endpoint must not use generic device removal');
  assert.equal(await originalCard.locator('[data-action="revoke-original-device"]').isDisabled(), true);
  const replacement = await browser.newPage();
  await replacement.addInitScript(value => localStorage.setItem('harness.session', JSON.stringify(value)), session);
  await replacement.route('**/api/enrollment?*', async route => {
    const response = await route.fetch(), body = await response.json();
    body.freshnessAuthority = { state: 'active', activationId: '1'.repeat(32), signer: body.endpoints?.at(-1) };
    return route.fulfill({ response, json: body });
  });
  await replacement.goto(url);
  await replacement.locator('#encrypted-setup').filter({ hasText: 'This endpoint: pending' }).waitFor();
  const next = await replacement.evaluate(() => window.__plexus.state.encryptedIdentity);
  const candidate = original.locator('.ew-device[data-device="' + next.device + '"]');
  await candidate.locator('input[type="checkbox"]').check(); await candidate.locator('[data-action="verify-teammate"]').click();
  await replacement.locator('#btn-access').click();
  await replacement.locator('[data-action="confirm-team-authority"]').click();
  await replacement.waitForFunction(() => window.__plexus.state.encryptedState?.membershipIdentity?.state === 'verified');
  const removal = replacement.locator('.ew-device[data-device="' + identity.device + '"]');
  assert.equal(await removal.locator('[data-action="revoke-original-device"]').isDisabled(), true);
  assert.match(await removal.innerText(), /installed app|local appointment/i);
  assert.equal(await replacement.evaluate(() => window.harnessDesktop?.confirmFreshnessAuthority), undefined);
  console.log('PASS original self-removal and a verified remote replacement cannot bypass guided local appointment using relay metadata');
  // The signed protocol intentionally permits this already verified owner device;
  // its public operation does not claim a global proof of a local host appointment.
  await replacement.evaluate(async identity => {
    const client = window.__plexus.state.encrypted;
    await client.revokeDevice({ userId: client.userId, device: identity.device });
  }, identity);
  const clean = await browser.newPage();
  await clean.addInitScript(value => localStorage.setItem('harness.session', JSON.stringify(value)), session);
  await clean.goto(url); await clean.locator('#encrypted-setup').filter({ hasText: 'This endpoint: pending' }).waitFor();
  await clean.locator('#btn-access').click();
  assert.ok((await clean.locator('[data-action="confirm-team-authority"]').locator('..').innerText()).includes(identity.fingerprint));
  await clean.locator('[data-action="confirm-team-authority"]').click();
  await clean.waitForFunction(() => !!window.__plexus.state.encryptedState?.membershipIdentity?.owner, null, { timeout: 15000 });
  const anchor = await clean.evaluate(() => window.__plexus.state.encryptedState.membershipIdentity);
  assert.equal(anchor.owner.ed25519, identity.ed25519); assert.equal(anchor.state, 'pending');
  console.log('PASS a clean endpoint confirms the compared historical genesis after its original live device is revoked, without gaining device verification');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); await hub?.close(); fs.rmSync(temp, { recursive: true, force: true });
});
