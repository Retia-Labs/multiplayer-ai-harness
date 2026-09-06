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
      -- A team is the private boundary. Its id is what the older tables call org_id, so
      -- threads/runtimes/users keep their columns and gain a real membership check above.
      CREATE TABLE IF NOT EXISTS teams       (id TEXT PRIMARY KEY, name TEXT, owner_id TEXT, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS memberships (team_id TEXT, user_id TEXT, role TEXT, enrollment TEXT, created_at INTEGER, PRIMARY KEY (team_id, user_id));
      CREATE TABLE IF NOT EXISTS invitations (code TEXT PRIMARY KEY, team_id TEXT, role TEXT, created_by TEXT, created_at INTEGER, expires_at INTEGER, accepted_by TEXT, accepted_at INTEGER, revoked_at INTEGER);
      -- Which team a paired execution host belongs to, and who consented to the pairing.
      CREATE TABLE IF NOT EXISTS pairings    (runtime_id TEXT PRIMARY KEY, team_id TEXT, paired_by TEXT, paired_at INTEGER);
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
      eventsFrom: this.db.prepare('SELECT seq, ts, json FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'),
      insertTeam: this.db.prepare('INSERT INTO teams (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)'),
      getTeam: this.db.prepare('SELECT * FROM teams WHERE id = ?'),
      upsertMember: this.db.prepare('INSERT INTO memberships (team_id, user_id, role, enrollment, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role'),
      getMember: this.db.prepare('SELECT * FROM memberships WHERE team_id = ? AND user_id = ?'),
      listMembers: this.db.prepare('SELECT m.team_id, m.user_id, m.role, m.enrollment, u.name, u.color FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.team_id = ?'),
      listTeamsFor: this.db.prepare('SELECT t.* , m.role, m.enrollment FROM memberships m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?'),
      deleteMember: this.db.prepare('DELETE FROM memberships WHERE team_id = ? AND user_id = ?'),
      insertInvite: this.db.prepare('INSERT INTO invitations (code, team_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
      getInvite: this.db.prepare('SELECT * FROM invitations WHERE code = ?'),
      acceptInvite: this.db.prepare('UPDATE invitations SET accepted_by = ?, accepted_at = ? WHERE code = ?'),
      revokeInvite: this.db.prepare('UPDATE invitations SET revoked_at = ? WHERE code = ?'),
      insertPairing: this.db.prepare('INSERT INTO pairings (runtime_id, team_id, paired_by, paired_at) VALUES (?, ?, ?, ?) ON CONFLICT(runtime_id) DO UPDATE SET team_id = excluded.team_id, paired_by = excluded.paired_by, paired_at = excluded.paired_at'),
      getPairing: this.db.prepare('SELECT * FROM pairings WHERE runtime_id = ?'),
      deletePairing: this.db.prepare('DELETE FROM pairings WHERE runtime_id = ?')
    };
  }

  // An identity, and nothing else. Deliberately never looks up an existing row by name:
  // that lookup was the authorization bypass, because it let anyone become a teammate by
  // typing their name.
  createAccount(name, color) {
    const user = {
      id: uid('u'), org_id: '', name: name || 'someone', color: color || pickColor(name || ''),
      token: 'tok_' + crypto.randomBytes(24).toString('hex'), created_at: Date.now()
    };
    this._stmts.insertUser.run(user.id, user.org_id, user.name, user.color, user.token, user.created_at);
    return user;
  }

  // ---- teams & membership ----
  // An account is an identity, nothing more. Membership of a team is granted by an
  // invitation the team's owner issued, never by what the caller claims about itself.
  createTeam(name, ownerId) {
    const team = { id: uid('team'), name: name || 'Team', owner_id: ownerId, created_at: Date.now() };
    this._stmts.insertTeam.run(team.id, team.name, team.owner_id, team.created_at);
    this._stmts.upsertMember.run(team.id, ownerId, 'owner', 'pending', Date.now());
    return { id: team.id, name: team.name, ownerId, createdAt: team.created_at };
  }

  getTeam(id) {
    const r = this._stmts.getTeam.get(id);
    return r ? { id: r.id, name: r.name, ownerId: r.owner_id, createdAt: r.created_at } : null;
  }

  membership(teamId, userId) {
    const r = this._stmts.getMember.get(teamId, userId);
    return r ? { teamId: r.team_id, userId: r.user_id, role: r.role, enrollment: r.enrollment } : null;
  }

  listMembers(teamId) {
    return this._stmts.listMembers.all(teamId).map((r) => ({ userId: r.user_id, name: r.name, color: r.color, role: r.role, enrollment: r.enrollment }));
  }

  teamsFor(userId) {
    return this._stmts.listTeamsFor.all(userId).map((r) => ({ id: r.id, name: r.name, ownerId: r.owner_id, role: r.role, enrollment: r.enrollment }));
  }

  removeMember(teamId, userId) {
    this._stmts.deleteMember.run(teamId, userId);
    return { ok: true };
  }

  // ---- invitations ----
  createInvitation(teamId, createdBy, role = 'member', ttlMs = 7 * 24 * 3600 * 1000) {
    const code = 'inv_' + crypto.randomBytes(12).toString('base64url');
    const now = Date.now();
    this._stmts.insertInvite.run(code, teamId, role, createdBy, now, now + ttlMs);
    return { code, teamId, role, createdAt: now, expiresAt: now + ttlMs };
  }

  // Returns { ok: true, invite } or { ok: false, reason } - the reason is the caller's
  // error code, because "expired" and "already used" are different security facts.
  redeemInvitation(code, userId, now = Date.now()) {
    const r = this._stmts.getInvite.get(code);
    if (!r) return { ok: false, reason: 'invitation_invalid' };
    if (r.revoked_at) return { ok: false, reason: 'invitation_revoked' };
    if (r.accepted_at) return { ok: false, reason: 'invitation_already_accepted' };
    if (now > r.expires_at) return { ok: false, reason: 'invitation_expired' };
    this._stmts.acceptInvite.run(userId, now, code);
    this._stmts.upsertMember.run(r.team_id, userId, r.role, 'pending', now);
    return { ok: true, invite: { code, teamId: r.team_id, role: r.role } };
  }

  getInvitation(code) { return this._stmts.getInvite.get(code) || null; }
  revokeInvitation(code) { this._stmts.revokeInvite.run(Date.now(), code); return { ok: true }; }

  // ---- runtime pairing ----
  pairRuntime(runtimeId, teamId, byUserId) {
    this._stmts.insertPairing.run(runtimeId, teamId, byUserId, Date.now());
    return { runtimeId, teamId, pairedBy: byUserId };
  }
  runtimePairing(runtimeId) {
    const r = this._stmts.getPairing.get(runtimeId);
    return r ? { runtimeId: r.runtime_id, teamId: r.team_id, pairedBy: r.paired_by, pairedAt: r.paired_at } : null;
  }
  unpairRuntime(runtimeId) { this._stmts.deletePairing.run(runtimeId); return { ok: true }; }

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
