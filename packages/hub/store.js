'use strict';
// Hub persistence: append-only per-thread event logs + registries, on node:sqlite.
// Single-writer-per-thread means we never need merge semantics — just sequence numbers.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

class HubStore {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS orgs     (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS users    (id TEXT PRIMARY KEY, org_id TEXT, name TEXT, color TEXT, token TEXT UNIQUE, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS runtimes (id TEXT PRIMARY KEY, org_id TEXT, json TEXT, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS threads  (id TEXT PRIMARY KEY, org_id TEXT, runtime_id TEXT, json TEXT, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS events   (thread_id TEXT, seq INTEGER, ts INTEGER, json TEXT, PRIMARY KEY (thread_id, seq));
      CREATE INDEX IF NOT EXISTS threads_org ON threads(org_id, updated_at);
    `);
    this._stmts = {
      insertOrg: this.db.prepare('INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, ?, ?)'),
      getUserByToken: this.db.prepare('SELECT * FROM users WHERE token = ?'),
      getUserByName: this.db.prepare('SELECT * FROM users WHERE org_id = ? AND name = ?'),
      insertUser: this.db.prepare('INSERT INTO users (id, org_id, name, color, token, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
      listUsers: this.db.prepare('SELECT id, org_id, name, color FROM users WHERE org_id = ?'),
      upsertRuntime: this.db.prepare('INSERT INTO runtimes (id, org_id, json, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, last_seen = excluded.last_seen'),
      listRuntimes: this.db.prepare('SELECT * FROM runtimes WHERE org_id = ?'),
      upsertThread: this.db.prepare('INSERT INTO threads (id, org_id, runtime_id, json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, runtime_id = excluded.runtime_id, updated_at = excluded.updated_at'),
      getThread: this.db.prepare('SELECT * FROM threads WHERE id = ?'),
      listThreads: this.db.prepare('SELECT * FROM threads WHERE org_id = ? ORDER BY updated_at DESC LIMIT ?'),
      deleteThread: this.db.prepare('DELETE FROM threads WHERE id = ?'),
      deleteEvents: this.db.prepare('DELETE FROM events WHERE thread_id = ?'),
      lastSeq: this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE thread_id = ?'),
      insertEvent: this.db.prepare('INSERT INTO events (thread_id, seq, ts, json) VALUES (?, ?, ?, ?)'),
      eventsFrom: this.db.prepare('SELECT seq, ts, json FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
    };
  }

  // ---- orgs & users ----
  ensureOrg(id, name) {
    this._stmts.insertOrg.run(id, name || id, Date.now());
    return { id, name: name || id };
  }

  userByToken(token) {
    return this._stmts.getUserByToken.get(token) || null;
  }

  // Lightweight identity for the prototype: a name within an org mints a bearer token.
  loginOrCreate(orgId, name, color) {
    const existing = this._stmts.getUserByName.get(orgId, name);
    if (existing) return existing;
    const user = {
      id: uid('u'), org_id: orgId, name, color: color || pickColor(name),
      token: 'tok_' + crypto.randomBytes(16).toString('hex'), created_at: Date.now()
    };
    this._stmts.insertUser.run(user.id, user.org_id, user.name, user.color, user.token, user.created_at);
    return user;
  }

  listUsers(orgId) {
    return this._stmts.listUsers.all(orgId);
  }

  // ---- runtimes (fleet) ----
  upsertRuntime(orgId, runtime) {
    this._stmts.upsertRuntime.run(runtime.id, orgId, JSON.stringify(runtime), Date.now());
  }

  listRuntimes(orgId) {
    return this._stmts.listRuntimes.all(orgId).map((r) => ({ ...JSON.parse(r.json), lastSeen: r.last_seen }));
  }

  // ---- threads ----
  upsertThread(thread) {
    this._stmts.upsertThread.run(thread.id, thread.orgId, thread.runtimeId || null, JSON.stringify(thread), Date.now());
    return thread;
  }

  getThread(id) {
    const row = this._stmts.getThread.get(id);
    return row ? JSON.parse(row.json) : null;
  }

  listThreads(orgId, limit = 200) {
    return this._stmts.listThreads.all(orgId, limit).map((r) => JSON.parse(r.json));
  }

  deleteThread(id) {
    this._stmts.deleteEvents.run(id);
    this._stmts.deleteThread.run(id);
  }

  // ---- append-only event log ----
  lastSeq(threadId) {
    return this._stmts.lastSeq.get(threadId).seq;
  }

  append(threadId, event) {
    const seq = this.lastSeq(threadId) + 1;
    const ts = Date.now();
    this._stmts.insertEvent.run(threadId, seq, ts, JSON.stringify(event));
    return { seq, ts };
  }

  eventsFrom(threadId, afterSeq = 0, limit = 5000) {
    return this._stmts.eventsFrom.all(threadId, afterSeq, limit).map((r) => ({ seq: r.seq, ts: r.ts, ...JSON.parse(r.json) }));
  }

  close() {
    this.db.close();
  }
}

// Teammate colours have to tell people apart, so they carry hue - but restrained ones
// that sit on the dark ground, keep white initials legible, and stay clear of the lime
// accent, which belongs to actions alone.
const PALETTE = ['#4a7fb5', '#7e6bae', '#2f7f6e', '#a05f4a', '#8a6b2f', '#4f7a45', '#a05070', '#5c6b7a'];
function pickColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

module.exports = { HubStore, uid, pickColor };
