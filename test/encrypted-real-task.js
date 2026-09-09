'use strict';
// Acceptance test for issue #7 (P06): a real task executing on the host and reaching the
// encrypted log.
//
// #6 wrote that log from fixture events and #9 read it, but nothing in the shipped runtime
// ever opened an encrypted task, so every encrypted history in this repository was written
// by test code. This drives the production path: the host publishes an endpoint through the
// hub, finds the task addressed to it, verifies the creator through #8's enrolment, runs an
// actual turn, and the objective, plan, tool calls and file changes arrive as encrypted
// events that a teammate can replay.
//
// The provider here is the deterministic one, so this runs the same way everywhere. The
// separate real-Codex check lives in encrypted-codex-task.js and skips when no CLI is
// present, because a test that silently passes without exercising a provider is worse than
// one that says it did not run.
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
const { EnrollmentTransport, announcement, confirmTeammateEndpoint } = require('../packages/e2ee/enrollment.mjs');
const { catchUp } = require('../packages/e2ee/catchup.mjs');
const { TeamOps, Events, ApprovalDecision } = require('../packages/protocol');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
const waitFor = async (fn, label = '') => {
  for (let n = 0; n < 400; n++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout: ' + label);
};
// The sync waitFor above cannot poll something that has to be awaited, and an approval
// landing in an encrypted log is exactly that: drain, decrypt, replay, look.
const until = async (fn, label = '') => {
  for (let n = 0; n < 400; n++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout: ' + label);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-real-task-'));
const canary = 'PRIVATE_' + randomBytes(16).toString('hex');
let hub, runtime, encrypted, socket;

(async () => {
  hub = new Hub({ dbFile: path.join(tmp, 'hub.sqlite'), log: () => {} });
  const addr = await hub.listen();
  const url = 'http://127.0.0.1:' + addr.port;
  const project = path.join(tmp, 'workspace');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'seed.txt'), canary + '\n');

  runtime = new Runtime({ hubUrl: url.replace('http', 'ws'), userName: 'host', dataDir: path.join(tmp, 'runtime'), projects: [project], encryptedTasksOnly: true });
  await runtime.start();

  let welcome; const messages = [];
  socket = new WebSocket(url.replace('http', 'ws'));
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', role: 'client', name: 'alice' }));
  socket.onmessage = ({ data }) => { const m = JSON.parse(data); messages.push(m); if (m.type === 'welcome') welcome = m; };
  await waitFor(() => welcome && hub.pendingPairings.size, 'welcome');
  socket.send(JSON.stringify({ type: TeamOps.TEAM_CREATE, name: 'Real task team', id: 'op1' }));
  await waitFor(() => messages.some((m) => m.type === 'team'), 'team');
  const team = messages.find((m) => m.type === 'team').team;
  socket.send(JSON.stringify({ type: TeamOps.RUNTIME_PAIR, teamId: team.id, code: runtime.pairingCode, id: 'op2' }));
  await waitFor(() => runtime.teamId === team.id, 'paired');
  const account = hub.store.userById(welcome.user.id);

  // ---- the host brings up its encrypted side through the real hub ----
  const projectId = newId('ep');
  encrypted = new EncryptedHost({
    endpointFactory: (options) => Endpoint.create(options),
    runtime, url, statePath: path.join(tmp, 'host-outbox.sqlite'),
    projects: new Map([[projectId, project]]), log: () => {}
  });
  const hostIdentity = await encrypted.start();
  assert.ok(hostIdentity.curve25519, 'the host published an endpoint');
  assert.equal(hub.store.db.prepare('SELECT COUNT(*) AS n FROM e2ee_devices').get().n >= 1, true);
  pass('the execution host publishes an encrypted endpoint through the hub', hostIdentity.device);

  // ---- the creator enrols, and is confirmed ----
  const client = await Endpoint.create({
    user: matrixUser(account.id), device: 'ALICEDEV',
    transport: new HubKeyTransport({ url, token: account.token, device: 'ALICEDEV' })
  });
  const enroll = new EnrollmentTransport({ url, token: account.token, endpoint: client });
  await enroll.bootstrap(team.id, announcement(client));
  await enroll.ownProject(team.id, projectId);
  encrypted.authority = client.identity();
  await encrypted.beginReconcile();
  await enroll.answerChallenges(team.id);
  for (const [a, b] of [[client, encrypted.endpoint], [encrypted.endpoint, client]]) await a.confirmEndpoint(b.identity(), { confirmed: true });

  const tasks = new EncryptedTaskTransport({ url, token: account.token });
  const task = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId, creatorUserId: account.id };
  const objective = { title: canary + ' title', objective: 'Create NOTES.md describing ' + canary };
  const created = await createEncryptedTask(client, tasks, { task, writer: hostIdentity, payload: objective });
  pass('a solo creator starts an encrypted task without another teammate present', task.id);

  // ---- the host finds it, and refuses what it cannot place ----
  const unmapped = { ...task, id: newId('et'), projectId: newId('ep') };
  await createEncryptedTask(client, tasks, { task: unmapped, writer: hostIdentity, payload: objective });
  const outcomeUnmapped = await encrypted.run(unmapped, { runTurn: async () => { throw new Error('should not run'); } });
  assert.equal(outcomeUnmapped.skipped, 'project_not_mapped');
  pass('a task naming a project this host has not mapped is left alone', 'project_not_mapped');

  const found = await encrypted.pending();
  assert.ok(found.some((t) => t.id === task.id), 'the host sees the task addressed to it');
  pass('the host finds the encrypted task addressed to it', found.length + ' pending');

  // ---- and runs a real turn into the log ----
  const runTurn = async (emit, decrypted) => {
    const session = new TurnSession({
      thread: { id: task.id, cwd: project, settings: {} },
      by: { userId: account.id, name: 'alice' },
      input: [{ type: 'text', text: decrypted.objective }],
      provider: { id: 'demo' }, settings: {}, executor: runtime.executor,
      history: [], emit, log: () => {}
    });
    await session.run();
    return session;
  };
  const outcome = await encrypted.run(task, { runTurn, provider: 'demo' });
  assert.ok(outcome.events >= 4, 'the turn produced a history, not a stub');
  pass('a real turn is executed and written to the encrypted log', outcome.events + ' events');

  // ---- which the creator can read back ----
  await client.open(await client.transport.drain());
  const reader = new EncryptedTaskReader({ endpoint: client, task, writer: hostIdentity });
  await reader.reconnect(tasks);
  const state = reader.state;
  assert.equal(state.title, objective.title);
  assert.ok(state.events.length >= 4);
  // The turn finished; the task is still open, because nobody has said otherwise. Recording
  // one as the other is what issue #13's fourth criterion is about.
  assert.ok(state.events.some((e) => e.type === 'turn.completed'), 'the log says how the turn ended');
  assert.equal(state.events.some((e) => e.type === 'task.completed'), false, 'a turn ending does not close the task');
  assert.equal(state.outcome, null);
  pass('the creator replays the task the host actually ran', reader.seq + ' events, turn ' + state.turn + ', task still open');

  // The provider is passed as context here deliberately, and deliberately loses: the log
  // says which provider the host ran, and a recorded fact outranks a caller's claim.
  const view = catchUp(reader.snapshot(), { responsible: 'alice', host: runtime.id, provider: 'something-else', hostConnected: true, taskId: task.id, projectId });
  assert.equal(view.objective.value, objective.objective);
  assert.equal(view.objective.provenance, 'recorded');
  assert.equal(view.provider.provenance, 'recorded');
  assert.equal(view.provider.value, 'demo', 'the log names the provider the host actually ran');
  assert.deepEqual(view.provider.source, { seq: 2, type: 'turn.started' });
  pass('the catch-up projection reads the real task, provider included', 'provider recorded by the host, not by the caller');

  // ---- criterion 1: a blocker a teammate can actually see, and answer ----
  //
  // This is the clause the projection could not satisfy before: "current blocker/pending
  // approvals". The demo agent drives the real approval pipeline, so the request here is
  // produced the same way a provider's would be, and answered the same way a teammate's
  // would be. What is being checked is that a joining endpoint can see the task is stopped
  // and on what, from the log alone, while it is still stopped.
  // Something for the risky command to be risky about: the workspace tool refuses a path
  // that is not there before policy is ever consulted, so an absent directory would produce
  // a declined command and no approval at all.
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build', 'out.txt'), 'built');

  const blocked = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId, creatorUserId: account.id };
  await createEncryptedTask(client, tasks, { task: blocked, writer: hostIdentity,
    payload: { title: 'Clear the build directory', objective: 'delete the build directory' } });

  const blockedReader = new EncryptedTaskReader({ endpoint: client, task: blocked, writer: hostIdentity });
  let session;
  let requested = null;
  let midFlight = null;
  const approvalTurn = async (emit, decrypted) => {
    session = new TurnSession({
      thread: { id: blocked.id, cwd: project, settings: {} },
      by: { userId: account.id, name: 'alice' },
      input: [{ type: 'text', text: decrypted.objective }],
      provider: { id: 'demo' },
      // on-request escalates a risky command rather than running it, which is the whole
      // point: an approval nobody configured is not an approval anybody asked for.
      settings: { approvalPolicy: 'on-request', sandboxPolicy: 'workspace-write' },
      executor: runtime.executor, history: [], log: () => {},
      emit: (event) => {
        emit(event);
        if (event.method !== Events.COMMAND_REQUEST_APPROVAL || requested) return;
        requested = event;
        // Answer it the way a teammate would - after reading, from the log, what is being
        // asked. The turn stays parked here until this resolves it.
        (async () => {
          await until(async () => {
            await client.open(await client.transport.drain());
            try { await blockedReader.reconnect(tasks); } catch { return false; }
            return blockedReader.state.approvals.length > 0;
          }, 'the approval request reaches the encrypted log');
          midFlight = catchUp(blockedReader.snapshot(), { responsible: 'alice', host: runtime.id, provider: 'demo', hostConnected: true, taskId: blocked.id, projectId });
          session.resolveApproval(event.requestId, ApprovalDecision.ACCEPT, { userId: account.id, name: 'alice' },
            { turnId: session.turnId, fingerprint: event.fingerprint });
        })().catch((error) => { requested = { failed: error }; });
      }
    });
    await session.run();
    return session;
  };
  await encrypted.run(blocked, { runTurn: approvalTurn, provider: 'demo' });
  assert.ok(requested && !requested.failed, 'the turn asked for an approval: ' + (requested && requested.failed && requested.failed.message));

  assert.equal(midFlight.pending.approvals.length, 1, 'the parked task shows one approval outstanding');
  assert.match(midFlight.pending.approvals[0].value.action, /rm -rf build/);
  assert.equal(midFlight.pending.approvals[0].provenance, 'recorded');
  assert.match(midFlight.pending.blocker.value, /rm -rf build/);
  assert.equal(midFlight.pending.blocker.provenance, 'derived');
  pass('a teammate reading a parked task sees what it is blocked on, from the log alone',
    midFlight.pending.approvals[0].value.action);

  // And once somebody answers, the same projection stops asking - because a decision names
  // the request it answers, not because the turn moved on.
  await client.open(await client.transport.drain());
  await blockedReader.reconnect(tasks);
  const answered = catchUp(blockedReader.snapshot(), { responsible: 'alice', host: runtime.id, provider: 'demo', hostConnected: true, taskId: blocked.id, projectId });
  assert.deepEqual(answered.pending.approvals, [], 'the answered request is no longer outstanding');
  assert.equal(answered.decisions.length, 1);
  assert.equal(answered.decisions[0].actor, account.id);
  assert.equal(answered.decisions[0].value, 'Approval accept');
  assert.equal(answered.decisions[0].basis, requested.requestId);
  pass('the recorded decision clears the request it names and is attributed to who made it',
    'alice, basis ' + requested.requestId);

  // Nobody invented the approval: the request and the answer are both in the log, and the
  // answer carries the person who gave it.
  const approvalEvents = blockedReader.state.events.filter((e) => e.type === 'approval.requested' || e.type === 'decision.recorded');
  assert.equal(approvalEvents.length, 2);
  pass('both halves of the approval are in the encrypted log', approvalEvents.map((e) => e.type).join(' then '));

  // ---- criterion 2: the relay never sees content or credentials ----
  const relay = JSON.stringify({
    events: await tasks.page(task.id),
    tasks: await tasks.list(team.id),
    devices: hub.store.db.prepare('SELECT * FROM e2ee_devices').all(),
    mailbox: hub.store.db.prepare('SELECT * FROM e2ee_mailbox').all(),
    threads: hub.store.listThreads(team.id)
  });
  assert.equal(relay.includes(canary), false, 'task content is absent from everything the relay holds');
  assert.equal(/sk-[A-Za-z0-9]{16}|OPENAI_API_KEY|Bearer sk-/.test(relay), false, 'no credential material is anywhere near it');
  pass('the relay holds neither the task content nor any credential', canary.slice(0, 12) + '...');

  // ---- criterion 4: product identifiers stay separate from provider ones ----
  const fleet = hub.store.getRuntime(runtime.id);
  assert.equal(fleet.taskProtocol, 'encrypted-v1');
  assert.deepEqual(fleet.projects, [], 'the fleet descriptor names no local paths');
  const descriptor = JSON.stringify(fleet);
  assert.equal(descriptor.includes(project), false, 'nor the workspace path');
  assert.equal(descriptor.includes(task.id), false, 'nor the task it is running');
  pass('product task ids stay out of the shared host descriptor', 'taskProtocol encrypted-v1, no paths');

  // ---- what the host is honest about ----
  const durability = EncryptedHost.identityDurability();
  assert.equal(durability.persistent, true);
  assert.equal(durability.backend, 'desktop-os-sealed-indexeddb');
  pass('production host persistence names the supported desktop store',
    'actual process restart is exercised separately in test/durable-host.js');

  fs.mkdirSync(path.join(__dirname, '..', '.artifacts', 'encrypted-real-task'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', '.artifacts', 'encrypted-real-task', 'results.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log('\n' + results.length + ' real encrypted task checks passed');
})().then(async () => {
  socket?.close(); encrypted?.close(); try { runtime?.stop?.(); } catch {}
  await hub?.close?.(); process.exit(0);
}).catch(async (error) => {
  console.error('REAL ENCRYPTED TASK FAILED\n', error);
  socket?.close(); try { encrypted?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
