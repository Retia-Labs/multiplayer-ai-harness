'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { canonical, digest, TASK_ID, PROJECT_ID } = require('../protocol/encrypted-task.mjs');
const { verifySignature, operationBody, accountId } = require('../e2ee/membership.mjs');
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { code, status }); };
const BACKUP_DAYS = 7;
const RETENTION_NOTICE = 'Deletion removes task ciphertext and its live indexes immediately. Service snapshots expire within 7 days. A restore never restores membership, device trust or approval grants. Recovery archives containing deleted history are removed as whole archives; unindexed legacy archives held by affected participants are also removed. Prepare a new recovery archive for retained work. Offline hosts apply deletion when they reconnect. Participant-held plaintext, downloaded kits, keys and copies cannot be erased remotely.';

class Retention {
  constructor(store, { dbFile = ':memory:' } = {}) {
    this.store = store; this.db = store.db;
    this.backupDir = dbFile === ':memory:' ? null : path.resolve(dbFile + '.backups');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deletion_tombstones(team_id TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT NOT NULL,project_id TEXT NOT NULL,record TEXT NOT NULL,deleted_at INTEGER NOT NULL,PRIMARY KEY(team_id,kind,target_id));
      CREATE TABLE IF NOT EXISTS deletion_acks(team_id TEXT NOT NULL,seq INTEGER NOT NULL,runtime_id TEXT NOT NULL,proof TEXT NOT NULL,PRIMARY KEY(team_id,seq,runtime_id));
      CREATE TABLE IF NOT EXISTS recovery_task_index(user_id TEXT NOT NULL,scope TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(user_id,scope,task_id));
      CREATE TABLE IF NOT EXISTS retired_recovery(user_id TEXT NOT NULL,scope TEXT NOT NULL,PRIMARY KEY(user_id,scope));
    `);
    this.pruneBackups();
  }
  deleted(teamId, projectId, taskId = '') {
    return !!this.db.prepare("SELECT 1 FROM deletion_tombstones WHERE team_id=? AND ((kind='project.delete' AND target_id=?) OR (kind='task.delete' AND target_id=?))")
      .get(teamId, projectId, taskId);
  }
  // Called in the signed membership mutation's transaction, with no intervening await.
  apply(record, now = Date.now()) {
    const { teamId, action, payload } = record;
    const targetId = action === 'task.delete' ? payload.taskId : payload.projectId;
    const tasks = this.db.prepare('SELECT * FROM encrypted_tasks WHERE team_id=? AND project_id=?').all(teamId, payload.projectId)
      .filter(task => action === 'project.delete' || task.id === payload.taskId);
    if (action === 'task.delete' && (!tasks.length || tasks[0].runtime_id !== payload.runtimeId)) fail('unknown_encrypted_task', 404);
    if (action === 'project.delete' && !this.db.prepare('SELECT 1 FROM project_grants WHERE team_id=? AND project_id=?').get(teamId, payload.projectId)) fail('invalid_project');
    if (action === 'project.delete' && canonical(payload.tasks.slice().sort((a,b) => a.id.localeCompare(b.id))) !==
        canonical(tasks.map(task => ({ id: task.id, runtimeId: task.runtime_id })).sort((a,b) => a.id.localeCompare(b.id)))) fail('project_tasks_changed', 409);
    this.db.prepare('INSERT INTO deletion_tombstones VALUES (?,?,?,?,?,?)').run(teamId, action, targetId, payload.projectId, canonical(record), now);
    const affectedUsers = this.db.prepare('SELECT user_id FROM project_grants WHERE team_id=? AND project_id=?').all(teamId, payload.projectId).map(row => row.user_id);
    for (const task of tasks) {
      this.db.prepare('DELETE FROM encrypted_task_events WHERE task_id=?').run(task.id);
      this.db.prepare('DELETE FROM encrypted_tasks WHERE id=?').run(task.id);
      if (this.hasTable('measurement_events')) for (const table of ['measurement_events', 'measurement_dedup']) this.db.prepare('DELETE FROM ' + table + ' WHERE task_id=?').run(task.id);
      const archives = this.db.prepare('SELECT user_id,scope FROM recovery_task_index WHERE task_id=?').all(task.id);
      for (const archive of archives) this.removeArchive(archive.user_id, archive.scope);
      if (this.db.prepare('PRAGMA table_info(e2ee_mailbox)').all().some(column => column.name === 'task_id')) this.db.prepare('DELETE FROM e2ee_mailbox WHERE task_id=?').run(task.id);
    }
    // Legacy recovery blobs have no task manifest and cannot safely be selectively restored.
    for (const user of new Set([...affectedUsers, ...tasks.map(task => task.runtime_id)])) {
      // Older clients did not tag task envelopes. Discard their unscoped queues
      // for affected endpoints too; retained tasks can request fresh handoffs.
      this.db.prepare('DELETE FROM e2ee_mailbox WHERE user_id=? AND task_id IS NULL').run('@' + user + ':plexus.local');
      const legacy = this.db.prepare('SELECT scope FROM e2ee_recovery WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM recovery_task_index i WHERE i.user_id=e2ee_recovery.user_id AND i.scope=e2ee_recovery.scope)').all(user);
      for (const archive of legacy) this.removeArchive(user, archive.scope);
    }
    if (action === 'project.delete') this.db.prepare('UPDATE project_grants SET revoked_at=? WHERE team_id=? AND project_id=?').run(now, teamId, payload.projectId);
    return { deleted: true, targetId, pending: true, retentionDays: BACKUP_DAYS };
  }
  hasTable(name) { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  removeArchive(userId, scope) {
    this.db.prepare('INSERT OR IGNORE INTO retired_recovery VALUES (?,?)').run(userId, scope);
    this.db.prepare('DELETE FROM e2ee_recovery WHERE user_id=? AND scope=?').run(userId, scope);
    this.db.prepare('DELETE FROM recovery_task_index WHERE user_id=? AND scope=?').run(userId, scope);
  }
  list(teamId) {
    const hosts = this.store.listRuntimes(teamId).map(host => host.id);
    return this.db.prepare('SELECT record,deleted_at FROM deletion_tombstones WHERE team_id=?').all(teamId).map(row => {
      const operation = JSON.parse(row.record), relevant = operation.action === 'task.delete' ? [operation.payload.runtimeId] : [...new Set([...hosts, ...operation.payload.tasks.map(task => task.runtimeId)])];
      const receipts = this.db.prepare('SELECT runtime_id,proof FROM deletion_acks WHERE team_id=? AND seq=?').all(teamId, operation.seq)
        .map(row => ({ runtimeId: row.runtime_id, proof: JSON.parse(row.proof) }));
      return { operation, deletedAt: row.deleted_at, receipts, pendingHosts: relevant.filter(id => !receipts.some(receipt => receipt.runtimeId === id)) };
    });
  }
  async acknowledge(teamId, runtimeId, proof) {
    if (proof?.type !== 'plexus.deletion.applied.v1' || proof.teamId !== teamId || proof.runtimeId !== runtimeId ||
        accountId(proof.signer?.user) !== runtimeId || !await verifySignature(proof.signer, operationBody(proof), proof.signature)) fail('deletion_signature_invalid', 403);
    const row = this.db.prepare('SELECT record FROM membership_log WHERE team_id=? AND seq=?').get(teamId, proof.seq);
    if (!row || !['task.delete', 'project.delete'].includes(JSON.parse(row.record).action) || await digest(JSON.parse(row.record)) !== proof.hash) fail('deletion_state_mismatch', 409);
    this.db.prepare('INSERT INTO deletion_acks VALUES (?,?,?,?) ON CONFLICT(team_id,seq,runtime_id) DO UPDATE SET proof=excluded.proof')
      .run(teamId, proof.seq, runtimeId, canonical(proof));
    return { applied: true };
  }
  pruneBackups(now = Date.now()) {
    if (!this.backupDir || !fs.existsSync(this.backupDir)) return;
    for (const name of fs.readdirSync(this.backupDir)) {
      const match = /^snapshot-(\d+)\.json$/.exec(name);
      if (match && Number(match[1]) <= now - BACKUP_DAYS * 86400000) fs.unlinkSync(path.join(this.backupDir, name));
    }
  }
  snapshot(now = Date.now()) {
    this.pruneBackups(now);
    // Content snapshots deliberately exclude all identities, trust, grants, credentials,
    // mailboxes and recovery kits. They can only restore into the current authority DB.
    this.db.exec('BEGIN');
    try {
      const snapshot = { version: 1, createdAt: now, expiresAt: now + BACKUP_DAYS * 86400000,
        tasks: this.db.prepare('SELECT * FROM encrypted_tasks').all(), events: this.db.prepare('SELECT * FROM encrypted_task_events').all() };
      this.db.exec('COMMIT'); return snapshot;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  restore(snapshot, now = Date.now()) {
    if (snapshot?.version !== 1 || !Number.isSafeInteger(snapshot.createdAt) || snapshot.expiresAt !== snapshot.createdAt + BACKUP_DAYS * 86400000 ||
        snapshot.createdAt > now || snapshot.expiresAt <= now || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.events)) fail('backup_expired_or_invalid');
    this.db.exec('BEGIN IMMEDIATE'); let restored = 0;
    try {
      for (const task of snapshot.tasks) {
        if (!TASK_ID.test(task.id) || !PROJECT_ID.test(task.project_id)) fail('backup_expired_or_invalid');
        // Missing current pairing/grant fails closed. Never create one from a snapshot.
        if (this.deleted(task.team_id, task.project_id, task.id) || this.store.runtimePairing(task.runtime_id)?.teamId !== task.team_id ||
            !this.store.membership(task.team_id, task.creator_id) ||
            !this.db.prepare('SELECT 1 FROM project_grants WHERE team_id=? AND project_id=? AND user_id=? AND revoked_at IS NULL').get(task.team_id, task.project_id, task.creator_id)) continue;
        const existing = this.db.prepare('SELECT id FROM encrypted_tasks WHERE id=?').get(task.id);
        if (existing) continue; // A restore cannot roll an existing task backwards.
        this.db.prepare('INSERT INTO encrypted_tasks VALUES (?,?,?,?,?,?,?)').run(task.id, task.team_id, task.runtime_id, task.project_id, task.creator_id, task.version, task.request);
        for (const event of snapshot.events.filter(event => event.task_id === task.id)) this.db.prepare('INSERT INTO encrypted_task_events VALUES (?,?,?,?)').run(event.task_id, event.seq, event.event_id, event.record);
        restored++;
      }
      this.db.exec('COMMIT'); return { restored };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
module.exports = { Retention, RETENTION_NOTICE, BACKUP_DAYS };
