// Desktop shell smoke: Electron boots a local hub + runtime, loads the web UI, auto-logs in.
const { _electron: electron } = require('playwright-core');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execSync } = require('child_process');
function assert(c, m) { if (!c) throw new Error('ASSERT FAILED: ' + m); console.log('  ✓ ' + m); }
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-desktop-'));
  const project = path.join(tmp, 'proj'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: project, shell: '/bin/bash' });
  const port = 7800 + Math.floor(Math.random() * 100);
  const app = await electron.launch({
    args: ['apps/desktop/main.js', '--user-data-dir=' + path.join(tmp, 'ud'), '--no-sandbox'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', HUB_PORT: String(port), HARNESS_USER: 'dana' }
  });
  const win = await app.firstWindow();
  await win.waitForSelector('#team-gate:not(.hidden)', { timeout: 30000 });
  await win.fill('#team-name', 'Desktop team');
  await win.click('#btn-create-team');
  await win.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
  assert((await win.title()) === 'Plexus', 'desktop window loaded the Plexus UI');
  assert((await win.textContent('#me')).includes('dana'), 'auto-logged in as the OS user');
  await win.waitForFunction(() => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.querySelector('#pair-code').value));
  await win.click('#btn-pair-host');
  await win.waitForSelector('.runtime-card', { timeout: 20000 });
  assert((await win.textContent('.runtime-card')).includes('no projects registered'), 'the pairing code shown by the shell paired its local runtime');
  assert(await win.evaluate(() => window.harnessDesktop.pairingCode()) === null, 'the consumed desktop pairing challenge is no longer offered');
  const localRuntimeId = await win.evaluate(() => window.harnessDesktop.runtimeId());
  assert(localRuntimeId === await win.inputValue('#fleet-runtime'), 'desktop identifies the exact shell-managed runtime');
  const wrongHostError = await win.evaluate(async () => {
    try { await window.harnessDesktop.pickFolder('rt_not_this_desktop'); return ''; }
    catch (error) { return String(error && error.message || error); }
  });
  assert(wrongHostError.includes('local execution host'), 'native folder authorization refuses a different selected runtime');
  await app.evaluate(({ dialog }, selectedProject) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedProject] });
  }, project);
  await win.click('#btn-add-project');
  await win.waitForFunction((selectedProject) => {
    const card = document.querySelector('.runtime-card');
    return card?.querySelector('.rc-dot.online') && document.querySelector('#fleet-project')?.value === selectedProject;
  }, project, { timeout: 20000 });
  assert((await win.inputValue('#fleet-project')) === project, 'a native folder selection authorized the project on the local runtime');
  const runtimeConfig = JSON.parse(fs.readFileSync(path.join(tmp, 'ud', 'harness', 'runtime.json'), 'utf8'));
  assert(runtimeConfig.projects.includes(project), 'native project authorization persists across runtime restarts');
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert(health.runtimes === 1, `hub spawned by the shell reports one runtime (got ${health.runtimes})`);
  await win.fill('#input', 'Create a NOTES.md');
  await win.press('#input', 'Enter');
  await win.waitForSelector('.edit-card', { timeout: 20000 });
  assert(fs.existsSync(path.join(project, 'NOTES.md')), 'agent wrote a file through the desktop-spawned runtime');
  await win.waitForFunction(() => document.querySelector('#working').classList.contains('hidden'), null, { timeout: 30000 });
  await win.screenshot({ path: path.join(__dirname, '..', 'docs', 'harness', 'desktop.png') });
  await app.close();
  console.log('\ndesktop smoke passed ✅'); process.exit(0);
})().catch((e) => { console.error('DESKTOP SMOKE FAILED', e); process.exit(1); });
