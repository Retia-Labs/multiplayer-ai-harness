'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EnrollmentTransport, announcement, confirmTeammateEndpoint, grantProjectAccess, acceptProjectAccess } = require('../packages/e2ee/enrollment.mjs');
const { EncryptedTaskTransport, EncryptedTaskReader, createEncryptedTask, newId } = require('../packages/e2ee/task-log.mjs');
const { sendTaskControl, readTaskReceipt, readTaskHistory } = require('../packages/e2ee/task-control.mjs');
const { matrixUser } = require('../packages/protocol/encrypted-task.mjs');
const { TeamOps, Errors } = require('../packages/protocol');
const { TurnSession } = require('../packages/runtime/session');
const { Events } = require('../packages/protocol');

const until = async (read, label) => {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    const value = await read(); if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
};

test('approval deadlines expire without a caller response or runtime polling', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-approval-expiry-'));
  fs.mkdirSync(path.join(workspace, 'build')); fs.writeFileSync(path.join(workspace, 'build/keep.txt'), 'unapproved');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const events = [], persisted = [];
  const session = new TurnSession({ thread: { id: 'expiry', cwd: workspace }, by: { userId: 'alice' },
    input: [{ type: 'text', text: 'delete build' }], provider: { id: 'demo' }, settings: {}, executor: { id: 'local' },
    approvalTtlMs: 30, emit: event => events.push(event), onApprovalSettled: record => persisted.push(record) });
  await session.run();
  const request = events.find(event => event.method === Events.COMMAND_REQUEST_APPROVAL);
  assert.ok(request);
  assert.equal(fs.readFileSync(path.join(workspace, 'build/keep.txt'), 'utf8'), 'unapproved');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].reason, 'approval_expired');
  assert.equal(persisted[0].by.userId, 'execution-host');
  assert.equal(events.filter(event => event.method === Events.SERVER_REQUEST_RESOLVED).length, 1);
  assert.throws(() => session.resolveApproval(request.requestId, 'accept', { userId: 'alice' },
    { turnId: request.turnId, fingerprint: request.fingerprint }), { code: Errors.APPROVAL_EXPIRED });
});

test('paired runtime discovers encrypted tasks and applies scoped controls without a test-owned host loop', { timeout: 180000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-runtime-e2e-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite') });
  const address = await hub.listen();
  const url = 'http://127.0.0.1:' + address.port;
  const owner = hub.store.createAccount('Alice');
  const teammate = hub.store.createAccount('Bob');
  const team = hub.store.createTeam('Runtime test', owner.id);
  // Seed only the seat produced by invitation acceptance. Key confirmation, project
  // membership and action approval still have to cross their real signed boundaries.
  hub.store._stmts.upsertMember.run(team.id, teammate.id, 'member', 'pending', Date.now());
  const endpoint = await Endpoint.create({ user: matrixUser(owner.id), device: 'ALICE',
    transport: new HubKeyTransport({ url, token: owner.token, device: 'ALICE' }) });
  const enrollment = new EnrollmentTransport({ url, token: owner.token, endpoint });
  await enrollment.bootstrap(team.id, announcement(endpoint));
  const teammateEndpoint = await Endpoint.create({ user: matrixUser(teammate.id), device: 'BOB',
    transport: new HubKeyTransport({ url, token: teammate.token, device: 'BOB' }) });
  const teammateEnrollment = new EnrollmentTransport({ url, token: teammate.token, endpoint: teammateEndpoint });
  await teammateEnrollment.announce(team.id, announcement(teammateEndpoint));
  await confirmTeammateEndpoint(endpoint, enrollment, team.id,
    { userId: teammate.id, ...teammateEndpoint.identity() }, { confirmed: true });
  // Provider determinism and an ephemeral endpoint are test adapters only; discovery,
  // execution, encrypted control, authorization, filesystem and relay are production.
  const logs = [];
  let hostKeys;
  const runtimeOptions = { hubUrl: url.replace('http', 'ws'), dataDir: path.join(dir, 'host'),
    projects: [workspace], encryptedTasksOnly: true,
    encryptionAuthority: { ...endpoint.identity(), teamId: team.id },
    approvalAuthority: { ...endpoint.identity(), teamId: team.id },
    // Substitute only the OS key store boundary: retain actual SDK keys in memory while
    // recreating Runtime, its database, host, provider sessions and collection loop.
    encryptedEndpointFactory: async (options) => {
      hostKeys ||= await Endpoint.create(options);
      hostKeys.transport = options.transport;
      return Object.assign(Object.create(hostKeys), { close: async () => {} });
    }, log: (line) => logs.push(line) };
  let runtime = new Runtime(runtimeOptions);
  let socket;
  let challenges;
  t.after(async () => {
    clearInterval(challenges); socket?.close();
    await runtime.stop(); hostKeys?.close(); endpoint.close(); teammateEndpoint.close();
    await hub.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  await runtime.start();
  socket = new WebSocket(url.replace('http', 'ws'));
  let welcome;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', role: 'client', token: owner.token }));
  socket.onmessage = ({ data }) => { const event = JSON.parse(data); if (event.type === 'welcome') welcome = event; };
  await until(() => welcome && hub.pendingPairings.size, 'pairing available');
  socket.send(JSON.stringify({ type: TeamOps.RUNTIME_PAIR, id: 'pair', teamId: team.id, code: runtime.pairingCode }));
  await until(() => runtime.encryptedHost?.endpoint, 'encrypted host startup');
  challenges = setInterval(() => enrollment.answerChallenges(team.id).catch(() => {}), 100);
  const projectId = runtime.descriptor().encryptedProjects[0].id;
  await enrollment.ownProject(team.id, projectId);
  const writer = runtime.descriptor().encryptedEndpoint;
  await endpoint.confirmEndpoint(writer, { confirmed: true });
  await teammateEndpoint.confirmEndpoint(writer, { confirmed: true });
  const tasks = new EncryptedTaskTransport({ url, token: owner.token });
  const task = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId, creatorUserId: owner.id };
  await createEncryptedTask(endpoint, tasks, { task, writer, payload: {
    title: 'Write a verified file', objective: 'create VERIFIED.txt', provider: 'demo'
  } });
  const reader = new EncryptedTaskReader({ endpoint, task, writer });
  const receipts = new Map();
  const refresh = async () => {
    const events = await endpoint.open(await endpoint.transport.drain());
    for (const event of events) { const receipt = readTaskReceipt(event, task, writer); if (receipt) receipts.set(receipt.commandId, receipt); }
    await reader.reconnect(tasks);
    return reader.snapshot();
  };
  await until(async () => { const state = await refresh(); return state.turn === 'completed'; }, 'automatic task execution: ' + logs.join('\n'));
  assert.match(fs.readFileSync(path.join(workspace, 'VERIFIED.txt'), 'utf8'), /create VERIFIED.txt/);
  assert.ok(reader.state.diffs.some((file) => file.path === 'VERIFIED.txt' && file.patch.includes('+')));
  assert.equal(reader.state.outcome, null, 'a completed turn is still an open task');
  assert.deepEqual(reader.state.details.approvalOwner, endpoint.identity(), 'the encrypted host record identifies its separately consented approval owner');
  const relay = JSON.stringify(await tasks.page(task.id));
  assert.equal(relay.includes('VERIFIED.txt'), false, 'relay has no task content');

  await grantProjectAccess(endpoint, enrollment, { teamId: team.id, projectId,
    member: { userId: teammate.id, device: teammateEndpoint.device }, taskIds: [task.id] });
  const teammateTasks = new EncryptedTaskTransport({ url, token: teammate.token });
  let teammateReader;
  const teammateReceipts = new Map();
  const admittedSessions = new Set();
  async function refreshTeammate() {
    for (const event of await teammateEndpoint.open(await teammateEndpoint.transport.drain())) {
      const transfer = readTaskHistory(event, task);
      if (transfer) {
        const admitted = await acceptProjectAccess(teammateEndpoint, { history: transfer.history }, { writer });
        for (const session of admitted.sessions) admittedSessions.add(session);
        // Reconstruct solely from the authenticated host handoff, never test-injected keys.
        teammateReader = new EncryptedTaskReader({ endpoint: teammateEndpoint, task, writer, admittedSessions });
      }
      const receipt = readTaskReceipt(event, task, writer);
      if (receipt) teammateReceipts.set(receipt.commandId, receipt);
    }
    if (teammateReader) await teammateReader.reconnect(teammateTasks);
    return teammateReader?.snapshot();
  }
  await until(async () => (await refreshTeammate())?.turn === 'completed', 'teammate receives verified task history');
  assert.ok(teammateReader.state.diffs.some(file => file.path === 'VERIFIED.txt' && file.patch.includes('+')));

  async function control(action, payload, commandId = newId('cmd')) {
    receipts.delete(commandId);
    await sendTaskControl(endpoint, writer, { task, action, payload, commandId });
    return until(async () => { await refresh(); return receipts.get(commandId); }, action);
  }
  async function teammateControl(action, payload, commandId = newId('cmd')) {
    teammateReceipts.delete(commandId);
    await sendTaskControl(teammateEndpoint, writer, { task, action, payload, commandId });
    return until(async () => { await refreshTeammate(); return teammateReceipts.get(commandId); }, 'teammate ' + action);
  }
  const first = await control('responsibility.handover', { to: owner.id, note: 'First handover' });
  assert.equal(first.state, 'delivered');
  const second = await control('responsibility.handover', { to: owner.id, note: 'Second independent handover' });
  assert.equal(second.state, 'delivered');
  assert.equal(reader.state.handover.note, 'Second independent handover');

  fs.mkdirSync(path.join(workspace, 'build')); fs.writeFileSync(path.join(workspace, 'build/obsolete.txt'), 'disposable');
  const started = await control('turn.start', { input: [{ type: 'text', text: 'delete build' }], settings: { provider: 'demo' } });
  assert.equal(started.state, 'accepted');
  const approval = await until(async () => {
    await refresh(); return reader.state.approvals.find((request) => !reader.state.decisions.some((decision) => decision.basis === request.id));
  }, 'encrypted approval');
  assert.equal(approval.turnId, started.result.turnId);
  assert.ok(approval.fingerprint);
  assert.deepEqual(approval.approvalOwner, endpoint.identity());
  const answer = { requestId: approval.id, turnId: approval.turnId,
    fingerprint: approval.fingerprint, decision: 'accept' };
  const ordinary = await teammateControl('approval.resolve', answer);
  assert.equal(ordinary.state, 'rejected');
  assert.equal(ordinary.code, Errors.NOT_APPROVER);
  const selfGrant = await teammateControl('approval.grant', { userId: teammate.id, requestId: approval.id,
    turnId: approval.turnId, expiresAt: Date.now() + 60000 });
  assert.equal(selfGrant.code, 'host_owner_required');
  assert.equal(fs.existsSync(path.join(workspace, 'build/obsolete.txt')), true,
    'verified project membership does not authorize the destructive action');
  const rejected = await control('approval.resolve', { requestId: approval.id, turnId: approval.turnId,
    fingerprint: 'mutated', decision: 'accept' });
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.code, Errors.APPROVAL_ACTION_CHANGED);
  assert.equal(fs.existsSync(path.join(workspace, 'build/obsolete.txt')), true);

  const wrongScope = await control('approval.grant', { userId: teammate.id, requestId: 'a-different-request',
    turnId: approval.turnId, expiresAt: Date.now() + 60000 });
  assert.equal(wrongScope.code, 'invalid_approval_scope');
  const granted = await control('approval.grant', { userId: teammate.id, requestId: approval.id,
    turnId: approval.turnId, expiresAt: Date.now() + 60000 });
  assert.equal(granted.state, 'delivered');
  assert.equal(granted.result.granted, true);

  // Submit the delegated response first, then the competing owner response without
  // waiting for either receipt. The member's grant must authorize a real settlement.
  const ownerAnswerId = newId('cmd');
  const teammateAnswerId = newId('cmd');
  await sendTaskControl(teammateEndpoint, writer, { task, action: 'approval.resolve', payload: answer, commandId: teammateAnswerId });
  await sendTaskControl(endpoint, writer, { task, action: 'approval.resolve', payload: answer, commandId: ownerAnswerId });
  const answers = await Promise.all([
    until(async () => { await refresh(); return receipts.get(ownerAnswerId); }, 'competing owner response'),
    until(async () => { await refreshTeammate(); return teammateReceipts.get(teammateAnswerId); }, 'delegated response')
  ]);
  assert.equal(answers.filter(receipt => receipt.state === 'delivered').length, 1, 'only one answer wins');
  assert.equal(answers[1].state, 'delivered', 'the exact delegated member response settles the action');
  const losing = answers.find(receipt => receipt.state === 'rejected');
  assert.equal(losing.code, Errors.APPROVAL_SETTLED);
  const winningIndex = answers.findIndex(receipt => receipt.state === 'delivered');
  const winningActor = winningIndex === 0 ? owner.id : teammate.id;
  assert.equal(losing.result.settled.by.userId, winningActor, 'loser learns the authoritative actor');
  assert.equal(losing.result.settled.requestId, approval.id);
  await until(async () => { await refresh(); return !fs.existsSync(path.join(workspace, 'build')); }, 'approved workspace action');
  await until(async () => (await refresh()).turn === 'completed', 'approved turn completion');
  const decisions = reader.state.decisions.filter(decision => decision.basis === approval.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].actor, winningActor);

  // A command retry after execution must return its receipt without repeating its effect.
  fs.mkdirSync(path.join(workspace, 'build'));
  fs.writeFileSync(path.join(workspace, 'build/new-work.txt'), 'new work after the first action');
  const retried = winningIndex === 0
    ? await control('approval.resolve', answer, ownerAnswerId)
    : await teammateControl('approval.resolve', answer, teammateAnswerId);
  assert.equal(retried.state, 'delivered');
  assert.equal(retried.result.duplicate, true);
  assert.equal(fs.readFileSync(path.join(workspace, 'build/new-work.txt'), 'utf8'), 'new work after the first action');
  await refresh();
  assert.equal(reader.state.decisions.filter(decision => decision.basis === approval.id).length, 1);

  const next = await teammateControl('turn.start', { input: [{ type: 'text', text: 'delete build' }], settings: { provider: 'demo' } });
  assert.equal(next.state, 'accepted', 'ordinary project participants can start work');
  const nextApproval = await until(async () => {
    await refresh(); return reader.state.approvals.find(request => request.turnId === next.result.turnId);
  }, 'second approval');
  const staleText = 'This belongs to the completed turn and must not enter the new turn';
  const stale = await teammateControl('turn.steer', { expectedTurnId: approval.turnId,
    input: [{ type: 'text', text: staleText }] });
  assert.equal(stale.state, 'rejected');
  assert.equal(stale.code, Errors.STALE_TURN);
  const expiredGrant = await teammateControl('approval.resolve', { requestId: nextApproval.id,
    turnId: nextApproval.turnId, fingerprint: nextApproval.fingerprint, decision: 'accept' });
  assert.equal(expiredGrant.code, Errors.NOT_APPROVER, 'the exact grant cannot carry into another turn or action');
  const interrupted = await teammateControl('turn.interrupt', { turnId: next.result.turnId });
  assert.equal(interrupted.state, 'accepted');
  assert.equal(interrupted.result.interruptState, 'requested');
  await until(async () => (await refresh()).turn === 'interrupted', 'interrupted turn is durably visible');
  assert.equal(reader.state.activeTurnId, null);
  assert.ok(reader.state.decisions.some(decision => decision.basis === nextApproval.id),
    'interruption settles the visible approval so catch-up does not keep offering an abandoned action');
  assert.equal(JSON.stringify(reader.state.messages).includes(staleText), false, 'stale correction never enters the agent transcript');
  assert.equal(fs.readFileSync(path.join(workspace, 'build/new-work.txt'), 'utf8'), 'new work after the first action',
    'interrupting an approval wait leaves the unapproved filesystem action untouched');

  const expiring = await control('turn.start', { input: [{ type: 'text', text: 'delete build' }], settings: { provider: 'demo' } });
  const expiringApproval = await until(async () => {
    await refresh(); return reader.state.approvals.find(request => request.turnId === expiring.result.turnId);
  }, 'expiring approval');
  const overlong = await control('approval.grant', { userId: teammate.id, requestId: expiringApproval.id,
    turnId: expiringApproval.turnId, expiresAt: expiringApproval.expiresAt + 1 });
  assert.equal(overlong.code, 'invalid_approval_scope', 'a grant cannot outlive its exact pending request');
  const clock = t.mock.method(Date, 'now', () => expiringApproval.expiresAt + 1);
  try {
    await until(async () => {
      await refresh(); return reader.state.decisions.some(decision => decision.basis === expiringApproval.id);
    }, 'runtime automatically records expired approval');
    const late = await control('approval.resolve', { requestId: expiringApproval.id, turnId: expiringApproval.turnId,
      fingerprint: expiringApproval.fingerprint, decision: 'accept' });
    assert.equal(late.code, Errors.APPROVAL_EXPIRED);
    assert.equal(late.result.settled.reason, 'approval_expired');
    assert.equal(late.result.settled.by.userId, 'execution-host');
  } finally { clock.mock.restore(); }
  await until(async () => (await refresh()).turn === 'completed', 'expired action finishes safely');
  assert.equal(fs.readFileSync(path.join(workspace, 'build/new-work.txt'), 'utf8'), 'new work after the first action');
  assert.equal(reader.state.approvers.length, 0);

  const abandoned = await control('turn.start', { input: [{ type: 'text', text: 'delete build' }], settings: { provider: 'demo' } });
  const abandonedApproval = await until(async () => {
    await refresh(); return reader.state.approvals.find(request => request.turnId === abandoned.result.turnId);
  }, 'approval before runtime loss');
  const abandonedGrant = await control('approval.grant', { userId: teammate.id, requestId: abandonedApproval.id,
    turnId: abandonedApproval.turnId, expiresAt: Date.now() + 60000 });
  assert.equal(abandonedGrant.state, 'delivered');
  async function restartRuntime() {
    await runtime.stop();
    runtime = new Runtime(runtimeOptions); await runtime.start();
    await until(() => runtime.encryptedHost?.endpoint, 'recreated runtime endpoint');
    assert.deepEqual(runtime.descriptor().encryptedEndpoint, writer, 'configured key persistence preserves host identity');
  }
  await restartRuntime();
  await until(async () => (await refresh()).recovery?.reason === 'host_restarted', 'uncertain execution requires recovery');
  assert.equal(reader.state.events.filter(event => event.type === 'turn.started' && event.payload.turnId === abandoned.result.turnId).length, 1);
  assert.equal(reader.state.approvers.length, 0, 'abandoned per-action grants are removed from the recovered view');
  assert.ok(reader.state.decisions.some(decision => decision.basis === abandonedApproval.id));
  const staleApproval = await teammateControl('approval.resolve', { requestId: abandonedApproval.id, turnId: abandonedApproval.turnId,
    fingerprint: abandonedApproval.fingerprint, decision: 'accept' });
  assert.equal(staleApproval.code, Errors.APPROVAL_STALE_AFTER_RESTART);
  const automaticRetry = await control('turn.start', { input: [{ type: 'text', text: 'create RECOVERED.txt' }], settings: { provider: 'demo' } });
  assert.equal(automaticRetry.code, 'recovery_required');
  assert.equal(fs.existsSync(path.join(workspace, 'RECOVERED.txt')), false);
  assert.equal(fs.readFileSync(path.join(workspace, 'build/new-work.txt'), 'utf8'), 'new work after the first action');
  const acknowledged = await control('turn.start', { acknowledgeUnknown: true,
    input: [{ type: 'text', text: 'create RECOVERED.txt' }], settings: { provider: 'demo' } });
  assert.equal(acknowledged.state, 'accepted');
  await until(async () => (await refresh()).turn === 'completed', 'explicitly acknowledged new work completes');
  assert.match(fs.readFileSync(path.join(workspace, 'RECOVERED.txt'), 'utf8'), /create RECOVERED.txt/);
  assert.equal(fs.readFileSync(path.join(workspace, 'build/new-work.txt'), 'utf8'), 'new work after the first action');

  // Fault the real relay append before the first event, then recreate the runtime.
  // An initialization failure has no provider effects and must not produce a recovery
  // event ahead of task.created or leave the task permanently unreplayable.
  const firstEventTask = { ...task, id: newId('et') };
  let refusedFirstEvent = false, blockFirstEvent = true;
  const append = hub.encryptedTasks.append.bind(hub.encryptedTasks);
  hub.encryptedTasks.append = (target, record) => {
    if (target.id === firstEventTask.id && record.seq === 1 && blockFirstEvent) {
      refusedFirstEvent = true; throw Object.assign(new Error('fixture_relay_offline'), { code: 'fixture_relay_offline' });
    }
    return append(target, record);
  };
  await createEncryptedTask(endpoint, tasks, { task: firstEventTask, writer, payload: {
    title: 'Initialization survives relay outage', objective: 'create INITIALIZED.txt', provider: 'demo'
  } });
  await until(() => refusedFirstEvent, 'first encrypted event refused by relay');
  assert.equal(fs.existsSync(path.join(workspace, 'INITIALIZED.txt')), false);
  await runtime.stop(); blockFirstEvent = false;
  await restartRuntime();
  const initializationReader = new EncryptedTaskReader({ endpoint, task: firstEventTask, writer });
  await until(async () => {
    await endpoint.open(await endpoint.transport.drain());
    await initializationReader.reconnect(tasks); return initializationReader.state.turn === 'completed';
  }, 'initial task resumes safely before any provider effect');
  assert.equal(initializationReader.state.events[0].type, 'task.created');
  assert.equal(initializationReader.state.events.filter(event => event.type === 'turn.started').length, 1);
  assert.match(fs.readFileSync(path.join(workspace, 'INITIALIZED.txt'), 'utf8'), /create INITIALIZED.txt/);

  const markerTask = { ...task, id: newId('et') };
  let markerPersisted = false;
  const save = runtime.encryptedHost.state.save.bind(runtime.encryptedHost.state);
  runtime.encryptedHost.state.save = (id, value) => {
    save(id, value);
    if (id === 'execution:' + markerTask.id && value.state === 'running' && !markerPersisted) {
      markerPersisted = true;
      throw Object.assign(new Error('fixture_crash_after_execution_marker'), { code: 'fixture_crash_after_execution_marker' });
    }
  };
  await createEncryptedTask(endpoint, tasks, { task: markerTask, writer, payload: {
    title: 'Crash at execution marker', objective: 'create MUST_NOT_RETRY.txt', provider: 'demo'
  } });
  await until(() => markerPersisted, 'execution marker persisted before simulated process loss');
  assert.equal(fs.existsSync(path.join(workspace, 'MUST_NOT_RETRY.txt')), false);
  assert.ok((await tasks.page(markerTask.id)).head >= 1, 'the task prefix is durable before its execution marker');
  await restartRuntime();
  const markerReader = new EncryptedTaskReader({ endpoint, task: markerTask, writer });
  await until(async () => {
    await endpoint.open(await endpoint.transport.drain());
    await markerReader.reconnect(tasks); return markerReader.state.recovery;
  }, 'interrupted startup produces a replayable recovery record');
  assert.equal(markerReader.state.events[0].type, 'task.created');
  assert.equal(markerReader.state.events.filter(event => event.type === 'turn.started').length, 0);
  assert.equal(markerReader.state.events.filter(event => event.type === 'recovery.required').length, 1);
  assert.equal(fs.existsSync(path.join(workspace, 'MUST_NOT_RETRY.txt')), false, 'no provider dispatch after uncertain startup');

  const activeFailureTask = { ...task, id: newId('et') };
  let activeAppendFailed = false, blockActiveAppend = true;
  let providerStopped;
  const stopped = new Promise(resolve => { providerStopped = resolve; });
  const originalProvider = runtime.provider.bind(runtime);
  runtime.provider = id => id !== 'demo' ? originalProvider(id) : {
    id: 'active-failure-fixture',
    async run(session) {
      // A deterministic provider adapter plans a later real workspace write. Failure
      // must abort it while running, rather than waiting for this turn to complete.
      session.thread.codexAppServerThreadId = 'private-native-provider-thread';
      session.thread.codexAccountBinding = 'a'.repeat(64);
      await session.onProviderStateChanged();
      session.updatePlan([{ step: 'Record progress before the next file write', status: 'inProgress' }]);
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        session.abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      const result = await session.writeFile('AFTER_LOG_FAILURE.txt', 'must never be written');
      providerStopped({ interrupted: session.abort.signal.aborted, result });
    }
  };
  hub.encryptedTasks.append = (target, record) => {
    if (target.id === activeFailureTask.id && record.seq === 3 && blockActiveAppend) {
      activeAppendFailed = true; throw Object.assign(new Error('fixture_active_relay_failure'), { code: 'fixture_active_relay_failure' });
    }
    return append(target, record);
  };
  await createEncryptedTask(endpoint, tasks, { task: activeFailureTask, writer, payload: {
    title: 'Stop when active event recording fails', objective: 'create AFTER_LOG_FAILURE.txt', provider: 'demo'
  } });
  await until(() => activeAppendFailed, 'relay rejects an event during active provider execution');
  const providerResult = await stopped;
  assert.equal(providerResult.interrupted, true, 'recording failure immediately reaches the live provider');
  assert.equal(providerResult.result.item.status, 'declined');
  assert.equal(fs.existsSync(path.join(workspace, 'AFTER_LOG_FAILURE.txt')), false);
  const failedState = runtime.encryptedExecution.state(activeFailureTask);
  assert.equal(failedState.state, 'recovery-required', 'provider completion cannot overwrite recording uncertainty');
  assert.equal(failedState.providerState.codexAppServerThreadId, 'private-native-provider-thread');
  assert.equal(failedState.providerState.codexAccountBinding, 'a'.repeat(64));
  await runtime.stop(); blockActiveAppend = false;
  await restartRuntime();
  const failedReader = new EncryptedTaskReader({ endpoint, task: activeFailureTask, writer });
  await until(async () => {
    await endpoint.open(await endpoint.transport.drain());
    await failedReader.reconnect(tasks); return failedReader.state.recovery;
  }, 'recording uncertainty is replayable after runtime recreation');
  assert.equal(failedReader.state.recovery.reason, 'encrypted_log_unavailable');
  assert.equal(failedReader.state.events.some(event => event.type === 'turn.completed'), false, 'no false completion crosses the log gap');
  assert.equal(fs.existsSync(path.join(workspace, 'AFTER_LOG_FAILURE.txt')), false, 'runtime recreation cannot resume provider work automatically');
  assert.equal(JSON.stringify(await tasks.page(activeFailureTask.id)).includes('private-native-provider-thread'), false);

  async function scopedControl(sender, target, action, payload) {
    const commandId = newId('cmd');
    await sendTaskControl(sender, writer, { task: target, action, payload, commandId });
    return until(async () => {
      const replies = await sender.open(await sender.transport.drain());
      for (const event of replies) {
        const receipt = readTaskReceipt(event, target, writer);
        if (receipt?.commandId === commandId) return receipt;
      }
    }, action + ' on isolated regression task');
  }

  // Membership signer Alice can authenticate the roster, but that must never confer
  // approval rights. Host-local consent is a separate fixture input, initially absent.
  runtime.approvalAuthority = null;
  const separateAuthorityTask = { ...task, id: newId('et') };
  await createEncryptedTask(endpoint, tasks, { task: separateAuthorityTask, writer, payload: {
    title: 'Approval consent is separate', objective: 'delete build', provider: 'demo'
  } });
  const authorityReader = new EncryptedTaskReader({ endpoint, task: separateAuthorityTask, writer });
  const refreshAuthority = async () => {
    await endpoint.open(await endpoint.transport.drain()); await authorityReader.reconnect(tasks); return authorityReader.snapshot();
  };
  const noOwnerApproval = await until(async () => (await refreshAuthority()).approvals[0], 'pending action without an approval owner');
  assert.equal(authorityReader.state.details.approvalOwner, null);
  assert.equal(noOwnerApproval.approvalOwner, null, 'missing consent is explicit in the authenticated request');
  const noOwnerAnswer = { requestId: noOwnerApproval.id, turnId: noOwnerApproval.turnId,
    fingerprint: noOwnerApproval.fingerprint, decision: 'accept' };
  assert.equal((await scopedControl(endpoint, separateAuthorityTask, 'approval.resolve', noOwnerAnswer)).code, Errors.NOT_APPROVER,
    'the membership signer is not an implicit approver');
  assert.equal((await scopedControl(teammateEndpoint, separateAuthorityTask, 'approval.resolve', noOwnerAnswer)).code, Errors.NOT_APPROVER);
  assert.equal((await scopedControl(endpoint, separateAuthorityTask, 'approval.grant', { userId: owner.id,
    requestId: noOwnerApproval.id, turnId: noOwnerApproval.turnId, expiresAt: Date.now() + 60000 })).code, 'host_owner_required');
  assert.equal(fs.existsSync(path.join(workspace, 'build/new-work.txt')), true);
  await scopedControl(endpoint, separateAuthorityTask, 'turn.interrupt', { turnId: noOwnerApproval.turnId });
  await until(async () => (await refreshAuthority()).turn === 'interrupted', 'unconsented action cancelled');

  runtime.approvalAuthority = { ...teammateEndpoint.identity(), teamId: team.id };
  await scopedControl(endpoint, separateAuthorityTask, 'turn.start', { input: [{ type: 'text', text: 'delete build' }], settings: { provider: 'demo' } });
  const bobApproval = await until(async () => (await refreshAuthority()).approvals.find(request => request.id !== noOwnerApproval.id),
    'independently consented Bob owns the new pending approval');
  assert.equal(authorityReader.state.details.approvalOwner, null, 'the original host record remains historical');
  assert.deepEqual(bobApproval.approvalOwner, teammateEndpoint.identity(), 'each request records its current approval owner');
  const bobAnswer = { requestId: bobApproval.id, turnId: bobApproval.turnId, fingerprint: bobApproval.fingerprint, decision: 'accept' };
  assert.equal((await scopedControl(endpoint, separateAuthorityTask, 'approval.resolve', bobAnswer)).code, Errors.NOT_APPROVER);
  assert.equal((await scopedControl(endpoint, separateAuthorityTask, 'approval.grant', { userId: owner.id,
    requestId: bobApproval.id, turnId: bobApproval.turnId, expiresAt: Date.now() + 60000 })).code, 'host_owner_required');
  runtime.approvalAuthority = { ...runtime.approvalAuthority, ed25519: endpoint.identity().ed25519 };
  assert.equal((await scopedControl(teammateEndpoint, separateAuthorityTask, 'approval.resolve', bobAnswer)).code, Errors.NOT_APPROVER,
    'matching user and device names cannot substitute for the exact consented endpoint keys');
  runtime.approvalAuthority = { ...teammateEndpoint.identity(), teamId: team.id };
  const bobAccepted = await scopedControl(teammateEndpoint, separateAuthorityTask, 'approval.resolve', bobAnswer);
  assert.equal(bobAccepted.state, 'delivered');
  await until(async () => (await refreshAuthority()).turn === 'completed', 'separately consented owner completes the real action');
  assert.equal(fs.existsSync(path.join(workspace, 'build')), false);
  assert.ok(authorityReader.state.decisions.some(decision => decision.basis === bobApproval.id && decision.actor === teammate.id));

  // Pause before the terminal ciphertext exists. The provider has finished and its file
  // exists, but a recreated manager cannot call that execution durably completed.
  const terminalTask = { ...task, id: newId('et') };
  const hostEndpoint = runtime.encryptedHost.endpoint;
  const encrypt = hostEndpoint.encryptTask.bind(hostEndpoint);
  let terminalPaused = false, releaseTerminal;
  hostEndpoint.encryptTask = async (room, type, payload, ...rest) => {
    if (payload?.task?.id === terminalTask.id && payload.event?.type === 'turn.completed') {
      terminalPaused = true;
      await new Promise((resolve, reject) => { releaseTerminal = reject; });
    }
    return encrypt(room, type, payload, ...rest);
  };
  await createEncryptedTask(endpoint, tasks, { task: terminalTask, writer, payload: {
    title: 'Terminal event must be durable', objective: 'create TERMINAL_EFFECT.txt', provider: 'demo'
  } });
  await until(() => terminalPaused, 'provider finished while terminal encryption is paused');
  try {
    assert.match(fs.readFileSync(path.join(workspace, 'TERMINAL_EFFECT.txt'), 'utf8'), /create TERMINAL_EFFECT.txt/);
    assert.equal(runtime.encryptedExecution.state(terminalTask).state, 'running', 'terminal state is not saved before the encrypted queue flushes');
    assert.equal(runtime.encryptedHost.state.load(terminalTask.id).pending, undefined, 'terminal ciphertext has not reached the durable outbox');
  } finally {
    const closing = runtime.stop();
    releaseTerminal(Object.assign(new Error('fixture_process_lost_before_terminal'), { code: 'fixture_process_lost_before_terminal' }));
    await closing;
  }
  await restartRuntime();
  const terminalReader = new EncryptedTaskReader({ endpoint, task: terminalTask, writer });
  await until(async () => {
    await endpoint.open(await endpoint.transport.drain()); await terminalReader.reconnect(tasks); return terminalReader.state.recovery;
  }, 'missing terminal event requires reconciliation after process loss');
  assert.equal(terminalReader.state.turn, 'unknown');
  assert.equal(terminalReader.state.events.some(event => event.type === 'turn.completed'), false);
  assert.equal(terminalReader.state.events.filter(event => event.type === 'turn.started').length, 1);
  assert.equal(terminalReader.state.recovery.reason, 'host_restarted');
  assert.match(fs.readFileSync(path.join(workspace, 'TERMINAL_EFFECT.txt'), 'utf8'), /create TERMINAL_EFFECT.txt/);
});
