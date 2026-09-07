'use strict';
// Acceptance test for issue #13 (P12): reviewing a correction and handing over the task.
//
// The scenario is the point, so it is played out rather than asserted piecewise: an agent
// makes an assumption, a teammate corrects it and the correction is recorded as a decision,
// the next turn changes the file, and the whole thing is then handed to somebody else with a
// note. Every claim on the resulting screen has to point at the event behind it.
//
// The criterion that turned out to be a real defect is the fourth one. A task used to be
// marked completed the moment a turn finished - so an agent stopping counted as the work
// being done, before anybody had looked at it. Those are recorded separately now, and this
// test asserts a finished turn leaves the task open.
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
const { EnrollmentTransport, announcement, confirmTeammateEndpoint, acceptProjectAccess } = require('../packages/e2ee/enrollment.mjs');
const { sendTaskControl, readTaskHistory } = require('../packages/e2ee/task-control.mjs');
const { catchUp, openSource, sourcesOf } = require('../packages/e2ee/catchup.mjs');
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-handover-'));
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
  const maya = new Client(url.replace('http', 'ws'), 'maya');
  const sam = new Client(url.replace('http', 'ws'), 'sam');
  clients = [alex, maya, sam];
  await Promise.all(clients.map((c) => c.connect()));
  await waitFor(() => hub.pendingPairings.size, 'pairing offered');
  const team = (await alex.op({ type: TeamOps.TEAM_CREATE, name: 'Checkout team' }, 'team')).team;
  for (const guest of [maya, sam]) {
    const invite = await alex.op({ type: TeamOps.INVITE_CREATE, teamId: team.id, inviteeUserId: guest.me.id, ttlMs: 60000 }, 'invitation');
    await guest.op({ type: TeamOps.INVITE_ACCEPT, code: invite.invitation.code }, 'team');
  }
  await alex.op({ type: TeamOps.RUNTIME_PAIR, teamId: team.id, code: runtime.pairingCode });
  await waitFor(() => runtime.teamId === team.id, 'paired');

  const token = (c) => hub.store.userById(c.me.id).token;
  const enrol = {
    alex: new EnrollmentTransport({ url, token: token(alex) }),
    maya: new EnrollmentTransport({ url, token: token(maya) }),
    sam: new EnrollmentTransport({ url, token: token(sam) })
  };
  const endpoints = {};
  for (const who of ['alex', 'maya', 'sam']) {
    const client = { alex, maya, sam }[who];
    endpoints[who] = await Endpoint.create({
      user: matrixUser(client.me.id), device: who.toUpperCase() + 'DEV',
      transport: new HubKeyTransport({ url, token: token(client), device: who.toUpperCase() + 'DEV' })
    });
  }
  await enrol.alex.bootstrap(team.id, announcement(endpoints.alex));
  for (const who of ['maya', 'sam']) {
    await enrol[who].announce(team.id, announcement(endpoints[who]));
    await confirmTeammateEndpoint(endpoints.alex, enrol.alex, team.id,
      { userId: { alex, maya, sam }[who].me.id, ...announcement(endpoints[who]) }, { confirmed: true });
  }

  const projectId = newId('ep');
  encrypted = new EncryptedHost({
    runtime, url, statePath: path.join(tmp, 'outbox.sqlite'),
    projects: new Map([[projectId, project]]), log: () => {}
  });
  const hostIdentity = await encrypted.start();
  for (const who of ['alex', 'maya', 'sam']) await endpoints[who].confirmEndpoint(hostIdentity, { confirmed: true });

  const tasks = {
    alex: new EncryptedTaskTransport({ url, token: token(alex) }),
    maya: new EncryptedTaskTransport({ url, token: token(maya) })
  };
  const task = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId, creatorUserId: alex.me.id };
  await createEncryptedTask(endpoints.alex, tasks.alex, {
    task, writer: hostIdentity,
    payload: { title: 'Retry notes', objective: 'create NOTES.md describing ' + canary }
  });

  // ---- the assumption ----
  const turn = (text, by) => async (emit, decrypted) => {
    const session = new TurnSession({
      thread: { id: task.id, cwd: project, settings: {} },
      by, input: [{ type: 'text', text: text || decrypted.objective }],
      provider: { id: 'demo' }, settings: { approvalPolicy: 'never', sandboxPolicy: 'workspace-write' },
      executor: runtime.executor, history: [], emit, log: () => {}
    });
    await session.run();
    return session;
  };
  await encrypted.run(task, { runTurn: turn(null, { userId: alex.me.id, name: 'alex' }), provider: 'demo' });

  const reader = new EncryptedTaskReader({ endpoint: endpoints.alex, task, writer: hostIdentity });
  await endpoints.alex.open(await endpoints.alex.transport.drain());
  await reader.reconnect(tasks.alex);
  assert.ok(reader.state.diffs.length, 'the first turn changed a file');
  pass('an agent acts on the original objective and changes a file', reader.state.diffs.map((f) => f.path).join(', '));

  // ---- criterion 4, the defect: a finished turn is not a finished task ----
  assert.equal(reader.state.turn, 'completed', 'the turn finished');
  assert.equal(reader.state.outcome, null, 'and the task is still open');
  const afterTurn = catchUp(reader.snapshot(), { taskId: task.id, projectId, host: runtime.id, hostConnected: true });
  assert.equal(afterTurn.outcome.value, 'open');
  assert.equal(afterTurn.outcome.provenance, 'derived');
  assert.equal(afterTurn.turn.value, 'completed');
  assert.equal(afterTurn.turn.provenance, 'recorded');
  pass('a finished turn leaves the task open, and both are recorded separately', 'turn completed, task open');

  // ---- the correction, recorded as a decision by the person who made it ----
  await enrol.alex.grant(team.id, projectId, maya.me.id, 'participant');
  await encrypted.admitParticipants(task);
  let admittedSessions = [];
  for (const event of await endpoints.maya.open(await endpoints.maya.transport.drain())) {
    const handover = readTaskHistory(event, task);
    if (!handover) continue;
    const accepted = await acceptProjectAccess(endpoints.maya, { history: handover.history }, { writer: hostIdentity });
    admittedSessions = admittedSessions.concat(accepted.sessions);
  }

  // A correction is a turn a person drove, and the decision they took responsibility for.
  await encrypted.run(task, {
    runTurn: turn('create NOTES.md describing the corrected retry policy', { userId: maya.me.id, name: 'maya' }),
    provider: 'demo'
  });
  // The decision itself is recorded through the same sealed channel any teammate uses.
  await sendTaskControl(endpoints.maya, hostIdentity, {
    task, action: 'help.request',
    payload: { id: 'help_correction01', question: 'The first note assumed retries were idempotent; they are not.', recipient: alex.me.id }
  });
  await encrypted.collect();

  const readerMaya = new EncryptedTaskReader({ endpoint: endpoints.maya, task, writer: hostIdentity, admittedSessions });
  await endpoints.maya.open(await endpoints.maya.transport.drain());
  await readerMaya.reconnect(tasks.maya);

  // ---- criterion 1: the whole scenario is navigable from the projection ----
  const context = { taskId: task.id, projectId, host: runtime.id, provider: 'demo', hostConnected: true };
  const view = catchUp(readerMaya.snapshot(), context);
  assert.ok(view.objective.value.includes(canary), 'the original objective is there');
  assert.ok(view.changes.value.length, 'and the file it changed');
  assert.equal(view.pending.help.length, 1, 'and the correction somebody raised');
  const refs = sourcesOf(view);
  for (const source of refs) assert.equal(openSource(readerMaya.snapshot(), source).available, true, source.type);
  pass('the assumption, the correction and the file change are all on one screen and all sourced',
    refs.length + ' references, every one resolving');

  // ---- criterion 3: responsibility cannot be handed to somebody without access ----
  await sendTaskControl(endpoints.alex, hostIdentity, {
    task, action: 'responsibility.handover', payload: { to: sam.me.id, note: 'over to you' }
  });
  const refusedHandover = await encrypted.collect();
  assert.ok(refusedHandover.refused.some((r) => r.code === 'recipient_not_in_project'), JSON.stringify(refusedHandover));
  await reader.reconnect(tasks.alex);
  assert.equal(reader.state.handover, null, 'nothing was recorded for the refused handover');
  pass('responsibility cannot be handed to somebody without project access', 'recipient_not_in_project');

  // ---- criterion 2: the handover moves responsibility and nothing else ----
  const approversBefore = hub.store.isApprover(team.id, maya.me.id);
  const hostBefore = JSON.stringify(hub.store.getRuntime(runtime.id));
  await sendTaskControl(endpoints.alex, hostIdentity, {
    task, action: 'responsibility.handover',
    payload: { to: maya.me.id, note: 'You corrected it, so it should be yours to close.' }
  });
  const handed = await encrypted.collect();
  assert.equal(handed.applied.length, 1, JSON.stringify(handed));
  await reader.reconnect(tasks.alex);
  const handover = reader.state.handover;
  assert.equal(handover.to, maya.me.id);
  assert.equal(handover.from, alex.me.id);
  assert.equal(handover.by, alex.me.id);
  assert.match(handover.note, /should be yours to close/);
  pass('responsibility moves, with a note, recorded and attributed', alex.me.id + ' to ' + maya.me.id);

  assert.equal(hub.store.isApprover(team.id, maya.me.id), approversBefore,
    'being handed a task did not make her an approver');
  assert.equal(JSON.stringify(hub.store.getRuntime(runtime.id)), hostBefore,
    'and changed nothing about the host or its provider usage');
  pass('responsibility does not silently carry approval rights or provider credentials',
    'approver set and host descriptor both unchanged');

  const handedView = catchUp(reader.snapshot(), { ...context, responsible: 'alex' });
  assert.equal(handedView.responsible.value, maya.me.id, 'the log outranks what the screen was told');
  assert.equal(handedView.responsible.provenance, 'recorded');
  assert.equal(handedView.host.value, runtime.id, 'the execution host is unchanged');
  assert.equal(handedView.provider.value, 'demo', 'and so is the provider');
  pass('the screen shows the new owner and the unchanged host and provider', 'responsible recorded, host and provider steady');

  // ---- criterion 4: recording the outcome is a person's act ----
  await sendTaskControl(endpoints.maya, hostIdentity, { task, action: 'task.outcome', payload: { outcome: 'completed' } });
  const settled = await encrypted.collect();
  assert.equal(settled.applied.length, 1, JSON.stringify(settled));
  await reader.reconnect(tasks.alex);
  assert.equal(reader.state.outcome, 'completed');
  assert.equal(reader.state.completedBy, maya.me.id);
  const done = catchUp(reader.snapshot(), context);
  assert.equal(done.outcome.provenance, 'recorded');
  assert.equal(done.outcome.actor, maya.me.id);
  pass('the task is completed when a person records it, and their name is on it', 'by ' + maya.me.id);

  // And it is not settled twice by somebody arriving late.
  await sendTaskControl(endpoints.alex, hostIdentity, { task, action: 'task.outcome', payload: { outcome: 'cancelled' } });
  const second = await encrypted.collect();
  assert.ok(second.refused.some((r) => r.code === 'task_already_settled'), JSON.stringify(second));
  await reader.reconnect(tasks.alex);
  assert.equal(reader.state.outcome, 'completed', 'the first outcome stands');
  pass('an outcome is recorded once, and a later one does not overwrite it', 'task_already_settled');

  // A teammate with no project access cannot close somebody else's work either.
  await sendTaskControl(endpoints.sam, hostIdentity, { task, action: 'task.outcome', payload: { outcome: 'cancelled' } });
  const outsider = await encrypted.collect();
  assert.ok(outsider.refused.some((r) => r.code === 'sender_not_in_project'), JSON.stringify(outsider));
  pass('somebody outside the project cannot record its outcome', 'sender_not_in_project');

  // ---- and none of it reaches the relay ----
  const relay = JSON.stringify({
    events: await tasks.alex.page(task.id), tasks: await tasks.alex.list(team.id),
    threads: hub.store.listThreads(team.id)
  });
  assert.equal(relay.includes(canary), false);
  assert.equal(relay.includes('yours to close'), false, 'the handover note is content too');
  pass('the handover note and the task content stay out of the relay', canary.slice(0, 12) + '...');

  const out = path.join(__dirname, '..', '.artifacts', 'handover');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log('\n' + results.length + ' handover checks passed');
})().then(async () => {
  for (const c of clients) c.close();
  try { encrypted?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  await hub?.close?.(); process.exit(0);
}).catch(async (error) => {
  console.error('HANDOVER FAILED\n', error);
  for (const c of clients) c.close();
  try { encrypted?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
