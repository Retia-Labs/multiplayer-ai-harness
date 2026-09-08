'use strict';
// The private host crypto origin serves bundled files only. Relay code never receives keys.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { protectedStoreKey } = require('./protected-store-key');
const { HubKeyTransport } = require('./hub-key-transport.mjs');
const ROOT = path.resolve(__dirname, '../..');
const ORIGIN = 'plexus-host-crypto://endpoint';
const windows = new Map();
let registered = false;
// This module must be loaded by main before app.whenReady().
require('./desktop-schemes');
const assets = {
  '/': ['packages/e2ee/host-crypto.html', 'text/html'],
  '/host-crypto.mjs': ['packages/e2ee/host-crypto.mjs', 'text/javascript'],
  '/endpoint-core.mjs': ['packages/e2ee/endpoint-core.mjs', 'text/javascript'],
  '/vendor/index.mjs': ['node_modules/@matrix-org/matrix-sdk-crypto-wasm/index.mjs', 'text/javascript'],
  '/vendor/pkg/matrix_sdk_crypto_wasm_bg.js': ['node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.js', 'text/javascript'],
  '/vendor/pkg/matrix_sdk_crypto_wasm_bg.wasm': ['node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm', 'application/wasm']
};
function trusted(event) {
  const context = windows.get(event.sender.id);
  if (!context || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== ORIGIN + '/') {
    throw new Error('untrusted_crypto_request');
  }
  return context;
}
async function register() {
  if (registered) return;
  registered = true;
  await app.whenReady();

  ipcMain.handle('plexus-crypto:store-key', (event) => protectedStoreKey(trusted(event).dataDir, 'execution-host'));
  ipcMain.handle('plexus-crypto:transport', async (event, method, args) => {
    const context = trusted(event);
    if (!context.transport || !['send', 'deliverToDevice', 'drain'].includes(method)) throw new Error('unknown_transport_operation');
    return context.transport[method](...args);
  });
}
function attachCryptoBroker(child, { dataDir, diagnostics = () => {} }) {
  let context = null;
  let queue = Promise.resolve();
  let closed = false;
  async function handle(message) {
    diagnostics('start ' + message.operation);
    if (message.operation === 'create') {
      if (context) throw new Error('crypto_endpoint_already_open');
      const options = message.args?.[0];
      if (!options?.transport?.url || !options.user || !/^[A-Za-z0-9_-]{1,64}$/.test(options.device || '')) throw new Error('invalid_crypto_endpoint');
      await register();
      const partition = 'persist:plexus-host-' + createHash('sha256').update(dataDir + '/' + options.user).digest('hex').slice(0, 24);
      const hostSession = session.fromPartition(partition);
      if (!await hostSession.protocol.isProtocolHandled('plexus-host-crypto')) {
        hostSession.protocol.handle('plexus-host-crypto', (request) => {
          const url = new URL(request.url);
          const asset = url.protocol === 'plexus-host-crypto:' && url.hostname === 'endpoint' && assets[url.pathname];
          if (!asset) return new Response('not found', { status: 404 });
          return new Response(fs.readFileSync(path.join(ROOT, asset[0])), { headers: { 'Content-Type': asset[1] } });
        });
      }
      const win = new BrowserWindow({ show: false, webPreferences: {
        preload: path.join(__dirname, 'host-crypto-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, partition
      } });
      win.webContents.on('console-message', (_event, details) => diagnostics(details?.message || 'crypto renderer console event'));
      context = { win, dataDir, transport: new HubKeyTransport(options.transport) };
      windows.set(win.webContents.id, context);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event) => event.preventDefault());
      await win.loadURL(ORIGIN + '/');
      await win.webContents.executeJavaScript('new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(new Error("crypto_renderer_not_ready")),5000); const check = () => globalThis.plexusHostCrypto ? (clearTimeout(timer),resolve()) : setTimeout(check, 10); check(); })');
    }
    if (!context) throw new Error('crypto_endpoint_closed');
    const result = await context.win.webContents.executeJavaScript(
      'globalThis.plexusHostCrypto(' + JSON.stringify(message.operation) + ',' + JSON.stringify(message.args || []) + ')');
    if (message.operation === 'close') {
      windows.delete(context.win.webContents.id); context.win.destroy(); context = null;
    }
    diagnostics('finished ' + message.operation);
    return result;
  }
  const listener = (message) => {
    if (closed || message?.type !== 'crypto.request') return;
    const work = queue.then(() => handle(message));
    queue = work.catch(() => {});
    const reply = (payload) => { if (!closed && child.connected !== false) { try { child.send(payload, () => {}); } catch {} } };
    work.then((result) => reply({ type: 'crypto.response', id: message.id, result }))
      .catch((error) => reply({ type: 'crypto.response', id: message.id, error: error.message || 'crypto_broker_failed' }));
  };
  child.on('message', listener);
  const close = () => {
    closed = true; child.off('message', listener);
    if (context) { windows.delete(context.win.webContents.id); context.win.destroy(); context = null; }
  };
  child.once('exit', close);
  return { close };
}
module.exports = { attachCryptoBroker, protectedStoreKey };
