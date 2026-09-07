'use strict';
// Acceptance test for issue #12 (P11): asking a named teammate for help, in an encrypted task.
//
// The question is content, so it lives in the encrypted log and nowhere else. That forces the
// shape of everything here: a teammate cannot append to a log they do not write, so the
// question is sealed to the host and the host records it - which is also what makes the "who
// asked" in the log a fact rather than a name somebody typed.
//
// The three things worth breaking are all tested by trying to break them: addressing a
// question outside the project, closing somebody else's question, and getting a question to
// reach a provider.
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
const { catchUp, inbox } = require('../packages/e2ee/catchup.mjs');
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-help-'));
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

  // ---- a team of three: two on the project, one only on the team ----
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

  // ---- a task, and a real turn on it ----
  const tasks = {
    alex: new EncryptedTaskTransport({ url, token: token(alex) }),
    maya: new EncryptedTaskTransport({ url, token: token(maya) })
  };
  const task = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId, creatorUserId: alex.me.id };
  await createEncryptedTask(endpoints.alex, tasks.alex, {
    task, writer: hostIdentity,
    payload: { title: 'Checkout retries', objective: 'create NOTES.md describing ' + canary }
  });
  const runTurn = async (emit, decrypted) => {
    const turn = new TurnSession({
      thread: { id: task.id, cwd: project, settings: {} },
      by: { userId: alex.me.id, name: 'alex' },
      input: [{ type: 'text', text: decrypted.objective }],
      provider: { id: 'demo' }, settings: { approvalPolicy: 'never', sandboxPolicy: 'workspace-write' },
      executor: runtime.executor, history: [], emit, log: () => {}
    });
    await turn.run();
    return turn;
  };
  const ran = await encrypted.run(task, { runTurn, provider: 'demo' });
  pass('a task is created and run before anybody asks for help', ran.events + ' events');

  // Alex owns the project by creating a task in it; maya is granted access, sam is not.
  await enrol.alex.grant(team.id, projectId, maya.me.id, 'participant');

  // A grant is the relay's gate and hands nobody a key. The host owns the group session, so
  // it is the only party that can share one - and until it does, a granted teammate can
  // fetch the ciphertext and read none of it.
  const beforeAdmit = new EncryptedTaskReader({ endpoint: endpoints.maya, task, writer: hostIdentity });
  await refused('a grant alone does not let the recipient read the task', 'task_integrity_failed',
    () => beforeAdmit.reconnect(tasks.maya));

  const admitted = await encrypted.admitParticipants(task);
  assert.ok(admitted.admitted.includes(maya.me.id), JSON.stringify(admitted));
  assert.equal(admitted.admitted.includes(sam.me.id), false, 'nobody without a grant is admitted');
  pass('the host admits the people a live grant covers, and only those', admitted.admitted.length + ' admitted');

  // The handoff arrives on the same sealed channel, and is only usable because it came from
  // the writer - acceptProjectAccess refuses one from anybody else.
  let admittedSessions = [];
  for (const event of await endpoints.maya.open(await endpoints.maya.transport.drain())) {
    const handover = readTaskHistory(event, task);
    if (!handover) continue;
    const accepted = await acceptProjectAccess(endpoints.maya, { history: handover.history }, { writer: hostIdentity });
    admittedSessions = admittedSessions.concat(accepted.sessions);
  }
  assert.ok(admittedSessions.length, 'the history handoff reached the recipient');
  pass('the recipient is handed the history of the task she was granted', admittedSessions.length + ' sessions');

  // ---- criterion 1: an encrypted question, addressed to somebody who can receive it ----
  const helpId = 'help_' + randomBytes(8).toString('hex');
  await sendTaskControl(endpoints.alex, hostIdentity, {
    task, action: 'help.request',
    payload: { id: helpId, question: 'Is the retry idempotent for ' + canary + '?', recipient: maya.me.id }
  });
  const collected = await encrypted.collect();
  assert.equal(collected.applied.length, 1, 'the host recorded one request: ' + JSON.stringify(collected));
  assert.equal(collected.applied[0].type, 'help.requested');
  pass('a sealed question reaches the host and is written to the encrypted log', helpId);

  const readerAlex = new EncryptedTaskReader({ endpoint: endpoints.alex, task, writer: hostIdentity });
  await endpoints.alex.open(await endpoints.alex.transport.drain());
  await readerAlex.reconnect(tasks.alex);
  const asked = readerAlex.state.help.find((h) => h.id === helpId);
  assert.equal(asked.from, alex.me.id, 'the host states who asked, from the seal');
  assert.equal(asked.recipient, maya.me.id);
  assert.ok(asked.question.includes(canary));
  pass('the log records requester, recipient and the question itself', 'from ' + asked.from);

  // A client cannot put somebody else's name on its own question: the host takes the asker
  // from the authenticated envelope and ignores anything the payload claims.
  const forgedId = 'help_' + randomBytes(8).toString('hex');
  await sendTaskControl(endpoints.maya, hostIdentity, {
    task, action: 'help.request',
    payload: { id: forgedId, question: 'Signed by somebody else', from: alex.me.id, recipient: alex.me.id }
  });
  await encrypted.collect();
  await endpoints.alex.open(await endpoints.alex.transport.drain());
  await readerAlex.reconnect(tasks.alex);
  const forged = readerAlex.state.help.find((h) => h.id === forgedId);
  assert.equal(forged.from, maya.me.id, 'the asker is who sealed it, not who the payload named');
  pass('a request cannot claim to be from somebody else', 'payload said alex, log says maya');

  // ---- criterion 1: a recipient outside the project is refused ----
  const outsideId = 'help_' + randomBytes(8).toString('hex');
  await sendTaskControl(endpoints.alex, hostIdentity, {
    task, action: 'help.request',
    payload: { id: outsideId, question: 'Can you look at this?', recipient: sam.me.id }
  });
  const outside = await encrypted.collect();
  assert.equal(outside.applied.length, 0);
  assert.ok(outside.refused.some((r) => r.code === 'recipient_not_in_project'), JSON.stringify(outside));
  await readerAlex.reconnect(tasks.alex);
  assert.equal(readerAlex.state.help.some((h) => h.id === outsideId), false,
    'nothing was written for the refused request');
  pass('a question addressed outside the project is refused, not recorded', 'recipient_not_in_project');

  // And an endpoint on the team but not on the project cannot ask either.
  const strangerId = 'help_' + randomBytes(8).toString('hex');
  await sendTaskControl(endpoints.sam, hostIdentity, {
    task, action: 'help.request',
    payload: { id: strangerId, question: 'Let me in', recipient: alex.me.id }
  });
  const stranger = await encrypted.collect();
  assert.ok(stranger.refused.some((r) => r.code === 'sender_not_in_project'), JSON.stringify(stranger));
  pass('being a verified endpoint is not being on the project', 'sender_not_in_project');

  // ---- criterion 2: the inbox and the task agree, on a client that joined late ----
  const readerMaya = new EncryptedTaskReader({ endpoint: endpoints.maya, task, writer: hostIdentity, admittedSessions });
  await endpoints.maya.open(await endpoints.maya.transport.drain());
  await readerMaya.reconnect(tasks.maya);
  const context = { taskId: task.id, projectId, responsible: 'alex', host: runtime.id, hostConnected: true };
  const mayaView = catchUp(readerMaya.snapshot(), context);
  const mayaInbox = inbox([{ projection: mayaView }], maya.me.id);
  assert.equal(mayaInbox.length, 1, JSON.stringify(mayaInbox));
  assert.equal(mayaInbox[0].request.id, helpId);
  assert.equal(mayaInbox[0].taskId, task.id);
  assert.ok(mayaInbox[0].request.question.includes(canary));
  pass('the recipient replays the task and finds the question in her inbox', mayaInbox[0].request.id);

  const alexInbox = inbox([{ projection: catchUp(readerAlex.snapshot(), context) }], alex.me.id);
  assert.deepEqual(alexInbox.map((e) => e.request.id), [forgedId],
    'alex sees only the question addressed to him');
  pass('an inbox shows what was addressed to that person and nothing else', '1 of 2 open requests');

  // The task view and the inbox come from the same projection, so they cannot disagree.
  assert.equal(mayaView.pending.help.length, 2, 'both open questions are on the task view');
  pass('the task view carries every open question, the inbox only the ones for you', '2 on the task, 1 in the inbox');

  // ---- criterion 3: asking for help is not talking to the agent ----
  const before = readerAlex.state.events.filter((e) => e.type === 'message.added').length;
  const beforeTools = readerAlex.state.tools.length;
  await encrypted.collect();
  await readerAlex.reconnect(tasks.alex);
  assert.equal(readerAlex.state.events.filter((e) => e.type === 'message.added').length, before,
    'no message was added to the transcript');
  assert.equal(readerAlex.state.tools.length, beforeTools, 'and no tool ran');
  assert.equal(runtime.sessions.size ? [...runtime.sessions.values()].filter((s) => s.running).length : 0, 0,
    'no turn is running');
  pass('a help request produces no provider input and no execution', 'transcript and tools unchanged');

  // ---- criterion 1: only the right person closes it ----
  await sendTaskControl(endpoints.alex, hostIdentity, { task, action: 'help.settle', payload: { id: helpId, outcome: 'resolved' } });
  const wrongCloser = await encrypted.collect();
  assert.ok(wrongCloser.refused.some((r) => r.code === 'not_the_help_owner'), JSON.stringify(wrongCloser));
  pass('the person who asked cannot mark their own question resolved', 'not_the_help_owner');

  await sendTaskControl(endpoints.maya, hostIdentity, { task, action: 'help.settle', payload: { id: helpId, outcome: 'resolved' } });
  const settled = await encrypted.collect();
  assert.equal(settled.applied.length, 1, JSON.stringify(settled));
  await endpoints.maya.open(await endpoints.maya.transport.drain());
  await readerMaya.reconnect(tasks.maya);
  const closed = readerMaya.state.help.find((h) => h.id === helpId);
  assert.equal(closed.outcome, 'resolved');
  assert.equal(closed.settledBy, maya.me.id);
  assert.deepEqual(inbox([{ projection: catchUp(readerMaya.snapshot(), context) }], maya.me.id), []);
  pass('the recipient resolves it, and it leaves her inbox', 'resolved by ' + closed.settledBy);

  // The asker withdrawing is a different act, and is allowed.
  await sendTaskControl(endpoints.maya, hostIdentity, { task, action: 'help.settle', payload: { id: forgedId, outcome: 'cancelled' } });
  const cancelled = await encrypted.collect();
  assert.equal(cancelled.applied.length, 1, JSON.stringify(cancelled));
  await readerAlex.reconnect(tasks.alex);
  assert.equal(readerAlex.state.help.find((h) => h.id === forgedId).outcome, 'cancelled');
  pass('the person who asked can withdraw their own question', 'cancelled');

  // ---- criterion 2: a reconnect from zero produces the same state ----
  const fresh = new EncryptedTaskReader({ endpoint: endpoints.maya, task, writer: hostIdentity, admittedSessions });
  await fresh.reconnect(tasks.maya);
  await readerMaya.reconnect(tasks.maya);
  assert.deepEqual(catchUp(fresh.snapshot(), context), catchUp(readerMaya.snapshot(), context));
  pass('a client replaying from zero sees the same open and closed questions', fresh.seq + ' events');

  // ---- criterion 4: the relay holds none of it ----
  const relay = JSON.stringify({
    events: await tasks.alex.page(task.id),
    tasks: await tasks.alex.list(team.id),
    threads: hub.store.listThreads(team.id)
  });
  assert.equal(relay.includes(canary), false, 'the question is not in anything the relay serves');
  assert.equal(relay.includes('idempotent'), false, 'nor any of its words');
  pass('the relay carries the question as ciphertext and nothing else', canary.slice(0, 12) + '...');

  const out = path.join(__dirname, '..', '.artifacts', 'help-inbox');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log('\n' + results.length + ' help inbox checks passed');
})().then(async () => {
  for (const c of clients) c.close();
  try { encrypted?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  await hub?.close?.(); process.exit(0);
}).catch(async (error) => {
  console.error('HELP INBOX FAILED\n', error);
  for (const c of clients) c.close();
  try { encrypted?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
