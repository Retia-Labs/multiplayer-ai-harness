'use strict';
// Acceptance test for issue #8 (P07): "Invite a verified teammate into encrypted project
// history".
//
// Most of these checks assert a refusal, and each refusal has to arrive with its own code.
// The failure this suite exists to catch is the one where everything "works": a teammate is
// invited, the screen fills with history, and nobody notices that an account and a link
// were all it took. So the positive path is only interesting *after* the negative ones -
// Bob reads the project because his fingerprint was confirmed, and the test proves he could
// not read it a moment earlier.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { KeyDirectory, KeyTransport } = require('../packages/e2ee/key-transport');
const { EncryptedTaskReader, EncryptedTaskTransport, createEncryptedTask, newId } = require('../packages/e2ee/task-log.mjs');
const { matrixUser } = require('../packages/protocol/encrypted-task.mjs');
const { EncryptedTaskState, EncryptedFixtureHost, fixtureEvents, fixtureEventId } = require('../packages/runtime/encrypted-task');
const { TeamOps } = require('../packages/protocol');
const {
  EnrollmentTransport, announcement, announceEndpoint, confirmTeammateEndpoint,
  grantProjectAccess, handOffHistory, acceptProjectAccess, participation
} = require('../packages/e2ee/enrollment.mjs');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
async function refused(name, code, fn) {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  assert.ok(error, name + ': expected a refusal, but it succeeded');
  const got = error.code || String(error.message || error);
  assert.ok(got === code || got.startsWith(code), name + ': expected ' + code + ', got ' + got);
  results.push({ name, status: 'pass', refusal: code });
  console.log('  PASS ' + name + ' - ' + code);
}

class Client {
  constructor(url, name) { this.url = url; this.name = name; this.msgs = []; this.waiters = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => this.ws.send(JSON.stringify({ type: 'hello', role: 'client', name: this.name })));
      this.ws.addEventListener('error', reject);
      this.ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        if (m.type === 'welcome') { this.me = m.user; resolve(m); }
        for (const w of this.waiters.slice()) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
      });
    });
  }
  op(msg, replyType) {
    const id = 'op_' + randomBytes(8).toString('hex');
    this.ws.send(JSON.stringify({ ...msg, id }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout: ' + msg.type)), 10000);
      this.waiters.push({
        pred: (m) => m.ref === id || (m.type === 'error' && m.ref === id),
        resolve: (m) => {
          clearTimeout(timer);
          if (m.type === 'error') { const err = new Error(m.message || m.code); err.code = m.code; return reject(err); }
          if (replyType && m.type !== replyType) return reject(new Error('unexpected reply ' + m.type));
          resolve(m);
        }
      });
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const waitFor = async (fn) => { for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('fixture_timeout'); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-enrollment-'));
const canary = 'PRIVATE_' + randomBytes(16).toString('hex');
let hub, runtime, socketsToClose = [];

(async () => {
  hub = new Hub({ dbFile: path.join(tmp, 'hub.sqlite'), log: () => {} });
  const addr = await hub.listen();
  const url = 'http://127.0.0.1:' + addr.port;
  const project = path.join(tmp, canary + '-workspace');
  fs.mkdirSync(project);
  runtime = new Runtime({ hubUrl: url.replace('http', 'ws'), userName: 'host', dataDir: path.join(tmp, 'runtime'), projects: [project], encryptedTasksOnly: true });
  await runtime.start();

  // ---- accounts, team, pairing ----
  const alice = new Client(url.replace('http', 'ws'), 'alice');
  const bob = new Client(url.replace('http', 'ws'), 'bob');
  const mallory = new Client(url.replace('http', 'ws'), 'mallory');
  socketsToClose = [alice, bob, mallory];
  await Promise.all([alice.connect(), bob.connect(), mallory.connect()]);
  await waitFor(() => hub.pendingPairings.size);
  const team = (await alice.op({ type: TeamOps.TEAM_CREATE, name: 'Fixture team' }, 'team')).team;
  await alice.op({ type: TeamOps.RUNTIME_PAIR, teamId: team.id, code: runtime.pairingCode });
  await waitFor(() => runtime.teamId === team.id);
  for (const guest of [bob, mallory]) {
    const invite = await alice.op({ type: TeamOps.INVITE_CREATE, teamId: team.id, inviteeUserId: guest.me.id, ttlMs: 60000 }, 'invitation');
    await guest.op({ type: TeamOps.INVITE_ACCEPT, code: invite.invitation.code }, 'team');
  }

  const tokenFor = (client) => hub.store.userById(client.me.id).token;
  const tasks = { alice: new EncryptedTaskTransport({ url, token: tokenFor(alice) }), bob: new EncryptedTaskTransport({ url, token: tokenFor(bob) }), mallory: new EncryptedTaskTransport({ url, token: tokenFor(mallory) }) };
  const enroll = { alice: new EnrollmentTransport({ url, token: tokenFor(alice) }), bob: new EnrollmentTransport({ url, token: tokenFor(bob) }), mallory: new EnrollmentTransport({ url, token: tokenFor(mallory) }) };
  const hostTasks = new EncryptedTaskTransport({ url, token: runtime.runtimeToken, runtimeId: runtime.id });

  // ---- endpoints ----
  const directory = new KeyDirectory();
  const keys = new KeyTransport(directory);
  const aliceEp = await Endpoint.create({ user: matrixUser(alice.me.id), device: 'ALICEDEV', transport: keys });
  const bobEp = await Endpoint.create({ user: matrixUser(bob.me.id), device: 'BOBDEV', transport: keys });
  const malloryEp = await Endpoint.create({ user: matrixUser(mallory.me.id), device: 'MALLORYDEV', transport: keys });
  const hostEp = await Endpoint.create({ user: matrixUser(runtime.id), device: 'HOST', transport: keys });
  for (const pair of [[aliceEp, hostEp], [hostEp, aliceEp]]) await pair[0].confirmEndpoint(pair[1].identity(), { confirmed: true });

  // ================= criterion 1: login and a link are not trust =================

  enroll.alice.bindEndpoint(aliceEp); enroll.bob.bindEndpoint(bobEp); enroll.mallory.bindEndpoint(malloryEp);
  await enroll.bob.pinAuthority(team.id, aliceEp.identity());
  await enroll.mallory.pinAuthority(team.id, aliceEp.identity());
  await enroll.alice.bootstrap(team.id, announcement(aliceEp));
  const announced = await announceEndpoint(bobEp, enroll.bob, team.id);
  assert.equal(announced.endpoint.state, 'pending');
  pass('an accepted invitation plus an announced endpoint is pending, not trusted', 'bob/BOBDEV pending');

  await refused('an unconfirmed endpoint cannot vouch for another one', 'confirming_endpoint_unverified',
    () => enroll.mallory.confirm(team.id, 'MALLORYDEV', { userId: bob.me.id, ...announcement(bobEp) }));

  await refused('a confirmation naming keys other than the announced ones is refused', 'endpoint_key_mismatch',
    () => enroll.alice.confirm(team.id, 'ALICEDEV', { userId: bob.me.id, device: 'BOBDEV', curve25519: announcement(malloryEp).curve25519, ed25519: announcement(bobEp).ed25519 }));

  await refused('confirming without having compared anything out of band is refused locally', 'endpoint_confirmation_required',
    () => confirmTeammateEndpoint(aliceEp, enroll.alice, team.id, { userId: bob.me.id, ...announcement(bobEp) }));

  await refused('the owner cannot vouch from a device that is not itself confirmed', 'confirming_endpoint_unverified',
    () => enroll.alice.confirm(team.id, 'ALICE_OTHER', { userId: bob.me.id, ...announcement(bobEp) }));

  // ================= a task exists before bob is anywhere near it =================

  const task = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId: newId('ep'), creatorUserId: alice.me.id };
  const payload = { title: canary + ' title', objective: canary + ' objective', fixture: { plan: canary + ' plan', path: canary + '/file.txt', result: canary + ' output', diff: canary + ' diff', activity: canary + ' activity', answer: canary + ' answer' } };
  await enroll.alice.ownProject(team.id, task.projectId);
  const created = await createEncryptedTask(aliceEp, tasks.alice, { task, writer: hostEp.identity(), payload });
  const state = new EncryptedTaskState(path.join(tmp, 'outbox.sqlite'));
  const host = new EncryptedFixtureHost({ runtime, endpoint: hostEp, transport: hostTasks, state, projects: new Map([[task.projectId, project]]), creators: new Map([[alice.me.id, aliceEp.identity()]]) });
  const opened = await host.open(created.task);
  await aliceEp.open(directory.drain(aliceEp.user, aliceEp.device));
  const events = fixtureEvents(opened.objective);
  // Everything except the closing event, so a late joiner meets a task still in flight.
  for (let i = 0; i < events.length - 1; i++) await opened.writer.append(events[i], fixtureEventId(task.id, i));

  const aliceReader = new EncryptedTaskReader({ endpoint: aliceEp, task, writer: hostEp.identity() });
  await aliceReader.reconnect(tasks.alice);
  assert.equal(aliceReader.seq, events.length - 1);
  assert.equal(aliceReader.state.outcome, null);
  pass('the project owner reads the running task', events.length - 1 + ' events, still pending');

  // ================= criterion 3: no grant, no bytes =================

  await refused('a teammate in the team but not in the project cannot fetch its history', 'not_a_project_participant',
    () => tasks.bob.page(task.id));
  await refused('a copied task id carries no authority for another member either', 'not_a_project_participant',
    () => tasks.mallory.page(task.id));
  assert.deepEqual((await tasks.bob.list(team.id)).tasks, []);
  pass('the task list shows a non-participant nothing at all', 'bob sees 0 tasks');

  // ================= criterion 2: granting, and what it says it does =================

  await refused('history cannot be handed to an endpoint the relay does not call verified', 'member_endpoint_unverified',
    () => grantProjectAccess(aliceEp, enroll.alice, {
      teamId: team.id, projectId: task.projectId, member: { userId: bob.me.id, device: 'BOBDEV' }, taskIds: [task.id]
    }));
  const access = { explanation: (await enroll.alice.state(team.id, task.projectId)) && null };
  // The grant row survived that refusal, which is the two-gate design working: bob fetches
  // every byte of the log and cannot open one of them.
  const ciphertext = await tasks.bob.page(task.id);
  assert.equal(ciphertext.events.length, events.length - 1);
  const blindReader = new EncryptedTaskReader({ endpoint: bobEp, task, writer: hostEp.identity() });
  await refused('a granted but unconfirmed endpoint fetches ciphertext it cannot open', 'task_integrity_failed',
    () => blindReader.reconnect(tasks.bob));

  // Now the confirmation actually happens, out of band, from a trusted endpoint.
  const confirmed = await confirmTeammateEndpoint(aliceEp, enroll.alice, team.id, { userId: bob.me.id, ...announcement(bobEp) }, { confirmed: true });
  assert.equal(confirmed.endpoint.state, 'verified');
  assert.equal(confirmed.endpoint.confirmedBy, alice.me.id + '/ALICEDEV');
  pass('a trusted endpoint completes the verification flow', 'confirmed by alice/ALICEDEV');

  const granted = await grantProjectAccess(aliceEp, enroll.alice, {
    teamId: team.id, projectId: task.projectId, member: { userId: bob.me.id, device: 'BOBDEV' }, taskIds: [task.id]
  });
  assert.equal(granted.explanation.existingTasks.length, 1);
  assert.match(granted.explanation.covers.join(' '), /complete ordered history of 1 task/);
  assert.match(granted.explanation.covers.join(' '), /every task added to this project after this grant/);
  assert.match(granted.explanation.covers.join(' '), /nothing in any other project/);
  pass('the grant states what it covers and what it does not', granted.explanation.covers.length + ' clauses');

  await bobEp.confirmEndpoint(aliceEp.identity(), { confirmed: true });
  await bobEp.confirmEndpoint(hostEp.identity(), { confirmed: true });
  await hostEp.confirmEndpoint(bobEp.identity(), { confirmed: true });

  // A grant is not a handoff. Alice may grant; only the host that wrote the log may hand
  // over its sessions, and a handoff sealed by anyone else is refused outright.
  const fromAlice = await handOffHistory(aliceEp, {
    teamId: team.id, projectId: task.projectId, member: { userId: bob.me.id, device: 'BOBDEV' }, taskIds: [task.id]
  });
  await refused('history sealed by a teammate rather than the writer is refused', 'project_history_not_from_writer',
    () => acceptProjectAccess(bobEp, { history: fromAlice }, { writer: hostEp.identity() }));

  const handoff = await host.handOff(created.task, { userId: bob.me.id, device: 'BOBDEV' });
  const accepted = await acceptProjectAccess(bobEp, { history: handoff }, { writer: hostEp.identity() });
  assert.ok(accepted.sessions.length > 0);

  const bobReader = new EncryptedTaskReader({ endpoint: bobEp, task, writer: hostEp.identity(), admittedSessions: accepted.sessions });
  await bobReader.reconnect(tasks.bob);
  assert.deepEqual(bobReader.state.events, aliceReader.state.events);
  assert.equal(bobReader.state.title, payload.title);
  assert.equal(bobReader.state.outcome, null);
  pass('a teammate joining late replays the ordered history and the pending state', bobReader.seq + ' events, outcome still open');

  // ================= future events need the writing host to admit him =================

  await opened.writer.append(events[events.length - 1], fixtureEventId(task.id, events.length - 1));
  await bobReader.reconnect(tasks.bob);
  // The fixture ends with a turn finishing. The task itself stays open until a person says
  // otherwise, which is issue #13's separation and is what makes this assertion narrow.
  assert.equal(bobReader.state.turn, 'completed');
  assert.equal(bobReader.state.outcome, null);
  assert.deepEqual(bobReader.state.events, events);
  pass('events written after the grant reach the new participant', 'the final turn arrives');

  // A second task in the same project needs no second grant.
  const second = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId: task.projectId, creatorUserId: alice.me.id };
  const secondPayload = { title: canary + ' second', objective: canary + ' second objective', fixture: payload.fixture };
  const createdSecond = await createEncryptedTask(aliceEp, tasks.alice, { task: second, writer: hostEp.identity(), payload: secondPayload });
  const secondOpen = await host.open(createdSecond.task);
  // A session with no events yet: admitting bob to it hands him its key at index zero, so
  // no history export is needed for a task he was present for from the start.
  await host.admit(createdSecond.task, [aliceEp.identity(), bobEp.identity()]);
  await Promise.all([aliceEp, bobEp].map((ep) => ep.open(directory.drain(ep.user, ep.device))));
  await secondOpen.writer.append({ type: 'task.created', payload: secondPayload }, fixtureEventId(second.id, 0));
  const secondReader = new EncryptedTaskReader({ endpoint: bobEp, task: second, writer: hostEp.identity() });
  await secondReader.reconnect(tasks.bob);
  assert.equal(secondReader.state.title, secondPayload.title);
  pass('a task added to the project afterwards needs no further grant', second.id);

  // ================= criterion 3, continued: control, and revocation =================

  const firstRecord = (await tasks.bob.page(task.id)).events[0];
  await refused('a participant cannot append to the log through the relay', 'owning_runtime_required',
    () => tasks.bob.append(task.id, firstRecord));

  await refused('mallory still sees nothing after all of that', 'not_a_project_participant',
    () => tasks.mallory.page(task.id));

  await enroll.alice.revokeGrant(team.id, task.projectId, bob.me.id);
  await refused('a revoked participant stops getting ciphertext', 'not_a_project_participant',
    () => tasks.bob.page(task.id));
  pass('revoking the grant closes the relay to a reader who still holds the keys', 'bob refused after revocation');

  // ================= criterion 4: site-data loss and re-enrollment =================

  await enroll.alice.grant(team.id, task.projectId, bob.me.id, 'participant');
  // Losing site data is a new crypto identity, not a returning one: same account, same
  // device name, different keys. The relay must not carry the old verdict over.
  const bobFresh = await Endpoint.create({ user: matrixUser(bob.me.id), device: 'BOBDEV2', transport: keys });
  await refused('the rebuilt endpoint cannot reclaim the lost device name', 'endpoint_device_id_reused',
    () => enroll.bob.announce(team.id, { ...announcement(bobFresh), device: 'BOBDEV' }));
  const reannounced = await announceEndpoint(bobFresh, enroll.bob, team.id);
  assert.equal(reannounced.endpoint.state, 'pending');
  pass('an endpoint rebuilt after site-data loss comes back pending', 'bob/BOBDEV2 pending');

  const wiped = new EncryptedTaskReader({ endpoint: bobFresh, task, writer: hostEp.identity() });
  await refused('the rebuilt endpoint holds a grant and still cannot read', 'task_integrity_failed',
    () => wiped.reconnect(tasks.bob));

  const state2 = await participation(enroll.alice, team.id, task.projectId);
  const bobParticipation = state2.participants.find((p) => p.userId === bob.me.id);
  assert.equal(bobParticipation.role, 'participant');
  assert.equal(bobParticipation.endpoints.find((e) => e.device === 'BOBDEV2').state, 'pending');
  assert.ok(state2.participants.find((p) => p.userId === alice.me.id).role === 'owner');
  pass('participant role and pending endpoints are visible', 'bob participant, BOBDEV2 pending');

  await confirmTeammateEndpoint(aliceEp, enroll.alice, team.id, { userId: bob.me.id, ...announcement(bobFresh) }, { confirmed: true });
  await hostEp.confirmEndpoint(bobFresh.identity(), { confirmed: true });
  await grantProjectAccess(aliceEp, enroll.alice, {
    teamId: team.id, projectId: task.projectId, member: { userId: bob.me.id, device: 'BOBDEV2' }, taskIds: [task.id]
  });
  await bobFresh.confirmEndpoint(aliceEp.identity(), { confirmed: true });
  await bobFresh.confirmEndpoint(hostEp.identity(), { confirmed: true });
  const rehandoff = await host.handOff(created.task, { userId: bob.me.id, device: 'BOBDEV2' });
  const rejoined = await acceptProjectAccess(bobFresh, { history: rehandoff }, { writer: hostEp.identity() });
  const recovered = new EncryptedTaskReader({ endpoint: bobFresh, task, writer: hostEp.identity(), admittedSessions: rejoined.sessions });
  await recovered.reconnect(tasks.bob);
  assert.deepEqual(recovered.state.events, events);
  pass('re-enrollment restores the full history to the rebuilt endpoint', recovered.seq + ' events');

  // ================= who is allowed to vouch, and who stops being allowed =================

  // Bob is verified and is not the team owner: the ordinary case, which until now only ever
  // ran through the owner's branch.
  await announceEndpoint(malloryEp, enroll.mallory, team.id);
  await bobEp.confirmEndpoint(malloryEp.identity(), { confirmed: true });
  const byBob = await confirmTeammateEndpoint(bobEp, enroll.bob, team.id, { userId: mallory.me.id, ...announcement(malloryEp) }, { confirmed: true });
  assert.equal(byBob.endpoint.confirmedBy, bob.me.id + '/BOBDEV');
  assert.equal(byBob.authority, 'endpoint');
  pass('a verified endpoint that is not the team owner can vouch for another', 'mallory confirmed by bob/BOBDEV');

  // Alice never compared mallory's fingerprint, so the relay calling it verified is not
  // enough. The two layers disagreeing is the point: each refuses on its own grounds.
  await refused('a relay-verified endpoint is still not sealed to without local confirmation', 'endpoint_unverified',
    () => handOffHistory(aliceEp, {
      teamId: team.id, projectId: task.projectId, member: { userId: mallory.me.id, device: 'MALLORYDEV' }, taskIds: [task.id]
    }));

  await refused('the team cannot be bootstrapped a second time', 'membership_bootstrap_refused',
    () => enroll.alice.bootstrap(team.id, announcement(aliceEp)));

  await refused('a participant cannot revoke the project owner', 'project_owner_grant_retained',
    () => enroll.bob.revokeGrant(team.id, task.projectId, alice.me.id));

  const revoked = await enroll.alice.revokeEndpoint(team.id, { userId: bob.me.id, device: 'BOBDEV2' });
  assert.equal(revoked.endpoint.state, 'revoked');
  pass('an endpoint can be revoked', 'bob/BOBDEV2 revoked');

  await refused('a revoked endpoint cannot be confirmed again', 'endpoint_revoked',
    () => enroll.alice.confirm(team.id, 'ALICEDEV', { userId: bob.me.id, ...announcement(bobFresh) }));
  await refused('a revoked endpoint cannot announce its way back to pending', 'endpoint_not_announced',
    () => announceEndpoint(bobFresh, enroll.bob, team.id));
  await refused('a revoked endpoint is refused a further grant, however trusted it once was', 'member_endpoint_unverified',
    () => grantProjectAccess(aliceEp, enroll.alice, {
      teamId: team.id, projectId: task.projectId, member: { userId: bob.me.id, device: 'BOBDEV2' }, taskIds: [task.id]
    }));

  await enroll.alice.revokeEndpoint(team.id, { userId: bob.me.id, device: 'BOBDEV' });
  await refused('a participant with no confirmed endpoint left cannot grant to anyone', 'confirming_endpoint_unverified',
    () => enroll.bob.grant(team.id, task.projectId, mallory.me.id, 'participant'));

  // An account token is not recovery signing authority. The former success assertion
  // here accepted an unsigned account-only takeover. Replacement of the pinned root
  // needs an authenticated rotation; history-only recovery's remaining limitation is
  // exercised separately in enrollment-authority.js rather than reported as success.
  await refused('the pinned membership authority cannot be removed without a supported rotation',
    'membership_authority_rotation_required',
    () => enroll.alice.revokeEndpoint(team.id, { userId: alice.me.id, device: 'ALICEDEV' }));

  // ================= the relay never saw any of it =================

  const relayBytes = JSON.stringify([
    ...(await tasks.alice.page(task.id)).events,
    await tasks.alice.list(team.id),
    await enroll.alice.state(team.id, task.projectId)
  ]);
  assert.equal(relayBytes.includes(canary), false);
  pass('no plaintext canary appears in anything the relay serves', canary.slice(0, 12) + '...');

  fs.mkdirSync(path.join(__dirname, '..', '.artifacts', 'teammate-enrollment'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', '.artifacts', 'teammate-enrollment', 'results.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), node: process.version, results }, null, 2) + '\n');
  console.log('\n' + results.length + ' teammate enrollment checks passed');
  state.close();
})().then(async () => {
  for (const c of socketsToClose) c.close();
  await runtime?.stop?.();
  await hub?.close?.();
  process.exit(0);
}).catch(async (error) => {
  console.error('TEAMMATE ENROLLMENT FAILED\n', error);
  for (const c of socketsToClose) c.close();
  try { await runtime?.stop?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
