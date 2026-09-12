// Desktop shell smoke: Electron boots a local hub + runtime, loads the web UI, auto-logs in.
const { _electron: electron } = require('playwright-core');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execSync } = require('child_process');
const { localShell } = require('../packages/runtime/executors');
const { desktopProfile } = require('../apps/desktop/profile');
const realCodex = process.env.PLEXUS_DESKTOP_CODEX_PROOF === '1';
// The real collaboration claim requires the same explicit provider opt-in as the
// solo proof. `demo` is a development run of the UI flow, never a real-provider claim.
const collaborationMode = process.env.PLEXUS_DESKTOP_COLLABORATION_PROOF;
const collaboration = collaborationMode === '1' || collaborationMode === 'demo';
if (collaborationMode === '1' && (!realCodex || !process.env.DESKTOP_EXECUTABLE)) {
  throw new Error('The collaboration proof requires PLEXUS_DESKTOP_CODEX_PROOF=1 and DESKTOP_EXECUTABLE for the installed app.');
}
if (collaborationMode === 'demo' && realCodex) throw new Error('The demo collaboration check must not enable real Codex calls.');

// A tray app does not exit when its window closes - that is what #18 changed - so a test that
// wants it gone has to say so, exactly as a person does by choosing Quit from the tray.
async function quitApp(app) {
  if (!app) return;
  try { await app.evaluate(() => { if (global.__plexusDesktop) global.__plexusDesktop.forceQuit(); }); } catch {}
  try { await app.close(); } catch {}
}
function assert(c, m) { if (!c) throw new Error('ASSERT FAILED: ' + m); console.log('  ✓ ' + m); }
let desktopApp;
let testWindow;
let desktopTemp;
const pageErrors = [];
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-desktop-'));
  desktopTemp = tmp;
  const project = path.join(tmp, 'proj'); fs.mkdirSync(project);
  const sourceText = realCodex ? 'Synthetic desktop check ' + require('node:crypto').randomBytes(12).toString('hex') + '\n' : 'a\n';
  fs.writeFileSync(path.join(project, 'a.txt'), sourceText);
  if (collaboration) {
    fs.mkdirSync(path.join(project, 'cleanup'));
    fs.writeFileSync(path.join(project, 'cleanup/obsolete.txt'), 'Synthetic obsolete fixture\n');
    fs.writeFileSync(path.join(project, 'correction.txt'), 'Bob reviewed this correction ' + require('node:crypto').randomBytes(12).toString('hex') + '\n');
  }
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: project, shell: localShell().bin });
  const port = 7800 + Math.floor(Math.random() * 100);
  const launchEnv = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', HUB_PORT: String(port), HARNESS_USER: 'dana' };
  const dataRoot = collaboration ? path.join(tmp, 'data') : process.env.HARNESS_DATA;
  if (collaboration) launchEnv.HARNESS_DATA = dataRoot;
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  if (process.env.DESKTOP_EXECUTABLE) launchEnv.PATH = process.platform === 'win32'
    ? process.env.SystemRoot + '/system32;' + process.env.SystemRoot
    : '/usr/bin:/bin';
  const app = await electron.launch({
    executablePath: process.env.DESKTOP_EXECUTABLE || undefined,
    args: [...(process.env.DESKTOP_EXECUTABLE ? [] : ['apps/desktop/main.js']), '--user-data-dir=' + path.join(tmp, 'ud'), '--no-sandbox'],
    cwd: path.join(__dirname, '..'),
    env: launchEnv
  });
  desktopApp = app;
  const win = await app.firstWindow();
  testWindow = win;
  if (collaboration) { await win.setViewportSize({ width: 1487, height: 1058 }); await win.emulateMedia({ reducedMotion: 'reduce' }); }
  win.on('pageerror', (error) => pageErrors.push(error.message));
  win.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
  await win.waitForSelector('#team-gate:not(.hidden)', { timeout: 30000 });
  await win.fill('#team-name', 'Desktop team');
  await win.click('#btn-create-team');
  await win.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
  assert((await win.title()) === 'Plexus', 'desktop window loaded the Plexus UI');
  assert(win.url().startsWith('plexus-app://app/'), 'the key-holding renderer loads bundled application code');
  assert((await win.textContent('#me')).includes('dana'), 'auto-logged in as the OS user');
  await win.locator('#encrypted-setup').filter({ hasText: 'This endpoint: verified' }).waitFor({ timeout: 15000 });
  await win.waitForFunction(() => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.querySelector('#pair-code').value));
  await win.click('#btn-pair-host');
  await win.waitForSelector('.runtime-card', { timeout: 20000 });
  assert((await win.textContent('.runtime-card')).includes('0 shared project(s)'), 'the pairing code shown by the shell paired its local runtime');
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
  await win.waitForFunction(() => {
    const card = document.querySelector('.runtime-card');
    return card?.querySelector('.rc-dot.online') && /^ep_[a-f0-9]{32}$/.test(document.querySelector('#fleet-project')?.value);
  }, null, { timeout: 20000 });
  const documentProjectId = await win.inputValue('#fleet-project');
  const setup = await win.evaluate(() => window.harnessDesktop.encryptedSetup());
  assert(setup.projects.some((entry) => entry.id === documentProjectId), 'a native folder selection authorized an opaque project on the local runtime');
  const profile = desktopProfile({ userData: path.join(tmp, 'ud'), hubUrl: `http://127.0.0.1:${port}`, dataRoot });
  const runtimeConfig = JSON.parse(fs.readFileSync(path.join(profile.dataDir, 'runtime.json'), 'utf8'));
  assert(runtimeConfig.projects.includes(project), 'native project authorization persists across runtime restarts');
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert(health.runtimes === 1, `hub spawned by the shell reports one runtime (got ${health.runtimes})`);
  await win.locator('#encrypted-setup').filter({ hasText: 'This endpoint: verified' }).waitFor({ timeout: 20000 });
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await win.locator('[data-action="authorize-encrypted-host"]').click();
  await win.waitForFunction(() => window.__plexus.state.runtimes.some((runtime) => runtime.encryptedEndpoint), null, { timeout: 30000 });
  const membershipConfig = JSON.parse(fs.readFileSync(path.join(profile.dataDir, 'runtime.json'), 'utf8'));
  assert(membershipConfig.encryptionAuthority && !membershipConfig.approvalAuthority,
    'trusting team membership does not implicitly authorize action approvals');
  await win.locator('[data-action="authorize-host-approver"]').click();
  await win.waitForFunction(async () => {
    const setup = await window.harnessDesktop.encryptedSetup();
    return setup.approvalAuthority && setup.state === 'ready';
  }, null, { timeout: 30000 });
  const approvalConfig = JSON.parse(fs.readFileSync(path.join(profile.dataDir, 'runtime.json'), 'utf8'));
  assert(['user', 'device', 'curve25519', 'ed25519'].every(key =>
    approvalConfig.approvalAuthority[key] === membershipConfig.encryptionAuthority[key]),
  'separate native consent persists the exact approval endpoint across runtime restart');
  await win.locator('[data-action="show-host-fingerprint"]').click();
  await win.locator('[data-action="confirm-host"]').click();
  await win.locator('[data-action="show-host-fingerprint"]').waitFor({ state: 'detached', timeout: 15000 });
  if (realCodex) {
    await win.locator('[data-action="configure-local-codex"]').click();
    await win.waitForFunction(() => window.__plexus.state.runtimes.some(runtime =>
      runtime.encryptionState === 'ready' && runtime.providers.some(provider => provider.id === 'codex-cli' && provider.configured)), null, { timeout: 30000 });
    await win.locator('#provider-select').selectOption('codex-cli');
    await win.locator('#model-select').selectOption('gpt-5.4-mini');
    await win.locator('#effort-select').selectOption('medium');
  } else await win.locator('#provider-select').selectOption('demo');
  await win.fill('#input', realCodex
    ? 'Read a.txt using the provided host tool. Create NOTES.md with exactly the same bytes, including its final newline. Use only the provided host workspace tools.'
    : 'Create a NOTES.md');
  await win.click('#btn-send');
  if (realCodex) {
    // Open the task through its persistent row before waiting for provider output;
    // setup/recovery surfaces are not the file-review view.
    await win.locator('.encrypted-task-row').first().click({ timeout: 30000 });
  }
  await win.locator('.ew-file h4').filter({ hasText: 'NOTES.md' }).waitFor({ timeout: realCodex ? 120000 : 30000 });
  assert(fs.existsSync(path.join(project, 'NOTES.md')), 'agent wrote a file through the desktop-spawned runtime');
  if (realCodex) assert(fs.readFileSync(path.join(project, 'NOTES.md'), 'utf8') === sourceText,
    'the real Codex task read the generated input and wrote exactly matching bytes through the installed product');
  await win.locator('#ew-target').filter({ hasText: 'Start a follow-up on this task' }).waitFor({ timeout: realCodex ? 120000 : 30000 });
  assert(await win.evaluate(() => {
    const state = window.__plexus.state;
    return state.encryptedSnapshots.get(state.activeThreadId)?.turn === 'completed';
  }), 'the encrypted provider turn completed before the desktop test closes the app');
  assert(!(await win.textContent('body')).includes('project_not_authorized'), 'created file verification uses a supported workspace operation');
  const collaborationResult = collaboration ? await require('./desktop-collaboration')({
    app, win, project, realCodex, url: `http://127.0.0.1:${port}`, assert, desktopErrors: pageErrors
  }) : null;
  assert(pageErrors.length === 0, 'desktop renderer reported no uncaught errors: ' + pageErrors.join(', '));
  const evidenceDir = path.join(__dirname, '..', '.artifacts', 'desktop-bootstrap');
  fs.mkdirSync(evidenceDir, { recursive: true });
  await win.screenshot({ path: path.join(evidenceDir, realCodex ? 'codex-workspace.png' : process.env.DESKTOP_EXECUTABLE ? 'packaged-workspace.png' : 'workspace.png') });
  const providerStatus = realCodex ? await win.evaluate(() => window.harnessDesktop.codexStatus()) : null;
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length > 1),
    'durable crypto broker is active before testing close');
  // Closing the product window is no longer quitting (#18): the execution host stays up for
  // the teammates still in the task. What still has to be true is that the hidden broker never
  // becomes the reason the app cannot leave, so the exit is tested on the explicit quit.
  await app.evaluate(() => global.__plexusDesktop.closeWindow());
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert((await app.evaluate(() => global.__plexusDesktop.lifecycle())).runtimeRunning,
    'closing the product window leaves the execution host running for teammates');
  const exited = app.waitForEvent('close', { timeout: 10000 });
  await app.evaluate(() => global.__plexusDesktop.forceQuit()); await exited;
  assert(true, 'an explicit quit exits even while the hidden crypto broker is active');
  fs.writeFileSync(path.join(evidenceDir, realCodex ? 'codex-results.json' : 'latest-results.json'), JSON.stringify({
    status: 'pass', ranAt: new Date().toISOString(), packaged: !!process.env.DESKTOP_EXECUTABLE,
    provider: realCodex ? 'codex-cli' : 'demo', providerStatus, rendererErrors: pageErrors,
    separateApprovalConsent: true, actualFileVerified: true, providerTurn: 'completed', exitedWithHiddenBroker: true,
    ...(collaborationResult ? { collaboration: collaborationResult } : {})
  }, null, 2) + '\n');
  console.log('\ndesktop smoke passed');
})().catch(async (e) => {
  console.error('DESKTOP SMOKE FAILED', e);
  const evidenceDir = path.join(__dirname, '..', '.artifacts', 'desktop-bootstrap');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, realCodex ? 'codex-results.json' : 'latest-results.json'), JSON.stringify({
    status: 'fail', ranAt: new Date().toISOString(), packaged: !!process.env.DESKTOP_EXECUTABLE,
    provider: realCodex ? 'codex-cli' : 'demo', rendererErrors: pageErrors
  }, null, 2) + '\n');
  if (testWindow && !testWindow.isClosed()) {
    await testWindow.screenshot({ path: path.join(evidenceDir, 'failure.png') }).catch(() => {});
    const encryptedState = await testWindow.evaluate(() => window.__plexus?.state?.encryptedState).catch(() => null);
    const taskError = await testWindow.locator('#ew-error').textContent().catch(() => '');
    const execution = await testWindow.evaluate(() => {
      const state = window.__plexus?.state;
      const snapshot = state?.encryptedSnapshots?.get(state.activeThreadId);
      return { view: { recovery: state?.recoveryOpen, access: state?.accessOpen },
        turn: snapshot?.turn, outcome: snapshot?.outcome,
        events: snapshot?.events?.map(event => ({ type: event.type, payload: event.payload })) };
    }).catch(() => null);
    fs.writeFileSync(path.join(evidenceDir, 'failure-execution.json'), JSON.stringify(execution, null, 2));
    fs.writeFileSync(path.join(evidenceDir, 'failure.txt'), await testWindow.locator('body').innerText().catch(() => '') + '\n' + pageErrors.join('\n') + '\n' + JSON.stringify(encryptedState) + '\nTask error: ' + taskError);
  }
  process.exitCode = 1;
}).finally(async () => {
  await quitApp(desktopApp);
  if (desktopTemp) fs.rmSync(desktopTemp, { recursive: true, force: true });
});
