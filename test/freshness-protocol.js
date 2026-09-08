'use strict';
// Public endpoint signing and EnrollmentTransport/hub routes; no provider or host pin mutation.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../packages/hub/server');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EnrollmentTransport, announcement } = require('../packages/e2ee/enrollment.mjs');
const { matrixUser, canonical } = require('../packages/protocol/encrypted-task.mjs');
const { currentMembershipBody, verifySignature } = require('../packages/e2ee/membership.mjs');
const identity = endpoint => Object.fromEntries(['user', 'device', 'curve25519', 'ed25519']
  .map(key => [key, endpoint.identity()[key]]));

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-freshness-protocol-'));
  const hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite'), log() {} });
  const endpoints = [];
  t.after(async () => { for (const endpoint of endpoints) endpoint.close(); await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const address = await hub.listen(), url = 'http://127.0.0.1:' + address.port;
  const owner = hub.store.createAccount('owner'), teammate = hub.store.createAccount('teammate');
  const team = hub.store.createTeam('Freshness replacement', owner.id);
  const invitation = hub.store.createInvitation(team.id, owner.id, teammate.id);
  hub.store.redeemInvitation(invitation.code, teammate.id);
  const make = async (account, device) => {
    const endpoint = await Endpoint.create({ user: matrixUser(account.id), device,
      transport: new HubKeyTransport({ url, token: account.token, device }) });
    endpoints.push(endpoint);
    const checkpoints = new Map();
    const persistence = { loadCheckpoint: teamId => checkpoints.get(teamId), saveCheckpoint: (teamId, head) => checkpoints.set(teamId, head) };
    return { endpoint, persistence, enrollment: new EnrollmentTransport({ url, token: account.token, endpoint, ...persistence }) };
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
  const host = (runtimeId = 'rt_freshness') => {
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
    return { runtimeId, enrollment: { request, state: teamId => request('?team=' + encodeURIComponent(teamId)) } };
  };
  const request = (client = replacement) => ({ teamId: team.id, challenge: crypto.randomBytes(24).toString('hex'),
    signer: identity(client.endpoint), activationId: crypto.randomBytes(16).toString('hex') });
  return { dir, hub, url, team, owner, teammate, original, peer, replacement, confirmReplacement, host, request };
}

test('a teammate-confirmed replacement answers only its addressed v2 challenge while legacy hosts retain the original signer', async t => {
  const f = await fixture(t); await f.confirmReplacement();
  const modern = f.host(), legacy = f.host('rt_legacy'), request = f.request();
  const before = await f.original.enrollment.state(f.team.id);
  await modern.enrollment.request('/challenge', request);
  const pending = await f.replacement.enrollment.state(f.team.id);
  assert.deepEqual(pending.challenges, [{ runtimeId: modern.runtimeId, challenge: request.challenge,
    signer: request.signer, activationId: request.activationId }]);
  assert.deepEqual(await f.original.enrollment.answerChallenges(f.team.id), { answered: 0 });
  assert.deepEqual(await f.peer.enrollment.answerChallenges(f.team.id), { answered: 0 });
  assert.deepEqual(await f.replacement.enrollment.answerChallenges(f.team.id), { answered: 1 });
  const proof = (await modern.enrollment.state(f.team.id)).currentProof;
  assert.equal(proof.type, 'plexus.membership.current.v2');
  assert.equal(proof.runtimeId, modern.runtimeId); assert.equal(proof.activationId, request.activationId);
  const { signature, ...body } = proof;
  assert.equal(await verifySignature(request.signer, body, signature), true);
  assert.equal(await verifySignature(identity(f.original.endpoint), body, signature), false);
  const legacyNonce = 'a'.repeat(48);
  await legacy.enrollment.request('/challenge', { teamId: f.team.id, challenge: legacyNonce });
  assert.deepEqual(await f.replacement.enrollment.answerChallenges(f.team.id), { answered: 0 });
  assert.deepEqual(await f.original.enrollment.answerChallenges(f.team.id), { answered: 1 });
  assert.equal((await legacy.enrollment.state(f.team.id)).currentProof.type, 'plexus.membership.current.v1');
  assert.deepEqual((await modern.enrollment.state(f.team.id)).authorityLog, before.authorityLog,
    'challenge routing and answers never replace the genesis or mutate membership');
});

test('a replacement signs no relay-supplied chain without its original pin or below its persisted checkpoint', async t => {
  const f = await fixture(t); await f.confirmReplacement();
  const host = f.host(), request = f.request();
  await host.enrollment.request('/challenge', request);
  const old = await f.replacement.enrollment.state(f.team.id);
  const unpinned = new EnrollmentTransport({ url: f.url, token: f.owner.token, endpoint: f.replacement.endpoint });
  await assert.rejects(() => unpinned.answerChallenges(f.team.id), /membership_authority_required/);
  await f.original.enrollment.revokeEndpoint(f.team.id, { userId: f.owner.id, device: 'REPLACEMENT' });
  assert.deepEqual(await f.replacement.enrollment.answerChallenges(f.team.id), { answered: 0 });

  // An untrusted relay replays the earlier valid chain and its "verified" projection.
  // The replacement's persisted checkpoint, not those rows, decides whether it may sign.
  const http = require('node:http'); let answers = 0;
  const proxy = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(old)); }
    else { answers++; res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"unexpected_answer"}'); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const restarted = new EnrollmentTransport({ url: 'http://127.0.0.1:' + proxy.address().port,
    token: f.owner.token, endpoint: f.replacement.endpoint, ...f.replacement.persistence });
  await assert.rejects(() => restarted.answerChallenges(f.team.id), /membership_rollback/);
  assert.equal(answers, 0);
  assert.equal((await host.enrollment.state(f.team.id)).currentProof, null);
});

test('runtime challenge routing refuses pending, foreign-account and malformed signers without changing membership', async t => {
  const f = await fixture(t), host = f.host();
  const pending = f.request();
  await assert.rejects(() => host.enrollment.request('/challenge', pending), /membership_proof_invalid/);
  await assert.rejects(() => host.enrollment.request('/challenge', f.request(f.peer)), /membership_proof_invalid/);
  await f.confirmReplacement();
  const valid = f.request();
  const invalid = [
    { ...valid, signer: null }, { ...valid, activationId: null },
    { ...valid, activationId: [valid.activationId] }, { ...valid, challenge: [valid.challenge] },
    { ...valid, activationId: 'a'.repeat(31) }, { ...valid, challenge: 'a'.repeat(47) },
    { ...valid, signer: { ...valid.signer, state: 'verified' } },
    { ...valid, signer: { ...valid.signer, device: '' } },
    { ...valid, signer: { ...valid.signer, ed25519: 'not-a-key' } },
    { teamId: f.team.id, challenge: valid.challenge, signer: valid.signer },
    { teamId: f.team.id, challenge: valid.challenge, activationId: valid.activationId },
    { ...valid, runtimeId: 'rt_foreign' }
  ];
  for (const body of invalid) await assert.rejects(() => host.enrollment.request('/challenge', body), /invalid_membership_challenge/);
  const changedKey = { ...valid, signer: { ...valid.signer, ed25519: identity(f.original.endpoint).ed25519 } };
  await assert.rejects(() => host.enrollment.request('/challenge', changedKey), /membership_proof_invalid/);
  await assert.rejects(() => f.replacement.enrollment.request('/challenge', valid), /invalid_membership_challenge/,
    'an account session cannot act as a paired runtime');
  const state = await host.enrollment.state(f.team.id);
  assert.deepEqual(state.challenges, []);
  assert.equal(state.currentProof, null);
  assert.equal(state.authorityLog.length, 3);
});

test('forged relay routing cannot appoint a teammate or pending owner endpoint, or downgrade malformed v2 context', async t => {
  const f = await fixture(t);
  const http = require('node:http');
  let state = await f.original.enrollment.state(f.team.id), challenges = [], answers = 0;
  const proxy = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'GET') res.end(JSON.stringify({ ...state, challenges }));
    else { answers++; res.end('{"answered":true}'); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const throughRelay = async client => {
    const enrollment = new EnrollmentTransport({ url: 'http://127.0.0.1:' + proxy.address().port,
      token: f.owner.token, endpoint: client.endpoint, ...client.persistence });
    return enrollment.answerChallenges(f.team.id);
  };
  for (const client of [f.peer, f.replacement]) {
    challenges = [{ runtimeId: 'rt_forged', ...f.request(client) }];
    assert.deepEqual(await throughRelay(client), { answered: 0 });
  }
  await f.confirmReplacement(); state = await f.replacement.enrollment.state(f.team.id);
  const request = { runtimeId: 'rt_forged', ...f.request() };
  challenges = [
    { ...request, signer: null }, { ...request, activationId: null },
    { ...request, activationId: [request.activationId] }, { ...request, challenge: [request.challenge] },
    { ...request, runtimeId: null }, { ...request, activationId: undefined },
    { ...request, signer: undefined }
  ];
  assert.deepEqual(await throughRelay(f.replacement), { answered: 0 });
  assert.equal(answers, 0, 'no application proof is sent to the relay for these untrusted appointments');
});

test('v2 proofs bind runtime, activation, team, nonce, version and exact device signature', async t => {
  const f = await fixture(t); await f.confirmReplacement();
  const host = f.host(), other = f.host('rt_other');
  const request = f.request();
  await host.enrollment.request('/challenge', request);
  await other.enrollment.request('/challenge', request); // Same nonce/activation still cannot cross runtimes.
  const head = await f.replacement.enrollment.signedHead(f.team.id, await f.replacement.enrollment.state(f.team.id));
  const body = currentMembershipBody(f.team.id, request.challenge, head,
    { runtimeId: host.runtimeId, activationId: request.activationId });
  const proofFor = async (body, endpoint = f.replacement.endpoint) => ({ ...body, signature: await endpoint.sign(canonical(body)) });
  const send = (proof, runtimeId = host.runtimeId, transport = f.replacement.enrollment) => transport.request('/answer-challenge', {
    teamId: f.team.id, runtimeId, proof });
  for (const changed of [
    { ...body, runtimeId: other.runtimeId }, { ...body, activationId: 'f'.repeat(32) },
    { ...body, teamId: 'team_foreign' }, { ...body, challenge: 'e'.repeat(48) },
    { ...body, type: 'plexus.membership.current.v1' }, { ...body, signer: request.signer },
    currentMembershipBody(f.team.id, request.challenge, head)
  ]) await assert.rejects(() => sendProof(changed), /membership_proof_invalid/);
  async function sendProof(changed) { return send(await proofFor(changed)); }
  for (const endpoint of [f.original.endpoint, f.peer.endpoint]) {
    await assert.rejects(() => sendProofFrom(endpoint), /membership_proof_invalid/);
  }
  async function sendProofFrom(endpoint) { return send(await proofFor(body, endpoint)); }
  const proof = await proofFor(body);
  await assert.rejects(() => send(proof, other.runtimeId), /membership_proof_invalid/);
  await assert.rejects(() => send(proof, host.runtimeId, f.peer.enrollment), /membership_proof_invalid/);
  assert.equal((await host.enrollment.state(f.team.id)).currentProof, null);
  const newActivation = { ...request, activationId: 'b'.repeat(32) };
  await host.enrollment.request('/challenge', newActivation);
  await assert.rejects(() => send(proof), /membership_proof_invalid/,
    'a former activation cannot answer a new activation even when its nonce is reused');
  assert.deepEqual(await f.replacement.enrollment.answerChallenges(f.team.id), { answered: 2 });
  assert.equal((await host.enrollment.state(f.team.id)).currentProof.activationId, newActivation.activationId);
});

test('revocation disables a selected replacement at both answer boundaries; original genesis rotation stays unavailable', async t => {
  const f = await fixture(t); await f.confirmReplacement();
  const host = f.host(), request = f.request();
  await host.enrollment.request('/challenge', request);
  const state = await f.replacement.enrollment.state(f.team.id);
  const head = await f.replacement.enrollment.signedHead(f.team.id, state);
  const body = currentMembershipBody(f.team.id, request.challenge, head, {
    runtimeId: host.runtimeId, activationId: request.activationId });
  const proof = { ...body, signature: await f.replacement.endpoint.sign(canonical(body)) };
  await f.original.enrollment.revokeEndpoint(f.team.id, { userId: f.owner.id, device: 'REPLACEMENT' });
  assert.deepEqual(await f.replacement.enrollment.answerChallenges(f.team.id), { answered: 0 });
  await assert.rejects(() => f.replacement.enrollment.request('/answer-challenge', {
    teamId: f.team.id, runtimeId: host.runtimeId, proof }), /membership_proof_invalid/);
  await assert.rejects(() => host.enrollment.request('/challenge', request), /membership_proof_invalid/);
  assert.equal((await host.enrollment.state(f.team.id)).currentProof, null);
  await assert.rejects(() => f.original.enrollment.revokeEndpoint(f.team.id, { userId: f.owner.id, device: 'ORIGINAL' }),
    /membership_authority_rotation_required/, 'this bounded slice does not replace or revoke the immutable genesis authority');
});
