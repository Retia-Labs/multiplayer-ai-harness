'use strict';
// A host-local appointment is separate from the immutable membership genesis and
// from action approval. Relay records may nominate a device, never appoint it here.
const crypto = require('node:crypto');
const { sameIdentity, GENESIS } = require('../e2ee/membership.mjs');
const { canonical } = require('../protocol/encrypted-task.mjs');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const identity = value => {
  const keys = ['user', 'device', 'curve25519', 'ed25519'];
  if (!value || !keys.every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length < 200)) fail('freshness_candidate_unverified');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
};
const checkpoint = value => ({ seq: value?.seq || 0, hash: value?.hash || GENESIS });
const same = (left, right) => canonical(left) === canonical(right);
const validCheckpoint = value => Number.isSafeInteger(value?.seq) && value.seq > 0 && /^[a-f0-9]{64}$/.test(value.hash || '');

class FreshnessAuthority {
  constructor({ state, teamId, runtimeId, genesis }) {
    this.state = state; this.teamId = teamId; this.runtimeId = runtimeId;
    this.genesis = identity(genesis);
    this.key = 'freshness:' + teamId;
    this.authorizationKey = 'authorization:' + teamId;
    this.proposals = new Map();
  }
  record() {
    const value = this.state.load(this.key);
    if (!value) return null;
    if (value.version !== 1 || value.teamId !== this.teamId || value.runtimeId !== this.runtimeId ||
        !sameIdentity(value.genesis, this.genesis) || !sameIdentity(identity(value.signer), value.signer) ||
        value.signer.user !== this.genesis.user || !/^[a-f0-9]{32}$/.test(value.activationId || '') ||
        !validCheckpoint(value.checkpoint) || !['active', 'revoked'].includes(value.state)) fail('freshness_state_invalid');
    return value;
  }
  signer() { return this.record()?.signer || this.genesis; }
  context() {
    const record = this.record();
    return record ? { runtimeId: this.runtimeId, activationId: record.activationId } : undefined;
  }
  verifiedSigner(head) {
    const signer = this.signer();
    return head.endpoints.some(row => row.state === 'verified' && sameIdentity(row, signer));
  }
  isRevoked(head) {
    return this.record()?.state === 'revoked' || head.endpoints.some(row => row.state === 'revoked' && sameIdentity(row, this.signer()));
  }
  markRevoked(head) {
    const record = this.record();
    if (!record) fail('freshness_state_invalid');
    const floor = checkpoint(head);
    this.state.saveMany([[this.authorizationKey, floor], [this.key, { ...record, state: 'revoked', revokedAt: floor }]]);
    this.proposals.clear();
  }
  prepare(candidate, head, generation) {
    candidate = identity(candidate);
    if (candidate.user !== this.genesis.user) fail('freshness_candidate_not_owner');
    if (!head.endpoints.some(row => row.state === 'verified' && sameIdentity(row, candidate))) fail('freshness_candidate_unverified');
    if (sameIdentity(candidate, this.signer())) fail('freshness_candidate_unchanged');
    const proposalId = crypto.randomBytes(24).toString('hex');
    const proposal = { proposalId, teamId: this.teamId, runtimeId: this.runtimeId, candidate,
      previousSigner: this.signer(), checkpoint: checkpoint(head),
      priorCheckpoint: checkpoint(this.state.load(this.authorizationKey)), expiresAt: Date.now() + 120000,
      accessSummary: { verifiedEndpoints: head.endpoints.filter(row => row.state === 'verified').length,
        projectGrants: head.grants.filter(grant => !grant.revoked).length } };
    // Only one local confirmation is outstanding. Neither a renderer's echoed head
    // nor a predictable device identifier can supply this single-use capability.
    this.proposals.clear();
    this.proposals.set(proposalId, { proposal, generation, priorRecord: this.record() });
    return structuredClone(proposal);
  }
  commit(proposalId, head, generation) {
    const pending = this.proposals.get(proposalId);
    if (!pending) fail('freshness_confirmation_required');
    this.proposals.delete(proposalId);
    const { proposal, priorRecord } = pending;
    if (Date.now() >= proposal.expiresAt) fail('freshness_confirmation_expired');
    if (generation !== pending.generation || !same(checkpoint(head), proposal.checkpoint) ||
        !same(checkpoint(this.state.load(this.authorizationKey)), proposal.priorCheckpoint) ||
        !same(this.record(), priorRecord)) fail('freshness_confirmation_changed');
    if (!head.endpoints.some(row => row.state === 'verified' && sameIdentity(row, proposal.candidate))) fail('freshness_candidate_unverified');
    const record = { version: 1, teamId: this.teamId, runtimeId: this.runtimeId, genesis: this.genesis,
      signer: proposal.candidate, activationId: crypto.randomBytes(16).toString('hex'),
      checkpoint: proposal.checkpoint, state: 'active' };
    // Both writes commit together. A crash cannot leave a new pin with an older floor
    // or acknowledge an appointment that never reached durable storage.
    this.state.saveMany([[this.authorizationKey, proposal.checkpoint], [this.key, record]]);
    return { activationId: record.activationId, runtimeId: this.runtimeId, teamId: this.teamId,
      signer: record.signer, checkpoint: record.checkpoint };
  }
}
module.exports = { FreshnessAuthority };
