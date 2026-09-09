'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { desktopProfile } = require('../apps/desktop/profile');
const root = path.join(__dirname, '..');

test('desktop service identity normalizes equivalent URLs without merging different services', () => {
  const options = { userData: '/isolated/test-profile' };
  const first = desktopProfile({ ...options, hubUrl: 'HTTPS://EXAMPLE.COM:443/' });
  assert.deepEqual(first, desktopProfile({ ...options, hubUrl: 'https://example.com' }));
  for (const hubUrl of ['http://example.com', 'https://example.com:444', 'https://elsewhere.example', 'https://example.com/team']) {
    assert.notEqual(first.partition, desktopProfile({ ...options, hubUrl }).partition);
    assert.notEqual(first.dataDir, desktopProfile({ ...options, hubUrl }).dataDir);
  }
  for (const hubUrl of ['file:///tmp/site', 'https://user:password@example.com', 'https://example.com/?token=secret']) {
    assert.throws(() => desktopProfile({ ...options, hubUrl }), /invalid_hub_address/);
  }
});

test('the actual desktop isolates account, crypto and runtime state per service and retains each on return', { timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-profile-'));
  const userData = path.join(dir, 'profile');
  const dataRoot = path.join(dir, 'service-data');
  const hubs = [new Hub({ dbFile: path.join(dir, 'a.sqlite') }), new Hub({ dbFile: path.join(dir, 'b.sqlite') })];
  const urls = [];
  for (const hub of hubs) { const addr = await hub.listen(); urls.push('http://127.0.0.1:' + addr.port); }
  const received = [[], []];
  hubs.forEach((hub, index) => hub.wss.on('connection', socket => socket.on('message', data => {
    const value = JSON.parse(data);
    if (value.type === 'hello') received[index].push(value);
  })));
  let app;
  t.after(async () => { await app?.close(); for (const hub of hubs) await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const states = [];
  for (const index of [0, 1, 0]) {
    const env = { ...process.env, HUB_HTTP_URL: urls[index], HARNESS_USER: 'Profile proof', HARNESS_DATA: dataRoot };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ args: ['apps/desktop/main.js', '--user-data-dir=' + userData], cwd: root, env });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.hide()));
    const page = await app.firstWindow();
    await page.waitForURL('plexus-app://app/**');
    if (states.length < 2) {
      await page.locator('#team-gate:not(.hidden)').waitFor();
      await page.locator('#team-name').fill('Service ' + index);
      await page.locator('#btn-create-team').click();
    }
    await page.locator('#encrypted-setup').filter({ hasText: 'This endpoint: verified' }).waitFor({ timeout: 20000 });
    const state = await page.evaluate(async () => ({
      token: JSON.parse(localStorage.getItem('harness.session')).token,
      identity: window.__plexus.state.encryptedIdentity,
      runtimeId: await window.harnessDesktop.runtimeId(),
      storeKey: await window.harnessDesktop.endpointStoreKey()
    }));
    states.push(state);
    await app.close(); app = null;
  }
  assert.equal(received[1].some(message => message.role === 'client' && message.token === states[0].token), false,
    'a newly selected service never receives the previous service account token');
  const runtimeA = received[0].find(message => message.role === 'runtime');
  const runtimeB = received[1].find(message => message.role === 'runtime');
  assert.equal(runtimeA.runtimeToken === runtimeB.runtimeToken, false, 'runtime credentials are service-scoped too');
  assert.equal(states[0].runtimeId === states[1].runtimeId, false);
  assert.equal(states[0].storeKey.join() === states[1].storeKey.join(), false);
  assert.equal(states[0].identity.ed25519 === states[1].identity.ed25519, false);
  assert.deepEqual(states[2], states[0], 'returning to a service restores exactly its prior account, endpoint and runtime identity');
});
