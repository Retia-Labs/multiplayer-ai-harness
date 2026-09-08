'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { Hub } = require('../packages/hub/server');

test('the product client refuses unavailable durable storage before creating replacement endpoint keys', { timeout: 45000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-storage-refusal-'));
  const hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite'), staticDir: path.resolve(__dirname, '../apps/web') });
  const address = await hub.listen(); const url = 'http://127.0.0.1:' + address.port;
  const account = hub.store.createAccount('Storage test'); const team = hub.store.createTeam('Storage', account.id);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
  t.after(async () => { await browser.close(); await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const desktop of [false, true]) {
    const context = await browser.newContext();
    const page = await context.newPage(); const keyRequests = [];
    page.on('request', request => { if (request.url().startsWith(url + '/api/e2ee/')) keyRequests.push(request.url()); });
    await page.addInitScript(({ desktop, url }) => {
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { throw new Error('fixture_storage_unavailable'); } });
      window.fixtureBrokerCalls = 0;
      if (desktop) window.harnessDesktop = { hubUrl: url, endpointStoreKey: async () => {
        window.fixtureBrokerCalls++; return Array(32).fill(7);
      } };
    }, { desktop, url });
    await page.goto(url);
    const outcome = await page.evaluate(async options => {
      const previousKey = btoa(String.fromCharCode(...Array(32).fill(9)));
      localStorage.setItem('plexus.endpoint.storeKey.' + options.userId, previousKey);
      const client = new window.PlexusEncrypted.EncryptedClient(options);
      let error = null;
      try { await client.open(); } catch (failure) { error = failure.code || failure.message; }
      const result = { error, endpointCreated: client.endpoint !== null, brokerCalls: window.fixtureBrokerCalls,
        preserved: localStorage.getItem('plexus.endpoint.storeKey.' + options.userId) === previousKey };
      client.close(); return result;
    }, { token: account.token, userId: account.id, teamId: team.id });
    assert.equal(outcome.error, 'endpoint_storage_unavailable', desktop ? 'desktop storage failure' : 'browser storage failure');
    assert.equal(outcome.endpointCreated, false);
    assert.equal(outcome.brokerCalls, 0);
    assert.equal(outcome.preserved, true);
    assert.deepEqual(keyRequests, [], 'no replacement key is published or queried');
    await context.close();
  }
});
