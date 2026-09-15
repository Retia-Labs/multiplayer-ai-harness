'use strict';
// Desktop shell: starts the local hub + execution host, shows what is happening while they
// come up, then loads the shared web UI.
//
// Closing the window does not stop the work. The window is one client of an execution host
// that keeps running in the tray, so a teammate who is still in the task can carry on while
// the person who started it is away. Quitting is a separate, explicit act: it says what it
// will end, takes the managed processes down with their children, and leaves the team told.
//
// The services run on Electron's own bundled Node (`process.execPath` with
// ELECTRON_RUN_AS_NODE), never on a `node` that happens to be on PATH. An installed copy
// has no terminal, no developer checkout, and no guarantee that Node exists at all - and
// the hub needs `node:sqlite`, which arrived in Node 22.5, so "whatever node is on PATH"
// was never a safe answer either.
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage } = require('electron');
const lifecycle = require('./lifecycle');
const { shouldQuitOnWindowClose, quitPlan, shouldLaunchRuntime, trayState } = lifecycle;
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createPairingCode } = require('../../packages/protocol');
const { ORIGIN, installRenderer, requireRenderer, endpointStoreKey } = require('./renderer');
const { attachCryptoBroker } = require('../../packages/e2ee/desktop-crypto-broker');
const { desktopProfile } = require('./profile');
const { createFreshnessConfirmation } = require('./local-runtime-rpc');
const { diagnosticExport } = require('../../packages/product/diagnostics.mjs');
const { pathToFileURL } = require('node:url');
const bootHealth = {};

// Packaged, everything lives under the asar and `getAppPath()` is its root. In a checkout
// that call returns whatever directory Electron was pointed at, which is not the same
// thing, so dev resolves relative to this file instead. Either way ROOT is the single base
// path the shell uses - nothing reaches into a source tree at runtime.
const ROOT = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..', '..');
// Where child services actually run. Must be a real directory: see spawnService.
const SERVICE_CWD = app.isPackaged ? path.dirname(process.execPath) : ROOT;

const userDataArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (userDataArg) app.setPath('userData', userDataArg.split('=').slice(1).join('='));

let win = null;
const children = [];
const serviceLogs = { hub: [], runtime: [] };
let runtimeChild = null;
let hubChild = null;
let runtimeLaunch = null;
let tray = null;
let trayMenu = null;
let trayTimer = null;
let stateFile = null;
let setup = {};
// Where the workspace was loaded from, so reopening a window does not re-run boot.
let bootedUrl = null;
// What the host says it is running, kept here so the tray and the quit warning are built from
// one snapshot and cannot disagree with each other.
let active = { count: 0, names: [], blocked: 0 };
let connectedHubUrl = null;
let profile = null;
let quitting = false;

// An installed app has no console to print to, so a startup failure would otherwise be
// invisible to the user and unreportable to us. Everything the shell prints also goes here.
let logStream = null;
function openLog() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logStream = fs.createWriteStream(path.join(dir, 'desktop.log'), { flags: 'a' });
    logStream.on('error', () => { logStream = null; });
    log(`--- started ${new Date().toISOString()} · electron ${process.versions.electron} · node ${process.versions.node} · packaged=${app.isPackaged} ---`);
  } catch { /* logging must never be the reason the app fails to start */ }
}
function log(line) {
  const text = String(line).trimEnd();
  process.stdout.write(text + '\n');
  if (logStream) { try { logStream.write(text + '\n'); } catch {} }
}

const PAIRING_CODE = createPairingCode();

function status(step, state, detail) {
  bootHealth[step] = state;
  const first = detail ? String(detail).split(/\r?\n/)[0] : '';
  log(`[boot] ${step} ${state}${first ? ' — ' + first : ''}`);
  if (win && !win.isDestroyed()) win.webContents.send('boot:status', { step, state, detail });
}

function spawnService(label, script, args, env) {
  const child = spawn(process.execPath, [script, ...args], {
    // A child's working directory has to be a real directory on disk. Packaged, ROOT is the
    // asar - a *file* - and spawning into it fails before the process ever starts. Scripts
    // still resolve through ROOT because Electron's fs reads inside the asar happily; only
    // cwd has to be somewhere the OS can actually chdir to.
    cwd: SERVICE_CWD,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    // Its own process group, so the sweep in killTreeCommand has a group to reach. A child
    // that is not a group leader gives `kill -TERM -pid` nothing to take. Windows has no
    // groups and uses `taskkill /T` instead, where detaching would only outlive the parent it
    // is supposed to follow.
    detached: process.platform !== 'win32',
    windowsHide: true
  });
  // Without this, a spawn that fails outright throws an unhandled error event and the app
  // dies with nothing on screen - the exact failure mode this slice is meant to remove.
  child.on('message', (message) => {
    if (label === 'runtime' && message?.type === 'runtime.ready') child.runtimeReady = message;
  });
  child.on('error', (err) => status(label, 'failed', `could not start: ${err.message}`));
  const keep = (s) => {
    const lines = serviceLogs[label];
    if (!lines) return;
    lines.push(s.trimEnd());
    if (lines.length > 80) lines.shift();
  };
  child.stdout.on('data', (d) => { const s = d.toString(); keep(s); log(`[${label}] ${s}`); });
  child.stderr.on('data', (d) => {
    const s = d.toString();
    if (/ExperimentalWarning|trace-warnings/.test(s)) return;
    keep(s);
    log(`[${label}] ${s}`);
  });
  // A service dying during startup is the most common real failure, and the reason is
  // always in its own output - so keep it and show it rather than leaving a blank window.
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      status(label, 'failed', `exited with code ${code}\n${(serviceLogs[label] || []).slice(-6).join('\n')}`);
    }
  });
  children.push(child);
  return child;
}

function launchRuntime() {
  if (!runtimeLaunch) return null;
  // Reopening a window must not start a second host. Two hosts on one machine means two
  // runtime ids, two pairing codes, and a fleet list implying a machine nobody has.
  if (!shouldLaunchRuntime(runtimeChild)) return runtimeChild;
  runtimeChild = spawnService('runtime', runtimeLaunch.script, runtimeLaunch.args, runtimeLaunch.env);
  // The broker serves bundled crypto code and keeps the host's SDK store persistent.
  attachCryptoBroker(runtimeChild, { dataDir: runtimeLaunch.dataDir });
  refreshTray();
  return runtimeChild;
}

function runtimeRunning() {
  return !!(runtimeChild && runtimeChild.exitCode === null && runtimeChild.signalCode === null);
}

// The host is the only process that knows what it is running, so it is the one asked - by the
// tray, and by the quit warning that has to name the work it would end.
async function refreshActive() {
  const status = await lifecycle.askService(runtimeChild, { type: 'runtime.status' });
  const running = (status && status.active) || [];
  active = {
    count: running.length,
    names: running.map((a) => a.name).filter(Boolean),
    blocked: running.filter((a) => a.waitingOnApproval).length
  };
  return active;
}

function activeTaskCount() { return runtimeRunning() ? active.count : 0; }

// A task that started or ended while nobody was looking still has to show up in the tray, so
// the snapshot is refreshed on a timer rather than only when something asks.
function watchActive() {
  if (trayTimer) return;
  trayTimer = setInterval(() => { refreshActive().then(refreshTray, () => {}); }, 5000);
}

// ---- tray ----
//
// The tray is what makes closing a window different from quitting. Without one there is no way
// back to a running host, so closing would have to end it - which is exactly the behaviour
// issue #18 exists to remove.
function createTray() {
  if (tray) return tray;
  try {
    const icon = nativeImage.createFromPath(path.join(ROOT, 'apps', 'web', 'brand', 'plexus-app-icon-256.png'));
    // A tray icon that fails to load would silently take the app back to quitting on close,
    // so an empty image is used rather than no tray at all.
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 18, height: 18 }));
  } catch (error) {
    // A desktop with no system tray still has to be quittable, and the window still has to be
    // closable. Losing the icon must not lose either.
    log('[tray] unavailable: ' + ((error && error.message) || error));
    return null;
  }
  tray.on('click', () => showWindow());
  refreshTray();
  return tray;
}

function refreshTray() {
  if (!tray || tray.isDestroyed() || quitting) return;
  const state = trayState({
    runtimeRunning: runtimeRunning(),
    activeTasks: activeTaskCount(),
    windowOpen: !!(win && !win.isDestroyed() && win.isVisible())
  });
  tray.setToolTip(state.tooltip);
  trayMenu = Menu.buildFromTemplate([
    { label: state.tooltip, enabled: false },
    ...(state.detail ? [{ label: state.detail, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Open Plexus', click: () => showWindow() },
    { label: 'Quit Plexus', click: () => requestQuit() }
  ]);
  tray.setContextMenu(trayMenu);
}

async function showWindow() {
  if (quitting) return;
  if (win && !win.isDestroyed()) { win.show(); win.focus(); refreshTray(); return; }
  // Only reached when there was no tray to hide into, or after a failed boot.
  await createWindow();
  // Reopening is not restarting. The services this app manages are already up - booting again
  // tried to bind the hub's port a second time and failed with EADDRINUSE, which is the same
  // mistake as launching a second runtime, wearing different clothes.
  if (bootedUrl && runtimeRunning()) await win.loadURL(bootedUrl);
  else await runBoot();
  refreshTray();
}

// ---- quitting ----
// Replaced in tests, which cannot answer a native modal. The warning is still built and its
// content still asserted; only the click is stood in for.
let askToQuit = async (options) => {
  const parent = win && !win.isDestroyed() ? win : undefined;
  return (await dialog.showMessageBox(parent, options)).response;
};

// What the person is about to be shown, built from what the host reports right now.
async function currentQuitPlan() {
  if (runtimeRunning()) await refreshActive();
  return quitPlan({ activeTasks: activeTaskCount(), activeTaskNames: active.names, blocked: active.blocked });
}

// Quitting is allowed to stop work. It is not allowed to stop it quietly.
async function requestQuit() {
  if (quitting) return true;
  const plan = await currentQuitPlan();
  if (plan.confirm) {
    const choice = await askToQuit({
      type: 'warning', title: plan.title, message: plan.message, detail: plan.detail,
      buttons: plan.buttons, defaultId: 1, cancelId: 1
    });
    if (choice !== 0) { refreshTray(); return false; }
  }
  await shutdown();
  return true;
}

// Stop the managed processes for real. The host goes first and is asked rather than killed, so
// it can interrupt its turns, let each one write its own outcome, and tell the relay it left on
// purpose - #17's `unknown` is for a host that vanished, and this one has not.
async function shutdown() {
  if (quitting) return;
  quitting = true;
  if (trayTimer) clearInterval(trayTimer);
  if (stateFile) lifecycle.saveState(stateFile, { lastQuitAt: Date.now(),
    ...(win && !win.isDestroyed() ? { bounds: win.getNormalBounds() } : {}) });
  const ordered = [runtimeChild, hubChild, ...children.filter((c) => c !== runtimeChild && c !== hubChild)];
  children.length = 0;
  for (const child of ordered) if (child) await stopService(child);
  if (tray && !tray.isDestroyed()) tray.destroy();
  app.exit(0);
}

// Ask over the IPC channel the service was spawned with, then take its whole tree if asking
// does not work. `child.kill()` alone is not enough on either count: Windows cannot deliver a
// signal a child can act on, so there is no polite stop there at all, and killing the parent
// leaves a provider CLI still running and a workspace still being written to.
function stopService(child, options = {}) {
  return lifecycle.stopService(child, { timeoutMs: 6000, ...options });
}

function addProjectToRuntimeConfig(dataDir, dir) {
  const configPath = path.join(dataDir, 'runtime.json');
  let config = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('runtime.json must contain an object');
  }
  if (config.projects != null && !Array.isArray(config.projects)) throw new Error('runtime.json projects must be an array');
  const projects = [...new Set([...(config.projects || []).map((p) => path.resolve(p)), dir])];
  if (projects.length === (config.projects || []).length) return false;
  const tempPath = configPath + `.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify({ ...config, projects }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tempPath, configPath);
  return true;
}

function localRuntimeId() {
  if (!runtimeLaunch) return null;
  try {
    const id = fs.readFileSync(path.join(runtimeLaunch.dataDir, 'runtime-id'), 'utf8').trim();
    return id || null;
  } catch {
    return null;
  }
}

function localPairingCode() {
  if (!runtimeLaunch) return null;
  try {
    const code = fs.readFileSync(path.join(runtimeLaunch.dataDir, 'pairing-code'), 'utf8').trim();
    return code || null;
  } catch {
    // The runtime writes the same initial code as soon as it starts. This fallback only
    // covers the short interval before that owner-only file exists.
    return PAIRING_CODE;
  }
}

async function pickAndAuthorizeProject(runtimeId) {
  // A desktop connected only to a remote hub must not authorize paths on an unrelated
  // runtime. The native picker is a host-local consent path only when this shell launched
  // the runtime itself.
  if (!runtimeLaunch) throw new Error('This desktop is connected to a remote hub and has no local execution host.');
  const ownedRuntimeId = localRuntimeId();
  if (!ownedRuntimeId) throw new Error('The local execution host is still starting. Try again in a moment.');
  if (runtimeId !== ownedRuntimeId) throw new Error("Select this desktop's local execution host before sharing a folder.");
  const res = await dialog.showOpenDialog(win, { title: 'Register project folder', properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths.length) return { changed: false, canceled: true };
  const dir = path.resolve(res.filePaths[0]);
  if (!fs.statSync(dir).isDirectory()) throw new Error('Selected project is not a directory');
  if (!addProjectToRuntimeConfig(runtimeLaunch.dataDir, dir)) return { changed: false, canceled: false };

  await stopService(runtimeChild);
  launchRuntime();
  // Report the outcome without exposing the authorized filesystem path to the renderer.
  return { changed: true, canceled: false };
}

async function waitForHub(url, tries = 80) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return { ok: true, health: await r.json() };
      lastErr = 'HTTP ' + r.status;
    } catch (e) { lastErr = e.message; }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, error: lastErr };
}

// Readiness comes from this child after its authenticated hub handshake. A fresh host
// can be ready to pair without being authorized to execute for any team yet.
async function waitForRuntime(tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (!runtimeChild || runtimeChild.exitCode !== null || runtimeChild.signalCode !== null) return null;
    if (runtimeChild.runtimeReady) return runtimeChild.runtimeReady;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const confirmFreshnessAuthority = createFreshnessConfirmation({
  getRuntime: () => runtimeLaunch && runtimeChild ? { child: runtimeChild, runtimeId: localRuntimeId() } : null,
  confirm: async options => (await dialog.showMessageBox(win, options)).response === 1,
  restart: async captured => {
    if (quitting || runtimeChild !== captured.child || localRuntimeId() !== captured.runtimeId) throw new Error('freshness_host_unavailable');
    await stopService(captured.child);
    if (quitting || runtimeChild !== captured.child || localRuntimeId() !== captured.runtimeId) throw new Error('freshness_host_unavailable');
    const replacement = launchRuntime();
    const ready = await waitForRuntime();
    if (!ready || runtimeChild !== replacement || localRuntimeId() !== captured.runtimeId) throw new Error('freshness_host_unavailable');
  }
});

async function boot() {
  const dataDir = profile.dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  const userName = process.env.HARNESS_USER || os.userInfo().username;
  const remote = process.env.HUB_HTTP_URL || null;
  const httpUrl = profile.hubUrl;

  status('hub', 'working', remote ? 'Connecting to ' + remote : 'Starting the local team service…');
  if (!remote) {
    const port = parseInt(process.env.HUB_PORT || '7777', 10);
    hubChild = spawnService('hub', path.join(ROOT, 'packages', 'hub', 'server.js'), [String(port)], { HUB_DB: profile.localHubDatabase });
  }
  const hub = await waitForHub(httpUrl);
  if (!hub.ok) {
    const hint = remote
      ? `Could not reach the team service at ${remote} (${hub.error}). Check the address and your network.`
      : `The local team service did not start.\n${serviceLogs.hub.slice(-6).join('\n') || 'It produced no output.'}`;
    status('hub', 'failed', hint);
    throw new Error(hint);
  }
  status('hub', 'ready', remote ? 'Connected to ' + remote : 'Local team service running');
  connectedHubUrl = httpUrl;

  // A remote hub does not remove the need for a local execution host: the agent still runs
  // on this machine. This used to skip the runtime entirely whenever HUB_HTTP_URL was set,
  // which left the app connected to a team with nothing able to execute anything.
  status('runtime', 'working', 'Starting this machine as an execution host…');
  // path.delimiter, not ':' - a Windows path starts with a drive letter and a colon.
  const projects = (process.env.HARNESS_PROJECTS || '').split(path.delimiter).filter(Boolean).flatMap((p) => ['--project', p]);
  runtimeLaunch = {
    script: path.join(ROOT, 'packages', 'runtime', 'index.js'),
    args: ['--hub', httpUrl.replace(/^http/, 'ws'), '--name', userName, '--data', dataDir, '--encrypted-tasks-only', ...projects],
    env: { HARNESS_PAIRING_CODE: PAIRING_CODE }, dataDir
  };
  launchRuntime();

  const registered = await waitForRuntime();
  status('runtime', registered ? 'ready' : 'failed', registered
    ? (registered.paired ? 'This machine is available to the team' : 'This machine is ready to pair with your team')
    : `The execution host did not register.\n${serviceLogs.runtime.slice(-6).join('\n') || 'It produced no output.'}`);

  if (!registered) throw new Error('The execution host did not connect. Try again or inspect the data folder logs.');

  status('ui', 'working', 'Opening the workspace…');
  bootedUrl = ORIGIN + '/?name=' + encodeURIComponent(userName);
  await win.loadURL(bootedUrl);
  // Where to connect, who this is, and how the window sat. Deliberately nothing about a task,
  // a turn or a command: a launch restores the workspace, and never re-issues work.
  if (stateFile) lifecycle.saveState(stateFile, { hubUrl: connectedHubUrl || ORIGIN, userName });
  await refreshActive();
  watchActive();
  refreshTray();
}

async function createWindow() {
  const saved = (setup.bounds && setup.bounds.width) ? setup.bounds : {};
  win = new BrowserWindow({
    width: saved.width || 1360, height: saved.height || 860, x: saved.x, y: saved.y,
    minWidth: 960, minHeight: 620,
    title: 'Plexus', backgroundColor: '#080a09', autoHideMenuBar: true,
    icon: path.join(ROOT, 'apps', 'web', 'brand', 'plexus-app-icon-256.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      ...(profile ? { partition: profile.partition } : {}) }
  });
  // The crypto broker is deliberately hidden, so it must not keep this app alive by itself.
  // With a tray there is a reason to stay alive that has nothing to do with the broker: the
  // execution host is still serving teammates, and the tray is how somebody gets back to it.
  // Without a tray there is no way back, so a closed window is still the end of the session.
  // The window exists before the services do, so startup is visible instead of being a
  // blank frame or - worse - no window at all when something fails.
  await win.loadFile(path.join(__dirname, 'boot.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN + '/')) event.preventDefault();
  });
  const remember = () => { if (stateFile && win && !win.isDestroyed() && !win.isMinimized()) lifecycle.saveState(stateFile, { bounds: win.getBounds() }); };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', remember);
  remember();
  // With a tray, closing puts the window away and keeps the renderer - which holds this
  // endpoint's keys and its verified state - alive behind it, so reopening is a window coming
  // back rather than an identity being derived again. Without a tray there is no way back, so
  // a closed window is still the end of the session.
  win.on('close', (event) => {
    if (quitting || shouldQuitOnWindowClose({ hasTray: !!tray })) return;
    event.preventDefault();
    remember();
    win.hide();
    refreshTray();
  });
  // The crypto broker is deliberately hidden, so it must not keep this app alive by itself.
  win.on('closed', () => { win = null; if (!quitting) app.quit(); });
}

async function runBoot() {
  try { await boot(); }
  catch (err) {
    log('[boot] failed: ' + ((err && err.stack) || err));
    status('ui', 'failed', String((err && err.message) || err));
  }
}

ipcMain.on('desktop:hubUrl', (event) => {
  requireRenderer(event, win); event.returnValue = connectedHubUrl;
});
ipcMain.handle('desktop:pairingCode', async (event) => { requireRenderer(event, win); return localPairingCode(); });
ipcMain.handle('desktop:runtimeId', async (event) => { requireRenderer(event, win); return localRuntimeId(); });
ipcMain.handle('desktop:pickFolder', (event, runtimeId) => { requireRenderer(event, win); return pickAndAuthorizeProject(runtimeId); });
ipcMain.handle('desktop:endpointStoreKey', (event) => {
  requireRenderer(event, win);
  return endpointStoreKey(profile.dataDir);
});
ipcMain.handle('desktop:encryptedSetup', (event) => {
  requireRenderer(event, win);
  try { return JSON.parse(fs.readFileSync(path.join(runtimeLaunch.dataDir, 'encrypted-setup.json'), 'utf8')); }
  catch { return { runtimeId: localRuntimeId(), projects: [], state: 'starting' }; }
});
ipcMain.handle('desktop:confirmFreshnessAuthority', (event, request) => {
  requireRenderer(event, win);
  return confirmFreshnessAuthority(request);
});
ipcMain.handle('desktop:codexStatus', (event) => {
  requireRenderer(event, win);
  const { resolveCodex, version, authStatus } = require('../../packages/runtime/codex-probe');
  const { SUPPORTED_CODEX_VERSION } = require('../../packages/runtime/codex-host-profile');
  const resolved = resolveCodex();
  const support = { supportedVersion: SUPPORTED_CODEX_VERSION,
    platformSupported: process.platform === 'darwin' && process.arch === 'arm64' };
  if (!resolved.ok) return { ...support, available: false, code: 'codex_unavailable' };
  return { ...support, available: true, version: version(resolved), authMode: authStatus(resolved).mode };
});
ipcMain.handle('desktop:configureCodex', async (event) => {
  requireRenderer(event, win);
  const { resolveCodex, version, authStatus, codexHome } = require('../../packages/runtime/codex-probe');
  const { SUPPORTED_CODEX_VERSION } = require('../../packages/runtime/codex-host-profile');
  const resolved = resolveCodex();
  const supported = resolved.ok && process.platform === 'darwin' && process.arch === 'arm64' &&
    version(resolved) === SUPPORTED_CODEX_VERSION;
  const authFile = path.join(codexHome(), 'auth.json');
  const authMode = supported ? authStatus(resolved).mode : null;
  if (!supported || !['chatgpt', 'apikey'].includes(authMode) || !fs.existsSync(authFile)) {
    await dialog.showMessageBox(win, { type: 'info', title: 'Codex setup unavailable',
      message: 'This Codex configuration cannot yet be enabled for shared tasks.',
      detail: 'Use Codex ' + SUPPORTED_CODEX_VERSION + ' on an Apple silicon Mac, with a ChatGPT or API-key login saved locally by Codex. Other versions, platforms and keyring-only logins still require verification. The older read-only CLI can read outside the selected workspace and remains disabled.',
      buttons: ['OK'], defaultId: 0 });
    return { enabled: false, code: 'provider_not_isolated' };
  }
  const choice = await dialog.showMessageBox(win, { type: 'question', title: 'Use Codex on this host',
    message: authMode === 'apikey' ? 'Allow shared tasks to use this machine’s Codex API account?' : 'Allow shared tasks to use this machine’s Codex ChatGPT account?',
    detail: 'Project files are supplied through this host’s authorized read and change tools. Changes follow the host’s approval policy. ' +
      (authMode === 'apikey' ? 'This uses the API key already saved locally by Codex. API usage is billed to that key’s provider account; ChatGPT subscription usage does not cover it. ' :
        'This uses your existing local login and refreshes that same login when needed. Usage belongs to this provider account. ') +
      'Teammates can direct authorized tasks; this does not transfer your provider entitlement. Changing accounts requires local authorization and a fresh provider session.',
    buttons: ['Cancel', 'Enable Codex'], defaultId: 0, cancelId: 0 });
  if (choice.response !== 1) return { enabled: false };
  const file = path.join(runtimeLaunch.dataDir, 'runtime.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const workspace = config.projects?.[0];
  if (!workspace) throw new Error('codex_host_tools_workspace_required');
  const { HostToolsCodexAppServerBackend } = require('../../packages/runtime/codex-app-server');
  const provider = new HostToolsCodexAppServerBackend({ bin: resolved.path, authFile, authMode,
    profileDir: path.join(runtimeLaunch.dataDir, 'codex-host-profile') });
  const ready = await provider.checkHost({ workspace, settings: { effort: 'medium' } });
  const temp = file + '.provider-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify({ ...config, codexHostTools: { bin: path.resolve(resolved.path), authFile, authMode,
    accountBinding: ready.accountBinding } }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  await stopService(runtimeChild); launchRuntime();
  return { enabled: true };
});
ipcMain.handle('desktop:confirmEncryptionAuthority', async (event, { teamId, identity } = {}) => {
  requireRenderer(event, win);
  if (!runtimeLaunch || typeof teamId !== 'string' || !identity ||
      !['user', 'device', 'curve25519', 'ed25519'].every((key) => typeof identity[key] === 'string' && identity[key].length < 200)) {
    throw new Error('invalid_encryption_authority');
  }
  const choice = await dialog.showMessageBox(win, { type: 'question',
    title: 'Trust this team encryption authority?',
    message: 'Allow this verified endpoint to authorize this execution host?',
    detail: 'Compare this fingerprint with the team owner’s trusted device:\n' + identity.ed25519 +
      '\n\nUser: ' + identity.user + '\nDevice: ' + identity.device +
      '\n\nThis trusts membership and encryption changes. It does not grant action-approval rights.',
    buttons: ['Cancel', 'Trust endpoint'], defaultId: 0, cancelId: 0 });
  if (choice.response !== 1) return { confirmed: false };
  const file = path.join(runtimeLaunch.dataDir, 'runtime.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const next = { ...config, encryptionAuthority: { ...identity, teamId } };
  const temp = file + '.authority-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  await stopService(runtimeChild); launchRuntime();
  return { confirmed: true };
});
ipcMain.handle('desktop:confirmApprovalAuthority', async (event, { teamId, identity, recoveryEpoch } = {}) => {
  requireRenderer(event, win);
  if (!runtimeLaunch || typeof teamId !== 'string' || !identity ||
      !['user', 'device', 'curve25519', 'ed25519'].every(key => typeof identity[key] === 'string' && identity[key].length < 200) ||
      (recoveryEpoch != null && !/^[a-f0-9]{32}$/.test(recoveryEpoch))) {
    throw new Error('invalid_approval_authority');
  }
  const choice = await dialog.showMessageBox(win, { type: 'question',
    title: 'Choose this host’s approval authority',
    message: 'Allow this exact device to approve and delegate actions on this host?',
    detail: 'This is separate from team administration and encryption membership. Each task action still has an exact scope and deadline.\n\nUser: ' +
      identity.user + '\nDevice: ' + identity.device + '\nFingerprint: ' + identity.ed25519 +
      (recoveryEpoch ? '\n\nThis is fresh approval consent after customer recovery: ' + recoveryEpoch : ''),
    buttons: ['Cancel', 'Authorize approver'], defaultId: 0, cancelId: 0 });
  if (choice.response !== 1) return { confirmed: false };
  const file = path.join(runtimeLaunch.dataDir, 'runtime.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const temp = file + '.approver-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify({ ...config, approvalAuthority: { ...identity, teamId,
    ...(recoveryEpoch ? { recoveryEpoch } : {}) } }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  await stopService(runtimeChild); launchRuntime();
  return { confirmed: true };
});
let retryPromise = null;
function requireShellRenderer(event) {
  const bootUrl = pathToFileURL(path.join(__dirname, 'boot.html')).href;
  if (event.sender === win?.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === bootUrl) return;
  requireRenderer(event, win);
}
ipcMain.handle('desktop:diagnostics', (event) => {
  requireShellRenderer(event);
  return diagnosticExport({ client: 'desktop', versions: { app: app.getVersion(), electron: process.versions.electron }, stages: [
    { stage: 'project', status: bootHealth.runtime === 'ready' ? 'ready' : 'failed', code: bootHealth.hub === 'failed' ? 'connection_unavailable' : 'runtime_missing' }
  ] });
});
ipcMain.handle('desktop:retryBoot', (event) => {
  requireShellRenderer(event);
  if (retryPromise) return retryPromise;
  retryPromise = (async () => {
    await Promise.all(children.splice(0).map(stopService));
    runtimeChild = null;
    hubChild = null;
    serviceLogs.hub.length = 0;
    serviceLogs.runtime.length = 0;
    for (const step of Object.keys(bootHealth)) delete bootHealth[step];
    await win.loadFile(path.join(__dirname, 'boot.html'));
    await runBoot();
  })().finally(() => { retryPromise = null; });
  return retryPromise;
});
ipcMain.handle('desktop:openDataFolder', async (event) => {
  requireShellRenderer(event);
  return shell.openPath(app.getPath('userData'));
});

// The seam the tests drive. A tray icon and a native modal cannot be clicked by a test, so the
// entries in the menu the app installed are invoked through their own handlers, and the answer
// a person would give the dialog is chosen for it.
global.__plexusDesktop = {
  lifecycle: () => ({
    runtimeRunning: runtimeRunning(),
    runtimePid: runtimeChild ? runtimeChild.pid : null,
    hasTray: !!tray,
    windows: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
    productWindow: !!(win && !win.isDestroyed()),
    windowVisible: !!(win && !win.isDestroyed() && win.isVisible()),
    quitsOnWindowClose: shouldQuitOnWindowClose({ hasTray: !!tray }),
    tray: trayState({ runtimeRunning: runtimeRunning(), activeTasks: activeTaskCount(), windowOpen: !!(win && !win.isDestroyed() && win.isVisible()) })
  }),
  closeWindow: () => { if (win && !win.isDestroyed()) win.close(); },
  showWindow: () => showWindow(),
  quitPlanNow: () => currentQuitPlan(),
  servicePids: () => ({ hub: hubChild ? hubChild.pid : null, runtime: runtimeChild ? runtimeChild.pid : null }),
  activeWork: () => refreshActive(),
  setup: () => (stateFile ? lifecycle.loadState(stateFile) : {}),
  pairingCode: () => localPairingCode(),
  trayMenuLabels: () => (trayMenu ? trayMenu.items.map((i) => i.label || '---') : []),
  // A test cannot make the OS open a tray menu, but it can invoke the entry a person would
  // choose from it - which is a smaller gap than calling the function that entry is wired to.
  clickTrayItem: (label) => {
    const item = trayMenu && trayMenu.items.find((i) => i.label === label);
    if (!item) throw new Error('no tray item labelled ' + JSON.stringify(label));
    if (!item.enabled) throw new Error('tray item is disabled: ' + label);
    item.click();
    return true;
  },
  onQuitPrompt: (fn) => { askToQuit = fn; },
  requestQuit: () => requestQuit(),
  // Quitting without the question. A tray app does not exit when its window closes - that is
  // the whole point of #18 - so an automated close has to say what it means, the same way a
  // person does by choosing Quit.
  forceQuit: () => shutdown()
};

app.whenReady().then(async () => {
  openLog();
  stateFile = path.join(app.getPath('userData'), 'desktop-state.json');
  setup = lifecycle.loadState(stateFile);
  createTray();
  try {
    profile = desktopProfile({ userData: app.getPath('userData'), dataRoot: process.env.HARNESS_DATA,
      hubUrl: process.env.HUB_HTTP_URL || 'http://127.0.0.1:' + (process.env.HUB_PORT || '7777') });
    installRenderer({ root: ROOT, hubUrl: () => connectedHubUrl, partition: profile.partition });
  } catch (error) {
    await createWindow(); status('hub', 'failed', 'Invalid team service address. Use an HTTP or HTTPS address without credentials.');
    status('ui', 'failed', error.message); return;
  }
  await createWindow(); return runBoot();
});
app.on('activate', () => { if (!quitting) showWindow(); });
// Cmd-Q, the dock menu and a taskbar close all reach the same warning the tray does. The
// shutdown behind it keeps the broker alive while the host flushes, as before.
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  requestQuit();
});
// Every window can be closed without ending the session: the host is still serving the team.
// Unless there is no tray to bring it back, in which case a closed window is the end of it.
app.on('window-all-closed', () => { if (shouldQuitOnWindowClose({ hasTray: !!tray })) app.quit(); });
app.on('quit', () => { for (const c of children) { try { c.kill(); } catch {} } });
