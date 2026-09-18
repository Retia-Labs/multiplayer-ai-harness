'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { chromium, request } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { DesktopAccount } = require('../apps/desktop/account');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-auth-'));
  const out = path.resolve('.artifacts/hosted-auth'); fs.mkdirSync(out, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key'), '-out', path.join(dir, 'cert'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const hub = new Hub({ staticDir: path.resolve('apps/web'), auth: {
    origin: 'https://localhost', clientId: 'fixture', clientSecret: 'fixture', allowedIds: ['42'],
    fetch: async url => ({ ok: true, json: async () => url.endsWith('access_token') ? { access_token: 'fixture' } : url.endsWith('/emails') ? [{ email: 'alice@example.test', verified: true }] : { id: 42, login: 'alice', name: 'Alice' } })
  } });
  await hub.listen();
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key')), cert: fs.readFileSync(path.join(dir, 'cert')) }, (req, res) => hub.handleHttp(req, res));
  server.on('upgrade', (req, socket, head) => hub.wss.handleUpgrade(req, socket, head, ws => hub.wss.emit('connection', ws, req)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'https://127.0.0.1:' + server.address().port; hub.auth.origin = origin;
  let browser, nativeContext;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1487, height: 1058 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/auth/login?**', async route => {
      const response = await route.fetch({ maxRedirects: 0 });
      const state = new URL(response.headers().location).searchParams.get('state');
      await route.fulfill({ response, headers: { ...response.headers(), location: origin + '/api/auth/callback?code=fixture&state=' + state } });
    });
    await page.goto(origin + '/t/private-task?name=spoofed');
    await page.locator('#github-login').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#login-form').isVisible(), false);
    assert.equal(await page.evaluate(() => window.__plexus.state.me), null);
    await page.screenshot({ path: path.join(out, 'sign-in-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'sign-in-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#github-login').click();
    try { await page.locator('#team-gate').waitFor({ state: 'visible' }); } catch (error) { console.log('PAGE', page.url(), await page.locator('body').innerText()); throw error; }
    assert.equal(new URL(page.url()).pathname, '/t/private-task');
    assert.equal(await page.evaluate(() => localStorage.getItem('harness.session')), null);
    assert.equal(await page.evaluate(() => document.cookie.includes('plexus-session')), false);
    await page.locator('#team-name').fill('Alpha team'); await page.locator('#btn-create-team').click();
    await page.waitForFunction(() => window.__plexus.state.encryptedIdentity, null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__plexus.state.me.token), null);
    console.log('PASS hosted browser login preserves private link, creates team and opens encrypted endpoint without exposing session token');

    // Exercise the actual desktop account exchange through its native I/O seams.
    nativeContext = await request.newContext({ ignoreHTTPSErrors: true });
    const nativeRequest = async (url, options = {}) => {
      const response = await nativeContext.fetch(url, { method: options.method, headers: options.headers, data: options.body, maxRedirects: 0 });
      return { ok: response.ok(), status: response.status(), json: () => response.json() };
    };
    const sealed = new Map(); let sequence = 0;
    const account = new DesktopAccount({ origin, dataDir: path.join(dir, 'desktop'), fetch: nativeRequest,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => { const key = 'sealed-' + ++sequence; sealed.set(key, value); return Buffer.from(key); }, decryptString: value => sealed.get(value.toString()) },
      openExternal: url => page.goto(url) });
    const { code } = await account.start();
    await page.locator('#desktop-consent').waitFor({ state: 'visible' });
    assert.equal(await account.poll(), null);
    await page.setViewportSize({ width: 1487, height: 1058 });
    await page.screenshot({ path: path.join(out, 'desktop-consent.png') });
    await page.locator('#desktop-code').fill(code); await page.locator('#desktop-consent button').click();
    await page.waitForFunction(() => document.querySelector('#login-hub').textContent.startsWith('Desktop connected.'));
    const token = await account.poll(); assert.match(token, /^ps_/);
    assert.equal(fs.readFileSync(path.join(dir, 'desktop/account-session'), 'utf8').includes(token), false);
    assert.equal(await account.session(), token);
    await account.logout(); assert.equal(await account.session(), null);
    console.log('PASS desktop browser consent, single-use exchange, protected storage and logout');

    if (process.env.PLEXUS_TEST_NATIVE === '1') await require('./hosted-auth-desktop')({ origin, dir, page, out });

    await page.goto(origin); await page.locator('#btn-settings').click(); await page.locator('#btn-logout').click();
    await page.locator('#github-login').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.__plexus.state.me), null);
    await page.route('**/api/auth/config', route => route.fulfill({ status: 503, body: '{}' }));
    await page.reload(); await page.locator('#retry-login').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#login-form').isVisible(), false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'sign-in-unavailable-mobile.png') });
    await page.unroute('**/api/auth/config'); await page.locator('#retry-login').click();
    await page.locator('#github-login').waitFor({ state: 'visible' });
    await page.goto(origin + '/api/auth/callback?state=expired');
    assert.match(await page.locator('body').innerText(), /This sign-in expired/);
    await page.screenshot({ path: path.join(out, 'sign-in-expired-mobile.png') });
    assert.deepEqual(errors, []);
    console.log('PASS browser logout and clean renderer; screenshots in .artifacts/hosted-auth');
  } catch (error) { console.error(error); throw error; } finally {
    if (nativeContext) await nativeContext.dispose();
    if (browser) await browser.close();
    server.closeAllConnections(); for (const ws of hub.clients.keys()) ws.terminate();
    await new Promise(resolve => server.close(resolve)); await hub.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
