'use strict';
// Real endpoint signatures and EnrollmentTransport/hub routes. Host-local signer
// selection, key rotation and application receipts are tested by the host suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../packages/hub/server');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EnrollmentTransport, announcement, announceEndpoint } = require('../packages/e2ee/enrollment.mjs');
const { matrixUser, canonical } = require('../packages/protocol/encrypted-task.mjs');
const { currentMembershipBody, signMembership, verifySignature } = require('../packages/e2ee/membership.mjs');

const identity = endpoint => Object.fromEntries(['user', 'device', 'curve25519', 'ed25519']
  .map(key => [key, endpoint.identity()[key]]));

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-genesis-revocation-'));
  const hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite'), log() {} });
  const endpoints = [];
  t.after(async () => { for (const endpoint of endpoints) endpoint.close(); await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const address = await hub.listen(), url = 'http://127.0.0.1:' + address.port;
  const owner = hub.store.createAccount('owner'), teammate = hub.store.createAccount('teammate');
  const team = hub.store.createTeam('Original device removal', owner.id);
  const invitation = hub.store.createInvitation(team.id, owner.id, teammate.id);
  hub.store.redeemInvitation(invitation.code, teammate.id);
  const make = async (account, device) => {
    const endpoint = await Endpoint.create({ user: matrixUser(account.id), device,
      transport: new HubKeyTransport({ url, token: account.token, device }) });
    endpoints.push(endpoint);
    return { endpoint, enrollment: new EnrollmentTransport({ url, token: account.token, endpoint }) };
  };
  const original = await make(owner, 'ORIGINAL'), peer = await make(teammate, 'TEAMMATE');
  const replacement = await make(owner, 'REPLACEMENT');
  await original.enrollment.bootstrap(team.id, announcement(original.endpoint));
  for (const client of [peer, replacement]) {
    await client.enrollment.pinAuthority(team.id, identity(original.endpoint));
    await client.enrollment.announce(team.id, announcement(client.endpoint));
  }
  await original.enrollment.confirm(team.id, 'ORIGINAL', { userId: teammate.id, ...announcement(peer.endpoint) });
  const confirmReplacement = () => peer.enrollment.confirm(team.id, 'TEAMMATE', { userId: owner.id, ...announcement(replacement.endpoint) });
  const head = async (client = replacement) => client.enrollment.signedHead(team.id, await client.enrollment.state(team.id));
  const target = { userId: owner.id, device: 'ORIGINAL' };
  const removeOriginal = () => replacement.enrollment.revokeEndpoint(team.id, target);
  const host = (runtimeId) => {
    const token = crypto.randomBytes(24).toString('hex');
    hub.store.pairRuntime(runtimeId, team.id, owner.id, token);
    const request = async (route, body) => {
      const response = await fetch(url + '/api/enrollment' + route, {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token,
          'X-Plexus-Runtime': runtimeId, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error), { code: value.error });
      return value;
    };
    return { runtimeId, request, state: () => request('?team=' + encodeURIComponent(team.id)) };
  };
  return { hub, url, owner, teammate, team, original, peer, replacement, confirmReplacement, head, target, removeOriginal, host };
}

test('a teammate-verified owner replacement removes the original device without replacing genesis or project grants', async t => {
  const f = await fixture(t); await f.confirmReplacement();
  const projectId = 'ep_' + 'a'.repeat(32);
  await f.original.enrollment.ownProject(f.team.id, projectId);
  const before = await f.head();
  const beforeLog = (await f.replacement.enrollment.state(f.team.id)).authorityLog;
  const removal = await f.removeOriginal();
  assert.equal(removal.endpoint.state, 'revoked');
  const after = await f.head();
  const afterLog = (await f.replacement.enrollment.state(f.team.id)).authorityLog;
  assert.deepEqual(after.owner, before.owner, 'owner remains the immutable original four-field identity');
  assert.deepEqual(afterLog.slice(0, beforeLog.length), beforeLog, 'every prior signed record is retained byte-for-byte');
  assert.deepEqual(after.grants, before.grants, 'device removal neither creates nor restores project grants');
  assert.equal(after.endpoints.find(endpoint => endpoint.device === 'ORIGINAL').state, 'revoked');
  assert.equal(after.endpoints.find(endpoint => endpoint.device === 'REPLACEMENT').state, 'verified');
  assert.deepEqual(after.revocations.at(-1), { ...f.target, seq: after.seq });
  assert.deepEqual(afterLog.at(-1).signer, identity(f.replacement.endpoint));
  await f.replacement.enrollment.grant(f.team.id, projectId, f.teammate.id);
  assert.deepEqual((await f.head()).owner, before.owner, 'later authorized operations still replay under the original root');
});

test('removing the original disables even preissued v1 proofs while the exact replacement still answers v2', async t => {
  const f = await fixture(t); await f.confirmReplacement();
  const legacy = f.host('rt_legacy'), modern = f.host('rt_replacement');
  const challenge = crypto.randomBytes(24).toString('hex');
  await legacy.request('/challenge', { teamId: f.team.id, challenge });
  const before = await f.head();
  const priorBody = currentMembershipBody(f.team.id, challenge, before);
  const priorProof = { ...priorBody, signature: await f.original.endpoint.sign(canonical(priorBody)) };
  await f.removeOriginal();
  const current = await f.head();
  const currentBody = currentMembershipBody(f.team.id, challenge, current);
  const currentProof = { ...currentBody, signature: await f.original.endpoint.sign(canonical(currentBody)) };
  assert.deepEqual(await f.original.enrollment.answerChallenges(f.team.id), { answered: 0 });
  for (const proof of [priorProof, currentProof]) {
    await assert.rejects(() => f.original.enrollment.request('/answer-challenge', {
      teamId: f.team.id, runtimeId: legacy.runtimeId, proof
    }), /membership_proof_invalid/, 'possession of the removed original key cannot answer even an outstanding legacy nonce');
  }
  assert.equal((await legacy.state()).currentProof, null);
  const request = { teamId: f.team.id, challenge: crypto.randomBytes(24).toString('hex'),
    signer: identity(f.replacement.endpoint), activationId: crypto.randomBytes(16).toString('hex') };
  await modern.request('/challenge', request);
  assert.deepEqual(await f.replacement.enrollment.answerChallenges(f.team.id), { answered: 1 });
  const { signature, ...body } = (await modern.state()).currentProof;
  assert.equal(body.type, 'plexus.membership.current.v2');
  assert.equal(body.runtimeId, modern.runtimeId); assert.equal(body.activationId, request.activationId);
  assert.equal(body.seq, current.seq); assert.equal(body.hash, current.hash);
  assert.equal(await verifySignature(request.signer, body, signature), true);
  assert.equal(await verifySignature(identity(f.original.endpoint), body, signature), false);
  assert.deepEqual((await f.head()).owner, before.owner);
});

test('a removal committed while proof verification awaits prevents the old original answer from being published', async t => {
  const f = await fixture(t); await f.confirmReplacement();
  const legacy = f.host('rt_concurrent_legacy'), challenge = crypto.randomBytes(24).toString('hex');
  await legacy.request('/challenge', { teamId: f.team.id, challenge });
  const body = currentMembershipBody(f.team.id, challenge, await f.head());
  const proof = { ...body, signature: await f.original.endpoint.sign(canonical(body)) };
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const verify = globalThis.crypto.subtle.verify.bind(globalThis.crypto.subtle);
  // Only delay the platform's real signature verification. Both HTTP requests and
  // every signature/policy check remain real; no forged verification result is used.
  t.mock.method(globalThis.crypto.subtle, 'verify', async (algorithm, key, signature, data) => {
    if (new TextDecoder().decode(data) === canonical(body)) { enter(); await gate; }
    return verify(algorithm, key, signature, data);
  });
  try {
    const refused = assert.rejects(() => f.original.enrollment.request('/answer-challenge', {
      teamId: f.team.id, runtimeId: legacy.runtimeId, proof
    }), /membership_proof_invalid/);
    await entered;
    assert.equal((await f.removeOriginal()).endpoint.state, 'revoked');
    release(); await refused;
    assert.equal((await legacy.request('?team=' + f.team.id)).currentProof, null);
  } finally { release(); t.mock.restoreAll(); }
});

test('original self-removal, pending or foreign signers, and an owner bearer token cannot remove genesis', async t => {
  const f = await fixture(t);
  const before = await f.original.enrollment.state(f.team.id);
  await assert.rejects(() => f.original.enrollment.revokeEndpoint(f.team.id, f.target), /membership_authority_rotation_required/);
  await assert.rejects(f.removeOriginal, /confirming_endpoint_unverified/);
  await assert.rejects(() => f.peer.enrollment.revokeEndpoint(f.team.id, f.target), /endpoint_revocation_refused/);
  const bearer = new EnrollmentTransport({ url: f.url, token: f.owner.token });
  await assert.rejects(() => bearer.revokeEndpoint(f.team.id, f.target), /enrollment_signature_required/);
  await assert.rejects(() => bearer.request('/revoke-endpoint', { teamId: f.team.id, target: f.target }), /enrollment_signature_required/);
  const counterfeit = await signMembership(f.peer.endpoint, await f.head(), 'revoke-endpoint', { target: f.target });
  counterfeit.signer = identity(f.original.endpoint);
  await assert.rejects(() => bearer.request('/revoke-endpoint', {
    teamId: f.team.id, target: f.target, operation: counterfeit
  }), /enrollment_signature_invalid/, 'a server account cannot substitute the identity on another endpoint signature');
  assert.deepEqual((await f.original.enrollment.state(f.team.id)).authorityLog, before.authorityLog);
});

test('a removed original cannot mutate membership or reannounce its fingerprint into trusted standing', async t => {
  const f = await fixture(t); await f.confirmReplacement();
  const projectId = 'ep_' + 'b'.repeat(32);
  await f.original.enrollment.ownProject(f.team.id, projectId);
  await f.removeOriginal();
  const removed = await f.head();
  const before = await f.replacement.enrollment.state(f.team.id);
  for (const mutation of [
    () => f.original.enrollment.ownProject(f.team.id, 'ep_' + 'c'.repeat(32)),
    () => f.original.enrollment.grant(f.team.id, projectId, f.teammate.id),
    () => f.original.enrollment.revokeGrant(f.team.id, projectId, f.owner.id),
    () => f.original.enrollment.confirm(f.team.id, 'ORIGINAL', { userId: f.owner.id, ...announcement(f.replacement.endpoint) }),
    () => f.original.enrollment.revokeEndpoint(f.team.id, { userId: f.owner.id, device: 'REPLACEMENT' })
  ]) await assert.rejects(mutation, /confirming_endpoint_unverified/);
  await assert.rejects(() => f.original.enrollment.bootstrap(f.team.id, announcement(f.original.endpoint)), /membership_bootstrap_refused/);
  const reannounced = await f.original.enrollment.announce(f.team.id, announcement(f.original.endpoint));
  assert.equal(reannounced.endpoint.state, 'revoked'); assert.equal(reannounced.known, true);
  await assert.rejects(() => announceEndpoint(f.original.endpoint, f.original.enrollment, f.team.id), /endpoint_not_announced/);
  await assert.rejects(() => f.replacement.enrollment.confirm(f.team.id, 'REPLACEMENT', {
    userId: f.owner.id, ...announcement(f.original.endpoint)
  }), /endpoint_revoked/, 'another verified endpoint cannot erase the old fingerprint tombstone');
  await assert.rejects(() => f.original.enrollment.announce(f.team.id, {
    ...announcement(f.replacement.endpoint), device: 'ORIGINAL'
  }), /endpoint_device_id_reused/);
  assert.deepEqual(await f.head(), removed);
  assert.deepEqual((await f.replacement.enrollment.state(f.team.id)).authorityLog, before.authorityLog);
});
