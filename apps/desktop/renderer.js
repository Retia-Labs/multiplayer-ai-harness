'use strict';
// The renderer that can receive an OS-unsealed key must come from this installation.
// Only API bytes are relayed; the service cannot substitute executable app assets.
const fs = require('node:fs');
const path = require('node:path');
const { session } = require('electron');
const { protectedStoreKey } = require('../../packages/e2ee/protected-store-key');

require('../../packages/e2ee/desktop-schemes');

const ORIGIN = 'plexus-app://app';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

function installRenderer({ root, hubUrl, partition }) {
  if (!partition) throw new Error('desktop_profile_required');
  session.fromPartition(partition).protocol.handle('plexus-app', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
    if (url.pathname.startsWith('/api/')) {
      try {
        const headers = new Headers(request.headers);
        for (const name of ['host', 'origin', 'cookie', 'referer']) headers.delete(name);
        const response = await fetch(hubUrl() + url.pathname + url.search, {
          method: request.method, headers, redirect: 'error',
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
          signal: AbortSignal.timeout(15000)
        });
        return new Response(response.body, { status: response.status, headers: {
          'Content-Type': 'application/json', 'Cache-Control': 'no-store'
        } });
      } catch { return Response.json({ error: 'relay_unavailable' }, { status: 503 }); }
    }
    if (request.method !== 'GET') return new Response('Not found', { status: 404 });
    let base = path.join(root, 'apps/web');
    let relative = url.pathname.slice(1);
    if (!relative || /^t\/[A-Za-z0-9_-]+$/.test(relative)) relative = 'index.html';
    if (relative.startsWith('vendor/')) {
      base = path.join(root, 'node_modules/@matrix-org/matrix-sdk-crypto-wasm');
      relative = relative.slice(7);
    } else if (relative.startsWith('shared/')) {
      base = path.join(root, 'packages');
      relative = relative.slice(7);
      if (!/^(e2ee|protocol)\/[A-Za-z0-9_-]+\.mjs$/.test(relative)) return new Response('Not found', { status: 404 });
    }
    const file = path.resolve(base, relative);
    if (!file.startsWith(base + path.sep) || !MIME[path.extname(file)]) return new Response('Not found', { status: 404 });
    try {
      return new Response(fs.readFileSync(file), { headers: {
        'Content-Type': MIME[path.extname(file)],
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-src 'none'"
      } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}

function requireRenderer(event, win) {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame ||
      !event.senderFrame.url.startsWith(ORIGIN + '/')) throw new Error('untrusted_desktop_request');
}

function endpointStoreKey(dataDir) {
  return protectedStoreKey(dataDir, 'browser-endpoint');
}

module.exports = { ORIGIN, installRenderer, requireRenderer, endpointStoreKey };
