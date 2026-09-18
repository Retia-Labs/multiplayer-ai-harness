'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Hub } = require('../packages/hub/server');
const { canonical } = require('../packages/protocol/encrypted-task.mjs');
const { diagnosticExport, onboarding } = require('../packages/product/diagnostics.mjs');
const { measurementEvent, observedOutcomes } = require('../packages/product/measurement.mjs');
const { BACKUP_DAYS } = require('../packages/hub/retention');
const { fixture } = require('./fixtures/pilot-service');

test('diagnostic export cannot contain canary content, keys, paths or arbitrary error strings', () => {
  const canary = 'PRIVATE_REPO_SECRET_CREDENTIAL';
  const report = diagnosticExport({ client: canary, versions: { app: canary, electron: '44.2.0' }, token: canary, path: canary,
    stages: [{ stage: 'provider', status: 'failed', code: canary, message: canary }, { stage: 'endpoint', status: 'failed', code: 'enrollment_failed' }] });
  assert.ok(!JSON.stringify(report).includes(canary));
  assert.equal(report.versions.app, 'unknown'); assert.equal(report.stages.find(row => row.stage === 'provider').code, 'setup_failed');
  assert.equal(report.stages.find(row => row.stage === 'endpoint').code, 'enrollment_failed');
  const malformed = diagnosticExport({ versions: { app: ['1.2.3'] }, stages: [{ stage: 'provider', status: 'failed', code: ['provider_missing'] }] });
  assert.equal(malformed.versions.app, 'unknown'); assert.equal(malformed.stages.find(row => row.stage === 'provider').code, 'setup_failed');
  const rows = onboarding({ account: true, verified: false, enrollmentError: true, recoveryError: true });
  assert.equal(rows.find(row => row.stage === 'endpoint').status, 'failed');
  assert.equal(rows.find(row => row.stage === 'recovery').code, 'recovery_failed');
});

test('provider setup waits for an online host before reporting provider failure or readiness', () => {
  const provider = facts => onboarding(facts).find(row => row.stage === 'provider');
  assert.deepEqual(provider({ host: false, providerCode: 'provider_missing' }), { stage: 'provider', status: 'pending', code: 'runtime_missing' });
  assert.equal(provider({ host: false, provider: true }).status, 'pending');
  assert.deepEqual(provider({ host: true, providerCode: 'provider_missing' }), { stage: 'provider', status: 'failed', code: 'provider_missing' });
  assert.deepEqual(provider({ host: true, provider: true }), { stage: 'provider', status: 'ready', code: null });
});

test('only signed owner deletion removes live task data, archives and indexes; replay and restoration cannot revive it', async t => {
  const f = await fixture(t), snapshot = f.hub.retention.snapshot();
  await assert.rejects(f.bob.deleteTask(f.team.id, f.task), /deletion_owner_required/);
  assert.equal((await f.request(f.stranger, '/api/enrollment/task.delete', { teamId: f.team.id })).status, 403);
  const principal = { id: f.owner.id };
  f.hub.keyExchange.putRecovery(principal, 'task-archive', 'SEALED_A', '1', Date.now(), [f.task.id]);
  f.hub.keyExchange.putRecovery(principal, 'other-archive', 'SEALED_B', '1', Date.now(), [f.other.id]);
  f.hub.keyExchange.putRecovery(principal, 'legacy-archive', 'SEALED_C', '1');
  const bytes = f.hub.store.db.prepare('SELECT record FROM encrypted_task_events WHERE task_id=?').get(f.task.id).record;
  const result = await f.alice.deleteTask(f.team.id, f.task);
  assert.equal(result.deleted, true);
  assert.equal(f.hub.encryptedTasks.get(f.task.id), null);
  assert.equal(f.hub.encryptedTasks.head(f.task.id), 0);
  assert.equal((await f.request(f.owner, '/api/encrypted-tasks/' + f.task.id + '/events')).status, 404);
  assert.throws(() => f.hub.encryptedTasks.append(f.task, JSON.parse(bytes)), /task_deleted/);
  const { creatorUserId, ...request } = f.task;
  assert.equal((await f.request(f.owner, '/api/encrypted-tasks', request)).value.error, 'task_deleted');
  assert.equal(f.hub.encryptedTasks.get(f.other.id).id, f.other.id);
  assert.throws(() => f.hub.keyExchange.getRecovery(principal, 'task-archive'), /no_recovery_material/);
  assert.throws(() => f.hub.keyExchange.getRecovery(principal, 'legacy-archive'), /no_recovery_material/);
  assert.equal(f.hub.keyExchange.getRecovery(principal, 'other-archive').ciphertext, 'SEALED_B');
  assert.throws(() => f.hub.keyExchange.putRecovery(principal, 'task-archive', 'OLD', '1'), /recovery_archive_deleted/);
  assert.equal(f.hub.retention.restore(snapshot).restored, 0);
  assert.equal(f.hub.encryptedTasks.get(f.task.id), null);
  const operation = f.hub.enrollment.authorityLog(f.team.id).at(-1);
  assert.equal((await f.alice.request('/task.delete', { teamId: f.team.id, ...operation.payload, operation })).duplicate, true);
  assert.deepEqual(f.hub.retention.list(f.team.id)[0].pendingHosts, [f.runtimeId]);
  assert.throws(() => f.hub.retention.restore(snapshot, snapshot.createdAt + BACKUP_DAYS * 86400000), /backup_expired_or_invalid/);
});

test('project deletion fences all tasks and grants, rejects stale task lists and later owner recovery grants', async t => {
  const f = await fixture(t), second = f.create();
  await assert.rejects(f.alice.deleteProject(f.team.id, f.project, [{ id: f.task.id, runtimeId: f.runtimeId }]), /project_tasks_changed/);
  assert.ok(f.hub.encryptedTasks.get(f.task.id));
  await f.alice.deleteProject(f.team.id, f.project, [f.task, second].map(task => ({ id: task.id, runtimeId: task.runtimeId })));
  assert.equal(f.hub.encryptedTasks.get(f.task.id), null); assert.equal(f.hub.encryptedTasks.get(second.id), null);
  assert.equal(f.hub.enrollment.participant(f.team.id, f.project, f.peer.id), null);
  await assert.rejects(f.alice.ownProject(f.team.id, f.project), /project_deleted/);
  await assert.rejects(f.alice.grant(f.team.id, f.project, f.peer.id), /project_deleted/);
  const head = await f.alice.signedHead(f.team.id, await f.alice.state(f.team.id));
  assert.equal(head.deletions.length, 1); assert.equal(head.grants.filter(grant => grant.projectId === f.project && !grant.revoked).length, 0);
});

test('service snapshots restore ciphertext only against current access and never restore removed members or approval grants', async t => {
  const f = await fixture(t), snapshot = f.hub.retention.snapshot();
  f.hub.store.grantApprover(f.team.id, f.peer.id, f.owner.id);
  f.hub.store.removeMember(f.team.id, f.peer.id);
  f.hub.store.db.prepare('DELETE FROM encrypted_task_events WHERE task_id=?').run(f.task.id);
  f.hub.store.db.prepare('DELETE FROM encrypted_tasks WHERE id=?').run(f.task.id);
  assert.equal(f.hub.retention.restore(snapshot).restored, 1);
  assert.equal(f.hub.store.membership(f.team.id, f.peer.id), null);
  assert.equal(f.hub.store.isApprover(f.team.id, f.peer.id), false);
  assert.equal((await f.request(f.peer, '/api/encrypted-tasks/' + f.task.id + '/events')).status, 403);
  assert.ok(!Object.keys(snapshot).some(key => /member|grant|credential|approval/i.test(key)));
});

test('measurement requires consent, authenticates person/task, drops content and deduplicates retry and deletes on opt-out', async t => {
  const f = await fixture(t), route = '/api/pilot/measurement?team=' + f.team.id;
  const now = Date.now(), event = await measurementEvent({ kind: 'solo', source: 1, userId: f.owner.id, teamId: f.team.id, taskId: f.task.id, at: now + 10 });
  assert.equal((await f.request(f.owner, route, event)).status, 403);
  await f.request(f.owner, '/api/pilot/consent', { enabled: true });
  event.at = Date.now();
  assert.equal((await f.request(f.owner, route, { ...event, prompt: 'PRIVATE_CANARY' })).status, 400);
  assert.equal((await f.request(f.peer, route, event)).status, 400);
  assert.equal((await f.request(f.owner, route, event)).value.stored, true);
  assert.equal((await f.request(f.owner, route, event)).value.duplicate, true);
  assert.equal(f.hub.pilot.summary(f.team.id).counts.solo, 1);
  const row = f.hub.store.db.prepare('SELECT record FROM measurement_events').get();
  assert.doesNotMatch(row.record, /PRIVATE_CANARY|prompt|title|url|path|diff/);
  await f.request(f.owner, '/api/pilot/consent', { enabled: false });
  assert.equal(f.hub.store.db.prepare('SELECT COUNT(*) n FROM measurement_events').get().n, 0);
  assert.equal(f.hub.store.db.prepare('SELECT COUNT(*) n FROM measurement_dedup').get().n, 0);
  assert.equal((await f.request(f.owner, route, event)).status, 403);
});

test('activation distinguishes authenticated participation and delivered peer intervention from passive/help/queued input', () => {
  const event = (type, payload) => ({ type, payload: { ...payload, occurredAt: Date.now() } });
  const start = event('turn.started', { actor: 'alice', turnId: '1' });
  const help = event('help.requested', { from: 'bob', question: 'PRIVATE_CANARY' });
  const queued = event('command.receipt', { actor: 'bob', action: 'turn.steer', state: 'queued', commandId: 'cmd_1' });
  const args = { userId: 'bob', creatorUserId: 'alice' };
  for (const events of [[start], [start, help], [start, queued], [start, event('command.receipt', { actor: 'bob', action: 'help.request', state: 'delivered', commandId: 'cmd_1' })]]) {
    assert.equal(observedOutcomes({ events }, args).some(outcome => outcome.kind === 'activation'), false);
  }
  const delivered = event('command.receipt', { ...queued.payload, state: 'delivered' });
  const snapshot = { events: [start, help, queued, delivered] };
  assert.equal(observedOutcomes(snapshot, args).filter(outcome => outcome.kind === 'activation').length, 1);
  assert.equal(observedOutcomes(snapshot, { ...args, userId: 'alice' }).filter(outcome => outcome.kind === 'activation').length, 1);
  assert.equal(observedOutcomes(snapshot, { ...args, userId: 'viewer' }).filter(outcome => outcome.kind === 'activation').length, 0);
  assert.doesNotMatch(JSON.stringify(observedOutcomes(snapshot, args)), /PRIVATE_CANARY/);
});

test('seat changes are founder-local, versioned and independent from all access and decryption records', async t => {
  const f = await fixture(t), db = f.hub.store.db;
  const authorization = () => canonical(['memberships', 'approvers', 'project_grants', 'endpoint_enrollments', 'membership_log'].map(table => db.prepare('SELECT * FROM ' + table).all()));
  const before = authorization();
  const record = { id: crypto.randomBytes(16).toString('hex'), teamId: f.team.id, userId: f.peer.id, operatorId: f.owner.id,
    billingOwnerId: f.owner.id, status: 'active', payment: 'invoiced', price: null, currency: null, expectedRevision: 0 };
  const first = f.hub.pilot.recordSeat(record);
  assert.equal(first.revision, 1); assert.equal(f.hub.pilot.recordSeat(record).revision, 1);
  assert.equal(f.hub.pilot.paidTeams(), 0);
  for (const payment of ['free-pilot', 'intent', 'unpaid', 'paid']) {
    const held = f.hub.pilot.seat(f.team.id, f.peer.id);
    f.hub.pilot.recordSeat({ ...record, id: crypto.randomBytes(16).toString('hex'), payment, expectedRevision: held.revision });
    assert.equal(f.hub.pilot.paidTeams(), payment === 'paid' ? 1 : 0);
  }
  const held = f.hub.pilot.seat(f.team.id, f.peer.id);
  assert.throws(() => f.hub.pilot.recordSeat({ ...record, id: crypto.randomBytes(16).toString('hex'), expectedRevision: 0 }), /seat_revision_conflict/);
  f.hub.pilot.recordSeat({ ...record, id: crypto.randomBytes(16).toString('hex'), status: 'revoked', payment: 'paid', expectedRevision: held.revision });
  assert.equal(f.hub.pilot.paidTeams(), 0); assert.equal(authorization(), before);
  assert.equal((await f.request(f.owner, '/api/pilot/seats?team=' + f.team.id, record)).status, 405);
  assert.equal((await f.request(f.peer, '/api/pilot/seats?team=' + f.team.id)).value.seats.length, 1);
  assert.equal((await f.request(f.stranger, '/api/pilot/seats?team=' + f.team.id)).status, 403);
});

test('a failed peer start cannot qualify activation; confirmed peer completion can', () => {
  const events = [
    { type: 'turn.started', payload: { actor: 'alice', turnId: 'first', occurredAt: 1 } },
    { type: 'turn.started', payload: { actor: 'bob', turnId: 'second', occurredAt: 2 } },
    { type: 'turn.completed', payload: { turnId: 'second', status: 'failed', occurredAt: 3 } }
  ];
  const args = { userId: 'bob', creatorUserId: 'alice' };
  assert.equal(observedOutcomes({ events }, args).some(row => row.kind === 'activation'), false);
  events[2].payload.status = 'completed';
  assert.equal(observedOutcomes({ events }, args).some(row => row.kind === 'activation'), true);
});

test('later-week active returns exclude views; retention, deletion and retry IDs remain bounded', async t => {
  const f = await fixture(t), now = Date.now(), day = 86400000;
  f.hub.pilot.setConsent(f.owner.id, true, now - 20 * day);
  const event = (kind, source, at) => measurementEvent({ kind, source, at, userId: f.owner.id, teamId: f.team.id, taskId: f.task.id });
  const first = await event('active', 1, now - 8 * day);
  await f.hub.pilot.recordMeasurement(f.owner.id, f.team.id, first);
  await f.hub.pilot.recordMeasurement(f.owner.id, f.team.id, await event('catchup', 2, now));
  assert.equal(f.hub.pilot.summary(f.team.id).returningTeam, false);
  await f.hub.pilot.recordMeasurement(f.owner.id, f.team.id, await event('active', 3, now));
  assert.equal(f.hub.pilot.summary(f.team.id).returningTeam, true);
  f.hub.pilot.prune(now + 31 * day);
  assert.equal(f.hub.store.db.prepare('SELECT COUNT(*) n FROM measurement_events').get().n, 0);
  assert.equal((await f.hub.pilot.recordMeasurement(f.owner.id, f.team.id, { ...first, at: now })).duplicate, true);
  await f.alice.deleteTask(f.team.id, f.task);
  assert.equal(f.hub.store.db.prepare('SELECT COUNT(*) n FROM measurement_dedup').get().n, 0);
  await assert.rejects(f.hub.pilot.recordMeasurement(f.owner.id, f.team.id, await event('activation', 4, now)), /task_unavailable/);
});

test('service snapshot files expire in seven days while unknown files remain untouched', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const f = await fixture(t), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-retention-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  f.hub.retention.backupDir = dir;
  const now = Date.now(), old = 'snapshot-' + (now - 7 * 86400000) + '.json', fresh = 'snapshot-' + now + '.json';
  for (const name of [old, fresh, 'operator-notes.txt']) fs.writeFileSync(path.join(dir, name), '{}');
  f.hub.retention.pruneBackups(now);
  assert.equal(fs.existsSync(path.join(dir, old)), false);
  assert.equal(fs.existsSync(path.join(dir, fresh)), true);
  assert.equal(fs.existsSync(path.join(dir, 'operator-notes.txt')), true);
  f.hub.retention.pruneBackups(now + 7 * 86400000);
  assert.equal(fs.existsSync(path.join(dir, fresh)), false);
});

test('Windows setup-status replacement retries a transient file lock without losing the previous complete record', { skip: process.platform !== 'win32' }, async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { Runtime } = require('../packages/runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-setup-storage-'));
  const runtime = new Runtime({ dataDir: dir, encryptedTasksOnly: true, log() {} });
  t.after(async () => { t.mock.restoreAll(); await runtime.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  runtime.setEncryptionState('awaiting-team');
  const file = path.join(dir, 'encrypted-setup.json'), before = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync; let blocked = 0;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === file && blocked++ < 2) {
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      throw Object.assign(new Error('fixture_lock'), { code: 'EPERM' });
    }
    return rename(source, target);
  });
  runtime.setEncryptionState('ready');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'ready');
  assert.equal(blocked, 3);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('fixture_disk'), { code: 'EIO' }); });
  assert.throws(() => runtime.setEncryptionState('unavailable'), /fixture_disk/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'ready');
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
});

test('local operator CLIs record and inspect seats and create a ciphertext-only service snapshot', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-pilot-cli-')), database = path.join(dir, 'hub.sqlite');
  const hub = new Hub({ dbFile: database }); await hub.listen();
  t.after(async () => { await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const user = hub.store.createAccount('Operator'), team = hub.store.createTeam('Pilot', user.id);
  const input = path.join(dir, 'seat.json');
  fs.writeFileSync(input, JSON.stringify({ id: crypto.randomBytes(16).toString('hex'), teamId: team.id, userId: user.id,
    operatorId: user.id, billingOwnerId: user.id, status: 'active', payment: 'paid', price: null, currency: null, expectedRevision: 0 }));
  const cli = (script, ...args) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(cli('pilot-seats.js', 'record', database, input).revision, 1);
  assert.equal(cli('pilot-seats.js', 'record', database, input).revision, 1);
  assert.equal(cli('pilot-seats.js', 'show', database, team.id, user.id).billingOwnerId, user.id);
  assert.equal(cli('pilot-seats.js', 'summary', database).paidTeams, 1);
  const backup = cli('service-backup.js', 'create', database);
  const snapshot = JSON.parse(fs.readFileSync(path.join(database + '.backups', backup.snapshot), 'utf8'));
  assert.deepEqual(Object.keys(snapshot).sort(), ['createdAt', 'events', 'expiresAt', 'tasks', 'version']);
  assert.equal(cli('service-backup.js', 'restore', database, backup.snapshot).restored, 0);
  assert.ok(hub.store.membership(team.id, user.id));
});
