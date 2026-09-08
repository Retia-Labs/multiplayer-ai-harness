'use strict';
// Who may fetch a project's ciphertext, and which endpoints have been vouched for.
//
// Two gates, deliberately independent:
//
//   * a *project grant* is what the relay checks. It decides who may fetch bytes.
//   * an *endpoint enrollment* is what the encryption layer checks. It decides whose
//     device may be handed a key.
//
// Neither one is access. A grant without a confirmed endpoint yields ciphertext nobody
// can open; a confirmed endpoint without a grant cannot fetch anything to open. Holding
// an account, an invitation link or a task id is not either of them - which is the whole
// claim being made here, and the reason this is a separate module from membership.
//
// The hub cannot check cryptography. It records who vouched for whom and refuses to let
// an unvouched endpoint be recorded as vouched; the fingerprint comparison itself happens
// on the confirming endpoint, against material carried out of band.
const { PROJECT_ID, canonical, digest } = require('../protocol/encrypted-task.mjs');
const { initialMembership, applyOperation, operationBody, replayMembership, verifySignature, accountId, GENESIS } = require('../e2ee/membership.mjs');

const problem = (code, status = 400) => Object.assign(new Error(code), { code, status });
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[A-Za-z0-9+/]{20,64}={0,2}$/;
const ROLES = ['owner', 'participant'];
const STATES = ['pending', 'verified', 'revoked'];

const fingerprint = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
  DEVICE.test(value.device || '') && KEY.test(value.curve25519 || '') && KEY.test(value.ed25519 || '');

class Enrollment {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.challenges = new Map();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS membership_log(
        team_id TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, record TEXT NOT NULL,
        PRIMARY KEY(team_id,seq));
      CREATE TABLE IF NOT EXISTS endpoint_enrollments(
        team_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
        curve25519 TEXT NOT NULL, ed25519 TEXT NOT NULL, state TEXT NOT NULL,
        announced_at INTEGER NOT NULL, confirmed_by TEXT, confirmed_at INTEGER, revoked_at INTEGER,
        PRIMARY KEY(team_id, user_id, device_id));
      CREATE TABLE IF NOT EXISTS project_grants(
        team_id TEXT NOT NULL, project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
        granted_by TEXT NOT NULL, granted_at INTEGER NOT NULL, revoked_at INTEGER,
        PRIMARY KEY(team_id, project_id, user_id));
      CREATE INDEX IF NOT EXISTS project_grants_user ON project_grants(team_id, user_id);
    
      CREATE TABLE IF NOT EXISTS revocation_acks(
        team_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL, applied_at INTEGER NOT NULL,
        PRIMARY KEY(team_id, user_id, device_id, runtime_id));
    `);
    if (!this.db.prepare('PRAGMA table_info(revocation_acks)').all().some((column) => column.name === 'proof')) {
      this.db.exec('ALTER TABLE revocation_acks ADD COLUMN proof TEXT');
    }
  }

  authorityLog(teamId) {
    return this.db.prepare('SELECT record FROM membership_log WHERE team_id=? ORDER BY seq').all(teamId).map((r) => JSON.parse(r.record));
  }

  async signedMutation(teamId, account, action, body) {
    const record = body.operation;
    if (!record || typeof record.signature !== 'string') throw problem('enrollment_signature_required', 403);
    const signed = operationBody(record);
    const { operation: _operation, teamId: _team, ...payload } = body;
    if (signed.teamId !== teamId || signed.action !== action || canonical(signed.payload) !== canonical(payload) ||
        accountId(signed.signer?.user) !== account.id) throw problem('enrollment_signature_invalid', 403);
    if (!await verifySignature(signed.signer, signed, record.signature)) throw problem('enrollment_signature_invalid', 403);
    if (action === 'confirm' && signed.payload.device !== signed.signer.device) throw problem('confirming_endpoint_unverified', 403);
    const records = this.authorityLog(teamId);
    const current = records.length
      ? await replayMembership(records, { teamId, authority: records[0].signer })
      : initialMembership(teamId);
    // The identical signed request may safely be retried after an uncertain HTTP reply.
    const known = records.find((entry) => entry.seq === record.seq);
    if (known && canonical(known) === canonical(record)) return { duplicate: true, seq: current.seq };
    const next = applyOperation(current, signed);
    const hash = await digest(record);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const held = this.db.prepare('SELECT seq,hash FROM membership_log WHERE team_id=? ORDER BY seq DESC LIMIT 1').get(teamId);
      if ((held?.seq || 0) !== current.seq || (held?.hash || GENESIS) !== current.hash) throw problem('membership_sequence_conflict', 409);
      let result;
      if (action === 'bootstrap') {
        if (this.store.getTeam(teamId)?.ownerId !== account.id) throw problem('team_owner_required', 403);
        this.announce(teamId, account.id, payload.endpoint);
        // Existing unsigned enrollment rows carry no cryptographic authority into this log.
        this.db.prepare("UPDATE endpoint_enrollments SET state='pending', confirmed_by=NULL WHERE team_id=? AND state='verified'").run(teamId);
        this.db.prepare("UPDATE endpoint_enrollments SET state='verified', confirmed_by='bootstrap', confirmed_at=? WHERE team_id=? AND user_id=? AND device_id=?")
          .run(Date.now(), teamId, account.id, signed.signer.device);
        result = { endpoint: this.row(teamId, account.id, signed.signer.device) };
      } else if (action === 'confirm') result = this.confirm(teamId, { userId: account.id, device: signed.signer.device }, payload.target);
      else if (action === 'revoke-endpoint') result = { endpoint: this.revokeEndpoint(teamId, { userId: account.id }, payload.target) };
      else if (action === 'own-project') result = { grant: this.ownProject(teamId, payload.projectId, account.id) };
      else if (action === 'grant') result = this.grant(teamId, payload.projectId, { userId: account.id }, payload.userId, payload.role);
      else if (action === 'revoke-grant') result = { grant: this.revokeGrant(teamId, payload.projectId, { userId: account.id }, payload.userId) };
      else throw problem('unsupported_membership_operation');
      this.db.prepare('INSERT INTO membership_log VALUES (?,?,?,?)').run(teamId, next.seq, hash, canonical(record));
      this.db.exec('COMMIT');
      return { ...result, seq: next.seq, hash };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  // ---- endpoint enrollment ----

  row(teamId, userId, deviceId) {
    const r = this.db.prepare('SELECT * FROM endpoint_enrollments WHERE team_id=? AND user_id=? AND device_id=?').get(teamId, userId, deviceId);
    return r ? {
      teamId: r.team_id, userId: r.user_id, device: r.device_id, curve25519: r.curve25519, ed25519: r.ed25519,
      state: r.state, announcedAt: r.announced_at, confirmedBy: r.confirmed_by, confirmedAt: r.confirmed_at, revokedAt: r.revoked_at
    } : null;
  }

  endpoints(teamId, userId) {
    const rows = userId
      ? this.db.prepare('SELECT user_id, device_id FROM endpoint_enrollments WHERE team_id=? AND user_id=?').all(teamId, userId)
      : this.db.prepare('SELECT user_id, device_id FROM endpoint_enrollments WHERE team_id=?').all(teamId);
    return rows.map((r) => this.row(teamId, r.user_id, r.device_id));
  }

  verified(teamId, userId, deviceId) {
    const held = this.row(teamId, userId, deviceId);
    return !!held && held.state === 'verified';
  }

  hasVerifiedEndpoint(teamId, userId) {
    return this.endpoints(teamId, userId).some((e) => e.state === 'verified');
  }

  // A new endpoint says who it is. This is the *only* thing an account and an invitation
  // link buy you, and it buys nothing readable: the row lands pending.
  //
  // The same device id turning up with different keys is refused rather than recorded.
  // Device keys are immutable in the crypto layer - the SDK will not accept a replacement
  // for a device it has already seen - so a row rewritten here would be one no endpoint
  // could ever confirm, and the relay's view of the team would quietly stop matching the
  // endpoints' view. An endpoint rebuilt after site-data loss is a new device and announces
  // itself as one; nothing carries over, which is the intended cost of losing the keys.
  announce(teamId, userId, endpoint, now = Date.now()) {
    if (!this.store.membership(teamId, userId)) throw problem('not_a_member', 403);
    if (!fingerprint(endpoint)) throw problem('invalid_endpoint_fingerprint');
    const held = this.row(teamId, userId, endpoint.device);
    if (held) {
      if (held.curve25519 !== endpoint.curve25519 || held.ed25519 !== endpoint.ed25519) throw problem('endpoint_device_id_reused', 409);
      return { endpoint: held, known: true };
    }
    this.db.prepare("INSERT INTO endpoint_enrollments VALUES (?,?,?,?,?,'pending',?,NULL,NULL,NULL)")
      .run(teamId, userId, endpoint.device, endpoint.curve25519, endpoint.ed25519, now);
    return { endpoint: this.row(teamId, userId, endpoint.device), known: false };
  }

  // The team's first endpoint has nobody to vouch for it. Every trust graph has this root;
  // naming it is better than pretending it is not there. It is the team owner's own device,
  // recorded as such, and it is the only self-confirmation the hub will ever write.
  bootstrap(teamId, userId, endpoint, now = Date.now()) {
    const team = this.store.getTeam(teamId);
    if (!team || team.ownerId !== userId) throw problem('team_owner_required', 403);
    if (this.endpoints(teamId).some((e) => e.state === 'verified')) throw problem('team_already_bootstrapped', 409);
    this.announce(teamId, userId, endpoint, now);
    this.db.prepare(`UPDATE endpoint_enrollments SET state='verified', confirmed_by='bootstrap', confirmed_at=?
      WHERE team_id=? AND user_id=? AND device_id=?`).run(now, teamId, userId, endpoint.device);
    return this.row(teamId, userId, endpoint.device);
  }

  // `confirmer` has compared fingerprints out of band and is now recording the verdict.
  // The hub accepts that verdict from a verified endpoint, or from the team owner acting as
  // the team's recovery authority - but only while the owner has no verified endpoint left,
  // which is the situation that authority exists for. An owner who still holds one confirms
  // from it like anybody else. Otherwise possession of the owner's session would be a way to
  // enrol endpoints into the team's trust, and "login is not trust" would have an exception
  // big enough to walk through.
  //
  // The fingerprints must match what was announced. A confirmation naming different keys
  // is refused rather than overwriting them: it means the confirmer and the relay are
  // looking at different devices, and exactly one of those is the attack.
  confirm(teamId, confirmer, target, now = Date.now()) {
    const team = this.store.getTeam(teamId);
    if (!team) throw problem('unknown_team', 404);
    const recoveryAuthority = team.ownerId === confirmer.userId && !this.hasVerifiedEndpoint(teamId, confirmer.userId);
    if (!recoveryAuthority && !this.verified(teamId, confirmer.userId, confirmer.device)) throw problem('confirming_endpoint_unverified', 403);
    if (!fingerprint(target) || typeof target.userId !== 'string') throw problem('invalid_endpoint_fingerprint');
    const held = this.row(teamId, target.userId, target.device);
    if (!held) throw problem('endpoint_not_announced', 404);
    if (held.state === 'revoked') throw problem('endpoint_revoked', 403);
    if (held.curve25519 !== target.curve25519 || held.ed25519 !== target.ed25519) throw problem('endpoint_key_mismatch', 409);
    this.db.prepare('UPDATE endpoint_enrollments SET state=?, confirmed_by=?, confirmed_at=? WHERE team_id=? AND user_id=? AND device_id=?')
      .run('verified', confirmer.userId + '/' + confirmer.device, now, teamId, target.userId, target.device);
    return { endpoint: this.row(teamId, target.userId, target.device), authority: recoveryAuthority ? 'recovery' : 'endpoint' };
  }

  revokeEndpoint(teamId, actor, target, now = Date.now()) {
    const team = this.store.getTeam(teamId);
    if (!team) throw problem('unknown_team', 404);
    if (team.ownerId !== actor.userId && actor.userId !== target.userId) throw problem('endpoint_revocation_refused', 403);
    if (!this.row(teamId, target.userId, target.device)) throw problem('endpoint_not_announced', 404);
    this.db.prepare("UPDATE endpoint_enrollments SET state='revoked', revoked_at=? WHERE team_id=? AND user_id=? AND device_id=?")
      .run(now, teamId, target.userId, target.device);
    return this.row(teamId, target.userId, target.device);
  }

  // ---- revocation, and who has actually applied it ----
  //
  // Revoking an endpoint is a decision made here, and applied somewhere else. The relay can
  // stop serving that device immediately; it cannot reach into an execution host that is
  // asleep and rotate a key. So a revocation is recorded as pending until each host says it
  // has applied it, and "pending" is shown rather than smoothed over - telling somebody a
  // device is locked out when the machine holding the keys has not heard yet is the kind of
  // reassurance that gets people hurt.
  revocations(teamId) {
    const revoked = this.db.prepare(
      "SELECT user_id, device_id, revoked_at FROM endpoint_enrollments WHERE team_id=? AND state='revoked'").all(teamId);
    const runtimes = (this.store.listRuntimes ? this.store.listRuntimes(teamId) : []).map((r) => r.id);
    return revoked.map((row) => {
      const applied = this.db.prepare(
        'SELECT runtime_id, applied_at, proof FROM revocation_acks WHERE team_id=? AND user_id=? AND device_id=? AND proof IS NOT NULL')
        .all(teamId, row.user_id, row.device_id);
      const appliedBy = new Set(applied.map((a) => a.runtime_id));
      return {
        userId: row.user_id, device: row.device_id, revokedAt: row.revoked_at,
        appliedBy: [...appliedBy],
        receipts: applied.map((a) => ({ runtimeId: a.runtime_id, proof: JSON.parse(a.proof) })),
        // Named rather than counted, because "1 of 2 hosts" does not tell anybody which
        // machine is still able to act on keys the removed device may still hold.
        pendingHosts: runtimes.filter((id) => !appliedBy.has(id)),
        applied: runtimes.length > 0 && runtimes.every((id) => appliedBy.has(id))
      };
    });
  }

  // Only the host that did the work may say it did. A client claiming a rotation happened on
  // somebody else's machine would be exactly the false reassurance this exists to prevent.
  async acknowledgeRevocation(teamId, runtimeId, proof, now = Date.now()) {
    if (!proof?.signature || !proof.signer) throw problem('revocation_signature_required', 403);
    const target = proof.target;
    const row = this.row(teamId, target?.userId, target?.device);
    if (!row || row.state !== 'revoked') throw problem('endpoint_not_revoked', 404);
    if (proof.type !== 'plexus.membership.applied.v1' || proof.teamId !== teamId || proof.runtimeId !== runtimeId || accountId(proof.signer.user) !== runtimeId ||
        !await verifySignature(proof.signer, operationBody(proof), proof.signature)) throw problem('revocation_signature_invalid', 403);
    const head = this.db.prepare('SELECT hash FROM membership_log WHERE team_id=? AND seq=?').get(teamId, proof.seq);
    const records = this.authorityLog(teamId);
    const revoked = records.find((r) => r.action === 'revoke-endpoint' && r.payload.target.userId === target.userId && r.payload.target.device === target.device);
    if (!head || head.hash !== proof.hash || !revoked || revoked.seq > proof.seq) throw problem('revocation_state_mismatch', 409);
    this.db.prepare(`INSERT INTO revocation_acks(team_id,user_id,device_id,runtime_id,applied_at,proof) VALUES (?,?,?,?,?,?)
      ON CONFLICT(team_id, user_id, device_id, runtime_id) DO UPDATE SET applied_at=excluded.applied_at,proof=excluded.proof`)
      .run(teamId, target.userId, target.device, runtimeId, now, canonical(proof));
    return { applied: true, runtimeId, target };
  }

  // ---- project grants ----

  grantRow(teamId, projectId, userId) {
    const r = this.db.prepare('SELECT * FROM project_grants WHERE team_id=? AND project_id=? AND user_id=?').get(teamId, projectId, userId);
    return r ? { teamId: r.team_id, projectId: r.project_id, userId: r.user_id, role: r.role, grantedBy: r.granted_by, grantedAt: r.granted_at, revokedAt: r.revoked_at } : null;
  }

  participant(teamId, projectId, userId) {
    const held = this.grantRow(teamId, projectId, userId);
    return held && !held.revokedAt ? held : null;
  }

  participants(teamId, projectId) {
    return this.db.prepare('SELECT user_id FROM project_grants WHERE team_id=? AND project_id=? AND revoked_at IS NULL').all(teamId, projectId)
      .map((r) => {
        const grant = this.grantRow(teamId, projectId, r.user_id);
        const account = this.store.userById(r.user_id);
        return { ...grant, name: account?.name || null, endpoints: this.endpoints(teamId, r.user_id) };
      });
  }

  projectsFor(teamId, userId) {
    return this.db.prepare('SELECT project_id FROM project_grants WHERE team_id=? AND user_id=? AND revoked_at IS NULL').all(teamId, userId).map((r) => r.project_id);
  }

  // Creating a task in a project makes its creator that project's owner. Without this the
  // creator would immediately be unable to read what they just created.
  ownProject(teamId, projectId, userId, now = Date.now()) {
    if (this.participant(teamId, projectId, userId)) return this.participant(teamId, projectId, userId);
    this.db.prepare(`INSERT INTO project_grants VALUES (?,?,?,'owner',?,?,NULL)
      ON CONFLICT(team_id,project_id,user_id) DO UPDATE SET role='owner', revoked_at=NULL`).run(teamId, projectId, userId, userId, now);
    return this.grantRow(teamId, projectId, userId);
  }

  // What a grant actually hands over, said in the response rather than left to a UI to
  // guess: every task already in this project, and every task added to it afterwards.
  explain(teamId, projectId, userId, role) {
    // Enrollment can be constructed before the task tables exist; a project with no
    // tables yet simply has no existing history to describe.
    const ready = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encrypted_tasks'").get();
    const existing = ready ? this.db.prepare('SELECT id FROM encrypted_tasks WHERE team_id=? AND project_id=?').all(teamId, projectId).map((r) => r.id) : [];
    return {
      teamId, projectId, userId, role,
      existingTasks: existing,
      covers: [
        'the complete ordered history of ' + existing.length + ' task(s) already in this project, from the first event',
        'every task added to this project after this grant, without a further grant',
        'nothing in any other project of this team'
      ],
      readableWhen: 'a trusted endpoint confirms this teammate\'s endpoint fingerprint and shares the project key with it; the grant alone fetches ciphertext only'
    };
  }

  grant(teamId, projectId, granter, userId, role = 'participant', now = Date.now()) {
    if (!PROJECT_ID.test(projectId)) throw problem('invalid_project');
    if (!ROLES.includes(role)) throw problem('invalid_project_role');
    if (!this.participant(teamId, projectId, granter.userId)) throw problem('not_a_project_participant', 403);
    if (!this.store.membership(teamId, userId)) throw problem('not_a_member', 403);
    // A grant is an authorization act, so it comes from a vouched-for endpoint rather than
    // from a session cookie that happens to belong to a participant.
    if (!this.hasVerifiedEndpoint(teamId, granter.userId)) throw problem('granting_endpoint_unverified', 403);
    this.db.prepare(`INSERT INTO project_grants VALUES (?,?,?,?,?,?,NULL)
      ON CONFLICT(team_id,project_id,user_id) DO UPDATE SET role=excluded.role, granted_by=excluded.granted_by, granted_at=excluded.granted_at, revoked_at=NULL`)
      .run(teamId, projectId, userId, role, granter.userId, now);
    return { grant: this.grantRow(teamId, projectId, userId), explanation: this.explain(teamId, projectId, userId, role) };
  }

  revokeGrant(teamId, projectId, actor, userId, now = Date.now()) {
    const held = this.grantRow(teamId, projectId, userId);
    if (!held) throw problem('not_a_project_participant', 404);
    if (!this.participant(teamId, projectId, actor.userId)) throw problem('not_a_project_participant', 403);
    if (held.role === 'owner' && actor.userId !== userId) throw problem('project_owner_grant_retained', 409);
    this.db.prepare('UPDATE project_grants SET revoked_at=? WHERE team_id=? AND project_id=? AND user_id=?').run(now, teamId, projectId, userId);
    return this.grantRow(teamId, projectId, userId);
  }

  // ---- HTTP ----

  // An account, or a paired execution host reading its own team.
  //
  // The host has to know which endpoints are verified: it decides whose task requests to
  // open and whose devices may be handed a key, and both of those are enrolment questions.
  // It may only ever read. Confirming an endpoint or granting project access stays with
  // accounts, because a host that could vouch for endpoints could admit itself an audience.
  principal(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const runtimeId = req.headers['x-plexus-runtime'];
    if (runtimeId) {
      const pairing = this.store.runtimePairing(runtimeId);
      if (!pairing || !this.store.runtimeCredentialMatches(runtimeId, token)) throw problem('runtime_authentication_failed', 401);
      return { runtimeId, teamId: pairing.teamId };
    }
    const account = this.store.userByToken(token);
    if (!account) throw problem('unauthenticated', 401);
    return { account };
  }

  user(req) {
    const principal = this.principal(req);
    if (!principal.account) throw problem('client_required', 403);
    return principal.account;
  }

  async handle(req, res, url) {
    const reply = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      const principal = this.principal(req);
      const parts = url.pathname.split('/').filter(Boolean).slice(2); // after /api/enrollment
      // A host reads; it does not decide. Every route below that changes a verdict needs an
      // account, and this is where that line is drawn rather than in each handler.
      // A host writes exactly one thing here: that it has applied a revocation. Everything
      // else that changes trust is a person's decision made on a client.
      const hostAck = principal.runtimeId && req.method === 'POST' && ['ack-revocation', 'challenge'].includes(parts[0]);
      if (principal.runtimeId && req.method !== 'GET' && !hostAck) throw problem('client_required', 403);
      const account = principal.account;
      let body;
      if (req.method === 'POST') {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) throw problem('record_too_large', 413); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw problem('invalid_enrollment_request'); }
      }
      const teamId = String((body && body.teamId) || url.searchParams.get('team') || '');
      if (principal.runtimeId) {
        if (teamId !== principal.teamId) throw problem('foreign_runtime', 403);
      } else if (!this.store.membership(teamId, account.id)) throw problem('not_a_member', 403);

      if (req.method === 'GET' && parts.length === 0) {
        const projectId = url.searchParams.get('project');
        return reply(200, {
          teamId,
          me: principal.runtimeId
            ? { runtimeId: principal.runtimeId, role: 'execution-host' }
            : { userId: account.id, role: this.store.membership(teamId, account.id).role },
          endpoints: this.endpoints(teamId),
          authorityLog: this.authorityLog(teamId),
          challenges: [...this.challenges.values()].filter((c) => c.teamId === teamId && !c.proof && c.expiresAt > Date.now())
            .map(({ runtimeId, challenge }) => ({ runtimeId, challenge })),
          ...(principal.runtimeId ? { currentProof: this.challenges.get(teamId + '/' + principal.runtimeId)?.proof || null } : {}),
          revocations: this.revocations(teamId),
          projects: principal.runtimeId ? [] : this.projectsFor(teamId, account.id),
          ...(projectId ? { participants: this.participants(teamId, projectId) } : {})
        });
      }
      if (req.method !== 'POST') throw problem('method_not_allowed', 405);
      if (parts[0] === 'challenge') {
        if (!principal.runtimeId || !/^[a-f0-9]{48}$/.test(body.challenge || '')) throw problem('invalid_membership_challenge');
        this.challenges.set(teamId + '/' + principal.runtimeId, { teamId, runtimeId: principal.runtimeId,
          challenge: body.challenge, proof: null, expiresAt: Date.now() + 60000 });
        return reply(200, { pending: true });
      }
      if (parts[0] === 'answer-challenge') {
        if (!account) throw problem('client_required', 403);
        const request = this.challenges.get(teamId + '/' + body.runtimeId);
        const records = this.authorityLog(teamId);
        const owner = records[0]?.signer;
        const proof = body.proof;
        if (!request || request.expiresAt < Date.now() || !proof || proof.challenge !== request.challenge ||
            proof.teamId !== teamId || proof.type !== 'plexus.membership.current.v1' || accountId(owner?.user) !== account.id ||
            !await verifySignature(owner, operationBody(proof), proof.signature)) throw problem('membership_proof_invalid', 403);
        request.proof = proof;
        return reply(200, { answered: true });
      }
      if (parts[0] === 'ack-revocation') {
        if (!principal.runtimeId) throw problem('host_required', 403);
        return reply(200, await this.acknowledgeRevocation(teamId, principal.runtimeId, body));
      }
      if (parts[0] === 'announce') return reply(200, this.announce(teamId, account.id, body.endpoint));
      if (['bootstrap', 'confirm', 'revoke-endpoint', 'own-project', 'grant', 'revoke-grant'].includes(parts[0])) {
        return reply(200, await this.signedMutation(teamId, account, parts[0], body));
      }
      throw problem('enrollment_route_required', 404);
    } catch (error) {
      // Same discipline as the task routes: fixed codes, never a reflected request or an
      // exception message that might carry one.
      reply(error.status || 400, { error: error.code || 'enrollment_request_refused' });
    }
  }
}

module.exports = { Enrollment, ROLES, STATES };
