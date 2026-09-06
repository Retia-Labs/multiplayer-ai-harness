'use strict';
// Packaged experiment entry point. It serves only bundled code and never loads a
// relay-supplied script into the renderer which receives the OS-unsealed store key.
const { app, BrowserWindow, ipcMain, protocol, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { assets, ROOT } = require('./experiment-relay');
const dataArg = process.argv.find((arg) => arg.startsWith('--user-data-dir='));
if (dataArg) app.setPath('userData', dataArg.slice('--user-data-dir='.length));
protocol.registerSchemesAsPrivileged([{ scheme: 'plexus-proof', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true
} }]);
let win;
ipcMain.handle('proof:store-key', (event) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url !== 'plexus-proof://endpoint/') throw new Error('untrusted_store_key_request');
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('os_key_protection_unavailable');
  }
  const keyFile = path.join(app.getPath('userData'), 'crypto-store-key');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  let secret;
  if (fs.existsSync(keyFile)) secret = safeStorage.decryptString(fs.readFileSync(keyFile));
  else {
    secret = randomBytes(32).toString('base64');
    fs.writeFileSync(keyFile, safeStorage.encryptString(secret), { mode: 0o600, flag: 'wx' });
  }
  const key = Buffer.from(secret, 'base64');
  if (key.length !== 32) throw new Error('invalid_store_key');
  return [...key];
});
app.whenReady().then(async () => {
  protocol.handle('plexus-proof', (request) => {
    const url = new URL(request.url);
    const asset = url.hostname === 'endpoint' && assets[url.pathname];
    if (!asset) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(path.join(ROOT, asset[0])), { headers: { 'Content-Type': asset[1] } });
  });
  win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, 'desktop-proof-preload.js'), contextIsolation: true,
    nodeIntegration: false, sandbox: true
  } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  await win.loadURL('plexus-proof://endpoint/');
});
app.on('window-all-closed', () => app.quit());
