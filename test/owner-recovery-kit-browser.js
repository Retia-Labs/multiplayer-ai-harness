'use strict';
// Real browser IndexedDB/WASM lifecycle, synthetic public-key directory. No model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { KeyDirectory, KeyTransport } = require('../packages/e2ee/key-transport');
const { initialMembership, replayMembership, signMembership } = require('../packages/e2ee/membership.mjs');
const { createOwnerRecoveryKey } = require('../packages/e2ee/owner-recovery-kit.mjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-owner-kit-'));
let hub, browser, original;
(async () => {
  hub = new Hub({ dbFile: path.join(temporary, 'hub.sqlite'), staticDir: path.resolve(__dirname, '../apps/web'), log() {} });
  const address = await hub.listen(), url = 'http://127.0.0.1:' + address.port;
  const directory = new KeyDirectory(), transport = new KeyTransport(directory);
  original = await Endpoint.create({ user: '@persistent_owner:plexus.local', device: 'ORIGINAL', transport });
  const expected = { service: url, teamId: 'tm_persistent_recovery', owner: original.user, genesis: original.identity() };
  const bootstrap = await signMembership(original, initialMembership(expected.teamId), 'bootstrap', { endpoint: original.identity() });
  const head = await replayMembership([bootstrap], { teamId: expected.teamId, authority: expected.genesis });
  const { masterKey } = await original.ownerRecoveryIdentity();
  const descriptor = { version: 1, purpose: 'owner-endpoint-recovery-with-host-local-activation', ...expected, generation: 1, masterKey };
  const configure = await signMembership(original, head, 'recovery.configure', { descriptor }), log = [bootstrap, configure];
  const recoveryKey = createOwnerRecoveryKey();
  const { ciphertext } = await original.provisionOwnerRecoveryKit({ descriptor, log, expected, recoveryKey });
  original.close();
  const before = directory.query();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
  const context = await browser.newContext(), errors = [];
  const makePage = async () => {
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.route(url + '/', route => route.fulfill({ contentType: 'text/html', body: '<title>Owner recovery SDK fixture</title>' }));
    await page.exposeFunction('sendPublic', (type, request) => transport.send(type, request));
    await page.goto(url);
    await page.evaluate(async () => {
      const [sdk, api] = await Promise.all([import('/vendor/index.mjs'), import('/shared/e2ee/endpoint-core.mjs')]);
      window.Endpoint = api.createEndpointAPI(sdk).Endpoint;
      window.transport = { send: (type, request) => window.sendPublic(type, request) };
      window.marker = async (storeName, replacement) => {
        const db = await new Promise((resolve, reject) => { const open = indexedDB.open('plexus-owner-recovery-lifecycle', 1);
          open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
        try { return await new Promise((resolve, reject) => {
          const tx = db.transaction('endpoints', replacement === undefined ? 'readonly' : 'readwrite');
          const request = replacement === undefined ? tx.objectStore('endpoints').get(storeName) : replacement === null
            ? tx.objectStore('endpoints').delete(storeName) : tx.objectStore('endpoints').put(replacement, storeName);
          let result; request.onsuccess = () => { result = request.result; }; tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error);
        }); } finally { db.close(); }
      };
    });
    return page;
  };
  let page = await makePage();
  const storeKey = Array(32).fill(7), options = { ciphertext, recoveryKey, expected, log, persistent: true, storeKey };
  const staged = await page.evaluate(async options => {
    window.staged = await Endpoint.stageOwnerRecovery(options);
    return window.staged.ownerRecoveryStatus();
  }, options);
  assert.equal(staged.state, 'staged');
  assert.equal(directory.query(), before);
  await page.evaluate(() => window.staged.close()); await page.close(); page = await makePage();
  const reopen = { user: staged.identity.user, device: staged.identity.device, storeName: staged.storeName, storeKey };
  assert.equal(await page.evaluate(async options => {
    try { const endpoint = await Endpoint.create({ ...options, transport }); endpoint.close(); return null; } catch (error) { return error.code; }
  }, reopen), 'owner_recovery_inactive');
  const originalMarker = await page.evaluate(name => marker(name), staged.storeName);
  await page.evaluate(name => marker(name, null), staged.storeName);
  assert.equal(await page.evaluate(async options => {
    try { const endpoint = await Endpoint.create({ ...options, transport }); endpoint.close(); return null; } catch (error) { return error.code; }
  }, reopen), 'owner_recovery_inactive', 'deleting lifecycle metadata cannot turn a staged SDK store into a normal endpoint');
  await page.evaluate(({ name, value }) => marker(name, value), { name: staged.storeName, value: originalMarker });

  await page.evaluate(({ name, value }) => marker(name, { ...value, marker: { ...value.marker, state: 'published' } }), { name: staged.storeName, value: originalMarker });
  assert.equal(await page.evaluate(async options => {
    try { const endpoint = await Endpoint.create({ ...options, transport }); endpoint.close(); return null; } catch (error) { return error.code; }
  }, reopen), 'owner_recovery_store_mismatch');
  await page.evaluate(({ name, value }) => marker(name, value), { name: staged.storeName, value: originalMarker });
  const resume = { ciphertext, recoveryKey, expected, log, storeName: staged.storeName, storeKey };
  assert.equal(await page.evaluate(async options => {
    try { const endpoint = await Endpoint.resumeOwnerRecovery(options); endpoint.close(); return null; } catch (error) { return error.code; }
  }, { ...resume, storeKey: Array(32).fill(8) }), 'owner_recovery_store_mismatch');
  const restored = await page.evaluate(async options => {
    window.staged = await Endpoint.resumeOwnerRecovery(options);
    return { status: window.staged.ownerRecoveryStatus(), drill: await window.staged.drillOwnerRecovery() };
  }, resume);
  assert.deepEqual(restored.status.identity, staged.identity);
  assert.equal(restored.drill.verified, true); assert.equal(directory.query(), before);
  console.log('PASS persistent inactive recovery survives reload; ordinary open, marker tamper and wrong store key refuse publication');
  await page.evaluate(log => window.staged.publishOwnerRecovery({ transport, log }), log);
  await page.evaluate(() => window.staged.close()); await page.close(); page = await makePage();
  const activeIdentity = await page.evaluate(async options => {
    const endpoint = await Endpoint.create({ ...options, transport });
    try { await endpoint.track([endpoint.user]); return { identity: endpoint.identity(), signed: (await endpoint.getDevice(endpoint.user, endpoint.device)).isCrossSignedByOwner() }; }
    finally { endpoint.close(); }
  }, reopen);
  assert.deepEqual(activeIdentity.identity, staged.identity); assert.equal(activeIdentity.signed, true);
  const publishedMarker = await page.evaluate(name => marker(name), staged.storeName);
  // A correctly authenticated marker must still match the actual SDK store identity.
  // This synthetic storage fault signs wrong PUBLIC keys with the fixture's store key;
  // no real account material or SDK private cross-signing seed enters the test bridge.
  await page.evaluate(async ({ storeName, storeKey, value, wrongKey }) => {
    const { canonical } = await import('/shared/protocol/encrypted-task.mjs');
    const changed = { ...value.marker, identity: { ...value.marker.identity, ed25519: wrongKey } };
    const encoder = new TextEncoder();
    const material = await crypto.subtle.importKey('raw', Uint8Array.from(storeKey), 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('plexus.owner-recovery.lifecycle.v1'),
      info: encoder.encode(storeName) }, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical(changed))));
    await marker(storeName, { marker: changed, signature: btoa(String.fromCharCode(...signed)) });
  }, { storeName: staged.storeName, storeKey, value: publishedMarker, wrongKey: expected.genesis.ed25519 });
  const beforeRefusal = directory.query();
  assert.equal(await page.evaluate(async options => {
    try { const endpoint = await Endpoint.create({ ...options, transport }); endpoint.close(); return null; } catch (error) { return error.code; }
  }, reopen), 'owner_recovery_store_mismatch');
  assert.equal(directory.query(), beforeRefusal);
  await page.evaluate(({ name, value }) => marker(name, value), { name: staged.storeName, value: publishedMarker });
  assert.deepEqual(errors, []);
  console.log('PASS only explicit publication permits ordinary persistent reopen with the same fresh cross-signed identity');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); original?.close(); await hub?.close(); fs.rmSync(temporary, { recursive: true, force: true });
});
