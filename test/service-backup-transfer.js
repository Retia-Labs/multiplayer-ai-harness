'use strict';
// Two-phase operator drill. Only synthetic fixture data is created. Transfer the
// exported snapshot between machines before putting it back in hub.sqlite.backups.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { HubStore } = require('../packages/hub/store');
const { fixture } = require('./fixtures/pilot-service');
const { canonical } = require('../packages/protocol/encrypted-task.mjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const authorityTables = ['users', 'memberships', 'pairings', 'runtime_credentials',
  'approvers', 'project_grants', 'endpoint_enrollments', 'membership_log', 'deletion_tombstones'];
const authorityHash = store => hash(canonical(authorityTables.map(table =>
  store.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all())));
const cli = (...args) => JSON.parse(execFileSync(process.execPath,
  [path.join(__dirname, '..', 'scripts/service-backup.js'), ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

async function prepare(dir) {
  // Refuse an existing directory: this drill must never target an operator DB.
  fs.mkdirSync(dir, { mode: 0o700 });
  const database = path.join(dir, 'hub.sqlite'), cleanup = [];
  try {
    const f = await fixture({ after(fn) { cleanup.push(fn); } }, { dbFile: database });
    const deleted = f.create(), retained = f.create();
    f.append(deleted); f.append(retained);
    const backup = cli('create', database);
    const original = path.join(database + '.backups', backup.snapshot);
    const bytes = fs.readFileSync(original), snapshot = JSON.parse(bytes);
    assert.deepEqual(Object.keys(snapshot).sort(), ['createdAt', 'events', 'expiresAt', 'tasks', 'version']);
    assert.equal(snapshot.tasks.length, 4);
    assert.equal(snapshot.events.length, 4);
    for (const token of [f.owner.token, f.peer.token, f.runtimeToken]) {
      assert.ok(!bytes.includes(Buffer.from(token)), 'snapshot must exclude credentials');
    }

    // Change current authority AFTER the snapshot using the signed endpoint flow.
    await f.alice.deleteTask(f.team.id, deleted);
    await f.alice.revokeGrant(f.team.id, f.other.projectId, f.owner.id);
    f.hub.store.grantApprover(f.team.id, f.peer.id, f.owner.id);
    f.hub.store.removeMember(f.team.id, f.peer.id);
    const event = JSON.parse(f.hub.store.db.prepare(
      'SELECT record FROM encrypted_task_events WHERE task_id=?').get(retained.id).record);
    event.id = 'ev_' + crypto.randomBytes(16).toString('hex'); event.seq = 2;
    f.hub.encryptedTasks.append(retained, event);
    // Simulate missing ciphertext, preserving the CURRENT authority and tombstones.
    for (const task of [f.task, f.other]) {
      f.hub.store.db.prepare('DELETE FROM encrypted_task_events WHERE task_id=?').run(task.id);
      f.hub.store.db.prepare('DELETE FROM encrypted_tasks WHERE id=?').run(task.id);
    }
    fs.renameSync(original, path.join(dir, backup.snapshot));
    const state = { snapshot: backup.snapshot, sha256: hash(bytes),
      authoritySha256: authorityHash(f.hub.store), restore: f.task.id,
      deleted: deleted.id, revoked: f.other.id, retained: retained.id,
      team: f.team.id, removedMember: f.peer.id };
    fs.writeFileSync(path.join(dir, 'drill.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
    return { phase: 'prepared', snapshot: state.snapshot, sha256: state.sha256, tasks: 4 };
  } finally { for (const close of cleanup.reverse()) await close(); }
}

function verify(dir) {
  const database = path.join(dir, 'hub.sqlite');
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'drill.json')));
  const returned = path.join(database + '.backups', state.snapshot);
  assert.equal(hash(fs.readFileSync(returned)), state.sha256, 'returned bytes differ');
  assert.equal(cli('restore', database, state.snapshot).restored, 1);
  const store = new HubStore(database);
  try {
    assert.equal(authorityHash(store), state.authoritySha256);
    const tasks = store.db.prepare('SELECT id FROM encrypted_tasks ORDER BY id').all().map(row => row.id);
    assert.deepEqual(tasks, [state.restore, state.retained].sort());
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM encrypted_task_events WHERE task_id=?').get(state.restore).n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM encrypted_task_events WHERE task_id=?').get(state.retained).n, 2);
    assert.equal(store.membership(state.team, state.removedMember), null);
    assert.equal(store.isApprover(state.team, state.removedMember), false);
    assert.equal(cli('restore', database, state.snapshot).restored, 0);
    assert.equal(authorityHash(store), state.authoritySha256);
  } finally { store.close(); }

  // A lost authority database is NOT reconstructed from the ciphertext snapshot.
  const blank = path.join(dir, 'lost-authority.sqlite');
  assert.ok(!fs.existsSync(blank), 'verification already ran');
  new HubStore(blank).close();
  fs.mkdirSync(blank + '.backups', { mode: 0o700 });
  fs.copyFileSync(returned, path.join(blank + '.backups', state.snapshot));
  assert.equal(cli('restore', blank, state.snapshot).restored, 0);
  const empty = new HubStore(blank);
  try {
    for (const table of [...authorityTables, 'encrypted_tasks', 'encrypted_task_events']) {
      assert.equal(empty.db.prepare('SELECT COUNT(*) n FROM ' + table).get().n, 0);
    }
  } finally { empty.close(); }
  const result = { phase: 'verified', sha256: state.sha256, restored: 1,
    deletedTaskSkipped: true, revokedGrantSkipped: true, currentLogPreserved: true,
    removedMembershipAndApprovalPreserved: true, authorityUnchanged: true,
    repeatedRestore: 0, lostAuthorityRestore: 0, platform: process.platform,
    node: process.version, verifiedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

async function main() {
  const [phase, directory] = process.argv.slice(2);
  assert.ok(['prepare', 'verify'].includes(phase) && directory,
    'Usage: node test/service-backup-transfer.js prepare|verify <isolated-drill-directory>');
  const dir = path.resolve(directory);
  console.log(JSON.stringify(phase === 'prepare' ? await prepare(dir) : verify(dir)));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
