'use strict';
// Action-approval grants, bound so that a captured one cannot be reused.
//
// The encryption layer proves *who sealed a message*. It does not, on its own, stop a
// relay replaying a message it already delivered, or an endpoint acting on an approval that
// belongs to a turn which has since moved on. Those are authorization properties and they
// have to be bound explicitly, which is what this does.
//
// This is not cryptography: every signature and every seal comes from the crypto machine.
// What lives here is the binding and the single-use ledger.
const crypto = require('crypto');

// A grant answers exactly one pending action, on one turn, for one approver device, until
// one moment in time.
function issueGrant({ requestId, turnId, threadId, approverUser, approverDevice, decision, ttlMs = 5 * 60 * 1000, now = Date.now() }) {
  return {
    grantId: 'grant_' + crypto.randomBytes(12).toString('hex'),
    requestId,
    turnId,
    threadId,
    approverUser,
    approverDevice,
    decision,
    issuedAt: now,
    expiresAt: now + ttlMs
  };
}

const Refusals = {
  REPLAYED: 'grant_already_consumed',
  EXPIRED: 'grant_expired',
  WRONG_REQUEST: 'grant_for_another_request',
  STALE_TURN: 'grant_for_a_superseded_turn',
  WRONG_APPROVER: 'grant_from_an_unexpected_endpoint',
  NOT_DECRYPTED: 'grant_was_not_encrypted'
};

// The execution host's ledger. It refuses a grant for a stated reason, and consumes the
// ones it accepts so the same grant can never be acted on twice.
class GrantLedger {
  constructor() { this.consumed = new Map(); }

  // `pending` is what the host is actually waiting for right now.
  check(grant, pending, { now = Date.now(), decrypted = true } = {}) {
    if (!decrypted) return { ok: false, reason: Refusals.NOT_DECRYPTED };
    if (!grant || !grant.grantId) return { ok: false, reason: Refusals.WRONG_REQUEST };
    if (this.consumed.has(grant.grantId)) return { ok: false, reason: Refusals.REPLAYED };
    if (now > grant.expiresAt) return { ok: false, reason: Refusals.EXPIRED };
    if (grant.requestId !== pending.requestId) return { ok: false, reason: Refusals.WRONG_REQUEST };
    // The turn is the freshness anchor: an approval for a turn that has been superseded is
    // an approval for work that no longer exists, however recently it was issued.
    if (grant.turnId !== pending.turnId) return { ok: false, reason: Refusals.STALE_TURN };
    if (pending.approverDevice && grant.approverDevice !== pending.approverDevice) {
      return { ok: false, reason: Refusals.WRONG_APPROVER };
    }
    return { ok: true };
  }

  consume(grant) {
    this.consumed.set(grant.grantId, Date.now());
    return { ok: true, decision: grant.decision };
  }

  // Recovery restores history, not authority. A grant recovered from a backup is still
  // expired or still consumed, because the ledger and the clock both survive it.
  resolve(grant, pending, opts) {
    const verdict = this.check(grant, pending, opts);
    if (!verdict.ok) return verdict;
    return this.consume(grant);
  }
}

module.exports = { issueGrant, GrantLedger, Refusals };
