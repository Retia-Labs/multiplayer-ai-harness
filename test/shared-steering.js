'use strict';
// Acceptance test for issue #10 (P09): two teammates steering and interrupting one task.
//
// The failure this guards against is the quiet one. Two people type at nearly the same
// moment, both see their own message appear, and both believe the agent got it - when the
// order was ambiguous, one instruction was applied to a turn it was never written for, or a
// message meant for a human was fed to the model. A visible message is not delivery, and
// most of these checks are about saying which of those actually happened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { TeamOps, Commands, Errors, Events, ItemTypes } = require('../packages/protocol');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
async function refused(name, code, fn) {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  assert.ok(error, name + ': expected a refusal, but it succeeded');
  const got = String(error.error || error.message || error);
  assert.ok(got.includes(code), name + ': expected ' + code + ', got ' + got);
  results.push({ name, status: 'pass', refusal: code });
  console.log('  PASS ' + name + ' - ' + code);
}
const waitFor = async (fn, label = '') => {
  for (let n = 0; n < 400; n++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout: ' + label);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-steering-'));
let hub, runtime, clients = [];

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
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  op(msg) {
    const id = msg.id || 'op_' + randomBytes(8).toString('hex');
    this.send({ ...msg, id });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout: ' + (msg.command?.method || msg.type))), 15000);
      this.waiters.push({
        pred: (m) => m.ref === id || (m.type === 'command.result' && m.id === id),
        resolve: (m) => {
          clearTimeout(timer);
          if (m.type === 'error') return reject(Object.assign(new Error(m.message || m.code), { error: m.code }));
          if (m.type === 'command.result' && !m.ok) return reject(Object.assign(new Error(m.error), { error: m.error }));
          resolve(m);
        }
      });
    });
  }
  command(threadId, command, id) { return this.op({ type: 'command', threadId, command, id }); }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  hub = new Hub({ dbFile: path.join(tmp, 'hub.sqlite'), log: () => {} });
  const addr = await hub.listen();
  const url = 'http://127.0.0.1:' + addr.port;
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  runtime = new Runtime({ hubUrl: url.replace('http', 'ws'), userName: 'host', dataDir: path.join(tmp, 'runtime'), projects: [project] });
  await runtime.start();

  const alice = new Client(url.replace('http', 'ws'), 'alice');
  const bob = new Client(url.replace('http', 'ws'), 'bob');
  clients = [alice, bob];
  await Promise.all([alice.connect(), bob.connect()]);
  await waitFor(() => hub.pendingPairings.size, 'pairing');
  const team = (await alice.op({ type: TeamOps.TEAM_CREATE, name: 'Steering team' })).team;
  await alice.op({ type: TeamOps.RUNTIME_PAIR, teamId: team.id, code: runtime.pairingCode });
  await waitFor(() => runtime.teamId === team.id, 'paired');
  const invite = await alice.op({ type: TeamOps.INVITE_CREATE, teamId: team.id, inviteeUserId: bob.me.id, ttlMs: 60000 });
  await bob.op({ type: TeamOps.INVITE_ACCEPT, code: invite.invitation.code });

  const started = await alice.op({ type: 'command', runtimeId: runtime.id, command: { method: Commands.THREAD_START, cwd: project } });
  const threadId = started.result.thread.id;
  // Demo turns are short. Any group of checks that needs a live turn starts its own, after
  // waiting for the previous one to finish, rather than assuming one is still running.
  const startTurn = async (text) => {
    await waitFor(() => {
      const t = hub.store.getThread(threadId);
      return !t || !t.activeTurnId;
    }, 'previous turn ended');
    const started = await alice.command(threadId, { method: Commands.TURN_START, input: [{ type: 'text', text }] });
    return started.result.turnId;
  };
  const turnId = await startTurn('Take a while.');
  assert.ok(turnId, 'a turn is running');

  // ================= criterion 1: two people, one order =================

  const [a, b] = await Promise.all([
    alice.command(threadId, { method: Commands.TURN_STEER, expectedTurnId: turnId, input: [{ type: 'text', text: 'alice says left' }] }),
    bob.command(threadId, { method: Commands.TURN_STEER, expectedTurnId: turnId, input: [{ type: 'text', text: 'bob says right' }] })
  ]);
  const seqs = [a.result.seq, b.result.seq].sort();
  assert.deepEqual(seqs, [1, 2], 'the host numbered them 1 and 2');
  assert.notEqual(a.result.seq, b.result.seq);
  assert.ok(['queued', 'queuedForNextProviderTurn'].includes(a.result.outcome), 'outcome is stated');
  assert.equal(a.result.turnId, turnId);
  pass('near-simultaneous instructions get one host order and an explicit outcome', 'seq ' + seqs.join(' then '));


  // The hub is where the event log lands, which is also where a teammate would read it.
  const events = () => hub.store.eventsFrom(threadId);
  const steers = () => events().filter((e) => e.method === Events.ITEM_COMPLETED && e.item?.type === ItemTypes.USER_MESSAGE);
  // Attribution rides on the message itself, which is what a reader of the transcript sees.
  await waitFor(() => {
    const named = events().filter((e) => e.item && e.item.by).map((e) => e.item.by.name);
    return named.includes('alice') && named.includes('bob');
  }, 'both actors in the hub log');
  pass('each instruction keeps its actor', 'alice and bob both attributed');
  // Queued is a promise; delivered is a fact, and the two genuinely come apart. An
  // instruction accepted while a turn is finishing may never reach a model call at all -
  // the queue is drained at the top of an agent loop that may not run again. That is the
  // whole reason the host reports `queued` rather than claiming delivery, so the test
  // asserts the distinction instead of assuming the happy case.
  const deliveredSeqs = () => events().filter((e) => e.method === Events.TURN_STEER_DELIVERED).map((e) => e.steerSeq);
  const settled = await waitFor(() => {
    const seen = deliveredSeqs();
    if (seen.includes(1) && seen.includes(2)) return { delivered: seen };
    const ended = events().find((e) => e.method === Events.TURN_COMPLETED && e.turnId === turnId);
    return ended ? { endedFirst: true, delivered: seen } : null;
  }, 'instructions delivered, or the turn ended first');

  if (settled.endedFirst) {
    // Accepted and never delivered. The host said queued and meant it.
    assert.equal(settled.delivered.includes(1) && settled.delivered.includes(2), false);
    pass('an accepted instruction is not delivered when the turn ends first', 'queued, never delivered - which is why they are separate words');
  } else {
    const one = events().find((e) => e.method === Events.TURN_STEER_DELIVERED && e.steerSeq === 1);
    assert.ok(one.by && one.by.name, 'delivery keeps the actor');
    pass('queued becomes delivered when the instruction reaches the agent, not before', 'seq 1 and 2 delivered');
  }

  // ================= criterion 2: retries and stale turns =================

  const retryTurn = await startTurn('Another one, take a while.');
  const retryId = 'op_' + randomBytes(8).toString('hex');
  const first = await alice.command(threadId, { method: Commands.TURN_STEER, expectedTurnId: retryTurn, input: [{ type: 'text', text: 'only once' }] }, retryId);
  const again = await alice.command(threadId, { method: Commands.TURN_STEER, expectedTurnId: retryTurn, input: [{ type: 'text', text: 'only once' }] }, retryId);
  assert.equal(again.duplicate, true, 'the retry is answered as a duplicate');
  assert.equal(again.result.seq, first.result.seq, 'and it did not take a new place in the order');
  // The reply matching is not enough: the host must never have accepted it a second time.
  const acceptedAfterRetry = runtime.sessions.get(threadId)?.acceptedSteers ?? 0;
  assert.equal(acceptedAfterRetry, first.result.seq, 'the host accepted it exactly once');
  pass('a retried instruction is answered, not delivered twice', 'accepted once, seq ' + first.result.seq);

  await refused('steering without naming a turn is refused', Errors.TURN_BINDING_REQUIRED,
    () => alice.command(threadId, { method: Commands.TURN_STEER, input: [{ type: 'text', text: 'unbound' }] }));
  // Refused instructions must not have been accepted anywhere, so the order is unchanged.
  const orderBefore = runtime.sessions.get(threadId)?.acceptedSteers ?? 0;

  await refused('steering a turn that is no longer running is refused', Errors.STALE_TURN,
    () => bob.command(threadId, { method: Commands.TURN_STEER, expectedTurnId: 'turn_stale_' + randomBytes(4).toString('hex'), input: [{ type: 'text', text: 'wrong turn' }] }));

  assert.equal(runtime.sessions.get(threadId)?.acceptedSteers ?? 0, orderBefore,
    'the refused instructions took no place in the order');
  pass('a stale instruction is not redirected into the running turn', 'order still at ' + orderBefore);

  // ================= criterion 4: help is not agent input =================

  const help = await bob.command(threadId, { method: Commands.THREAD_HELP, text: 'Alice, is the retry safe?', to: alice.me.id });
  assert.ok(help.result.requestId.startsWith('help_'));
  const helpEvent = events().find((e) => (e.method || '') === Events.HELP_REQUESTED);
  assert.ok(helpEvent, 'the help request is recorded');
  assert.equal(helpEvent.by.name, 'bob');
  assert.equal(helpEvent.to, alice.me.id);
  const session = runtime.sessions.get(threadId);
  assert.equal(session.steerQueue.some((s) => JSON.stringify(s.input).includes('is the retry safe')), false,
    'the help text never entered the queue the agent reads');
  const orderAtHelp = session.acceptedSteers;
  assert.ok(orderAtHelp >= 1, 'instructions have been accepted on this turn');
  pass('a message for a person never becomes agent input', 'help_ recorded, steer order untouched');

  await refused('a help request with no text for a person to read is refused', Errors.HELP_IS_NOT_INPUT,
    () => bob.command(threadId, { method: Commands.THREAD_HELP, text: '   ' }));

  await refused('a help request addressed to no thread is refused', Errors.UNKNOWN_THREAD,
    () => bob.op({ type: 'command', runtimeId: runtime.id, command: { method: Commands.THREAD_HELP, text: 'orphan' } }));

  // `to` used to be whatever the caller typed, so a question could be addressed to a
  // stranger, to a typo, or to nobody at all - and would then sit open forever, because the
  // person it named could never see it.
  await refused('a help request addressed to somebody outside the team is refused', Errors.RECIPIENT_NOT_AUTHORIZED,
    () => bob.command(threadId, { method: Commands.THREAD_HELP, text: 'who is this for?', to: 'u_nobody' }));

  await refused('handing a thread to somebody outside the team is refused', Errors.RECIPIENT_NOT_AUTHORIZED,
    () => bob.command(threadId, { method: Commands.THREAD_ASSIGN, assignee: { userId: 'u_nobody', name: 'nobody' } }));

  // Resolving something nobody asked for would put an answer in the log for a question that
  // was never posed, and clear a real request while doing it.
  await refused('resolving a help request that was never made is refused', Errors.UNKNOWN_HELP_REQUEST,
    () => bob.command(threadId, { method: Commands.THREAD_HELP_RESOLVE, requestId: 'help_' + randomBytes(8).toString('hex') }));

  await alice.command(threadId, { method: Commands.THREAD_HELP_RESOLVE, requestId: help.result.requestId });
  assert.ok(events().some((e) => (e.method || '') === Events.HELP_RESOLVED), 'resolution is recorded too');
  pass('help is resolved by a person and recorded as such', help.result.requestId);

  // ================= criterion 3: interrupting is a request =================

  await refused('interrupting without naming the turn is refused', Errors.TURN_BINDING_REQUIRED,
    () => bob.command(threadId, { method: Commands.TURN_INTERRUPT }));
  await refused('interrupting a turn that is not running is refused', Errors.STALE_TURN,
    () => bob.command(threadId, { method: Commands.TURN_INTERRUPT, turnId: 'turn_gone' }));

  const liveTurn = await startTurn('One more, take a while.');
  const stop = await bob.command(threadId, { method: Commands.TURN_INTERRUPT, turnId: liveTurn });
  assert.equal(stop.result.state, 'requested', 'the answer is requested, not stopped');
  assert.equal(stop.result.stopping, true);
  const requested = events().find((e) => (e.method || '') === Events.TURN_INTERRUPT_REQUESTED);
  assert.ok(requested, 'the request itself is recorded');
  assert.equal(requested.by.name, 'bob');
  pass('an interrupt reports requested and stopping, not stopped', 'recorded with its actor');

  const thread = await waitFor(() => {
    const t = hub.store.getThread(threadId);
    return t && (t.status?.activeFlags?.includes('stopping') || t.status?.type === 'idle') ? t : null;
  }, 'stopping or ended');
  assert.ok(thread.status.activeFlags?.includes('stopping') || thread.status.type === 'idle');
  pass('the thread shows stopping until the turn actually ends', thread.status.activeFlags?.join(',') || thread.status.type);

  const completed = await waitFor(() => events().find((e) => e.method === Events.TURN_COMPLETED && e.turnId === liveTurn), 'turn ended');
  const settledThread = await waitFor(() => {
    const t = hub.store.getThread(threadId);
    return t && !(t.status?.activeFlags || []).includes('stopping') ? t : null;
  }, 'stopping cleared');
  assert.equal(settledThread.interruptRequestedBy, null, 'and the request is no longer outstanding');
  pass('stopping clears once the turn actually ends', 'status ' + settledThread.status.type);
  assert.ok(['interrupted', 'completed', 'failed'].includes(completed.status));
  const text = JSON.stringify(events());
  assert.equal(/undone|reverted|rolled back/i.test(text), false, 'nothing claims the work was undone');
  pass('the record says the turn ended, never that its effects were undone', 'status ' + completed.status);

  // ================= criterion 3, again: interrupting mid-tool =================

  // A turn that actually runs a tool, interrupted while the tool is in flight. Stopping a
  // model mid-sentence and stopping it mid-command are different situations, and the
  // criterion asks for the second one.
  const toolTurn = await alice.command(threadId, { method: Commands.TURN_START, input: [{ type: 'text', text: 'Create NOTES.md with one line.' }] });
  const toolTurnId = toolTurn.result.turnId;
  const toolItem = await waitFor(() => events().find((e) => e.method === Events.ITEM_STARTED &&
    [ItemTypes.COMMAND_EXECUTION, ItemTypes.FILE_CHANGE].includes(e.item?.type)), 'a tool started');
  const stopMidTool = await alice.command(threadId, { method: Commands.TURN_INTERRUPT, turnId: toolTurnId });
  assert.equal(stopMidTool.result.state, 'requested');
  const toolTurnEnd = await waitFor(() => events().find((e) => e.method === Events.TURN_COMPLETED && e.turnId === toolTurnId), 'tool turn ended');
  assert.ok(['interrupted', 'completed', 'failed'].includes(toolTurnEnd.status));
  const afterTool = JSON.stringify(events());
  assert.equal(/undone|reverted|rolled back/i.test(afterTool), false, 'no claim that the tool was undone');
  pass('interrupting while a tool is running reports requested and never claims a rollback',
    toolItem.item.type + ', ended ' + toolTurnEnd.status);

  // ================= criterion 4: authority is current, not remembered =================

  await alice.op({ type: TeamOps.MEMBER_REMOVE, teamId: team.id, userId: bob.me.id });
  await refused('a teammate removed from the team can no longer steer the host', Errors.NOT_A_MEMBER,
    () => bob.command(threadId, { method: Commands.TURN_STEER, expectedTurnId: liveTurn, input: [{ type: 'text', text: 'after removal' }] }));
  pass('authority is checked when the instruction arrives, not when the session began', 'removal takes effect immediately');

  // ================= criterion 3: the host goes away mid-flight =================

  runtime.hub.close();
  await waitFor(() => !hub.runtimes.has(runtime.id), 'host disconnected');
  let offline = null;
  try {
    await alice.command(threadId, { method: Commands.TURN_INTERRUPT, turnId: liveTurn });
  } catch (error) { offline = String(error.error || error.message); }
  assert.ok(offline, 'the interrupt did not report success');
  assert.match(offline, /offline|unknown/i);
  pass('an interrupt to a disconnected host reports an unknown outcome, never success', offline);

  fs.mkdirSync(path.join(__dirname, '..', '.artifacts', 'shared-steering'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', '.artifacts', 'shared-steering', 'results.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log('\n' + results.length + ' shared steering checks passed');
})().then(async () => {
  for (const c of clients) c.close();
  await runtime?.stop?.(); await hub?.close?.(); process.exit(0);
}).catch(async (error) => {
  console.error('SHARED STEERING FAILED\n', error);
  for (const c of clients) c.close();
  try { await runtime?.stop?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
