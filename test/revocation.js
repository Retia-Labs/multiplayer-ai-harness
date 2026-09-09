'use strict';
// Acceptance test for issue #16 (P15): removing a device, and being honest about what that
// does and does not reach.
//
// The relay can stop serving a revoked device the moment somebody clicks. It cannot take back
// a key that device already holds - so the removal that matters happens on the execution host,
// which throws the group session away and re-shares to whoever is left. Everything written
// afterwards is unreadable to the removed device; everything it had already read stays read.
//
// Both halves are asserted here, because a product that says "removed" without saying "from
// here on" invites somebody to believe a laptop that went home has been reached into.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { TurnSession } = require('../packages/runtime/session');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EncryptedHost } = require('../packages/runtime/encrypted-host');
const { EncryptedTaskReader, EncryptedTaskTransport, createEncryptedTask, newId } = require('../packages/e2ee/task-log.mjs');
const { matrixUser } = require('../packages/protocol/encrypted-task.mjs');
const { EnrollmentTransport, announcement, confirmTeammateEndpoint, acceptProjectAccess, REVOCATION_LIMITS } = require('../packages/e2ee/enrollment.mjs');
const { sendTaskControl, readTaskHistory } = require('../packages/e2ee/task-control.mjs');
const { TeamOps } = require('../packages/protocol');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
async function refused(name, code, fn) {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  assert.ok(error, name + ': expected a refusal, but it succeeded');
  const got = error.code || String(error.message || error);
  assert.ok(got === code || got.includes(code), name + ': expected ' + code + ', got ' + got);
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

const waitFor = async (fn, label = '') => {
  for (let n = 0; n < 400; n++) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout: ' + label);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-revoke-'));
const before = 'BEFORE_' + randomBytes(12).toString('hex');
const after = 'AFTER_' + randomBytes(12).toString('hex');
let hub, runtime, encrypted, clients = [];

(async () => {
  hub = new Hub({ dbFile: path.join(tmp, 'hub.sqlite'), log: () => {} });
  const addr = await hub.listen();
  const url = 'http://127.0.0.1:' + addr.port;
  const project = path.join(tmp, 'workspace');
  fs.mkdirSync(project, { recursive: true });

  runtime = new Runtime({
    hubUrl: url.replace('http', 'ws'), userName: 'host',
    dataDir: path.join(tmp, 'runtime'), projects: [project], encryptedTasksOnly: true
  });
  await runtime.start();

  const alex = new Client(url.replace('http', 'ws'), 'alex');
  const maya = new Client(url.replace('http', 'ws'), 'maya');
  clients = [alex, maya];
  await Promise.all(clients.map((c) => c.connect()));
  await waitFor(() => hub.pendingPairings.size, 'pairing offered');
  const team = (await alex.op({ type: TeamOps.TEAM_CREATE, name: 'Checkout team' }, 'team')).team;
  const invite = await alex.op({ type: TeamOps.INVITE_CREATE, teamId: team.id, inviteeUserId: maya.me.id, ttlMs: 60000 }, 'invitation');
  await maya.op({ type: TeamOps.INVITE_ACCEPT, code: invite.invitation.code }, 'team');
  await alex.op({ type: TeamOps.RUNTIME_PAIR, teamId: team.id, code: runtime.pairingCode });
  await waitFor(() => runtime.teamId === team.id, 'paired');

  const token = (c) => hub.store.userById(c.me.id).token;
  const enrol = {
    alex: new EnrollmentTransport({ url, token: token(alex) }),
    maya: new EnrollmentTransport({ url, token: token(maya) })
  };
  const alexEp = await Endpoint.create({
    user: matrixUser(alex.me.id), device: 'ALEXDEV',
    transport: new HubKeyTransport({ url, token: token(alex), device: 'ALEXDEV' })
  });
  const mayaEp = await Endpoint.create({
    user: matrixUser(maya.me.id), device: 'MAYADEV',
    transport: new HubKeyTransport({ url, token: token(maya), device: 'MAYADEV' })
  });
  enrol.alex.bindEndpoint(alexEp);
  enrol.maya.bindEndpoint(mayaEp);
  await enrol.alex.bootstrap(team.id, announcement(alexEp));
  await enrol.maya.announce(team.id, announcement(mayaEp));
  await confirmTeammateEndpoint(alexEp, enrol.alex, team.id, { userId: maya.me.id, ...announcement(mayaEp) }, { confirmed: true });

  // ---- criterion 3: a device claiming somebody else's name is refused up front ----
  // Two gates, and the second one was missing until this test found it: the enrolment refused
  // the announcement while the key directory happily accepted the upload, so a substitute
  // could overwrite the real device's published keys and make it undiscoverable.
  await refused('a second device cannot republish an enrolled device id with different keys',
    'endpoint_device_id_reused', () => Endpoint.create({
      user: matrixUser(maya.me.id), device: 'MAYADEV',
      transport: new HubKeyTransport({ url, token: token(maya), device: 'MAYADEV' })
    }));

  const directory = hub.store.db.prepare('SELECT keys FROM e2ee_devices WHERE device_id=?').get('MAYADEV');
  assert.ok(JSON.parse(directory.keys).keys['ed25519:MAYADEV'] === announcement(mayaEp).ed25519,
    'the real device still owns its published keys');
  pass('a substituted identity cannot take over a device id that was already confirmed',
    'the directory still holds the confirmed keys');

  const projectId = newId('ep');
  encrypted = new EncryptedHost({
    runtime, url, statePath: path.join(tmp, 'outbox.sqlite'),
    projects: new Map([[projectId, project]]), authority: alexEp.identity(), endpointFactory: (options) => Endpoint.create(options), log: () => {}
  });
  const hostIdentity = await encrypted.start();
  await alexEp.confirmEndpoint(hostIdentity, { confirmed: true });
  await mayaEp.confirmEndpoint(hostIdentity, { confirmed: true });
  await encrypted.beginReconcile();
  await enrol.alex.answerChallenges(team.id);
  await encrypted.reconcileMembership();

  const tasks = {
    alex: new EncryptedTaskTransport({ url, token: token(alex) }),
    maya: new EncryptedTaskTransport({ url, token: token(maya) })
  };
  const task = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId, creatorUserId: alex.me.id };
  await enrol.alex.ownProject(team.id, projectId);
  await createEncryptedTask(alexEp, tasks.alex, {
    task, writer: hostIdentity, payload: { title: 'Retries', objective: 'create NOTES.md describing ' + before }
  });
  const runTurn = (text) => async (emit, decrypted) => {
    const turn = new TurnSession({
      thread: { id: task.id, cwd: project, settings: {} },
      by: { userId: alex.me.id, name: 'alex' },
      input: [{ type: 'text', text: text || decrypted.objective }],
      provider: { id: 'demo' }, settings: { approvalPolicy: 'never', sandboxPolicy: 'workspace-write' },
      executor: runtime.executor, history: [], emit, log: () => {}
    });
    await turn.run();
    return turn;
  };
  await encrypted.run(task, { runTurn: runTurn(null), provider: 'demo' });

  // Maya is granted, admitted, and can read what exists so far.
  await enrol.alex.grant(team.id, projectId, maya.me.id, 'participant');
  await encrypted.admitParticipants((await tasks.alex.list(team.id)).tasks[0]);
  let admitted = [];
  for (const event of await mayaEp.open(await mayaEp.transport.drain())) {
    const handover = readTaskHistory(event, task);
    if (!handover) continue;
    const accepted = await acceptProjectAccess(mayaEp, { history: handover.history }, { writer: hostIdentity });
    admitted = admitted.concat(accepted.sessions);
  }
  const mayaReader = new EncryptedTaskReader({ endpoint: mayaEp, task, writer: hostIdentity, admittedSessions: admitted });
  await mayaReader.reconnect(tasks.maya);
  assert.ok(mayaReader.state.objective.includes(before));
  const seenBefore = mayaReader.seq;
  const backupKey = randomBytes(32).toString('base64url');
  const backup = await mayaEp.exportHistory(['!' + task.id + ':plexus.local'], backupKey);
  pass('a participating device can read the task before it is removed', seenBefore + ' events');

  // ---- criterion 2: revoked here, pending until the host applies it ----
  await enrol.alex.revokeEndpoint(team.id, { userId: maya.me.id, device: 'MAYADEV' });
  const pendingState = await enrol.alex.state(team.id);
  const pendingRevocation = pendingState.revocations.find((r) => r.device === 'MAYADEV');
  assert.equal(pendingRevocation.applied, false);
  assert.deepEqual(pendingRevocation.pendingHosts, [runtime.id]);
  pass('a revocation is pending until the host that holds the keys has applied it',
    'named host still pending: ' + pendingRevocation.pendingHosts.join(', '));

  // ---- criterion 1: the host applies it, and the removed device loses the future ----
  const applied = await encrypted.applyRevocations();
  assert.equal(applied.applied.length, 1, JSON.stringify(applied));
  assert.ok(applied.rotated.includes(task.id));
  const appliedState = await enrol.alex.state(team.id);
  const done = appliedState.revocations.find((r) => r.device === 'MAYADEV');
  assert.equal(done.applied, true);
  assert.deepEqual(done.pendingHosts, []);
  pass('the host rotates the key and says it has applied the revocation', 'rotated ' + applied.rotated.length + ' task key(s)');

  // Something new happens on the task.
  await sendTaskControl(alexEp, hostIdentity, {
    task, action: 'link.add', payload: { id: 'lnk_after', url: 'https://example.invalid/' + after }
  });
  await encrypted.collect();

  // Alex still reads everything.
  const alexReader = new EncryptedTaskReader({ endpoint: alexEp, task, writer: hostIdentity });
  await alexEp.open(await alexEp.transport.drain());
  await alexReader.reconnect(tasks.alex);
  assert.ok(alexReader.state.links.some((l) => l.url.includes(after)));
  pass('a device that was not removed keeps reading the task', alexReader.seq + ' events');

  // Maya cannot. The relay will still hand her the ciphertext - membership is a separate
  // gate - and that is exactly the point: the refusal is cryptographic, not a permission.
  await mayaEp.open(await mayaEp.transport.drain());
  await refused('the removed device cannot read anything written after the rotation',
    'task_integrity_failed', () => mayaReader.reconnect(tasks.maya));
  pass('removal is enforced by the key, not by the relay declining to answer', 'rotation, not permission');

  // ---- criterion 4: and it cannot unsay what was already said ----
  assert.ok(mayaReader.state.objective.includes(before),
    'what she had already decrypted is still decrypted on her machine');
  assert.match(REVOCATION_LIMITS.alreadyRead, /does not erase/);
  assert.match(REVOCATION_LIMITS.participantHistory, /does not un-share/);
  assert.match(REVOCATION_LIMITS.distinctFromRole, /three separate things/);
  assert.match(REVOCATION_LIMITS.pending, /named rather than counted/);
  pass('already-read plaintext is not erased, and the product says so', 'stated, not implied');

  // Role and seat are untouched by a key decision.
  assert.ok(hub.store.membership(team.id, maya.me.id), 'she is still on the team');
  pass('revoking a device changes keys, not role or seat', 'membership unchanged');

  // ---- criterion 1: and cannot authorize anything either ----
  await refused('the removed device cannot ask the host to record anything',
    'endpoint_revoked', async () => {
      await sendTaskControl(mayaEp, hostIdentity, {
        task, action: 'help.request', payload: { id: 'help_after', question: 'let me back in', recipient: alex.me.id }
      });
      const out = await encrypted.collect();
      const refusal = out.refused[0];
      if (refusal) { const e = new Error(refusal.code); e.code = refusal.code; throw e; }
    });

  // ---- criterion 3: recovery cannot roll authorization back ----
  //
  // A restored endpoint holding the old exported keys is still a removed endpoint. The
  // rotation happened after the export, so the old keys open the old events and nothing else.
  const restored = await Endpoint.create({
    user: matrixUser(maya.me.id), device: 'MAYARESTORED',
    transport: new HubKeyTransport({ url, token: token(maya), device: 'MAYARESTORED' })
  });
  await restored.confirmEndpoint(hostIdentity, { confirmed: true });
  const imported = await restored.importHistory(backup, backupKey, ['!' + task.id + ':plexus.local']);
  const restoredReader = new EncryptedTaskReader({ endpoint: restored, task, writer: hostIdentity, admittedSessions: imported.sessions });
  await refused('history restored from a backup does not restore access to what came after',
    'task_integrity_failed', () => restoredReader.reconnect(tasks.maya));
  restored.close();

  const out = path.join(__dirname, '..', '.artifacts', 'revocation');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log('\n' + results.length + ' revocation checks passed');
})().then(async () => {
  for (const c of clients) c.close();
  try { encrypted?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  await hub?.close?.(); process.exit(0);
}).catch(async (error) => {
  console.error('REVOCATION FAILED\n', error);
  for (const c of clients) c.close();
  try { encrypted?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
