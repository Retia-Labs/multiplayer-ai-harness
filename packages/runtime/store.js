'use strict';
// Runtime-local persistence: thread metadata + a local mirror of each thread's
// event log (so a runtime can replay/resume even if the hub is unreachable).
const { DatabaseSync } = require('node:sqlite');

class RuntimeStore {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv      (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, json TEXT, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS items   (thread_id TEXT, ord INTEGER, json TEXT, PRIMARY KEY (thread_id, ord));
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, reply_json TEXT, updated_at INTEGER);
    `);
    this.s = {
      getKv: this.db.prepare('SELECT v FROM kv WHERE k = ?'),
      setKv: this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
      upsertThread: this.db.prepare('INSERT INTO threads (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at'),
      getThread: this.db.prepare('SELECT json FROM threads WHERE id = ?'),
      listThreads: this.db.prepare('SELECT json FROM threads ORDER BY updated_at DESC'),
      deleteThread: this.db.prepare('DELETE FROM threads WHERE id = ?'),
      deleteItems: this.db.prepare('DELETE FROM items WHERE thread_id = ?'),
      nextOrd: this.db.prepare('SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM items WHERE thread_id = ?'),
      insertItem: this.db.prepare('INSERT INTO items (thread_id, ord, json) VALUES (?, ?, ?)'),
      listItems: this.db.prepare('SELECT json FROM items WHERE thread_id = ? ORDER BY ord ASC'),
      getCommand: this.db.prepare('SELECT fingerprint, state, reply_json FROM commands WHERE id = ?'),
      claimCommand: this.db.prepare("INSERT OR IGNORE INTO commands (id, fingerprint, state, updated_at) VALUES (?, ?, 'pending', ?)"),
      completeCommand: this.db.prepare("UPDATE commands SET state = 'completed', reply_json = ?, updated_at = ? WHERE id = ? AND fingerprint = ?")
    };
  }
  getKv(k, fallback = null) { const r = this.s.getKv.get(k); return r ? JSON.parse(r.v) : fallback; }
  setKv(k, v) { this.s.setKv.run(k, JSON.stringify(v)); }
  upsertThread(t) { this.s.upsertThread.run(t.id, JSON.stringify(t), Date.now()); return t; }
  getThread(id) { const r = this.s.getThread.get(id); return r ? JSON.parse(r.json) : null; }
  listThreads() { return this.s.listThreads.all().map((r) => JSON.parse(r.json)); }
  deleteThread(id) { this.s.deleteItems.run(id); this.s.deleteThread.run(id); }
  appendItem(threadId, item) { this.s.insertItem.run(threadId, this.s.nextOrd.get(threadId).n, JSON.stringify(item)); }
  listItems(threadId) { return this.s.listItems.all(threadId).map((r) => JSON.parse(r.json)); }
  getCommand(id) {
    const r = this.s.getCommand.get(id);
    return r ? { fingerprint: r.fingerprint, state: r.state, reply: r.reply_json ? JSON.parse(r.reply_json) : null } : null;
  }
  claimCommand(id, fingerprint) { return this.s.claimCommand.run(id, fingerprint, Date.now()).changes === 1; }
  completeCommand(id, fingerprint, reply) { this.s.completeCommand.run(JSON.stringify(reply), Date.now(), id, fingerprint); }
  close() { this.db.close(); }
}

module.exports = { RuntimeStore };
