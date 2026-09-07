'use strict';
// Key exchange on the real hub.
//
// #3 built this as an in-process directory and a standalone experiment relay, and #6 said
// plainly that wiring it to the real hub was the next step rather than that one. This is
// that step. Nothing about the cryptography changes: the relay still only ever handles
// public device keys, one-time keys and sealed envelopes it cannot open, which is the whole
// claim the directory was written to demonstrate.
//
// What is new is authorization. The spike had one token per endpoint and no notion of who
// might legitimately ask about whom; a hub carrying real teams cannot hand every device key
// to every caller. So a query answers only for accounts and paired execution hosts inside a
// team the caller belongs to, and an envelope may only be delivered to an endpoint the
// caller shares a team with. Membership is the boundary, exactly as it is everywhere else
// in this hub - it is not decryption authority, and it never becomes any.
const { matrixUser } = require('../protocol/encrypted-task.mjs');

const problem = (code, status = 400) => Object.assign(new Error(code), { code, status });
const DEVICE = /^[A-Za-z0-9_.-]{1,64}$/;
// '@id:plexus.local' back to 'id'. Anything else is not one of ours.
const localId = (user) => {
  const match = /^@([A-Za-z0-9_-]{1,64}):plexus\.local$/.exec(String(user || ''));
  return match ? match[1] : null;
};

class KeyExchange {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS e2ee_devices(
        user_id TEXT NOT NULL, device_id TEXT NOT NULL, keys TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, device_id));
      CREATE TABLE IF NOT EXISTS e2ee_one_time_keys(
        user_id TEXT NOT NULL, device_id TEXT NOT NULL, key_id TEXT NOT NULL, key TEXT NOT NULL,
        PRIMARY KEY(user_id, device_id, key_id));
      CREATE TABLE IF NOT EXISTS e2ee_mailbox(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
        envelope TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS e2ee_mailbox_box ON e2ee_mailbox(user_id, device_id, seq);
      CREATE TABLE IF NOT EXISTS e2ee_recovery(
        user_id TEXT NOT NULL, scope TEXT NOT NULL, ciphertext TEXT NOT NULL,
        version TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, scope));
    `);
  }

  // ---- who is asking ----

  // Both an account and a paired execution host hold endpoints, and both must be able to
  // publish and fetch keys. They authenticate the way they already do everywhere else.
  principal(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const runtimeId = req.headers['x-plexus-runtime'];
    if (runtimeId) {
      const pairing = this.store.runtimePairing(runtimeId);
      if (!pairing || !this.store.runtimeCredentialMatches(runtimeId, token)) throw problem('runtime_authentication_failed', 401);
      return { kind: 'runtime', id: runtimeId, user: matrixUser(runtimeId), teams: [pairing.teamId] };
    }
    const account = this.store.userByToken(token);
    if (!account) throw problem('unauthenticated', 401);
    return { kind: 'account', id: account.id, user: matrixUser(account.id), teams: this.store.teamsFor(account.id).map((team) => team.id) };
  }

  // An endpoint the caller may legitimately learn about: themselves, a teammate's account,
  // or an execution host paired to a team they are in.
  visible(principal, user) {
    if (user === principal.user) return true;
    const id = localId(user);
    if (!id) return false;
    if (principal.teams.some((teamId) => this.store.membership(teamId, id))) return true;
    const pairing = this.store.runtimePairing(id);
    return !!pairing && principal.teams.includes(pairing.teamId);
  }

  // ---- the directory ----

  upload(user, device, body, now = Date.now()) {
    const value = JSON.parse(body || '{}');
    if (value.device_keys) {
      this.db.prepare(`INSERT INTO e2ee_devices VALUES (?,?,?,?)
        ON CONFLICT(user_id, device_id) DO UPDATE SET keys=excluded.keys, updated_at=excluded.updated_at`)
        .run(user, device, JSON.stringify(value.device_keys), now);
    }
    const counts = {};
    for (const [keyId, key] of Object.entries(value.one_time_keys || {})) {
      this.db.prepare('INSERT INTO e2ee_one_time_keys VALUES (?,?,?,?) ON CONFLICT(user_id,device_id,key_id) DO NOTHING')
        .run(user, device, keyId, JSON.stringify(key));
      const alg = keyId.split(':')[0];
      counts[alg] = (counts[alg] || 0) + 1;
    }
    return JSON.stringify({ one_time_key_counts: counts });
  }

  query(principal, body) {
    const asked = Object.keys(JSON.parse(body || '{}').device_keys || {});
    const device_keys = {};
    const failures = {};
    for (const user of asked.length ? asked : [principal.user]) {
      if (!this.visible(principal, user)) { failures[user] = { errcode: 'M_FORBIDDEN' }; continue; }
      device_keys[user] = {};
      for (const row of this.db.prepare('SELECT device_id, keys FROM e2ee_devices WHERE user_id=?').all(user)) {
        device_keys[user][row.device_id] = JSON.parse(row.keys);
      }
    }
    return JSON.stringify({ device_keys, failures });
  }

  // One-time keys are consumed, not read: handing the same one out twice would let two
  // sessions share it. The delete is the point of the transaction.
  claim(principal, body) {
    const want = JSON.parse(body || '{}').one_time_keys || {};
    const one_time_keys = {};
    const failures = {};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [user, devices] of Object.entries(want)) {
        if (!this.visible(principal, user)) { failures[user] = { errcode: 'M_FORBIDDEN' }; continue; }
        one_time_keys[user] = {};
        for (const device of Object.keys(devices)) {
          const row = this.db.prepare('SELECT key_id, key FROM e2ee_one_time_keys WHERE user_id=? AND device_id=? LIMIT 1').get(user, device);
          if (!row) continue;
          this.db.prepare('DELETE FROM e2ee_one_time_keys WHERE user_id=? AND device_id=? AND key_id=?').run(user, device, row.key_id);
          one_time_keys[user][device] = { [row.key_id]: JSON.parse(row.key) };
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return JSON.stringify({ one_time_keys, failures });
  }

  deliver(principal, user, device, envelope, now = Date.now()) {
    if (!DEVICE.test(String(device || ''))) throw problem('invalid_endpoint');
    if (!this.visible(principal, user)) throw problem('endpoint_not_visible', 403);
    this.db.prepare('INSERT INTO e2ee_mailbox(user_id, device_id, envelope, created_at) VALUES (?,?,?,?)')
      .run(user, device, JSON.stringify(envelope), now);
    return { delivered: true };
  }

  // Draining is destructive, so it is the one call an endpoint may only make for itself.
  drain(principal, device) {
    const rows = this.db.prepare('SELECT seq, envelope FROM e2ee_mailbox WHERE user_id=? AND device_id=? ORDER BY seq').all(principal.user, device);
    if (rows.length) {
      this.db.prepare('DELETE FROM e2ee_mailbox WHERE user_id=? AND device_id=? AND seq<=?')
        .run(principal.user, device, rows[rows.length - 1].seq);
    }
    return rows.map((row) => JSON.parse(row.envelope));
  }

  // ---- customer-held recovery ----
  //
  // The relay stores a blob it cannot open and does not know the shape of. That is the whole
  // arrangement: an operator who wanted to read a customer's history from here would need the
  // recovery key, and the recovery key is the one thing that never arrives.
  //
  // A recovery blob is readable only by the account that stored it - not by a teammate, not by
  // a team owner. History is shared through #8's grants and handoffs, which are somebody
  // deciding; a backup is somebody's own copy, and widening that would turn "the operator
  // cannot read your history" into "anybody on your team can restore it".
  putRecovery(principal, scope, ciphertext, version, now = Date.now()) {
    if (!/^[A-Za-z0-9_:.-]{1,120}$/.test(String(scope || ''))) throw problem('invalid_recovery_scope');
    if (typeof ciphertext !== 'string' || !ciphertext.length) throw problem('invalid_recovery_material');
    if (ciphertext.length > 4 * 1024 * 1024) throw problem('record_too_large', 413);
    this.db.prepare(`INSERT INTO e2ee_recovery VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, scope) DO UPDATE SET ciphertext=excluded.ciphertext, version=excluded.version, updated_at=excluded.updated_at`)
      .run(principal.id, scope, ciphertext, String(version || '1'), now);
    return { stored: true, scope, bytes: ciphertext.length };
  }

  getRecovery(principal, scope) {
    const row = this.db.prepare('SELECT ciphertext, version, updated_at FROM e2ee_recovery WHERE user_id=? AND scope=?')
      .get(principal.id, String(scope || ''));
    if (!row) throw problem('no_recovery_material', 404);
    return { ciphertext: row.ciphertext, version: row.version, updatedAt: row.updated_at };
  }

  listRecovery(principal) {
    return this.db.prepare('SELECT scope, version, updated_at, LENGTH(ciphertext) AS bytes FROM e2ee_recovery WHERE user_id=?')
      .all(principal.id)
      .map((row) => ({ scope: row.scope, version: row.version, updatedAt: row.updated_at, bytes: row.bytes }));
  }

  // ---- HTTP ----

  async handle(req, res, url) {
    const reply = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      const principal = this.principal(req);
      if (req.method !== 'POST') throw problem('method_not_allowed', 405);
      let size = 0;
      const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw problem('record_too_large', 413); chunks.push(chunk); }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw problem('invalid_key_request'); }

      const route = url.pathname.split('/').filter(Boolean).slice(2)[0];
      if (route === 'keys') {
        // The caller may only ever publish as itself. Everything else here is public
        // material, but a device claiming another endpoint's name is not.
        if (value.user !== principal.user || !DEVICE.test(String(value.device || ''))) throw problem('endpoint_mismatch', 403);
        if (value.type === 'KeysUpload') return reply(200, JSON.parse(this.upload(principal.user, value.device, value.body)));
        if (value.type === 'KeysQuery') return reply(200, JSON.parse(this.query(principal, value.body)));
        if (value.type === 'KeysClaim') return reply(200, JSON.parse(this.claim(principal, value.body)));
        // Cross-signing is not established by this adapter; #8's enrolment is device
        // fingerprint confirmation. Accepting these silently keeps the SDK's request loop
        // moving without pretending the hub stores an identity it does not.
        if (['SigningKeysUpload', 'SignatureUpload', 'ToDevice', 'RoomMessage', 'KeysBackup'].includes(value.type)) return reply(200, {});
        throw problem('unsupported_key_request');
      }
      if (route === 'recovery') {
        // An execution host has no customer recovery material and never will: what it holds
        // is a log it wrote, not a person's history to restore.
        if (principal.kind !== 'account') throw problem('client_required', 403);
        if (value.op === 'put') return reply(200, this.putRecovery(principal, value.scope, value.ciphertext, value.version));
        if (value.op === 'get') return reply(200, this.getRecovery(principal, value.scope));
        if (value.op === 'list') return reply(200, { backups: this.listRecovery(principal) });
        throw problem('unsupported_recovery_request');
      }
      if (route === 'deliver') return reply(200, this.deliver(principal, String(value.user || ''), String(value.device || ''), value.envelope));
      if (route === 'drain') {
        if (!DEVICE.test(String(value.device || ''))) throw problem('invalid_endpoint');
        return reply(200, this.drain(principal, value.device));
      }
      throw problem('key_route_required', 404);
    } catch (error) {
      // Same discipline as the task routes: fixed codes, never a reflected request.
      reply(error.status || 400, { error: error.code || 'key_request_refused' });
    }
  }
}

module.exports = { KeyExchange };
