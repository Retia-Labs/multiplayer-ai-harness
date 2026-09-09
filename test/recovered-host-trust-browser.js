'use strict';
// Extra negative relay boundary for desktop-authority-recovery.js. The continuous
// recovery proof uses the real relay; this separate clean browser replaces only a
// host public-key query with valid, different SDK-generated keys.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { KeyDirectory, KeyTransport } = require('../packages/e2ee/key-transport');

module.exports = async function recoveredHostTrust({ browser, bob, url, savedSession, original, writer, task, recoveryKey, until, out }) {
  const directory = new KeyDirectory();
  const impostor = await Endpoint.create({ user: writer.user, device: writer.device, transport: new KeyTransport(directory) });
  const changedKeys = JSON.parse(directory.query()).device_keys[writer.user][writer.device];
  assert.notEqual(impostor.identity().ed25519, writer.ed25519);
  const context = await browser.newContext({ viewport: { width: 1487, height: 1058 }, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [];
  let queries = 0, submissions = 0;
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(session => localStorage.setItem('harness.session', JSON.stringify(session)), savedSession);
    await page.route('**/api/e2ee/keys', async route => {
      const request = route.request().postDataJSON();
      const response = await route.fetch();
      if (request.type !== 'KeysQuery') return route.fulfill({ response });
      const body = await response.json();
      body.device_keys ||= {}; body.device_keys[writer.user] ||= {};
      body.device_keys[writer.user][writer.device] = changedKeys;
      queries++;
      return route.fulfill({ response, json: body });
    });
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/encrypted-tasks') submissions++;
    });
    await page.goto(url);
    await page.locator('#encrypted-setup').filter({ hasText: 'This endpoint: pending' }).waitFor({ timeout: 30000 });
    await page.locator('#btn-recovery').click();
    await page.locator('[name="restore-recovery-key"]').fill(recoveryKey);
    await page.locator('[data-action="restore-history"]').click();
    await page.locator('#toasts .toast').filter({ hasText: 'History restored' }).waitFor({ timeout: 45000 });
    const identity = await page.evaluate(() => window.__plexus.state.encryptedIdentity);
    await page.locator('#btn-access').click();
    assert.ok((await page.locator('[data-action="confirm-team-authority"]').locator('..').innerText()).includes(original.fingerprint));
    await page.locator('[data-action="confirm-team-authority"]').click();
    await bob.locator('#btn-access').click();
    const card = bob.locator('#access-view .ew-device[data-device="' + identity.device + '"]');
    await card.waitFor({ timeout: 30000 });
    assert.ok((await card.innerText()).includes(identity.fingerprint));
    await card.locator('input[type="checkbox"]').check();
    await card.locator('[data-action="verify-teammate"]').click();
    await until(() => page.evaluate(() => window.__plexus.state.encryptedState?.membershipIdentity?.state === 'verified'), 'negative restored endpoint has authenticated membership');
    await page.locator('#nav-fleet').click();
    await page.locator('#fleet-runtime').selectOption(task.runtimeId);
    await page.locator('#fleet-project').selectOption(task.projectId);
    await page.locator('#provider-select').selectOption('demo');
    await page.locator('#input').fill('create MUST-NOT-EXIST.txt'); await page.locator('#btn-send').click();
    const alert = page.locator('#encrypted-composer-error');
    await alert.waitFor({ timeout: 30000 });
    assert.match(await alert.innerText(), /host keys do not match the verified fingerprint/);
    const refusal = await page.evaluate(async value => {
      const client = window.__plexus.state.encrypted;
      try { await client.startTurn(value, { input: [{ type: 'text', text: 'must not execute' }] }); return null; }
      catch (error) { return { error: error.code || error.message, pin: client.confirmedHost(value.runtimeId), pending: client.pendingCommands.size }; }
    }, task);
    assert.equal(refusal.error, 'endpoint_key_mismatch');
    for (const key of ['user', 'device', 'curve25519', 'ed25519']) assert.equal(refusal.pin[key], writer[key]);
    assert.equal(refusal.pending, 0); assert.equal(submissions, 0); assert.ok(queries > 0);
    assert.deepEqual(errors, []);
    const captures = [];
    await page.waitForFunction(() => document.querySelectorAll('#toasts .toast').length === 0, null, { timeout: 10000 });
    for (const [name, viewport] of [['restored-host-mismatch-desktop.png', { width: 1487, height: 1058 }], ['restored-host-mismatch-mobile.png', { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport); await alert.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, name) }); captures.push(name);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    const result = { status: 'pass', queries, submissions, errors, captures, checks: ['restored pin refuses changed live host keys before task creation', 'turn control refuses changed keys without pending commands', 'Fleet retains an actionable error and original exact host identity'] };
    fs.writeFileSync(path.join(out, 'restored-host-trust.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'failure-restored-host-trust.png') }).catch(() => {});
    fs.writeFileSync(path.join(out, 'failure-restored-host-trust.txt'), await page.locator('body').innerText().catch(() => ''));
    throw error;
  } finally { await context.close(); impostor.close(); }
};
