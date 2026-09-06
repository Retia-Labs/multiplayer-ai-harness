'use strict';
// Desktop shell: spawns a local hub + runtime (unless HUB_URL points at a remote hub),
// loads the shared web UI, and adds native integrations (folder picker).
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createPairingCode } = require('../../packages/protocol');

const ROOT = path.join(__dirname, '..', '..');

// This process is the host, so it mints the pairing code and shows it only in the local
// shell. The runtime sends it to the hub as the short-lived pairing challenge.
const PAIRING_CODE = createPairingCode();
const userDataArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (userDataArg) app.setPath('userData', userDataArg.split('=').slice(1).join('='));

let win = null;
const children = [];
let runtimeChild = null;
let runtimeLaunch = null;

function nodeBin() {
  // Use the system node for the hub/runtime so node:sqlite (Node ≥22) is available.
  return process.env.HARNESS_NODE || 'node';
}

function spawnService(label, script, args, env) {
  const child = spawn(nodeBin(), [script, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on('data', (d) => { const s = d.toString(); if (!/ExperimentalWarning|trace-warnings/.test(s)) process.stderr.write(`[${label}] ${s}`); });
  children.push(child);
  return child;
}

function launchRuntime() {
  if (!runtimeLaunch) return null;
  runtimeChild = spawnService('runtime', runtimeLaunch.script, runtimeLaunch.args, runtimeLaunch.env);
  return runtimeChild;
}

function stopService(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let forceTimer;
    const done = () => { clearTimeout(forceTimer); resolve(); };
    child.once('exit', done);
    child.kill();
    forceTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2000);
  });
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

async function waitForHub(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url + '/api/health'); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function boot() {
  const dataDir = path.join(app.getPath('userData'), 'harness');
  fs.mkdirSync(dataDir, { recursive: true });
  let httpUrl = process.env.HUB_HTTP_URL || null;
  const userName = process.env.HARNESS_USER || os.userInfo().username;
  if (!httpUrl) {
    const port = parseInt(process.env.HUB_PORT || '7777', 10);
    spawnService('hub', path.join(ROOT, 'packages', 'hub', 'server.js'), [String(port)], { HUB_DB: path.join(dataDir, 'hub.sqlite') });
    httpUrl = `http://127.0.0.1:${port}`;
    const ok = await waitForHub(httpUrl);
    if (!ok) throw new Error('hub did not start');
    // path.delimiter, not ':' - a Windows path starts with a drive letter and a colon.
    const projects = (process.env.HARNESS_PROJECTS || '').split(path.delimiter).filter(Boolean).flatMap((p) => ['--project', p]);
    runtimeLaunch = {
      script: path.join(ROOT, 'packages', 'runtime', 'index.js'),
      args: ['--hub', httpUrl.replace('http', 'ws'), '--name', userName, '--data', dataDir, ...projects],
      env: { HARNESS_PAIRING_CODE: PAIRING_CODE },
      dataDir
    };
    launchRuntime();
  }
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 960, minHeight: 620, title: 'Plexus', backgroundColor: '#080a09', autoHideMenuBar: true,
    icon: path.join(ROOT, 'apps', 'web', 'brand', 'plexus-app-icon-256.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadURL(httpUrl + '/?name=' + encodeURIComponent(userName));
  win.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) shell.openExternal(url); return { action: 'deny' }; });
}

ipcMain.handle('desktop:pairingCode', async () => localPairingCode());
ipcMain.handle('desktop:runtimeId', async () => localRuntimeId());
ipcMain.handle('desktop:pickFolder', (_event, runtimeId) => pickAndAuthorizeProject(runtimeId));

app.whenReady().then(() => boot().catch((err) => { console.error(err); app.quit(); }));
app.on('window-all-closed', () => app.quit());
app.on('quit', () => { for (const c of children) { try { c.kill(); } catch {} } });
