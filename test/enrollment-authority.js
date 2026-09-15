'use strict';
// Public EnrollmentTransport and EncryptedHost acceptance seams, authorized for this repair.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../packages/hub/server');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EnrollmentTransport, announcement } = require('../packages/e2ee/enrollment.mjs');
const { matrixUser } = require('../packages/protocol/encrypted-task.mjs');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-authority-'));
  const hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite'), log: () => {} });
  const addr = await hub.listen();
  const url = 'http://127.0.0.1:' + addr.port;
  const owner = hub.store.createAccount('owner');
  const teammate = hub.store.createAccount('teammate');
  const team = hub.store.createTeam('Encrypted work', owner.id);
  const invitation = hub.store.createInvitation(team.id, owner.id, teammate.id);
  hub.store.redeemInvitation(invitation.code, teammate.id);
  const makeEndpoint = (account, device) => Endpoint.create({ user: matrixUser(account.id), device,
    transport: new HubKeyTransport({ url, token: account.token, device }) });
  const ownerEndpoint = await makeEndpoint(owner, 'OWNER');
  const teammateEndpoint = await makeEndpoint(teammate, 'TEAMMATE');
  const enrollment = new EnrollmentTransport({ url, token: owner.token, endpoint: ownerEndpoint });
  const teammateEnrollment = new EnrollmentTransport({ url, token: teammate.token, endpoint: teammateEndpoint });
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    ownerEndpoint.close(); teammateEndpoint.close(); await hub.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  await enrollment.bootstrap(team.id, announcement(ownerEndpoint));
  await teammateEnrollment.announce(team.id, announcement(teammateEndpoint));
  return { dir, hub, url, owner, teammate, team, ownerEndpoint, teammateEndpoint, enrollment, teammateEnrollment, cleanup };
}

test('an account session cannot impersonate the owner’s confirmed device', async (t) => {
  const f = await fixture(t);
  const stolenSession = new EnrollmentTransport({ url: f.url, token: f.owner.token });
  await assert.rejects(() => stolenSession.request('/confirm', {
    teamId: f.team.id, device: 'OWNER', target: { userId: f.teammate.id, ...announcement(f.teammateEndpoint) }
  }), /enrollment_signature_required/);
  const state = await f.enrollment.state(f.team.id);
  assert.equal(state.endpoints.find((e) => e.device === 'TEAMMATE').state, 'pending');
});

test('a signed owner confirmation admits the intended teammate and cannot be replayed with changed keys', async (t) => {
  const f = await fixture(t);
  const target = { userId: f.teammate.id, ...announcement(f.teammateEndpoint) };
  await f.enrollment.confirm(f.team.id, 'OWNER', target);
  const state = await f.enrollment.state(f.team.id);
  assert.equal(state.endpoints.find((e) => e.device === 'TEAMMATE').state, 'verified');
  const signed = state.authorityLog.at(-1);
  const changed = { ...signed, payload: { ...signed.payload, target: { ...target, ed25519: announcement(f.ownerEndpoint).ed25519 } } };
  await assert.rejects(() => f.enrollment.request('/confirm', { teamId: f.team.id, ...changed.payload, operation: changed }), /enrollment_signature_invalid/);
  await assert.rejects(() => f.teammateEnrollment.request('/confirm', { teamId: f.team.id, ...signed.payload, operation: signed }), /enrollment_signature_invalid/);
});

async function hostFixture(f, t) {
  const http = require('node:http');
  const { EncryptedHost } = require('../packages/runtime/encrypted-host');
  const { EncryptedTaskTransport, createEncryptedTask, newId } = require('../packages/e2ee/task-log.mjs');
  const project = path.join(f.dir, 'project'); fs.mkdirSync(project);
  const runtime = { id: 'rt_authority_test', teamId: f.team.id, runtimeToken: 'runtime-secret-test', encryptedTasksOnly: true,
    projects: new Map([[project, {}]]) };
  f.hub.store.pairRuntime(runtime.id, f.team.id, f.owner.id, runtime.runtimeToken);
  f.hub.store.upsertRuntime(f.team.id, { id: runtime.id, taskProtocol: 'encrypted-v1' });
  const projectId = newId('ep');
  await f.enrollment.ownProject(f.team.id, projectId);
  await f.enrollment.confirm(f.team.id, 'OWNER', { userId: f.teammate.id, ...announcement(f.teammateEndpoint) });
  await f.enrollment.grant(f.team.id, projectId, f.teammate.id);
  let replay = null;
  const proxy = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(f.url + req.url, { method: req.method, headers: req.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      let content = await response.text();
      if (replay && req.method === 'GET' && req.url.startsWith('/api/enrollment?')) {
        const parsed = JSON.parse(content); parsed.authorityLog = replay; content = JSON.stringify(parsed);
      }
      res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(content);
    } catch { res.writeHead(502); res.end('{}'); }
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + proxy.address().port;
  const host = new EncryptedHost({ runtime, url, statePath: path.join(f.dir, 'host.sqlite'),
    projects: new Map([[projectId, project]]), authority: f.ownerEndpoint.identity(), endpointFactory: (options) => Endpoint.create(options) });
  f.cleanup.push(async () => { await host.close(); await new Promise((resolve) => proxy.close(resolve)); });
  const writer = await host.start();
  await f.ownerEndpoint.confirmEndpoint(writer, { confirmed: true });
  await f.teammateEndpoint.confirmEndpoint(writer, { confirmed: true });
  await host.beginReconcile();
  await f.enrollment.answerChallenges(f.team.id);
  await host.reconcileMembership();
  const tasks = new EncryptedTaskTransport({ url, token: f.owner.token });
  const task = { version: 1, id: newId('et'), projectId, runtimeId: runtime.id, teamId: f.team.id, creatorUserId: f.owner.id };
  await createEncryptedTask(f.ownerEndpoint, tasks, { task, writer, payload: { title: 'Authenticated work', objective: 'Keep this task private' } });
  await host.run(task, { runTurn: async (emit) => emit({ method: 'turn/completed', status: 'completed' }) });
  await host.admitParticipants((await tasks.list(f.team.id)).tasks[0]);
  return { host, task, writer, tasks, replay: (records) => { replay = records; } };
}

async function replacementEndpoint(f, t, device = 'REPLACEMENT') {
  const endpoint = await Endpoint.create({ user: matrixUser(f.owner.id), device,
    transport: new HubKeyTransport({ url: f.url, token: f.owner.token, device }) });
  f.cleanup.push(() => endpoint.close());
  const enrollment = new EnrollmentTransport({ url: f.url, token: f.owner.token, endpoint });
  await enrollment.pinAuthority(f.team.id, f.ownerEndpoint.identity());
  await enrollment.announce(f.team.id, announcement(endpoint));
  return { endpoint, enrollment, confirm: () => f.enrollment.confirm(f.team.id, 'OWNER', { userId: f.owner.id, ...announcement(endpoint) }) };
}

test('local authority appointment refuses unverified or foreign candidates and relay rollback', async t => {
  const f = await fixture(t), h = await hostFixture(f, t);
  const candidate = await replacementEndpoint(f, t);
  await assert.rejects(() => h.host.prepareFreshnessAuthority(candidate.endpoint.identity()), /freshness_candidate_unverified/);
  await assert.rejects(() => h.host.prepareFreshnessAuthority(f.teammateEndpoint.identity()), /freshness_candidate_not_owner/);
  await assert.rejects(() => h.host.prepareFreshnessAuthority(f.ownerEndpoint.identity()), /freshness_candidate_unchanged/);
  const older = (await f.enrollment.state(f.team.id)).authorityLog;
  await candidate.confirm();
  await h.host.reconcileMembership();
  h.replay(older);
  await assert.rejects(() => h.host.prepareFreshnessAuthority(candidate.endpoint.identity()), /membership_rollback/);
  assert.equal(h.host.freshness.record(), null);
});

test('a local confirmation cannot survive changed membership or a disconnected host generation', async t => {
  const f = await fixture(t), h = await hostFixture(f, t);
  const candidate = await replacementEndpoint(f, t); await candidate.confirm();
  let proposal = await h.host.prepareFreshnessAuthority(candidate.endpoint.identity());
  await f.enrollment.grant(f.team.id, h.task.projectId, f.teammate.id);
  await assert.rejects(() => h.host.commitFreshnessAuthority(proposal.proposalId), /freshness_confirmation_changed/);
  await assert.rejects(() => h.host.commitFreshnessAuthority(proposal.proposalId), /freshness_confirmation_required/);
  proposal = await h.host.prepareFreshnessAuthority(candidate.endpoint.identity());
  h.host.disconnect();
  await assert.rejects(() => h.host.commitFreshnessAuthority(proposal.proposalId), /freshness_confirmation_changed/);
  assert.equal(h.host.freshness.record(), null);
});

test('failed durable authority activation keeps both the old pin and applied checkpoint', async t => {
  const f = await fixture(t), h = await hostFixture(f, t);
  const candidate = await replacementEndpoint(f, t); await candidate.confirm();
  const key = 'authorization:' + f.team.id;
  const before = h.host.state.load(key);
  const proposal = await h.host.prepareFreshnessAuthority(candidate.endpoint.identity());
  // A storage failure on the second record must roll back the earlier checkpoint write.
  h.host.state.db.exec("CREATE TRIGGER refuse_freshness BEFORE INSERT ON encrypted_task_state WHEN NEW.id LIKE 'freshness:%' BEGIN SELECT RAISE(ABORT, 'synthetic_storage_failure'); END;");
  await assert.rejects(() => h.host.commitFreshnessAuthority(proposal.proposalId), /synthetic_storage_failure/);
  assert.deepEqual(h.host.state.load(key), before);
  assert.equal(h.host.freshness.record(), null);
  assert.equal(h.host.freshness.signer().ed25519, f.ownerEndpoint.identity().ed25519);
});

test('applied replacement revocation persists its disabled pin and never falls back to the original signer', async t => {
  const f = await fixture(t), h = await hostFixture(f, t);
  const candidate = await replacementEndpoint(f, t); await candidate.confirm();
  const proposal = await h.host.prepareFreshnessAuthority(candidate.endpoint.identity());
  const receipt = await h.host.commitFreshnessAuthority(proposal.proposalId);
  await h.host.beginReconcile();
  assert.deepEqual(await f.enrollment.answerChallenges(f.team.id), { answered: 0 });
  await candidate.enrollment.answerChallenges(f.team.id);
  await h.host.reconcileMembership();
  const older = (await f.enrollment.state(f.team.id)).authorityLog;
  await f.enrollment.revokeEndpoint(f.team.id, { userId: f.owner.id, device: 'REPLACEMENT' });
  const applied = await h.host.applyRevocations();
  assert.equal(applied.requiresAuthority, true);
  assert.ok(applied.rotated.includes(h.task.id));
  const saved = h.host.freshness.record();
  assert.equal(saved.state, 'revoked');
  assert.equal(saved.activationId, receipt.activationId);
  const floor = h.host.state.load('authorization:' + f.team.id);
  assert.ok(floor.seq > older.length);
  const { FreshnessAuthority } = require('../packages/runtime/freshness-authority');
  const { EncryptedTaskState } = require('../packages/runtime/encrypted-task');
  const reopened = new EncryptedTaskState(h.host.statePath);
  try {
    const restored = new FreshnessAuthority({ state: reopened, teamId: f.team.id, runtimeId: h.host.runtime.id,
      genesis: f.ownerEndpoint.identity() });
    assert.equal(restored.record().state, 'revoked');
    assert.equal(restored.signer().ed25519, candidate.endpoint.identity().ed25519);
    assert.deepEqual(reopened.load('authorization:' + f.team.id), floor);
  } finally { reopened.close(); }
  h.replay(older); h.host.disconnect();
  await assert.rejects(() => h.host.collect(), /membership_freshness_authority_revoked/);
  assert.equal(h.host.freshness.signer().ed25519, candidate.endpoint.identity().ed25519);
});

test('the execution host refuses a relay rollback after it applied signed device revocation', async (t) => {
  const f = await fixture(t);
  const h = await hostFixture(f, t);
  const { sendTaskControl } = require('../packages/e2ee/task-control.mjs');
  const before = (await f.enrollment.state(f.team.id)).authorityLog;
  await f.enrollment.revokeEndpoint(f.team.id, { userId: f.teammate.id, device: 'TEAMMATE' });
  const applied = await h.host.applyRevocations();
  assert.ok(applied.rotated.includes(h.task.id));
  const { verifyRevocationReceipts } = require('../packages/e2ee/enrollment.mjs');
  const shown = await f.enrollment.state(f.team.id);
  const hosts = [{ runtimeId: h.host.runtime.id, identity: h.writer }];
  assert.equal((await verifyRevocationReceipts(shown.revocations, { hosts, authorityLog: shown.authorityLog }))[0].applied, true);
  const forged = structuredClone(shown.revocations);
  forged[0].receipts[0].proof.hash = 'f'.repeat(64);
  assert.equal((await verifyRevocationReceipts(forged, { hosts, authorityLog: shown.authorityLog }))[0].applied, false);
  await sendTaskControl(f.teammateEndpoint, h.writer, { task: h.task, action: 'help.request',
    payload: { id: 'help_revoked', question: 'May I act?', recipient: f.owner.id } });
  assert.equal((await h.host.collect()).refused[0].code, 'endpoint_revoked');
  h.replay(before);
  await sendTaskControl(f.teammateEndpoint, h.writer, { task: h.task, action: 'help.request',
    payload: { id: 'help_rollback', question: 'May I act after rollback?', recipient: f.owner.id } });
  await assert.rejects(() => h.host.collect(), /membership_rollback/);
});

test('the execution host requires a fresh owner response after reconnect', async (t) => {
  const f = await fixture(t);
  const h = await hostFixture(f, t);
  h.host.disconnect();
  await assert.rejects(() => h.host.collect(), /membership_reconciliation_required/);
  await f.enrollment.answerChallenges(f.team.id);
  assert.deepEqual(await h.host.collect(), { applied: [], refused: [] });
});

test('an owner returning after challenge expiry can reconcile without another host reconnect', async (t) => {
  const f = await fixture(t);
  const h = await hostFixture(f, t);
  h.host.disconnect();
  await assert.rejects(() => h.host.reconcileMembership(), /membership_reconciliation_required/);
  const expired = h.host.challenge;
  await assert.rejects(() => h.host.reconcileMembership(), /membership_reconciliation_required/);
  assert.equal(h.host.challenge, expired, 'polling leaves the pending challenge stable for its owner');

  const later = Date.now() + 61000;
  const clock = t.mock.method(Date, 'now', () => later);
  try {
    assert.deepEqual(await f.enrollment.answerChallenges(f.team.id), { answered: 0 },
      'the relay no longer offers its expired challenge to the returning owner');
    await assert.rejects(() => h.host.reconcileMembership(), /membership_reconciliation_required/);
    assert.notEqual(h.host.challenge, expired, 'the host replaces the expired nonce without reconnecting');
    assert.deepEqual(await f.enrollment.answerChallenges(f.team.id), { answered: 1 });
    await h.host.reconcileMembership();
    assert.equal(h.host.reconciled, true);
  } finally { clock.mock.restore(); }
});

test('a project added after the first owner proof promptly renews the challenge at the current head', async (t) => {
  const f = await fixture(t);
  const { EncryptedHost } = require('../packages/runtime/encrypted-host');
  const { newId } = require('../packages/e2ee/task-log.mjs');
  const runtime = { id: 'rt_initial_head_race', teamId: f.team.id, runtimeToken: 'initial-head-race-token' };
  f.hub.store.pairRuntime(runtime.id, f.team.id, f.owner.id, runtime.runtimeToken);
  const host = new EncryptedHost({ runtime, url: f.url, statePath: path.join(f.dir, 'initial-head.sqlite'),
    authority: f.ownerEndpoint.identity(), endpointFactory: options => Endpoint.create(options) });
  f.cleanup.push(() => host.close());
  await host.start();
  const original = await host.beginReconcile();
  assert.deepEqual(await f.enrollment.answerChallenges(f.team.id), { answered: 1 });
  const first = (await host.enrollmentRequest('?team=' + f.team.id)).currentProof;
  assert.equal(first.seq, 1, 'the owner answered the bootstrap head');
  const projectId = newId('ep');
  await f.enrollment.ownProject(f.team.id, projectId);
  assert.deepEqual(await f.enrollment.answerChallenges(f.team.id), { answered: 0 },
    'the relay hides an already answered nonce even after the membership head advances');

  const request = host.enrollmentRequest.bind(host);
  host.enrollmentRequest = async (...args) => {
    const response = await request(...args);
    if (args[0].startsWith('?')) response.currentProof.signature = 'forged';
    return response;
  };
  await assert.rejects(() => host.reconcileMembership(), /membership_reconciliation_required/);
  assert.equal(host.challenge, original, 'an unauthenticated relay proof cannot churn a pending nonce');
  host.enrollmentRequest = request;

  await assert.rejects(() => host.reconcileMembership(), /membership_reconciliation_required/);
  assert.equal(host.reconciled, false, 'the stale proof never authorizes the host');
  assert.notEqual(host.challenge, original, 'the host immediately replaces the stale answered nonce');
  assert.equal(host.state.load('authorization:' + f.team.id), null, 'no stale head is committed');
  await assert.rejects(() => f.enrollment.request('/answer-challenge', {
    teamId: f.team.id, runtimeId: runtime.id, proof: first
  }), /membership_proof_invalid/, 'a previous nonce cannot satisfy the replacement challenge');
  assert.deepEqual(await f.enrollment.answerChallenges(f.team.id), { answered: 1 });
  const current = await host.reconcileMembership();
  assert.equal(current.seq, 2);
  assert.equal(current.grants.some(grant => grant.projectId === projectId && !grant.revoked), true);
  assert.equal(host.reconciled, true);
});

for (const advanceHead of [false, true]) test(`a disconnected host rejects an in-flight ${advanceHead ? 'stale' : 'current'} signed membership answer from the prior generation`, async (t) => {
  const f = await fixture(t);
  const h = await hostFixture(f, t);
  h.host.disconnect();
  await h.host.beginReconcile();
  await f.enrollment.answerChallenges(f.team.id);
  if (advanceHead) await f.enrollment.ownProject(f.team.id, require('../packages/e2ee/task-log.mjs').newId('ep'));
  const request = h.host.enrollmentRequest.bind(h.host);
  let responseReady, releaseResponse;
  const ready = new Promise(resolve => { responseReady = resolve; });
  const released = new Promise(resolve => { releaseResponse = resolve; });
  h.host.enrollmentRequest = async (...args) => {
    const response = await request(...args);
    if (args[0].startsWith('?')) { responseReady(); await released; }
    return response;
  };
  const reconciling = h.host.reconcileMembership();
  await ready;
  h.host.disconnect();
  releaseResponse();
  await assert.rejects(() => reconciling, /membership_reconciliation_required/);
  assert.equal(h.host.reconciled, false);
  assert.equal(h.host.challenge, null);
  h.host.enrollmentRequest = request;
  await assert.rejects(() => h.host.reconcileMembership(), /membership_reconciliation_required/);
  await f.enrollment.answerChallenges(f.team.id);
  await h.host.reconcileMembership();
  assert.equal(h.host.reconciled, true, 'only the new connection generation may enable controls');
});

test('a runtime session alone cannot falsely acknowledge device revocation', async (t) => {
  const f = await fixture(t);
  const h = await hostFixture(f, t);
  await f.enrollment.revokeEndpoint(f.team.id, { userId: f.teammate.id, device: 'TEAMMATE' });
  const response = await fetch(f.url + '/api/enrollment/ack-revocation', { method: 'POST', headers: {
    Authorization: 'Bearer ' + h.host.runtime.runtimeToken, 'X-Plexus-Runtime': h.host.runtime.id, 'Content-Type': 'application/json'
  }, body: JSON.stringify({ teamId: f.team.id, target: { userId: f.teammate.id, device: 'TEAMMATE' } }) });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'revocation_signature_required');
});

test('distinct handovers by one teammate each apply, while a repeated command returns its first result', async (t) => {
  const f = await fixture(t);
  const h = await hostFixture(f, t);
  const { sendTaskControl } = require('../packages/e2ee/task-control.mjs');
  const { newId } = require('../packages/e2ee/task-log.mjs');
  let last;
  for (const to of [f.teammate.id, f.owner.id, f.teammate.id]) {
    last = { task: h.task, commandId: newId('cmd'), action: 'responsibility.handover', payload: { to, note: 'Please continue' } };
    await sendTaskControl(f.ownerEndpoint, h.writer, last);
    const result = await h.host.collect();
    assert.equal(result.applied.length, 1);
    assert.equal(result.refused.length, 0);
  }
  await sendTaskControl(f.ownerEndpoint, h.writer, last);
  assert.equal((await h.host.collect()).applied[0].duplicate, true);
  const { EncryptedTaskReader } = require('../packages/e2ee/task-log.mjs');
  const reader = new EncryptedTaskReader({ endpoint: f.ownerEndpoint, task: h.task, writer: h.writer });
  await f.ownerEndpoint.open(await f.ownerEndpoint.transport.drain());
  await reader.reconnect(h.tasks);
  assert.equal(reader.state.responsible, f.teammate.id);
  assert.equal(reader.state.events.filter((e) => e.type === 'responsibility.changed').length, 3);
});

test('each confirmed device of the same participant receives future task access', async (t) => {
  const f = await fixture(t);
  const h = await hostFixture(f, t);
  const second = await Endpoint.create({ user: matrixUser(f.teammate.id), device: 'SECOND',
    transport: new HubKeyTransport({ url: f.url, token: f.teammate.token, device: 'SECOND' }) });
  f.cleanup.push(() => second.close());
  await f.teammateEnrollment.announce(f.team.id, announcement(second));
  await f.enrollment.confirm(f.team.id, 'OWNER', { userId: f.teammate.id, ...announcement(second) });
  await second.confirmEndpoint(h.writer, { confirmed: true });
  await h.host.admitParticipants((await h.tasks.list(f.team.id)).tasks[0]);
  const { sendTaskControl } = require('../packages/e2ee/task-control.mjs');
  await sendTaskControl(second, h.writer, { task: h.task, action: 'responsibility.handover', payload: { to: f.owner.id } });
  assert.equal((await h.host.collect()).applied.length, 1);
  const { readTaskHistory } = require('../packages/e2ee/task-control.mjs');
  const { acceptProjectAccess } = require('../packages/e2ee/enrollment.mjs');
  const { EncryptedTaskReader, EncryptedTaskTransport } = require('../packages/e2ee/task-log.mjs');
  const admitted = [];
  for (const event of await second.open(await second.transport.drain())) {
    const handoff = readTaskHistory(event, h.task);
    if (handoff) admitted.push(...(await acceptProjectAccess(second, { history: handoff.history }, { writer: h.writer })).sessions);
  }
  const reader = new EncryptedTaskReader({ endpoint: second, task: h.task, writer: h.writer, admittedSessions: admitted });
  await reader.reconnect(new EncryptedTaskTransport({ url: f.url, token: f.teammate.token }));
  assert.equal(reader.state.objective, 'Keep this task private');
  assert.equal(reader.state.responsible, f.owner.id);
});

test('customer history recovery and teammate re-enrollment require explicit local authority replacement', async (t) => {
  const f = await fixture(t);
  const h = await hostFixture(f, t);
  const { EncryptedTaskReader } = require('../packages/e2ee/task-log.mjs');
  const { RecoveryTransport, backupHistory, restoreHistory } = require('../packages/e2ee/recovery.mjs');
  const { roomFor, canonical } = require('../packages/protocol/encrypted-task.mjs');
  const { currentMembershipBody } = require('../packages/e2ee/membership.mjs');
  const originalIdentity = f.ownerEndpoint.identity();
  await f.ownerEndpoint.open(await f.ownerEndpoint.transport.drain());
  const original = new EncryptedTaskReader({ endpoint: f.ownerEndpoint, task: h.task, writer: h.writer });
  await original.reconnect(h.tasks);
  const recovery = new RecoveryTransport({ url: f.url, token: f.owner.token });
  const options = { scope: 'owner-loss-proof', taskIds: [h.task.id], recoveryKey: 'customer-held-owner-loss-recovery-key', roomFor };
  await backupHistory(f.ownerEndpoint, recovery, options);
  // Destroy the old signing machine. The remaining test can use the backup and the
  // account session, but cannot answer a challenge with the original private key.
  f.ownerEndpoint.close();
  h.host.disconnect();

  const clean = await Endpoint.create({ user: matrixUser(f.owner.id), device: 'REPLACEMENT',
    transport: new HubKeyTransport({ url: f.url, token: f.owner.token, device: 'REPLACEMENT' }) });
  f.cleanup.push(() => clean.close());
  assert.notEqual(clean.identity().ed25519, originalIdentity.ed25519);
  const restored = await restoreHistory(clean, recovery, options);
  const recovered = restored.restored.history[h.task.id];
  const reader = new EncryptedTaskReader({ endpoint: clean, task: h.task, writer: recovered.writer,
    admittedSessions: recovered.sessions });
  await reader.reconnect(h.tasks);
  assert.deepEqual(reader.state.events, original.state.events);
  assert.match(restored.notRestored.endpointTrust, /confirmed again/);

  const replacement = new EnrollmentTransport({ url: f.url, token: f.owner.token, endpoint: clean });
  // This pin is the previously recorded local fingerprint, never a relay-selected key.
  await replacement.pinAuthority(f.team.id, originalIdentity);
  await replacement.announce(f.team.id, announcement(clean));
  assert.equal((await replacement.state(f.team.id)).endpoints.find(e => e.device === 'REPLACEMENT').state, 'pending');
  await assert.rejects(() => h.host.collect(), /membership_reconciliation_required/);
  assert.deepEqual(await replacement.answerChallenges(f.team.id), { answered: 0 });
  const state = await replacement.state(f.team.id);
  const head = await replacement.signedHead(f.team.id, state);
  const proofBody = currentMembershipBody(f.team.id, h.host.challenge, head);
  const signature = await clean.sign(canonical(proofBody));
  await assert.rejects(() => replacement.request('/answer-challenge', { teamId: f.team.id,
    runtimeId: h.host.runtime.id, proof: { ...proofBody, signature } }), /membership_proof_invalid/);

  // Existing verified teammates restore participation, but cannot silently appoint
  // a new freshness signer on somebody else's execution host.
  await f.teammateEnrollment.pinAuthority(f.team.id, originalIdentity);
  await f.teammateEnrollment.confirm(f.team.id, 'TEAMMATE', { userId: f.owner.id, ...announcement(clean) });
  assert.equal((await replacement.state(f.team.id)).endpoints.find(e => e.device === 'REPLACEMENT').state, 'verified');
  assert.deepEqual(await replacement.answerChallenges(f.team.id), { answered: 0 });
  await assert.rejects(() => h.host.collect(), /membership_reconciliation_required/);

  const proposal = await h.host.prepareFreshnessAuthority(clean.identity());
  assert.equal(proposal.candidate.ed25519, clean.identity().ed25519);
  assert.deepEqual(await replacement.answerChallenges(f.team.id), { answered: 0 });
  const receipt = await h.host.commitFreshnessAuthority(proposal.proposalId);
  assert.equal(receipt.signer.ed25519, clean.identity().ed25519);
  assert.equal(h.host.authority.ed25519, originalIdentity.ed25519, 'the historical trust root never changes');
  await h.host.beginReconcile();
  assert.deepEqual(await replacement.answerChallenges(f.team.id), { answered: 1 });
  await h.host.collect();
  assert.equal(h.host.reconciled, true);
  assert.equal(h.host.runtime.approvalAuthority, undefined, 'replacement does not grant approval authority');
});
