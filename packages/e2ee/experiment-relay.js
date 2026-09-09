'use strict';
// Real HTTP + sqlite boundary for the issue #3 experiment. No production hub route
// is modified. Account authentication routes bytes; fingerprint confirmation at the
// endpoints separately decides who those bytes may be trusted to come from.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { KeyDirectory, KeyTransport } = require('./key-transport');

const ROOT = path.resolve(__dirname, '../..');
const assets = {
  '/': ['packages/e2ee/proof-client.html', 'text/html'],
  '/proof-client.mjs': ['packages/e2ee/proof-client.mjs', 'text/javascript'],
  '/endpoint-core.mjs': ['packages/e2ee/endpoint-core.mjs', 'text/javascript'],
  '/owner-recovery-kit.mjs': ['packages/e2ee/owner-recovery-kit.mjs', 'text/javascript'],
  '/owner-recovery.mjs': ['packages/e2ee/owner-recovery.mjs', 'text/javascript'],
  '/membership.mjs': ['packages/e2ee/membership.mjs', 'text/javascript'],
  '/protocol/encrypted-task.mjs': ['packages/protocol/encrypted-task.mjs', 'text/javascript'],
  '/http-transport.mjs': ['packages/e2ee/http-transport.mjs', 'text/javascript'],
  '/vendor/index.mjs': ['node_modules/@matrix-org/matrix-sdk-crypto-wasm/index.mjs', 'text/javascript'],
  '/vendor/pkg/matrix_sdk_crypto_wasm_bg.js': ['node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.js', 'text/javascript'],
  '/vendor/pkg/matrix_sdk_crypto_wasm_bg.wasm': ['node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm', 'application/wasm']
};

function sealed(event) {
  if (!event || event.type !== 'm.room.encrypted' || typeof event.sender !== 'string') return false;
  if (Object.keys(event).some((key) => !['type', 'sender', 'content', 'room_id', 'event_id', 'origin_server_ts'].includes(key))) return false;
  const content = event.content;
  if (!content || Object.keys(content).some((key) => !['algorithm', 'sender_key', 'ciphertext', 'session_id', 'device_id', 'org.matrix.msgid'].includes(key))) return false;
  return ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'].includes(content.algorithm) && !!content.ciphertext;
}

class ExperimentRelay {
  constructor(file) {
    this.directory = new KeyDirectory(); this.transport = new KeyTransport(this.directory);
    this.accounts = new Map(); this.logs = [];
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, room TEXT, envelope TEXT);
      CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY, owner TEXT, ciphertext TEXT);`);
    this.server = http.createServer((req, res) => this.handle(req, res));
  }
  enroll(user, device) {
    const token = randomBytes(24).toString('base64url');
    this.accounts.set(token, { user, device });
    return { url: this.url, token };
  }
  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = 'http://127.0.0.1:' + this.server.address().port;
    return this.url;
  }
  async handle(req, res) {
    const route = new URL(req.url, 'http://localhost').pathname;
    // The proof runs from a bundled desktop origin as well as the browser origin.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && assets[route]) {
      res.setHeader('Content-Type', assets[route][1]);
      return res.end(fs.readFileSync(path.join(ROOT, assets[route][0])));
    }
    let status = 200, size = 0;
    try {
      const account = this.accounts.get((req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!account) throw 401;
      const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 2 ** 20) throw 413; chunks.push(chunk); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let result;
      if (route === '/e2ee/keys') {
        if (value.user !== account.user || value.device !== account.device) throw 403;
        if (!['KeysUpload', 'KeysQuery', 'KeysClaim', 'SigningKeysUpload', 'SignatureUpload'].includes(value.type)) throw 400;
        result = JSON.parse(await this.transport.send(value.type, { ...value, ...account }));
      } else if (route === '/e2ee/deliver') {
        if (!sealed(value.envelope) || value.envelope.sender !== account.user) throw 400;
        result = this.directory.deliver(value.user, value.device, value.envelope);
      } else if (route === '/e2ee/drain') {
        result = this.directory.drain(account.user, account.device);
      } else if (route === '/e2ee/task') {
        if (!sealed(value.event) || value.event.sender !== account.user || typeof value.room !== 'string') throw 400;
        this.db.prepare('INSERT INTO events(room,envelope) VALUES (?,?)').run(value.room, JSON.stringify(value.event));
        result = { stored: true };
      } else if (route === '/e2ee/history') {
        result = this.db.prepare('SELECT envelope FROM events WHERE room=? ORDER BY seq').all(value.room).map((r) => JSON.parse(r.envelope));
      } else if (route === '/e2ee/backup') {
        if (typeof value.id !== 'string' || typeof value.ciphertext !== 'string' ||
            !value.ciphertext.startsWith('-----BEGIN MEGOLM SESSION DATA-----')) throw 400;
        const held = this.db.prepare('SELECT owner FROM backups WHERE id=?').get(value.id);
        if (held && held.owner !== account.user) throw 403;
        this.db.prepare('INSERT INTO backups VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext').run(value.id, account.user, value.ciphertext);
        result = { stored: true };
      } else if (route === '/e2ee/restore') {
        const backup = this.db.prepare('SELECT owner,ciphertext FROM backups WHERE id=?').get(value.id);
        if (!backup || backup.owner !== account.user) throw 403;
        result = { ciphertext: backup.ciphertext };
      } else throw 404;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
    } catch (error) {
      status = Number.isInteger(error) ? error : 400;
      res.writeHead(status); res.end(JSON.stringify({ error: 'request_refused' }));
    } finally { this.logs.push({ route, status, bytes: size }); }
  }
  evidence() {
    return JSON.stringify({ directory: this.directory.everythingTheRelayHolds(), logs: this.logs,
      events: this.db.prepare('SELECT * FROM events').all(), backups: this.db.prepare('SELECT * FROM backups').all() });
  }
  async close() { await new Promise((resolve) => this.server.close(resolve)); this.db.close(); }
}
module.exports = { ExperimentRelay, assets, ROOT };
