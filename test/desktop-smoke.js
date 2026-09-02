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
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', HUB_PORT: String(port), HARNESS_USER: 'dana', HARNESS_PROJECTS: project }
  });
  const win = await app.firstWindow();
  await win.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
  assert((await win.title()) === 'Harness', 'desktop window loaded the Harness UI');
  assert((await win.textContent('#me')).includes('dana'), 'auto-logged in as the OS user');
  await win.waitForSelector('.runtime-card', { timeout: 20000 });
  assert((await win.textContent('.runtime-card')).includes('proj'), 'local runtime auto-started and registered the project');
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert(health.runtimes === 1, 'hub spawned by the shell reports one runtime');
  await win.fill('#input', 'Create a NOTES.md');
  await win.press('#input', 'Enter');
  await win.waitForSelector('.edit-card', { timeout: 20000 });
  assert(fs.existsSync(path.join(project, 'NOTES.md')), 'agent wrote a file through the desktop-spawned runtime');
  await win.waitForFunction(() => document.querySelector('#working').classList.contains('hidden'), null, { timeout: 30000 });
  await win.screenshot({ path: path.join(__dirname, '..', 'docs', 'harness', 'desktop.png') });
  await app.close();
  console.log('\ndesktop smoke passed ✅'); process.exit(0);
})().catch((e) => { console.error('DESKTOP SMOKE FAILED', e); process.exit(1); });
