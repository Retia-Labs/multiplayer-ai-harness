'use strict';
// Acceptance test for issue #15 (P14): getting encrypted history back on a clean device.
//
// The endpoint that restores here is genuinely clean - a new Endpoint, new keys, no store, no
// knowledge of the task and no trust from anybody. That is the only version of this test worth
// running: an endpoint that had ever held the session keys would pass without proving anything.
//
// The claims being tested are as much about what recovery does *not* do. It restores history.
// It does not restore who you are to anybody else, it does not restore permission to do
// anything, and it cannot restore a provider account. Each of those is asserted, because
// somebody assuming otherwise is the failure this issue is really about.
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
const { matrixUser, roomFor } = require('../packages/protocol/encrypted-task.mjs');
const { EnrollmentTransport, announcement } = require('../packages/e2ee/enrollment.mjs');
const { RecoveryTransport, backupHistory, restoreHistory, confirmRecoveryDrill, rotateRecovery, RECOVERY_LIMITS } = require('../packages/e2ee/recovery.mjs');
const { TeamOps } = require('../packages/protocol');

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

const waitFor = async (fn, label = '') => {
  for (let n = 0; n < 400; n++) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout: ' + label);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-recovery-'));
const canary = 'PRIVATE_' + randomBytes(16).toString('hex');
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
  const nosy = new Client(url.replace('http', 'ws'), 'nosy');
  clients = [alex, nosy];
  await Promise.all(clients.map((c) => c.connect()));
  await waitFor(() => hub.pendingPairings.size, 'pairing offered');
  const team = (await alex.op({ type: TeamOps.TEAM_CREATE, name: 'Checkout team' }, 'team')).team;
  const invite = await alex.op({ type: TeamOps.INVITE_CREATE, teamId: team.id, inviteeUserId: nosy.me.id, ttlMs: 60000 }, 'invitation');
  await nosy.op({ type: TeamOps.INVITE_ACCEPT, code: invite.invitation.code }, 'team');
  await alex.op({ type: TeamOps.RUNTIME_PAIR, teamId: team.id, code: runtime.pairingCode });
  await waitFor(() => runtime.teamId === team.id, 'paired');

  const token = (c) => hub.store.userById(c.me.id).token;
  const enrol = new EnrollmentTransport({ url, token: token(alex) });
  const laptop = await Endpoint.create({
    user: matrixUser(alex.me.id), device: 'LAPTOP',
    transport: new HubKeyTransport({ url, token: token(alex), device: 'LAPTOP' })
  });
  await enrol.bootstrap(team.id, announcement(laptop));

  const projectId = newId('ep');
  encrypted = new EncryptedHost({
    runtime, url, statePath: path.join(tmp, 'outbox.sqlite'),
    projects: new Map([[projectId, project]]), log: () => {}
  });
  const hostIdentity = await encrypted.start();
  await laptop.confirmEndpoint(hostIdentity, { confirmed: true });

  const tasks = new EncryptedTaskTransport({ url, token: token(alex) });
  const task = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId, creatorUserId: alex.me.id };
  await createEncryptedTask(laptop, tasks, {
    task, writer: hostIdentity, payload: { title: 'Retry notes', objective: 'create NOTES.md describing ' + canary }
  });
  await encrypted.run(task, {
    provider: 'demo',
    runTurn: async (emit, decrypted) => {
      const turn = new TurnSession({
        thread: { id: task.id, cwd: project, settings: {} },
        by: { userId: alex.me.id, name: 'alex' },
        input: [{ type: 'text', text: decrypted.objective }],
        provider: { id: 'demo' }, settings: { approvalPolicy: 'never', sandboxPolicy: 'workspace-write' },
        executor: runtime.executor, history: [], emit, log: () => {}
      });
      await turn.run();
      return turn;
    }
  });
  await laptop.open(await laptop.transport.drain());
  const onLaptop = new EncryptedTaskReader({ endpoint: laptop, task, writer: hostIdentity });
  await onLaptop.reconnect(tasks);
  assert.ok(onLaptop.state.objective.includes(canary));
  pass('a task exists and the original endpoint can read it', onLaptop.seq + ' events');

  // ---- criterion 4: the onboarding exercise, before any of this is relied on ----
  const issued = await laptop.enableRecovery();
  assert.ok(issued.recoveryKey.length >= 32);
  await refused('a recovery drill nobody completed does not count as done', 'recovery_drill_incomplete',
    async () => confirmRecoveryDrill(issued.recoveryKey, '   '));
  await refused('typing something close but wrong does not count either', 'recovery_drill_mismatch',
    async () => confirmRecoveryDrill(issued.recoveryKey, issued.recoveryKey.slice(0, -1) + 'x'));
  assert.deepEqual(confirmRecoveryDrill(issued.recoveryKey, ' ' + issued.recoveryKey + ' '), { confirmed: true });
  pass('the key is only considered stored once somebody reproduces it', 'whitespace forgiven, nothing else');

  // ---- criterion 1: back it up, and check what the operator can see ----
  const recovery = new RecoveryTransport({ url, token: token(alex) });
  const backed = await backupHistory(laptop, recovery, {
    scope: 'project:' + projectId, taskIds: [task.id], recoveryKey: issued.recoveryKey, roomFor
  });
  assert.ok(backed.bytes > 0);
  pass('the history is backed up encrypted to material the customer holds', backed.bytes + ' bytes for 1 task');

  const stored = hub.store.db.prepare('SELECT * FROM e2ee_recovery').all();
  assert.equal(stored.length, 1);
  const operatorView = JSON.stringify(stored);
  assert.equal(operatorView.includes(canary), false, 'the operator cannot read the history');
  assert.equal(operatorView.includes('NOTES.md'), false, 'nor what it touched');
  assert.equal(operatorView.includes(task.id), false, 'nor which task it is');
  const listed = await recovery.list();
  assert.deepEqual(Object.keys(listed.backups[0]).sort(), ['bytes', 'scope', 'updatedAt', 'version']);
  pass('the operator sees that a backup exists, its size and its age - and nothing in it',
    'scope, version, updatedAt, bytes');

  // A teammate on the same team cannot fetch somebody else's recovery material.
  const nosyRecovery = new RecoveryTransport({ url, token: token(nosy) });
  await refused('a teammate cannot fetch another account’s recovery material', 'no_recovery_material',
    () => nosyRecovery.get('project:' + projectId));
  pass('history is shared by a grant, never by reading somebody’s backup', 'per-account, not per-team');

  // ---- criterion 1: a genuinely clean endpoint ----
  const replacement = await Endpoint.create({
    user: matrixUser(alex.me.id), device: 'NEWLAPTOP',
    transport: new HubKeyTransport({ url, token: token(alex), device: 'NEWLAPTOP' })
  });
  const cleanReader = new EncryptedTaskReader({ endpoint: replacement, task, writer: hostIdentity });
  await refused('the clean endpoint can fetch the ciphertext and read none of it', 'task_integrity_failed',
    () => cleanReader.reconnect(tasks));

  const cleanRecovery = new RecoveryTransport({ url, token: token(alex) });
  await refused('the wrong recovery material fails', 'recovery_material_rejected',
    () => restoreHistory(replacement, cleanRecovery, {
      scope: 'project:' + projectId, taskIds: [task.id],
      recoveryKey: 'K'.repeat(issued.recoveryKey.length), roomFor
    }));
  await refused('material that is obviously too short is refused before anything is tried', 'recovery_key_too_weak',
    () => restoreHistory(replacement, cleanRecovery, {
      scope: 'project:' + projectId, taskIds: [task.id], recoveryKey: 'short', roomFor
    }));
  await refused('asking for history this backup never held is its own answer', 'recovery_scope_mismatch',
    () => restoreHistory(replacement, cleanRecovery, {
      scope: 'project:' + projectId, taskIds: [newId('et')], recoveryKey: issued.recoveryKey, roomFor
    }));

  const restored = await restoreHistory(replacement, cleanRecovery, {
    scope: 'project:' + projectId, taskIds: [task.id], recoveryKey: issued.recoveryKey, roomFor
  });
  assert.ok(restored.restored.sessions.length, JSON.stringify(restored));
  await replacement.confirmEndpoint(hostIdentity, { confirmed: true });
  const recoveredReader = new EncryptedTaskReader({
    endpoint: replacement, task, writer: hostIdentity, admittedSessions: restored.restored.sessions
  });
  await recoveredReader.reconnect(tasks);
  assert.ok(recoveredReader.state.objective.includes(canary));
  assert.deepEqual(recoveredReader.state.events, onLaptop.state.events);
  pass('the clean endpoint restores the history with the customer key alone',
    recoveredReader.seq + ' events, identical to the original');

  // ---- criterion 3: what recovery did not restore ----
  assert.ok(restored.notRestored.endpointTrust.length > 20);
  assert.ok(restored.notRestored.approvalAuthority.length > 20);
  assert.ok(restored.notRestored.providerCredentials.length > 20);
  pass('the restore states its scope and the three things it did not restore', 'trust, authority, credentials');

  // The restored device is nobody's trusted device. The enrolment still has never heard of it.
  const enrolment = await enrol.state(team.id);
  assert.equal((enrolment.endpoints || []).some((e) => e.device === 'NEWLAPTOP'), false,
    'the new device has not announced itself, let alone been confirmed');
  pass('a restored endpoint is not a trusted endpoint', 'it still has to announce and be confirmed');

  // Nothing about approval authority or a provider account is in the material.
  const blob = (await cleanRecovery.get('project:' + projectId)).ciphertext;
  assert.equal(/sk-[A-Za-z0-9_-]{12,}|OPENAI_API_KEY|access_token|refresh_token/i.test(blob), false,
    'no credential material is in the backup');
  assert.equal(hub.store.isApprover(team.id, alex.me.id), false,
    'restoring did not make the restorer an approver');
  pass('recovery carries no approval authority and no provider credentials', 'scans clean, approver set unchanged');

  // ---- criterion 4: rotation, and what it honestly does ----
  const rotated = await rotateRecovery(replacement, cleanRecovery, {
    scope: 'project:' + projectId, taskIds: [task.id], roomFor
  });
  assert.notEqual(rotated.recoveryKey, issued.recoveryKey);
  assert.match(rotated.caveat, /already downloaded/);
  const afterRotation = await cleanRecovery.get('project:' + projectId);
  assert.notEqual(afterRotation.ciphertext, blob, 'the stored blob was replaced');
  pass('the key can be replaced, and the limit of doing so is stated', 'old copies stay openable by the old key');

  // ---- criterion 1: the honest account of total loss ----
  assert.match(RECOVERY_LIMITS.everythingLost, /cannot be recovered/);
  assert.match(RECOVERY_LIMITS.everythingLost, /not the operator/);
  assert.match(RECOVERY_LIMITS.siteDataCleared, /destroys/);
  assert.match(RECOVERY_LIMITS.storageLocked, /no durable identity/);
  pass('losing every endpoint and the key is explained as unrecoverable, not hedged',
    'no second path, stated as a design choice');

  const out = path.join(__dirname, '..', '.artifacts', 'recovery');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log('\n' + results.length + ' recovery checks passed');
})().then(async () => {
  for (const c of clients) c.close();
  try { encrypted?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  await hub?.close?.(); process.exit(0);
}).catch(async (error) => {
  console.error('RECOVERY FAILED\n', error);
  for (const c of clients) c.close();
  try { encrypted?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
