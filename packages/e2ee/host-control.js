'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const { GrantLedger, Refusals } = require('./authorization');

// Local execution-host storage. This never belongs in the relay or a history backup.
class DurableGrantLedger extends GrantLedger {
  constructor(db) { super(); this.db = db; }
  resolve(grant, pending, opts) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.consumed = new Map(this.db.prepare('SELECT grant_id FROM consumed_grants').all().map((r) => [r.grant_id, true]));
      this.resolvedRequests = new Set(this.db.prepare('SELECT request_key FROM consumed_grants').all().map((r) => r.request_key));
      const verdict = this.check(grant, pending, opts);
      if (!verdict.ok) { this.db.exec('ROLLBACK'); return verdict; }
      this.db.prepare('INSERT INTO consumed_grants VALUES (?, ?)').run(grant.grantId,
        JSON.stringify([grant.threadId, grant.turnId, grant.requestId]));
      this.db.exec('COMMIT');
      return { ok: true, decision: grant.decision };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

const sameEndpoint = (identity, event) => identity && identity.user === event.sender &&
  identity.device === event.senderDevice && identity.curve25519 === event.senderKey;

// A bounded control experiment, deliberately separate from the production runtime.
// Reconnect requires a fresh response from the locally pinned membership authority.
// Relay withholding causes unavailability, never a fallback to stale authorization.
class EncryptedHostControl {
  constructor({ endpoint, owner, file }) {
    this.endpoint = endpoint;
    this.owner = owner;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS consumed_grants(grant_id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS membership(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, state TEXT NOT NULL);`);
    this.ledger = new DurableGrantLedger(this.db);
    this.state = this.db.prepare('SELECT state FROM membership WHERE id=1').get();
    this.state = this.state ? JSON.parse(this.state.state) : null;
    this.disconnect();
  }

  disconnect() { this.reconciled = false; this.challenge = null; }
  beginReconcile() {
    this.reconciled = false;
    this.challenge = randomBytes(24).toString('base64url');
    return this.challenge;
  }

  async applyMembership(envelope) {
    const event = await this.endpoint.openControl([envelope]);
    const next = event.content;
    if (!sameEndpoint(this.owner, event)) throw new Error('membership_authority_mismatch');
    if (!this.challenge || next?.challenge !== this.challenge) throw new Error('membership_challenge_mismatch');
    if (next.kind !== 'membership' || !Number.isSafeInteger(next.epoch) || next.epoch < 1 ||
        !Array.isArray(next.members) || !Array.isArray(next.approvers)) throw new Error('membership_invalid');
    const challengeAtStart = this.challenge;
    const canonical = JSON.stringify({ epoch: next.epoch, members: next.members, approvers: next.approvers });
    if (this.state && (next.epoch < this.state.epoch ||
        (next.epoch === this.state.epoch && canonical !== JSON.stringify(this.state)))) throw new Error('membership_rollback');
    for (const member of next.members) {
      if (!member?.user || !member.device || !member.curve25519 || !member.ed25519) throw new Error('membership_invalid');
      await this.endpoint.confirmEndpoint(member, { confirmed: true });
    }
    if (next.approvers.some((id) => !next.members.some((m) => id === m.user + '/' + m.device))) throw new Error('approver_not_member');
    if (!next.members.some((m) => m.user === this.endpoint.user && m.device === this.endpoint.device)) throw new Error('host_removed');
    if (this.challenge !== challengeAtStart) throw new Error('membership_challenge_superseded');
    this.db.prepare('INSERT INTO membership VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,state=excluded.state').run(next.epoch, canonical);
    this.state = JSON.parse(canonical);
    const challenge = this.challenge;
    this.challenge = null;
    this.reconciled = true;
    return this.endpoint.sealControl(this.owner.user, this.owner.device,
      { kind: 'membership.applied', epoch: next.epoch, challenge });
  }

  async resolve(envelope, pending, opts = {}) {
    if (!this.reconciled) return { ok: false, reason: 'membership_reconciliation_required' };
    const event = await this.endpoint.openControl([envelope]);
    if (!this.reconciled) return { ok: false, reason: 'membership_reconciliation_required' };
    const grant = event.content;
    if (!grant || grant.membershipEpoch !== this.state.epoch) return { ok: false, reason: 'membership_epoch_stale' };
    if (!this.state.members.some((m) => sameEndpoint(m, event)) ||
        !this.state.approvers.includes(event.sender + '/' + event.senderDevice)) return { ok: false, reason: 'not_delegated_approver' };
    if (grant.approverUser !== event.sender || grant.approverDevice !== event.senderDevice) return { ok: false, reason: Refusals.WRONG_APPROVER };
    return this.ledger.resolve(grant, pending, { ...opts, decrypted: true });
  }

  close() { this.db.close(); }
}

// Owner-side state becomes applied only after the exact host acknowledges this update.
// No timeout or relay receipt can complete it. The caller retains pending state on error.
class MembershipReceipt {
  constructor({ host, epoch, challenge }) {
    this.host = host; this.epoch = epoch; this.challenge = challenge;
    this.status = 'pending-host-acknowledgment';
  }
  async accept(endpoint, envelope) {
    const event = await endpoint.openControl([envelope]);
    const receipt = event.content;
    if (!sameEndpoint(this.host, event) || receipt?.kind !== 'membership.applied' ||
        receipt.epoch !== this.epoch || receipt.challenge !== this.challenge) throw new Error('membership_receipt_mismatch');
    this.status = 'applied';
    return event;
  }
}

module.exports = { EncryptedHostControl, MembershipReceipt };
