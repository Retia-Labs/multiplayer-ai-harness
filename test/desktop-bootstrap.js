const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _electron: electron } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { desktopProfile } = require('../apps/desktop/profile');

// A tray app does not exit when its window closes - that is what #18 changed - so a test that
// wants it gone has to say so, exactly as a person does by choosing Quit from the tray.
async function quitApp(app) {
  if (!app) return;
  try { await app.evaluate(() => { if (global.__plexusDesktop) global.__plexusDesktop.forceQuit(); }); } catch {}
  try { await app.close(); } catch {}
}

const root = path.join(__dirname, '..');
const out = path.join(root, '.artifacts', 'desktop-bootstrap');
fs.mkdirSync(out, { recursive: true });
async function capture(page, name) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: '* { animation: none !important; transition: none !important; }' });
  for (const [width, height] of [[1487, 1058], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: path.join(out, `${name}-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal clipping');
  }
  await page.setViewportSize({ width: 1360, height: 860 });
}
// DESKTOP_EXECUTABLE points these same checks at an installed copy instead of the checkout.
const packaged = process.env.DESKTOP_EXECUTABLE || null;
const launch = (dataDir, env) => electron.launch({
  executablePath: packaged || undefined,
  args: [...(packaged ? [] : ['apps/desktop/main.js']), '--user-data-dir=' + dataDir, '--no-sandbox'],
  cwd: root, env
});
(async () => {
  const unavailable = http.createServer((_req, res) => { res.writeHead(503); res.end(); });
  await new Promise((resolve) => unavailable.listen(0, '127.0.0.1', resolve));
  const port = unavailable.address().port;
  let hub, app;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-bootstrap-'));
  const env = { ...process.env, HUB_HTTP_URL: `http://127.0.0.1:${port}`, HARNESS_USER: 'bootstrap-tester' };
  delete env.ELECTRON_RUN_AS_NODE;
  // Verify the app's services require no system Node on PATH.
  if (process.platform === 'win32') env.PATH = `${process.env.SystemRoot}\\system32;${process.env.SystemRoot}`;
  else if (packaged) env.PATH = '/usr/bin:/bin';
  try {
    console.log('RECOVERY TEST: deliberately unavailable hub; an error screen is expected until retry.');
    app = await launch(temp, env);
    const page = await app.firstWindow();
    await page.waitForSelector('#step-hub.working');
    await capture(page, 'starting');
    await page.waitForSelector('#step-hub.failed', { timeout: 35000 });
    assert.match(await page.textContent('#detail-hub'), /Could not reach.*Check the address/);
    await capture(page, 'failed');
    assert.equal(await page.locator('#diagnostic-preview').isVisible(), false);
    await page.click('#inspect-diagnostics');
    const report = JSON.parse(await page.locator('#diagnostic-report').innerText());
    assert.equal(report.client, 'desktop');
    assert.match(report.versions.electron, /^\d+\.\d+\.\d+$/);
    assert.equal(report.stages.find(stage => stage.stage === 'project').code, 'connection_unavailable');
    assert.ok(!JSON.stringify(report).includes(temp) && !JSON.stringify(report).includes(env.HUB_HTTP_URL));
    await capture(page, 'diagnostic-preview');
    console.log('PASS: startup diagnostics preview exposes only fixed health codes and versions');
    let openedDataFolder;
    await app.evaluate(({ shell }) => { shell.openPath = async (folder) => { global.testOpenedFolder = folder; return ''; }; });
    const refused = await app.evaluate(async ({ app, BrowserWindow }, sourceRoot) => {
      const alien = new BrowserWindow({ show: false, webPreferences: {
        preload: (app.isPackaged ? app.getAppPath() : sourceRoot) + '/apps/desktop/preload.js',
        contextIsolation: true, nodeIntegration: false, sandbox: true
      } });
      try {
        await alien.loadURL('data:text/html,<html><body>Untrusted test page</body></html>');
        return await alien.webContents.executeJavaScript("Promise.all(['openDataFolder', 'retryBoot', 'diagnostics'].map(action => window.harnessDesktop[action]().then(() => 'allowed', e => e.message)))");
      } finally { alien.destroy(); }
    }, root);
    for (const error of refused) assert.match(error, /untrusted_desktop_request/, 'another renderer cannot invoke privileged shell actions');
    assert.equal(await app.evaluate(() => global.testOpenedFolder), undefined);
    await page.click('#open-data');
    openedDataFolder = await app.evaluate(() => global.testOpenedFolder);
    assert.equal(openedDataFolder, temp);
    console.log('PASS: startup failure stays visible with working data-folder action');
    await new Promise((resolve) => unavailable.close(resolve));
    hub = new Hub({ dbFile: ':memory:', staticDir: path.join(root, 'apps', 'web'), log: () => {} });
    await hub.listen(port, '127.0.0.1');
    await page.evaluate(() => { window.harnessDesktop.retryBoot(); window.harnessDesktop.retryBoot(); });
    await page.waitForSelector('#team-gate:not(.hidden)', { timeout: 20000 });
    const runtimeId = await page.evaluate(() => window.harnessDesktop.runtimeId());
    assert.ok([...hub.pendingPairings.values()].some((p) => p.runtimeId === runtimeId));
    assert.equal(hub.runtimes.size, 0, 'unpaired host is not described as authorized');
    const log = fs.readFileSync(path.join(temp, 'logs', 'desktop.log'), 'utf8');
    assert.match(log, /ready to pair with your team/);
    assert.match(log, /node 24\./);
    await capture(page, 'ready-to-pair');
    console.log('PASS: retry reaches remote hub and starts this exact local host without Node on PATH');
    await quitApp(app); app = null;
    const failureData = path.join(temp, 'runtime-failure');
    const runtimeConfig = path.join(desktopProfile({ userData: failureData, hubUrl: env.HUB_HTTP_URL,
      dataRoot: env.HARNESS_DATA }).dataDir, 'runtime.json');
    fs.mkdirSync(path.dirname(runtimeConfig), { recursive: true });
    fs.writeFileSync(runtimeConfig, JSON.stringify({ maxPreset: 'invalid-preset' }));
    console.log('RECOVERY TEST: deliberately invalid runtime configuration; an error screen is expected until repair.');
    app = await launch(failureData, env);
    const failedPage = await app.firstWindow();
    await failedPage.waitForSelector('#step-ui.failed', { timeout: 20000 });
    assert.match(await failedPage.textContent('#detail-runtime'), /unknown max preset/);
    await capture(failedPage, 'runtime-failed');
    fs.writeFileSync(runtimeConfig, '{}');
    await failedPage.click('#retry');
    await failedPage.waitForSelector('#team-gate:not(.hidden)', { timeout: 20000 });
    console.log('PASS: an exited local runtime stays on the error screen and can recover after repair');

  } finally {
    if (app) await quitApp(app);
    if (hub) await hub.close();
    if (unavailable.listening) await new Promise((resolve) => unavailable.close(resolve));
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
