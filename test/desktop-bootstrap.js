const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _electron: electron } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { desktopProfile } = require('../apps/desktop/profile');
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
    app = await launch(temp, env);
    const page = await app.firstWindow();
    await page.waitForSelector('#step-hub.working');
    await capture(page, 'starting');
    await page.waitForSelector('#step-hub.failed', { timeout: 35000 });
    assert.match(await page.textContent('#detail-hub'), /Could not reach.*Check the address/);
    await capture(page, 'failed');
    let openedDataFolder;
    await app.evaluate(({ shell }) => { shell.openPath = async (folder) => { global.testOpenedFolder = folder; return ''; }; });
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
    await app.close(); app = null;
    const failureData = path.join(temp, 'runtime-failure');
    const runtimeConfig = path.join(desktopProfile({ userData: failureData, hubUrl: env.HUB_HTTP_URL,
      dataRoot: env.HARNESS_DATA }).dataDir, 'runtime.json');
    fs.mkdirSync(path.dirname(runtimeConfig), { recursive: true });
    fs.writeFileSync(runtimeConfig, JSON.stringify({ maxPreset: 'invalid-preset' }));
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
    if (app) await app.close();
    if (hub) await hub.close();
    if (unavailable.listening) await new Promise((resolve) => unavailable.close(resolve));
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
