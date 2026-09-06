'use strict';
// Desktop shell: spawns a local hub + runtime (unless HUB_URL points at a remote hub),
// loads the shared web UI, and adds native integrations (folder picker).
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const userDataArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (userDataArg) app.setPath('userData', userDataArg.split('=').slice(1).join('='));

let win = null;
const children = [];

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
    spawnService('runtime', path.join(ROOT, 'packages', 'runtime', 'index.js'), ['--hub', httpUrl.replace('http', 'ws'), '--name', userName, '--data', dataDir, ...projects], {});
  }
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 960, minHeight: 620, title: 'Plexus', backgroundColor: '#080a09', autoHideMenuBar: true,
    icon: path.join(ROOT, 'apps', 'web', 'brand', 'plexus-app-icon-256.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadURL(httpUrl + '/?name=' + encodeURIComponent(userName));
  win.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) shell.openExternal(url); return { action: 'deny' }; });
}

ipcMain.handle('desktop:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Register project folder', properties: ['openDirectory', 'createDirectory'] });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

app.whenReady().then(() => boot().catch((err) => { console.error(err); app.quit(); }));
app.on('window-all-closed', () => app.quit());
app.on('quit', () => { for (const c of children) { try { c.kill(); } catch {} } });
