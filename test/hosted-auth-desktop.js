'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate, createHash } = require('node:crypto');
const { _electron } = require('playwright-core');
const { desktopProfile } = require('../apps/desktop/profile');

// Invoked by the HTTPS journey fixture with PLEXUS_TEST_NATIVE=1.
// Only OS browser navigation is redirected to the fixture browser; Electron IPC,
// HTTP relay, WebSocket, OS safeStorage, profile persistence and renderer are real.
module.exports = async function desktopJourney({ origin, dir, page, out }) {
  const userData = path.join(dir, 'native-profile'), dataRoot = path.join(dir, 'native-data');
  const certificate = new X509Certificate(fs.readFileSync(path.join(dir, 'cert')));
  const spki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const env = { ...process.env, HUB_HTTP_URL: origin, HARNESS_DATA: dataRoot, NODE_EXTRA_CA_CERTS: path.join(dir, 'cert') };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  async function launch() {
    app = await _electron.launch({ args: ['apps/desktop/main.js', '--user-data-dir=' + userData, '--ignore-certificate-errors-spki-list=' + spki], cwd: path.resolve(__dirname, '..'), env });
    await app.evaluate(({ shell, app: electronApp, BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach(window => window.hide());
      shell.openExternal = async url => { electronApp.testBrowserUrl = url; };
    });
    const win = await app.firstWindow(); win.setDefaultTimeout(20000); await win.setViewportSize({ width: 1487, height: 1058 });
    await win.waitForURL('plexus-app://app/**');
    return win;
  }
  try {
    let win = await launch();
    await win.locator('#github-login').waitFor({ state: 'visible' });
    assert.equal(await win.evaluate(() => window.__plexus.state.me), null);
    await win.locator('#github-login').click();
    await win.waitForFunction(() => /Enter this code/.test(document.querySelector('#login-hub').textContent));
    const code = (await win.locator('#login-hub').innerText()).match(/[A-F0-9]{8}/)[0];
    const destination = await app.evaluate(({ app: electronApp }) => electronApp.testBrowserUrl);
    assert.equal(new URL(destination).origin, origin);
    await win.screenshot({ scale: 'css', path: path.join(out, 'native-desktop-waiting.png') });
    await page.goto(destination); await page.locator('#desktop-code').fill(code);
    await page.locator('#desktop-consent button').click();
    await win.waitForFunction(() => window.__plexus.state.connected && window.__plexus.state.me);
    const identity = await win.evaluate(() => ({ id: window.__plexus.state.me.id, token: window.__plexus.state.me.token, saved: localStorage.getItem('harness.session') }));
    assert.equal(identity.saved, null); assert.match(identity.token, /^ps_/);
    const profile = desktopProfile({ userData, dataRoot, hubUrl: origin });
    const credentialFile = path.join(profile.dataDir, 'account-session');
    assert.equal(fs.readFileSync(credentialFile).includes(Buffer.from(identity.token)), false);
    await win.waitForFunction(() => window.__plexus.state.encryptedIdentity);
    assert.equal(await win.locator('#provider-select').inputValue(), '');
    assert.equal(await win.locator('#provider-select').isEnabled(), false);
    assert.equal(await win.locator('#btn-send').isEnabled(), false);
    await win.screenshot({ scale: 'css', path: path.join(out, 'native-desktop-signed-in.png') });
    await app.close(); app = null;
    win = await launch();
    await win.waitForFunction(() => window.__plexus.state.connected && window.__plexus.state.me);
    assert.equal(await win.evaluate(() => window.__plexus.state.me.id), identity.id);
    await win.locator('#btn-settings').click(); await win.locator('#btn-logout').click();
    await win.locator('#github-login').waitFor({ state: 'visible' });
    assert.equal(fs.existsSync(credentialFile), false);
    console.log('PASS actual Electron sign-in, IPC, HTTPS relay, OS-sealed token, restart and logout');
  } finally { if (app) await app.close(); }
};
