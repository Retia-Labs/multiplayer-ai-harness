'use strict';
// Public enrollment routes with actual Matrix device signatures and independently
// generated Ed25519 recovery-key fixtures. SDK secret import/drill has its own seam.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Hub } = require('../packages/hub/server');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EnrollmentTransport, announcement } = require('../packages/e2ee/enrollment.mjs');
const { canonical, digest, matrixUser } = require('../packages/protocol/encrypted-task.mjs');
const { signMembership, operationBody, replayMembership, currentMembershipBody } = require('../packages/e2ee/membership.mjs');
const identity = endpoint => Object.fromEntries(['user', 'device', 'curve25519', 'ed25519'].map(key => [key, endpoint.identity()[key]]));
const recoveryKey = () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  return { masterKey: pair.publicKey.export({ format: 'jwk' }).x.replace(/-/g, '+').replace(/_/g, '/'),
    sign: body => crypto.sign(null, Buffer.from(canonical({ type: 'plexus.owner-recovery.claim.v1', operation: body })), pair.privateKey).toString('base64'),
    rawSign: body => crypto.sign(null, Buffer.from(canonical(body)), pair.privateKey).toString('base64') };
};
async function fixture(t, { service } = {}) {
  const hub = new Hub({ service, log() {} }), endpoints = [];
  t.after(async () => { for (const endpoint of endpoints) endpoint.close(); await hub.close(); });
  const address = await hub.listen(), url = 'http://127.0.0.1:' + address.port;
  const owner = hub.store.createAccount('owner'), peerAccount = hub.store.createAccount('peer');
  const team = hub.store.createTeam('Customer authority recovery', owner.id);
  const invitation = hub.store.createInvitation(team.id, owner.id, peerAccount.id);
  hub.store.redeemInvitation(invitation.code, peerAccount.id);
  const make = async (account, device) => {
    const endpoint = await Endpoint.create({ user: matrixUser(account.id), device,
      transport: new HubKeyTransport({ url, token: account.token, device }) });
    endpoints.push(endpoint);
    return { endpoint, enrollment: new EnrollmentTransport({ url, service: service || url, token: account.token, endpoint }) };
  };
  const original = await make(owner, 'ORIGINAL'), peer = await make(peerAccount, 'PEER'), candidate = await make(owner, 'RECOVERED');
  await original.enrollment.bootstrap(team.id, announcement(original.endpoint));
  const genesis = identity(original.endpoint);
  for (const client of [peer, candidate]) {
    await client.enrollment.pinAuthority(team.id, genesis);
    await client.enrollment.announce(team.id, announcement(client.endpoint));
  }
  await original.enrollment.confirm(team.id, 'ORIGINAL', { userId: peerAccount.id, ...announcement(peer.endpoint) });
  const key = recoveryKey();
  const descriptor = { version: 1, purpose: 'owner-endpoint-recovery-with-host-local-activation', service: service || url,
    teamId: team.id, owner: genesis.user, genesis, generation: 1, masterKey: key.masterKey };
  const head = async (client = original) => client.enrollment.signedHead(team.id, await client.enrollment.state(team.id));
  const claim = async (client = candidate, changes = {}, useKey = key) => {
    const payload = { descriptorHash: await digest(descriptor), generation: 1, epoch: crypto.randomBytes(16).toString('hex'),
      candidate: identity(client.endpoint), ...changes };
    const record = await signMembership(client.endpoint, await head(client), 'owner.recover', payload);
    return { ...record, masterSignature: useKey.sign(operationBody(record)) };
  };
  const publish = (record, client = candidate) => client.enrollment.request('/owner.recover', {
    teamId: team.id, ...record.payload, operation: record });
  return { hub, url, team, owner, peerAccount, original, peer, candidate, descriptor, key, head, claim, publish, make, genesis };
}

test('owner prepares a signed recovery descriptor without publishing and commits the exact drilled prefix', async t => {
  const f = await fixture(t);
  const before = await f.head();
  const prepared = await f.original.enrollment.prepareRecovery(f.team.id, f.descriptor);
  assert.equal((await f.head()).seq, before.seq, 'preparing customer material must not invalidate existing authority');
  const staged = await replayMembership(prepared.log, { teamId: f.team.id, authority: f.genesis, service: f.url });
  assert.deepEqual(staged.recoveryDescriptor, f.descriptor);
  await f.original.enrollment.commitRecovery(f.team.id, prepared);
  const current = await f.head();
  assert.deepEqual(current.owner, f.genesis);
  assert.deepEqual(current.recoveryDescriptor, f.descriptor);
  assert.equal(current.recoveryGeneration, 1);
  assert.equal(current.recoveryEpoch, null);
});

test('customer recovery admits only the new owner identity and resets live authorization while retaining tombstones', async t => {
  const f = await fixture(t);
  const removed = await f.make(f.peerAccount, 'REMOVED');
  await removed.enrollment.announce(f.team.id, announcement(removed.endpoint));
  await f.original.enrollment.confirm(f.team.id, 'ORIGINAL', { userId: f.peerAccount.id, ...announcement(removed.endpoint) });
  await f.original.enrollment.revokeEndpoint(f.team.id, { userId: f.peerAccount.id, device: 'REMOVED' });
  const projectId = 'ep_' + 'a'.repeat(32);
  await f.original.enrollment.ownProject(f.team.id, projectId);
  await f.original.enrollment.grant(f.team.id, projectId, f.peerAccount.id);
  await f.original.enrollment.configureRecovery(f.team.id, f.descriptor);
  const prefix = (await f.original.enrollment.state(f.team.id)).authorityLog;
  const claim = await f.claim();
  await f.publish(claim);
  const current = await f.head(f.candidate), projected = await f.candidate.enrollment.state(f.team.id);
  assert.deepEqual(current.owner, f.genesis, 'recoverable key never replaces historical genesis');
  assert.deepEqual(projected.authorityLog.slice(0, prefix.length), prefix);
  assert.equal(current.recoveryEpoch, claim.payload.epoch);
  assert.deepEqual(current.endpoints.filter(entry => entry.state === 'verified').map(entry => entry.device), ['RECOVERED']);
  for (const device of ['ORIGINAL', 'PEER']) {
    assert.equal(current.endpoints.find(entry => entry.device === device).state, 'pending');
    assert.equal(projected.endpoints.find(entry => entry.device === device).state, 'pending');
  }
  assert.equal(current.endpoints.find(entry => entry.device === 'REMOVED').state, 'revoked');
  assert.equal(projected.endpoints.find(entry => entry.device === 'REMOVED').state, 'revoked');
  assert.ok(current.grants.every(grant => grant.revoked && grant.resetByRecovery === current.recoveryEpoch));
  assert.deepEqual(projected.projects, []);
  await assert.rejects(() => f.original.enrollment.grant(f.team.id, projectId, f.peerAccount.id), /confirming_endpoint_unverified/);
  await f.candidate.enrollment.ownProject(f.team.id, projectId);
  await f.candidate.enrollment.confirm(f.team.id, 'RECOVERED', { userId: f.peerAccount.id, ...announcement(f.peer.endpoint) });
  const reclaimed = await f.head(f.candidate);
  assert.equal(reclaimed.endpoints.find(entry => entry.device === 'PEER').state, 'verified');
  assert.equal(reclaimed.grants.find(grant => grant.userId === f.owner.id).revoked, false);
  assert.equal(reclaimed.grants.find(grant => grant.userId === f.peerAccount.id).revoked, true, 'endpoint confirmation cannot revive old project access');
  assert.equal((await f.publish(claim)).duplicate, true, 'uncertain publication retries are exact and idempotent');
});

test('retiring recovery material prevents reuse of old keys and old-generation claims', async t => {
  const f = await fixture(t);
  await f.original.enrollment.configureRecovery(f.team.id, f.descriptor);
  const oldClaim = await f.claim();
  await f.original.enrollment.revokeRecovery(f.team.id, { descriptorHash: await digest(f.descriptor), generation: 1 });
  assert.equal((await f.head()).recoveryDescriptor, null);
  await assert.rejects(() => f.publish(oldClaim), /recovery_descriptor_mismatch/);
  await assert.rejects(() => f.original.enrollment.configureRecovery(f.team.id, { ...f.descriptor, generation: 2 }), /recovery_master_key_reused/);
  const nextKey = recoveryKey(), descriptor = { ...f.descriptor, generation: 2, masterKey: nextKey.masterKey };
  await f.original.enrollment.configureRecovery(f.team.id, descriptor);
  const newClaim = await f.claim(f.candidate, { descriptorHash: await digest(descriptor), generation: 2 });
  await assert.rejects(() => f.publish(newClaim), /recovery_signature_invalid/, 'old key cannot sign a new-generation claim learned from the relay');
  const stale = await f.claim();
  await assert.rejects(() => f.publish(stale), /recovery_descriptor_mismatch/);
  await f.publish({ ...newClaim, masterSignature: nextKey.sign(operationBody(newClaim)) });
  assert.equal((await f.head(f.candidate)).recoveryGeneration, 2);
});

test('device and master signatures bind the exact account, candidate, descriptor, epoch and parent', async t => {
  const f = await fixture(t);
  await f.original.enrollment.configureRecovery(f.team.id, f.descriptor);
  const valid = await f.claim(), before = await f.head();
  const check = async (record, pattern, client = f.candidate) => {
    await assert.rejects(() => f.publish(record, client), pattern);
    assert.equal((await f.head()).hash, before.hash, 'refusal leaves the authenticated state unchanged');
  };
  await check({ ...valid, masterSignature: recoveryKey().sign(operationBody(valid)) }, /recovery_signature_invalid/);
  await check({ ...valid, masterSignature: undefined }, /recovery_signature_invalid/);
  await check({ ...valid, signature: await f.peer.endpoint.sign(canonical(operationBody(valid))) }, /enrollment_signature_invalid/);
  for (const change of [
    { descriptorHash: 'a'.repeat(64) }, { generation: 2 }, { epoch: 'b'.repeat(32) },
    { candidate: identity(f.original.endpoint) }
  ]) await check({ ...valid, payload: { ...valid.payload, ...change } }, /enrollment_signature_invalid/);
  const wrongDescriptor = await f.claim(f.candidate, { descriptorHash: 'c'.repeat(64) });
  await check(wrongDescriptor, /recovery_descriptor_mismatch/);
  const wrongGeneration = await f.claim(f.candidate, { generation: 2 });
  await check(wrongGeneration, /recovery_descriptor_mismatch/);
  const wrongAccount = await f.claim(f.peer);
  await check(wrongAccount, /owner_recovery_refused/, f.peer);
  const reusedIdentity = await f.claim(f.original);
  await check(reusedIdentity, /recovery_candidate_not_new/, f.original);
  const wrongParentBody = { ...operationBody(valid), previous: 'd'.repeat(64) };
  await check({ ...wrongParentBody, signature: await f.candidate.endpoint.sign(canonical(wrongParentBody)),
    masterSignature: f.key.sign(wrongParentBody) }, /membership_sequence_conflict/);
  await check({ ...valid, masterSignature: f.key.rawSign(operationBody(valid)) }, /recovery_signature_invalid/,
    f.candidate);
  await assert.rejects(() => f.publish(valid, f.peer), /enrollment_signature_invalid/, 'account bearer must match the signed candidate');
  await f.publish(valid);
  const after = await f.head(f.candidate), log = (await f.candidate.enrollment.state(f.team.id)).authorityLog;
  await assert.rejects(() => replayMembership(log.slice(0, -1), { teamId: f.team.id, authority: f.genesis, checkpoint: after, service: f.url }), /membership_rollback/);
  await assert.rejects(() => replayMembership(log, { teamId: f.team.id, authority: f.genesis, service: 'https://other.example' }), /recovery_context_mismatch/);
});

test('recovery master possession cannot configure authority, grant projects or answer ordinary owner challenges', async t => {
  const f = await fixture(t);
  await f.original.enrollment.configureRecovery(f.team.id, f.descriptor);
  const projectId = 'ep_' + 'b'.repeat(32);
  await f.original.enrollment.ownProject(f.team.id, projectId);
  for (const action of ['own-project', 'grant', 'recovery.configure']) {
    const payload = action === 'own-project' ? { projectId } : action === 'grant'
      ? { projectId, userId: f.peerAccount.id } : { descriptor: { ...f.descriptor, generation: 2, masterKey: recoveryKey().masterKey } };
    const record = await signMembership(f.candidate.endpoint, await f.head(), action, payload);
    await assert.rejects(() => f.candidate.enrollment.request('/' + action, { teamId: f.team.id, ...payload,
      operation: { ...record, masterSignature: f.key.sign(operationBody(record)) } }), /owner_recovery_purpose_required/);
    await assert.rejects(() => f.candidate.enrollment.request('/' + action, { teamId: f.team.id, ...payload, operation: record }), /confirming_endpoint_unverified/);
  }
  await assert.rejects(() => f.peer.enrollment.configureRecovery(f.team.id, { ...f.descriptor, generation: 2, masterKey: recoveryKey().masterKey }), /recovery_owner_required/);
  const before = await f.head();
  const claim = await f.claim();
  await assert.rejects(() => f.candidate.enrollment.request('/owner.recover', { teamId: f.team.id, ...claim.payload }), /enrollment_signature_required/);
  const runtimeId = 'rt_master_refusal', token = crypto.randomBytes(24).toString('hex'), challenge = crypto.randomBytes(24).toString('hex');
  f.hub.store.pairRuntime(runtimeId, f.team.id, f.owner.id, token);
  const response = await fetch(f.url + '/api/enrollment/challenge', { method: 'POST', headers: {
    Authorization: 'Bearer ' + token, 'X-Plexus-Runtime': runtimeId, 'Content-Type': 'application/json'
  }, body: JSON.stringify({ teamId: f.team.id, challenge }) });
  assert.equal(response.status, 200);
  const proof = currentMembershipBody(f.team.id, challenge, before);
  await assert.rejects(() => f.candidate.enrollment.request('/answer-challenge', { teamId: f.team.id, runtimeId,
    proof: { ...proof, signature: f.key.rawSign(proof) } }), /membership_proof_invalid/);
  assert.equal((await f.head()).hash, before.hash);
});

test('prepared descriptor publication never rebases after the customer recovery drill', async t => {
  const f = await fixture(t);
  const prepared = await f.original.enrollment.prepareRecovery(f.team.id, f.descriptor);
  await f.original.enrollment.ownProject(f.team.id, 'ep_' + 'c'.repeat(32));
  await assert.rejects(() => f.original.enrollment.commitRecovery(f.team.id, prepared), /membership_sequence_conflict/);
  assert.equal((await f.head()).recoveryDescriptor, null);
  const fresh = await f.original.enrollment.prepareRecovery(f.team.id, f.descriptor);
  await f.original.enrollment.commitRecovery(f.team.id, fresh);
  await f.original.enrollment.commitRecovery(f.team.id, fresh);
  assert.equal((await f.head()).seq, fresh.operation.seq, 'exact uncertain commit retries add no second record');
});

test('descriptor authorization refuses foreign context, extra capabilities and generation gaps at the hub', async t => {
  const f = await fixture(t), before = await f.head();
  const variants = [
    { ...f.descriptor, service: 'https://other.example' },
    { ...f.descriptor, service: f.url + '/path' },
    { ...f.descriptor, service: f.url + '/' },
    { ...f.descriptor, teamId: 'other-team' },
    { ...f.descriptor, owner: matrixUser(f.peerAccount.id) },
    { ...f.descriptor, genesis: identity(f.peer.endpoint), owner: matrixUser(f.peerAccount.id) },
    { ...f.descriptor, generation: 3 },
    { ...f.descriptor, purpose: 'ordinary-membership-authority' },
    { ...f.descriptor, restoreApprovals: true },
    { ...f.descriptor, masterKey: f.descriptor.masterKey + '=' }
  ];
  for (const descriptor of variants) {
    const operation = await signMembership(f.original.endpoint, before, 'recovery.configure', { descriptor });
    await assert.rejects(() => f.original.enrollment.request('/recovery.configure', { teamId: f.team.id, descriptor, operation }),
      /recovery_(context_mismatch|service_mismatch|descriptor_invalid|generation_conflict)/);
  }
  assert.equal((await f.head()).hash, before.hash);
  await f.original.enrollment.configureRecovery(f.team.id, f.descriptor);
  const log = (await f.original.enrollment.state(f.team.id)).authorityLog;
  await assert.rejects(() => replayMembership(log, { teamId: f.team.id, authority: identity(f.peer.endpoint), service: f.url }), /membership_authority_mismatch/);
});

test('recovery cannot reuse revoked identities or old recovery epochs', async t => {
  const f = await fixture(t);
  await f.original.enrollment.confirm(f.team.id, 'ORIGINAL', { userId: f.owner.id, ...announcement(f.candidate.endpoint) });
  await f.original.enrollment.revokeEndpoint(f.team.id, { userId: f.owner.id, device: 'RECOVERED' });
  await f.original.enrollment.configureRecovery(f.team.id, f.descriptor);
  const revokedClaim = await f.claim();
  await assert.rejects(() => f.publish(revokedClaim), /endpoint_revoked/);
  const fresh = await f.make(f.owner, 'FRESH');
  await fresh.enrollment.pinAuthority(f.team.id, f.genesis);
  const first = await f.claim(fresh);
  await f.publish(first, fresh);
  const later = await f.make(f.owner, 'LATER');
  await later.enrollment.pinAuthority(f.team.id, f.genesis);
  const repeated = await f.claim(later, { epoch: first.payload.epoch });
  await assert.rejects(() => f.publish(repeated, later), /recovery_epoch_reused/);
  const current = await f.head(fresh);
  assert.equal(current.endpoints.find(entry => entry.device === 'RECOVERED').state, 'revoked');
  assert.deepEqual(current.endpoints.filter(entry => entry.state === 'verified').map(entry => entry.device), ['FRESH']);
});

test('concurrent recovery proposals cannot both extend the same authenticated parent', async t => {
  const f = await fixture(t);
  await f.original.enrollment.configureRecovery(f.team.id, f.descriptor);
  const second = await f.make(f.owner, 'SECOND');
  await second.enrollment.pinAuthority(f.team.id, f.genesis);
  const claims = [await f.claim(), await f.claim(second)], parent = await f.head();
  const results = await Promise.allSettled([f.publish(claims[0]), f.publish(claims[1], second)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.code, /membership_sequence_conflict/);
  const winner = results[0].status === 'fulfilled' ? 0 : 1;
  const state = await f.head(winner ? second : f.candidate);
  assert.equal(state.seq, parent.seq + 1);
  assert.equal(state.recoveryEpoch, claims[winner].payload.epoch);
  assert.deepEqual(state.endpoints.filter(entry => entry.state === 'verified').map(entry => entry.device), [claims[winner].signer.device]);
});

test('a renamed device cannot recycle prior owner keys through customer recovery', async t => {
  const f = await fixture(t);
  await f.original.enrollment.configureRecovery(f.team.id, f.descriptor);
  const parent = await f.head(), candidate = { ...f.genesis, device: 'RENAMED' };
  const body = { version: 1, teamId: f.team.id, seq: parent.seq + 1, previous: parent.hash, signer: candidate,
    action: 'owner.recover', payload: { descriptorHash: await digest(f.descriptor), generation: 1,
      epoch: crypto.randomBytes(16).toString('hex'), candidate } };
  const record = { ...body, signature: await f.original.endpoint.sign(canonical(body)), masterSignature: f.key.sign(body) };
  await assert.rejects(() => f.publish(record, f.original), /recovery_candidate_not_new/);
  assert.equal((await f.head()).hash, parent.hash);
});

test('trusted desktop proxy transport preserves the actual service binding independently of its local scheme', async t => {
  const f = await fixture(t);
  const proxied = new EnrollmentTransport({ url: 'plexus-app://app', service: f.url, token: f.owner.token, endpoint: f.original.endpoint });
  // The trusted desktop network bridge routes requests while retaining its bundle
  // origin. Cryptographic service identity is still the actual configured service.
  proxied.request = (route, body) => f.original.enrollment.request(route, body);
  await proxied.pinAuthority(f.team.id, f.genesis);
  const prepared = await proxied.prepareRecovery(f.team.id, f.descriptor);
  await proxied.commitRecovery(f.team.id, prepared);
  assert.deepEqual((await proxied.signedHead(f.team.id, await proxied.state(f.team.id))).recoveryDescriptor, f.descriptor);
  const foreign = new EnrollmentTransport({ url: 'plexus-app://app', service: 'https://other.example', endpoint: f.original.endpoint });
  await foreign.pinAuthority(f.team.id, f.genesis);
  const published = await proxied.state(f.team.id);
  await assert.rejects(() => foreign.signedHead(f.team.id, published), /recovery_context_mismatch/);
});

test('a configured public service origin works behind a proxy and forwarded headers cannot choose recovery authority', async t => {
  const f = await fixture(t, { service: 'https://plexus.example' });
  await f.original.enrollment.configureRecovery(f.team.id, f.descriptor);
  assert.equal((await f.head()).recoveryDescriptor.service, 'https://plexus.example');
  const next = { ...f.descriptor, service: 'https://attacker.example', generation: 2, masterKey: recoveryKey().masterKey };
  const operation = await signMembership(f.original.endpoint, await f.head(), 'recovery.configure', { descriptor: next });
  const response = await fetch(f.url + '/api/enrollment/recovery.configure', { method: 'POST', headers: {
    Authorization: 'Bearer ' + f.owner.token, 'Content-Type': 'application/json',
    'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'https'
  }, body: JSON.stringify({ teamId: f.team.id, descriptor: next, operation }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'recovery_context_mismatch');
  assert.equal((await f.head()).recoveryGeneration, 1);
});
