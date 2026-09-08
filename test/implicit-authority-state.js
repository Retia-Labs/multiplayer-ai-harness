'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FreshnessAuthority } = require('../packages/runtime/freshness-authority');
const { EncryptedTaskState } = require('../packages/runtime/encrypted-task');
const original = { user: '@owner:plexus.local', device: 'ORIGINAL', curve25519: 'original-encryption-key', ed25519: 'original-signing-key' };
const replacement = { ...original, device: 'REPLACEMENT', curve25519: 'replacement-encryption-key', ed25519: 'replacement-signing-key' };
const before = { seq: 4, hash: 'a'.repeat(64) };
const removed = { seq: 5, hash: 'b'.repeat(64), grants: [], endpoints: [
  { ...original, state: 'revoked' }, { ...replacement, state: 'verified' }
] };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-implicit-authority-'));
  const file = path.join(dir, 'state.sqlite'), stores = [];
  const open = () => {
    const state = new EncryptedTaskState(file); stores.push(state);
    return { state, authority: new FreshnessAuthority({ state, teamId: 'team', runtimeId: 'runtime', genesis: original }) };
  };
  t.after(() => { for (const state of stores) { try { state.close(); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); });
  const value = open(); value.state.save('authorization:team', before);
  return { ...value, open };
}

test('removal of an implicitly selected original device survives store reopening without inventing an appointment', t => {
  const f = fixture(t);
  assert.equal(f.authority.record(), null);
  f.authority.markRevoked(removed);
  f.state.close();
  const { authority, state } = f.open();
  assert.equal(authority.record().kind, 'implicit-genesis');
  assert.equal(authority.record().state, 'revoked');
  assert.equal(Object.hasOwn(authority.record(), 'activationId'), false);
  assert.equal(authority.context(), undefined, 'a removed implicit signer never becomes a v2 appointment');
  assert.deepEqual(authority.signer(), original);
  assert.deepEqual(state.load('authorization:team'), { seq: removed.seq, hash: removed.hash });
  assert.equal(authority.isRevoked({ endpoints: [{ ...original, state: 'verified' }] }), true, 'old relay rows cannot restore selection');
  const proposal = authority.prepare(replacement, removed, 1);
  assert.deepEqual(proposal.previousSigner, original);
  const receipt = authority.commit(proposal.proposalId, removed, 1);
  assert.match(receipt.activationId, /^[a-f0-9]{32}$/);
  assert.deepEqual(authority.record().genesis, original);
  assert.deepEqual(authority.signer(), replacement);
  assert.equal(authority.record().state, 'active');
});

test('failed implicit revocation storage cannot leave a newer floor with an unpersisted disabled selection', t => {
  const f = fixture(t);
  f.state.db.exec("CREATE TRIGGER fail_implicit BEFORE INSERT ON encrypted_task_state WHEN NEW.id LIKE 'freshness:%' BEGIN SELECT RAISE(ABORT, 'synthetic_disk_failure'); END;");
  assert.throws(() => f.authority.markRevoked(removed), /synthetic_disk_failure/);
  assert.deepEqual(f.state.load('authorization:team'), before);
  assert.equal(f.authority.record(), null);
});

test('corrupt, active or foreign implicit records cannot become trusted selections', t => {
  const f = fixture(t); f.authority.markRevoked(removed);
  const saved = f.authority.record();
  for (const change of [{ state: 'active' }, { activationId: 'c'.repeat(32) }, { signer: replacement },
    { runtimeId: 'another-host' }, { teamId: 'another-team' }, { kind: 'unknown' },
    { revokedAt: { seq: 0, hash: 'd'.repeat(64) } }]) {
    f.state.save('freshness:team', { ...saved, ...change });
    assert.throws(() => f.authority.record(), /freshness_state_invalid/);
  }
});
