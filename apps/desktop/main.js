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
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, dialog, clipboard, shell, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createPairingCode } = require('../../packages/protocol');
const lifecycle = require('./lifecycle');

// Packaged, everything lives under the asar and `getAppPath()` is its root. In a checkout
// that call returns whatever directory Electron was pointed at, which is not the same
// thing, so dev resolves relative to this file instead. Either way ROOT is the single base
// path the shell uses - nothing reaches into a source tree at runtime.
const ROOT = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..', '..');
// Where child services actually run. Must be a real directory: see spawnService.
const SERVICE_CWD = app.isPackaged ? path.dirname(process.execPath) : ROOT;
const ICON = path.join(ROOT, 'apps', 'web', 'brand', 'plexus-app-icon-256.png');

const userDataArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (userDataArg) app.setPath('userData', userDataArg.split('=').slice(1).join('='));

let win = null;
const children = [];
const serviceLogs = { hub: [], runtime: [] };
let runtimeChild = null;
let hubChild = null;
let runtimeLaunch = null;
let tray = null;
let trayTimer = null;
let quitting = false;
let toldAboutTray = false;
let httpUrl = null;
let stateFile = null;
let setup = {};

// A second launch must not start a second hub and a second execution host against the same
// data directory. That is the duplicate host this slice exists to prevent, and it is also how
// two processes end up fighting over one sqlite file.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.exit(0);
else app.on('second-instance', () => showWindow());

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
    // Its own process group, so a forced stop can take the whole tree rather than orphaning
    // whatever the host spawned under it. Windows has no groups; `taskkill /T` does the job
    // there, and detaching would only survive the parent it is meant to follow.
    detached: process.platform !== 'win32',
    windowsHide: true
  });
  // Without this, a spawn that fails outright throws an unhandled error event and the app
  // dies with nothing on screen - the exact failure mode this slice is meant to remove.
  child.on('message', (message) => {
    if (label === 'runtime' && message.type === 'runtime.ready') child.runtimeReady = message;
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
  runtimeChild = spawnService('runtime', runtimeLaunch.script, runtimeLaunch.args, runtimeLaunch.env);
  return runtimeChild;
}

// The host is the only process that knows what it is running, so it is the one asked - by the
// tray, and by the quit warning that has to name the work it would end.
async function activeWork() {
  const status = await lifecycle.askService(runtimeChild, { type: 'runtime.status' }, { timeoutMs: 2500 });
  return { name: (status && status.name) || null, active: (status && status.active) || [] };
}

// Ask over the IPC channel the service was spawned with, then take its whole tree if it does
// not go. `child.kill()` alone is not enough on either count: Windows cannot deliver a signal
// a child can act on, and killing the parent leaves its own children holding the workspace.
function stopService(child, options = {}) {
  return lifecycle.stopService(child, { timeoutMs: 2500, ...options });
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

async function boot() {
  const dataDir = path.join(app.getPath('userData'), 'harness');
  fs.mkdirSync(dataDir, { recursive: true });
  const userName = process.env.HARNESS_USER || os.userInfo().username;
  const remote = process.env.HUB_HTTP_URL || null;
  httpUrl = remote;

  status('hub', 'working', remote ? 'Connecting to ' + remote : 'Starting the local team service…');
  if (!remote) {
    const port = parseInt(process.env.HUB_PORT || '7777', 10);
    hubChild = spawnService('hub', path.join(ROOT, 'packages', 'hub', 'server.js'), [String(port)], { HUB_DB: path.join(dataDir, 'hub.sqlite') });
    httpUrl = `http://127.0.0.1:${port}`;
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

  // A remote hub does not remove the need for a local execution host: the agent still runs
  // on this machine. This used to skip the runtime entirely whenever HUB_HTTP_URL was set,
  // which left the app connected to a team with nothing able to execute anything.
  status('runtime', 'working', 'Starting this machine as an execution host…');
  // path.delimiter, not ':' - a Windows path starts with a drive letter and a colon.
  const projects = (process.env.HARNESS_PROJECTS || '').split(path.delimiter).filter(Boolean).flatMap((p) => ['--project', p]);
  runtimeLaunch = {
    script: path.join(ROOT, 'packages', 'runtime', 'index.js'),
    args: ['--hub', httpUrl.replace(/^http/, 'ws'), '--name', userName, '--data', dataDir, ...projects],
    env: { HARNESS_PAIRING_CODE: PAIRING_CODE }, dataDir
  };
  launchRuntime();

  const registered = await waitForRuntime();
  status('runtime', registered ? 'ready' : 'failed', registered
    ? (registered.paired ? 'This machine is available to the team' : 'This machine is ready to pair with your team')
    : `The execution host did not register.\n${serviceLogs.runtime.slice(-6).join('\n') || 'It produced no output.'}`);

  if (!registered) throw new Error('The execution host did not connect. Try again or inspect the data folder logs.');

  status('ui', 'working', 'Opening the workspace…');
  await win.loadURL(httpUrl + '/?name=' + encodeURIComponent(userName));
  // Where to connect, who this is, and how the window sat. Deliberately nothing about a task,
  // a turn or a command: a launch restores the workspace, and never re-issues work.
  lifecycle.saveState(stateFile, { hubUrl: httpUrl, userName });
  refreshTray();
}

async function createWindow() {
  const saved = (setup.bounds && setup.bounds.width) ? setup.bounds : {};
  win = new BrowserWindow({
    width: saved.width || 1360, height: saved.height || 860, x: saved.x, y: saved.y,
    minWidth: 960, minHeight: 620,
    title: 'Plexus', backgroundColor: '#080a09', autoHideMenuBar: true,
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  // The window exists before the services do, so startup is visible instead of being a
  // blank frame or - worse - no window at all when something fails.
  await win.loadFile(path.join(__dirname, 'boot.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) shell.openExternal(url); return { action: 'deny' }; });
  const remember = () => { if (win && !win.isDestroyed() && !win.isMinimized()) lifecycle.saveState(stateFile, { bounds: win.getBounds() }); };
  win.on('resize', remember);
  win.on('move', remember);
  // The close button puts the app away; it does not end anyone's work. Only an explicit quit
  // does that, and it asks first.
  win.on('close', (event) => {
    // With no tray there is nothing to reopen from, so hiding would strand the app with no
    // window and no icon. On a desktop without one, close means close.
    if (quitting || !tray) return;
    event.preventDefault();
    remember();
    win.hide();
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    announceStillRunning();
    refreshTray();
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow().then(() => { if (!httpUrl) runBoot(); else win.loadURL(httpUrl + '/?name=' + encodeURIComponent(setup.userName || '')); }); return; }
  if (process.platform === 'darwin' && app.dock) app.dock.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  refreshTray();
}

// Said once, the first time the window goes away, because a host that keeps running after its
// window closes is only a good surprise if it is not a surprise.
function announceStillRunning() {
  if (toldAboutTray) return;
  toldAboutTray = true;
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: 'Plexus is still running',
        body: 'Tasks on this machine keep going and teammates can still join them. Quit from the tray to stop.',
        icon: ICON, silent: true
      }).show();
    }
  } catch { /* a notification is never worth failing over */ }
}

// ---------------- tray ----------------
function createTray() {
  if (tray) return tray;
  try {
    let image = nativeImage.createFromPath(ICON);
    if (!image.isEmpty()) image = image.resize({ width: 16, height: 16 });
    tray = new Tray(image);
  } catch (err) {
    // A desktop with no system tray still has to be quittable, and the window still has to
    // close without ending the work. Losing the icon must not lose either.
    log('[tray] unavailable: ' + ((err && err.message) || err));
    return null;
  }
  tray.setToolTip('Plexus');
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  refreshTray();
  trayTimer = setInterval(refreshTray, 5000);
  return tray;
}

async function trayState() {
  const { name, active } = await activeWork();
  return {
    hostName: name,
    active,
    hubUrl: httpUrl,
    windowVisible: !!(win && !win.isDestroyed() && win.isVisible())
  };
}

async function refreshTray() {
  if (!tray || tray.isDestroyed() || quitting) return;
  const state = await trayState();
  if (!tray || tray.isDestroyed() || quitting) return;
  tray.setToolTip('Plexus — ' + lifecycle.describeActive(state.active));
  tray.setContextMenu(Menu.buildFromTemplate(lifecycle.trayMenuTemplate(state, {
    open: () => showWindow(),
    copyLink: () => clipboard.writeText(httpUrl || ''),
    openExternal: () => httpUrl && shell.openExternal(httpUrl),
    quit: () => requestQuit()
  })));
}

// ---------------- quit ----------------
// Replaced in tests, which cannot click a native modal: the warning's content is still built
// and asserted, and the answer a person would give is chosen for it.
let askToQuit = async (options) => {
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : null;
  const res = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return res.response;
};

async function requestQuit() {
  if (quitting) return 'already-quitting';
  const { active } = await activeWork();
  if (active.length) {
    const options = lifecycle.quitDialog(active);
    if (await askToQuit(options) !== options.confirmId) { refreshTray(); return 'cancelled'; }
  }
  await shutdown();
  return 'quit';
}

// Stop the managed processes for real. The host goes first and is asked rather than killed, so
// it can interrupt its turns, let each one write its own outcome, and tell the team it left on
// purpose. Anything still alive after that is taken with its whole tree.
async function shutdown() {
  if (quitting) return;
  quitting = true;
  if (trayTimer) clearInterval(trayTimer);
  lifecycle.saveState(stateFile, { lastQuitAt: Date.now() });
  await stopService(runtimeChild, { timeoutMs: 6000 });
  await stopService(hubChild, { timeoutMs: 3000 });
  await Promise.all(children.filter((c) => c !== runtimeChild && c !== hubChild).map((c) => stopService(c, { timeoutMs: 2000 })));
  if (tray && !tray.isDestroyed()) tray.destroy();
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(0);
}

async function runBoot() {
  try { await boot(); }
  catch (err) {
    log('[boot] failed: ' + ((err && err.stack) || err));
    status('ui', 'failed', String((err && err.message) || err));
  }
}

ipcMain.handle('desktop:pairingCode', async () => localPairingCode());
ipcMain.handle('desktop:runtimeId', async () => localRuntimeId());
ipcMain.handle('desktop:pickFolder', (_event, runtimeId) => pickAndAuthorizeProject(runtimeId));
let retryPromise = null;
ipcMain.handle('desktop:retryBoot', () => {
  if (retryPromise) return retryPromise;
  retryPromise = (async () => {
    await Promise.all(children.splice(0).map((c) => stopService(c)));
    runtimeChild = null;
    hubChild = null;
    serviceLogs.hub.length = 0;
    serviceLogs.runtime.length = 0;
    await win.loadFile(path.join(__dirname, 'boot.html'));
    await runBoot();
  })().finally(() => { retryPromise = null; });
  return retryPromise;
});
ipcMain.handle('desktop:openDataFolder', async () => shell.openPath(app.getPath('userData')));

// The seam the tests drive. A tray icon and a native modal cannot be clicked by a test, so
// the same entry points those controls use are reachable by name.
app.harness = {
  showWindow, requestQuit, shutdown, refreshTray, trayState, activeWork, lifecycle,
  trayMenuLabels: async () => lifecycle.trayMenuTemplate(await trayState(), {}).map((i) => i.label || '---'),
  servicePids: () => ({ hub: hubChild && hubChild.pid, runtime: runtimeChild && runtimeChild.pid }),
  hubUrl: () => httpUrl,
  setup: () => lifecycle.loadState(stateFile),
  onQuitPrompt: (fn) => { askToQuit = fn; }
};

if (primaryInstance) app.whenReady().then(async () => {
  openLog();
  stateFile = path.join(app.getPath('userData'), 'desktop-state.json');
  setup = lifecycle.loadState(stateFile);
  createTray();
  await createWindow();
  return runBoot();
});
app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) { await createWindow(); runBoot(); }
  else showWindow();
});
// Every window can be closed without ending the session: the host is still serving the team.
// Unless there is no tray to bring it back, in which case a closed window is the end of it.
app.on('window-all-closed', () => { if (!tray) requestQuit(); });
// Cmd-Q, the dock menu and a taskbar close all reach the same warning the tray does.
app.on('before-quit', (event) => { if (!quitting) { event.preventDefault(); requestQuit(); } });
// Last resort only. Anything that gets here skipped the polite path, so nothing is left behind.
app.on('quit', () => { for (const c of children) { try { c.kill(); } catch {} } });
