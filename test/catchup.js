'use strict';
// Acceptance test for issue #9 (P08): the catch-up projection a joining teammate reads.
//
// The claim under test is narrow and checkable: the same accepted events produce the same
// catch-up whether they were watched as they happened or replayed from sequence zero hours
// later. Everything else here is about refusing to say more than the log supports - no
// invented decisions, no invented approvals, no dead source links, and no "current" when
// the host has gone quiet.
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
const { catchUp, sourcesOf, openSource } = require('../packages/e2ee/catchup.mjs');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
const waitFor = async (fn) => { for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('fixture_timeout'); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-catchup-'));
const canary = 'PRIVATE_' + randomBytes(16).toString('hex');
let hub, runtime, socket, state;

// ---------- the projection on its own, with no network anywhere near it ----------

function pureChecks() {
  const empty = catchUp({ events: [], seq: 0, status: { state: 'caught-up' } }, {});
  assert.equal(empty.objective.provenance, 'unavailable');
  assert.match(empty.objective.reason, /no creation event/);
  assert.equal(empty.plan.provenance, 'unavailable');
  assert.deepEqual(empty.decisions, []);
  assert.equal(empty.scope.events, 0);
  pass('an empty log projects as unavailable everywhere, not as blanks', 'nothing is invented to fill a slot');

  const events = [
    { type: 'task.created', payload: { title: 'T', objective: 'Recover failed checkouts' } },
    { type: 'message.added', payload: { id: 'm1', text: 'I think we should reuse the original key.' } },
    { type: 'plan.updated', payload: { steps: [{ text: 'Trace', status: 'completed' }, { text: 'Retry', status: 'in-progress' }] } }
  ];
  const snapshot = { events, seq: 3, status: { state: 'caught-up' } };
  const view = catchUp(snapshot, { now: 1000, lastEventAt: 900 });

  assert.equal(view.objective.provenance, 'recorded');
  assert.deepEqual(view.objective.source, { seq: 1, type: 'task.created' });
  assert.equal(view.objective.value, 'Recover failed checkouts');
  pass('the objective is quoted from the creating event and points at it', 'seq 1');

  // The message says something decisive. It is still a message.
  assert.deepEqual(view.decisions, []);
  assert.deepEqual(view.pending.approvals, []);
  pass('a decisive-sounding message is not promoted to a decision or an approval', 'decisions: 0');

  assert.equal(view.currentStep.provenance, 'derived');
  assert.equal(view.currentStep.value, 'Retry');
  assert.equal(view.plan.provenance, 'recorded');
  pass('the plan is recorded, the current step is marked as read off it', 'derived from seq 3');

  const decided = catchUp({ ...snapshot, events: [...events, { type: 'decision.recorded', payload: { actor: 'maya', text: 'Reuse the original payment key', basis: 'm1' } }], seq: 4 }, {});
  assert.equal(decided.decisions.length, 1);
  assert.equal(decided.decisions[0].provenance, 'recorded');
  assert.equal(decided.decisions[0].actor, 'maya');
  assert.deepEqual(decided.decisions[0].source, { seq: 4, type: 'decision.recorded' });
  pass('a recorded decision is attributed and sourced', 'maya, seq 4');

  // Freshness has to distinguish quiet from lost, and neither from broken.
  const cases = [
    [{ hostConnected: true, now: 1000, lastEventAt: 900 }, 'current'],
    [{ hostConnected: true, now: 10 ** 7, lastEventAt: 900 }, 'stale'],
    [{ hostConnected: false, now: 1000, lastEventAt: 900 }, 'unknown'],
    [{ hostConnected: true, head: 9, now: 1000, lastEventAt: 900 }, 'behind']
  ];
  for (const [context, expected] of cases) assert.equal(catchUp(snapshot, context).freshness.state, expected, expected);
  assert.equal(catchUp({ ...snapshot, status: { state: 'error', code: 'history_rollback' } }, {}).freshness.state, 'error');
  pass('freshness separates current, quiet, disconnected, behind and failed', cases.map(([, s]) => s).join('/') + '/error');

  const missing = openSource(snapshot, { seq: 9, type: 'task.created' });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, 'source_unavailable');
  pass('a source that does not resolve is reported, not silently dropped', 'source_unavailable');

  // ---- what the task is stopped on ----
  //
  // Criterion 1 asks for "current blocker/pending approvals". Until an approval request was
  // part of the log vocabulary the projection could only say it had none to report, which is
  // a true statement about an empty vocabulary and a useless one about a blocked task.
  const asked = [...events,
    { type: 'approval.requested', payload: { id: 'req_1', action: 'Run: npm publish', reason: 'writes outside the workspace', expiresAt: 5000 } }];
  const waiting = catchUp({ ...snapshot, events: asked, seq: 4 }, { now: 1000 });
  assert.equal(waiting.pending.approvals.length, 1);
  assert.equal(waiting.pending.approvals[0].provenance, 'recorded');
  assert.equal(waiting.pending.approvals[0].value.action, 'Run: npm publish');
  assert.equal(waiting.pending.approvals[0].value.reason, 'writes outside the workspace');
  assert.deepEqual(waiting.pending.approvals[0].source, { seq: 4, type: 'approval.requested' });
  pass('an unanswered approval is reported as outstanding, with the action it would authorise', 'seq 4');

  // A step in progress is work continuing; an unanswered approval is work that cannot.
  assert.equal(waiting.currentStep.value, 'Retry');
  assert.equal(waiting.pending.blocker.provenance, 'derived');
  assert.match(waiting.pending.blocker.value, /npm publish/);
  pass('an outstanding approval outranks the plan step as the blocker', 'derived, not recorded');

  // The answer is the decision that records who took responsibility - not a second event
  // type, and not the passage of time.
  const answered = catchUp({ ...snapshot, events: [...asked,
    { type: 'decision.recorded', payload: { actor: 'maya', text: 'Approval accept', basis: 'req_1' } }], seq: 5 }, { now: 1000 });
  assert.deepEqual(answered.pending.approvals, []);
  assert.equal(answered.decisions.length, 1);
  assert.equal(answered.decisions[0].actor, 'maya');
  assert.equal(answered.pending.blocker.value, 'Retry');
  pass('a recorded decision answers the request it names, and only that one', 'basis req_1');

  // An expired request nobody answered is still unanswered. Clearing it would be this code
  // deciding a request went away because a clock moved.
  const expired = catchUp({ ...snapshot, events: asked, seq: 4 }, { now: 9000 });
  assert.equal(expired.pending.approvals.length, 1);
  assert.equal(expired.pending.approvals[0].value.expired, true);
  pass('an expired approval stays outstanding and is marked expired', 'not silently cleared');

  // A decision naming a request that was never asked for must not clear anything, and must
  // not invent an approval either.
  const foreign = catchUp({ ...snapshot, events: [...asked,
    { type: 'decision.recorded', payload: { actor: 'mallory', text: 'Approval accept', basis: 'req_elsewhere' } }], seq: 5 }, { now: 1000 });
  assert.equal(foreign.pending.approvals.length, 1);
  pass('a decision naming an unrelated request answers nothing', 'req_1 stays outstanding');

  // The provider is the one operational fact the log can carry, because the host asserts it.
  // A caller passing a different one must not override what the host wrote down.
  const withProvider = catchUp({ ...snapshot, events: [
    { type: 'task.created', payload: { title: 'T', objective: 'Recover failed checkouts', provider: 'codex-cli' } },
    ...events.slice(1)
  ], seq: 3 }, { provider: 'something-else', host: 'host-1' });
  assert.equal(withProvider.provider.provenance, 'recorded');
  assert.equal(withProvider.provider.value, 'codex-cli');
  assert.equal(withProvider.host.provenance, 'context');
  pass('a provider the host recorded outranks one a caller passed in', 'recorded beats context');

  const noProvider = catchUp(snapshot, { provider: 'demo' });
  assert.equal(noProvider.provider.provenance, 'context');
  assert.equal(catchUp(snapshot, {}).provider.provenance, 'unavailable');
  pass('without one in the log the provider stays context, or absent and says so', 'context/unavailable');

  // Every reference the pending section makes has to resolve like any other.
  const refs = sourcesOf(waiting);
  assert.ok(refs.some((r) => r.type === 'approval.requested'));
  for (const source of refs) {
    assert.equal(openSource({ events: asked, seq: 4 }, source).available, true, source.type);
  }
  pass('every source the pending section cites resolves to an accepted event', refs.length + ' references');
}

// ---------- and now the same projection over a real encrypted log ----------

(async () => {
  pureChecks();

  hub = new Hub({ dbFile: path.join(tmp, 'hub.sqlite'), log: () => {} });
  const addr = await hub.listen();
  const url = 'http://127.0.0.1:' + addr.port;
  const project = path.join(tmp, canary + '-workspace');
  fs.mkdirSync(project);
  runtime = new Runtime({ hubUrl: url.replace('http', 'ws'), userName: 'host', dataDir: path.join(tmp, 'runtime'), projects: [project], encryptedTasksOnly: true });
  await runtime.start();
  let welcome;
  const messages = [];
  socket = new WebSocket(url.replace('http', 'ws'));
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', name: 'watcher' }));
  socket.onmessage = ({ data }) => { const m = JSON.parse(data); messages.push(m); if (m.type === 'welcome') welcome = m; };
  await waitFor(() => welcome && hub.pendingPairings.size);
  socket.send(JSON.stringify({ type: 'team/create', name: 'Catch-up team' }));
  await waitFor(() => messages.some((m) => m.type === 'team'));
  const team = messages.find((m) => m.type === 'team').team;
  socket.send(JSON.stringify({ type: 'runtime/pair', teamId: team.id, code: runtime.pairingCode }));
  await waitFor(() => runtime.teamId === team.id);

  const account = hub.store.userById(welcome.user.id);
  const transport = new EncryptedTaskTransport({ url, token: account.token });
  const hostTransport = new EncryptedTaskTransport({ url, token: runtime.runtimeToken, runtimeId: runtime.id });
  const directory = new KeyDirectory();
  const keys = new KeyTransport(directory);
  const client = await Endpoint.create({ user: matrixUser(account.id), device: 'CLIENT', transport: keys });
  const hostEp = await Endpoint.create({ user: matrixUser(runtime.id), device: 'HOST', transport: keys });
  for (const [a, b] of [[client, hostEp], [hostEp, client]]) await a.confirmEndpoint(b.identity(), { confirmed: true });

  const task = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId: newId('ep'), creatorUserId: account.id };
  const payload = { title: canary + ' title', objective: canary + ' objective', fixture: { plan: canary + ' plan', path: canary + '/file.txt', result: canary + ' output', diff: canary + ' diff', activity: canary + ' activity', answer: canary + ' answer' } };
  const created = await createEncryptedTask(client, transport, { task, writer: hostEp.identity(), payload });
  state = new EncryptedTaskState(path.join(tmp, 'outbox.sqlite'));
  const host = new EncryptedFixtureHost({ runtime, endpoint: hostEp, transport: hostTransport, state, projects: new Map([[task.projectId, project]]), creators: new Map([[account.id, client.identity()]]) });
  const opened = await host.open(created.task);
  await client.open(directory.drain(client.user, client.device));

  // One reader watches the task happen, catching up after every event, the way somebody with
  // the tab already open does.
  const watcher = new EncryptedTaskReader({ endpoint: client, task, writer: hostEp.identity() });
  const events = fixtureEvents(opened.objective);
  const withDecision = [
    ...events.slice(0, 6),
    { type: 'decision.recorded', payload: { actor: 'maya', text: canary + ' decision', basis: 'answer' } },
    ...events.slice(6)
  ];
  for (let i = 0; i < withDecision.length; i++) {
    await opened.writer.append(withDecision[i], fixtureEventId(task.id, i));
    await watcher.reconnect(transport);
  }
  assert.equal(watcher.seq, withDecision.length);

  // The other opens the task for the first time, long after all of it happened.
  const joiner = new EncryptedTaskReader({ endpoint: client, task, writer: hostEp.identity() });
  await joiner.reconnect(transport);

  const context = { responsible: 'alex', host: "Alex's Mac", provider: 'Codex', hostConnected: true, now: 5000, lastEventAt: 4900, taskId: task.id, projectId: task.projectId };
  const watched = catchUp(watcher.snapshot(), context);
  const joined = catchUp(joiner.snapshot(), context);
  assert.deepEqual(joined, watched);
  pass('a late join produces exactly the catch-up of continuous observation', watched.scope.events + ' events, byte-identical projection');

  assert.equal(watched.objective.value, payload.objective);
  assert.equal(watched.decisions.length, 1);
  assert.equal(watched.decisions[0].actor, 'maya');
  // A turn finished; nobody has said the work is done. Those are different facts and the
  // projection reports both rather than letting the first stand in for the second.
  assert.equal(watched.turn.value, 'completed');
  assert.equal(watched.turn.provenance, 'recorded');
  assert.equal(watched.outcome.value, 'open');
  assert.equal(watched.outcome.provenance, 'derived');
  assert.equal(watched.responsible.value, 'alex');
  assert.equal(watched.host.value, "Alex's Mac");
  assert.equal(watched.provider.value, 'Codex');
  pass('the view carries objective, responsible, host, provider, decisions and both statuses', 'all present');

  // And the task's own outcome only appears when a person records it, with their name on it.
  const settled = catchUp({ ...watcher.snapshot(),
    events: [...watcher.state.events, { type: 'task.completed', payload: { outcome: 'completed', by: 'maya' } }],
    seq: watcher.seq + 1 }, context);
  assert.equal(settled.outcome.provenance, 'recorded');
  assert.equal(settled.outcome.value, 'completed');
  assert.equal(settled.outcome.actor, 'maya');
  pass('a task is completed when somebody records it, not when a turn ends', 'recorded by maya');

  // Every reference the projection makes must resolve to an event this endpoint accepted.
  const sources = sourcesOf(watched);
  assert.ok(sources.length >= 5);
  for (const source of sources) {
    const opened = openSource(joiner.snapshot(), source);
    assert.equal(opened.available, true, 'source ' + JSON.stringify(source) + ' did not resolve');
    assert.equal(opened.event.type, source.type);
  }
  pass('every source in the projection resolves to an accepted event', sources.length + ' references');

  // A host that stops talking must not leave the view claiming to be current.
  const offline = catchUp(joiner.snapshot(), { ...context, hostConnected: false });
  assert.equal(offline.freshness.state, 'unknown');
  assert.notEqual(offline.freshness.explain, watched.freshness.explain);
  pass('a disconnected host is reported as unknown rather than current', 'freshness: unknown');

  // The projection is a reading aid over ciphertext; the relay never saw any of it.
  const relayBytes = JSON.stringify(await transport.page(task.id));
  assert.equal(relayBytes.includes(canary), false);
  assert.equal(JSON.stringify(watched).includes(canary), true);
  pass('the relay serves none of what the projection reads', 'projection is endpoint-side only');

  fs.mkdirSync(path.join(__dirname, '..', '.artifacts', 'catchup'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', '.artifacts', 'catchup', 'results.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), node: process.version, results }, null, 2) + '\n');
  console.log('\n' + results.length + ' catch-up checks passed');
})().then(async () => {
  socket?.close(); state?.close(); await runtime?.stop?.(); await hub?.close?.(); process.exit(0);
}).catch(async (error) => {
  console.error('CATCH-UP FAILED\n', error);
  socket?.close(); try { state?.close(); } catch {}
  try { await runtime?.stop?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
