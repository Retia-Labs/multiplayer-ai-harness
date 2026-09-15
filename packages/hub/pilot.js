'use strict';
const { exact, canonical } = require('../protocol/encrypted-task.mjs');
const { pseudonym, validMeasurement, MEASUREMENT_DAYS, DEDUP_DAYS } = require('../product/measurement.mjs');
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { code, status }); };

class Pilot {
  constructor(store, enrollment) {
    this.store = store; this.db = store.db; this.enrollment = enrollment;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pilot_seats(team_id TEXT NOT NULL,user_id TEXT NOT NULL,record TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(team_id,user_id));
      CREATE TABLE IF NOT EXISTS pilot_seat_changes(id TEXT PRIMARY KEY,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS measurement_consent(user_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL,since INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS measurement_events(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,team_id TEXT NOT NULL,task_id TEXT,kind TEXT NOT NULL,at INTEGER NOT NULL,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS measurement_dedup(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,team_id TEXT NOT NULL,task_id TEXT,created_at INTEGER NOT NULL);
    `);
    this.prune();
  }
  prune(now = Date.now()) {
    this.db.prepare('DELETE FROM measurement_events WHERE at <= ?').run(now - MEASUREMENT_DAYS * 86400000);
    this.db.prepare('DELETE FROM measurement_dedup WHERE created_at <= ?').run(now - DEDUP_DAYS * 86400000);
  }
  consent(userId) { return this.db.prepare('SELECT enabled,since FROM measurement_consent WHERE user_id=?').get(userId) || { enabled: 0, since: null }; }
  setConsent(userId, enabled, now = Date.now()) {
    if (typeof enabled !== 'boolean') fail('invalid_measurement_consent');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO measurement_consent VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,since=excluded.since`)
        .run(userId, enabled ? 1 : 0, now);
      if (!enabled) {
        this.db.prepare('DELETE FROM measurement_events WHERE user_id=?').run(userId);
        this.db.prepare('DELETE FROM measurement_dedup WHERE user_id=?').run(userId);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { enabled, since: now };
  }
  seat(teamId, userId) {
    const held = this.db.prepare('SELECT record FROM pilot_seats WHERE team_id=? AND user_id=?').get(teamId, userId);
    return held ? JSON.parse(held.record) : { teamId, userId, status: 'unrecorded', payment: 'unrecorded', revision: 0 };
  }
  // Local operator API only. There is deliberately no remote seat-write route.
  recordSeat(value, now = Date.now()) {
    if (!exact(value, ['id', 'teamId', 'userId', 'operatorId', 'billingOwnerId', 'status', 'payment', 'price', 'currency', 'expectedRevision']) ||
        !/^[a-f0-9]{32}$/.test(value.id) || !['active', 'revoked'].includes(value.status) ||
        !['paid', 'free-pilot', 'intent', 'invoiced', 'unpaid'].includes(value.payment) ||
        !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
        !(value.price === null && value.currency === null || typeof value.price === 'string' && /^\d{1,8}(\.\d{1,2})?$/.test(value.price) && /^[A-Z]{3}$/.test(value.currency))) fail('invalid_seat_record');
    if (!this.store.getTeam(value.teamId) || !this.store.userById(value.userId) ||
        !this.store.userById(value.operatorId) || !this.store.userById(value.billingOwnerId)) fail('unknown_seat_account');
    const prior = this.db.prepare('SELECT record FROM pilot_seat_changes WHERE id=?').get(value.id);
    if (prior) {
      const saved = JSON.parse(prior.record);
      if (canonical(saved.request) !== canonical(value)) fail('seat_change_conflict', 409);
      return saved.result;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.seat(value.teamId, value.userId);
      if (current.revision !== value.expectedRevision) fail('seat_revision_conflict', 409);
      const result = { ...value, revision: current.revision + 1, updatedAt: now };
      this.db.prepare(`INSERT INTO pilot_seats VALUES (?,?,?,?) ON CONFLICT(team_id,user_id) DO UPDATE SET record=excluded.record,revision=excluded.revision`)
        .run(value.teamId, value.userId, canonical(result), result.revision);
      this.db.prepare('INSERT INTO pilot_seat_changes VALUES (?,?)').run(value.id, canonical({ request: value, result }));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  paidTeams() {
    const rows = this.db.prepare('SELECT record FROM pilot_seats').all().map(row => JSON.parse(row.record));
    return new Set(rows.filter(row => row.status === 'active' && row.payment === 'paid').map(row => row.teamId)).size;
  }
  async recordMeasurement(userId, teamId, event, now = Date.now()) {
    if (!validMeasurement(event, now) || event.person !== await pseudonym('person', userId) || event.team !== await pseudonym('team', teamId)) fail('invalid_measurement');
    // Crypto checks yield; recheck consent, access and deletion immediately before writing.
    const consent = this.consent(userId);
    if (!consent.enabled || event.at < consent.since) fail('measurement_not_enabled', 403);
    if (!this.store.membership(teamId, userId)) fail('not_a_member', 403);
    if (event.task) {
      const task = this.db.prepare('SELECT team_id,project_id FROM encrypted_tasks WHERE id=?').get(event.task);
      if (!task || task.team_id !== teamId || !this.enrollment.participant(teamId, task.project_id, userId)) fail('task_unavailable', 403);
    } else if (!['setup', 'invite'].includes(event.kind)) fail('measurement_task_required');
    this.prune(now);
    if (this.db.prepare('SELECT id FROM measurement_dedup WHERE id=?').get(event.id)) return { duplicate: true };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO measurement_dedup VALUES (?,?,?,?,?)').run(event.id, userId, teamId, event.task, now);
      this.db.prepare('INSERT INTO measurement_events VALUES (?,?,?,?,?,?,?)').run(event.id, userId, teamId, event.task, event.kind, event.at, canonical(event));
      this.db.exec('COMMIT'); return { stored: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  summary(teamId) {
    this.prune();
    const rows = this.db.prepare('SELECT user_id,task_id,kind,at FROM measurement_events WHERE team_id=?').all(teamId);
    const counts = Object.fromEntries(require('../product/measurement.mjs').KINDS.map(kind => [kind, rows.filter(row => row.kind === kind).length]));
    const weeks = new Set(rows.filter(row => row.kind === 'active').map(row => Math.floor((row.at - 4 * 86400000) / (7 * 86400000))));
    return { counts, activatedPeople: new Set(rows.filter(row => row.kind === 'activation').map(row => row.user_id)).size,
      qualifyingTasks: new Set(rows.filter(row => row.kind === 'activation').map(row => row.task_id)).size,
      returningTeam: weeks.size >= 2, windowDays: MEASUREMENT_DAYS };
  }
  async handle(req, res, url) {
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      let body;
      if (req.method === 'POST') {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 8192) fail('record_too_large', 413); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid_pilot_request'); }
      }
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const user = this.store.userByToken(token); if (!user) fail('unauthenticated', 401);
      const route = url.pathname.slice('/api/pilot/'.length), teamId = url.searchParams.get('team');
      if (route === 'consent') {
        if (req.method === 'GET') return reply(200, this.consent(user.id));
        if (req.method === 'POST' && exact(body, ['enabled'])) return reply(200, this.setConsent(user.id, body.enabled));
        fail('invalid_measurement_consent');
      }
      if (!this.store.membership(teamId, user.id)) fail('not_a_member', 403);
      if (route === 'measurement' && req.method === 'POST') return reply(200, await this.recordMeasurement(user.id, teamId, body));
      if (req.method !== 'GET') fail('method_not_allowed', 405);
      if (route === 'seats') {
        const owner = this.store.getTeam(teamId).ownerId === user.id;
        const ids = owner ? this.store.listMembers(teamId).map(row => row.userId) : [user.id];
        return reply(200, { seats: ids.map(id => this.seat(teamId, id)), providerUsageIncluded: false });
      }
      if (route === 'summary') {
        if (this.store.getTeam(teamId).ownerId !== user.id) fail('owner_role_required', 403);
        return reply(200, this.summary(teamId));
      }
      fail('pilot_route_required', 404);
    } catch (error) { reply(error.status || 400, { error: error.code || 'pilot_request_refused' }); }
  }
}
module.exports = { Pilot };
