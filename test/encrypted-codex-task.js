'use strict';
// Real supported provider through the runtime's encrypted collector and public controls.
// Input is exclusively fresh synthetic fixtures. Requires explicit real-provider opt-in;
// ordinary npm/CI runs never spend provider quota or reuse account credentials.
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
const { codexHome } = require('../packages/runtime/codex-probe');

if (process.env.PLEXUS_RUN_REAL_CODEX !== '1') {
  console.log('SKIPPED: real provider proof requires explicit PLEXUS_RUN_REAL_CODEX=1 authorization.');
  process.exit(0);
}
const bin = process.env.PLEXUS_TEST_CODEX_BIN;
assert.ok(bin && path.isAbsolute(bin), 'PLEXUS_TEST_CODEX_BIN must name the supported isolated CLI');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-supported-real-'));
const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
const marker = 'SYNTHETIC_FIXTURE_' + Date.now();
const initial = 'The maintenance window is Monday. ' + marker + '\n';
const corrected = 'The maintenance window is Tuesday. ' + marker + '\n';
const outsideMarker = 'SYNTHETIC_OUTSIDE_' + Date.now();
fs.writeFileSync(path.join(workspace, 'ANSWER.txt'), initial);
fs.writeFileSync(path.join(dir, 'OUTSIDE_READ.txt'), outsideMarker);
fs.symlinkSync(path.join(dir, 'OUTSIDE_READ.txt'), path.join(workspace, 'outside-link.txt'));
for (const name of ['build', 'pause']) {
  fs.mkdirSync(path.join(workspace, name));
  fs.writeFileSync(path.join(workspace, name, 'keep.txt'), 'Synthetic approval fixture only.\n');
}
const report = { ranAt: new Date().toISOString(), version: '0.153.4', model: 'gpt-5.4-mini', effort: 'medium',
  platform: { os: process.platform, arch: process.arch },
  inputSource: 'Fresh temporary generated ANSWER/build/pause fixtures and generated sibling read marker only; no repository/user documents',
  checks: [], turns: [] };
const pass = name => { report.checks.push({ name, status: 'pass' }); console.log('PASS ' + name); };
const until = async (read, label, timeout = 120000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error('Timed out: ' + label);
};
let hub, runtime, socket, ownerEndpoint, teammateEndpoint, hostKeys, challenges;
(async () => {
  hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite') });
  const address = await hub.listen(), url = 'http://127.0.0.1:' + address.port;
  const owner = hub.store.createAccount('Alice'), teammate = hub.store.createAccount('Bob');
  const team = hub.store.createTeam('Synthetic native proof', owner.id);
  hub.store._stmts.upsertMember.run(team.id, teammate.id, 'member', 'pending', Date.now());
  ownerEndpoint = await Endpoint.create({ user: matrixUser(owner.id), device: 'ALICE',
    transport: new HubKeyTransport({ url, token: owner.token, device: 'ALICE' }) });
  const enrollment = new EnrollmentTransport({ url, token: owner.token, endpoint: ownerEndpoint });
  await enrollment.bootstrap(team.id, announcement(ownerEndpoint));
  teammateEndpoint = await Endpoint.create({ user: matrixUser(teammate.id), device: 'BOB',
    transport: new HubKeyTransport({ url, token: teammate.token, device: 'BOB' }) });
  const teammateEnrollment = new EnrollmentTransport({ url, token: teammate.token, endpoint: teammateEndpoint });
  await teammateEnrollment.announce(team.id, announcement(teammateEndpoint));
  await confirmTeammateEndpoint(ownerEndpoint, enrollment, team.id,
    { userId: teammate.id, ...teammateEndpoint.identity() }, { confirmed: true });
  runtime = new Runtime({ hubUrl: url.replace('http', 'ws'), dataDir: path.join(dir, 'host'), projects: [workspace],
    encryptedTasksOnly: true, codexHostTools: { bin, authFile: path.join(codexHome(), 'auth.json') },
    encryptionAuthority: { ...ownerEndpoint.identity(), teamId: team.id },
    approvalAuthority: { ...ownerEndpoint.identity(), teamId: team.id },
    // Only the OS key-store boundary is substituted; runtime discovery, SDK, signed
    // membership, control receipts, native provider and real workspace remain production.
    encryptedEndpointFactory: async options => {
      hostKeys ||= await Endpoint.create(options); hostKeys.transport = options.transport;
      return Object.assign(Object.create(hostKeys), { close: async () => {} });
    } });
  const provider = runtime.provider('codex-cli');
  assert.equal(provider.capabilities().nativeTools, false);
  assert.equal(provider.capabilities().readsVia, 'host-workspace-tools');
  const ready = await provider.checkHost({ workspace, settings: { effort: 'medium' } });
  // This explicitly opted-in host-local proof authorizes the inspected account;
  // an old unbound saved configuration cannot grant the same consent implicitly.
  runtime.codexHostTools.accountBinding = ready.accountBinding;
  pass('actual runtime alias verifies supported version, private profile, no ambient tools or instructions before model work');
  await runtime.start();
  socket = new WebSocket(url.replace('http', 'ws')); let welcome;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', role: 'client', token: owner.token }));
  socket.onmessage = ({ data }) => { const value = JSON.parse(data); if (value.type === 'welcome') welcome = value; };
  await until(() => welcome && hub.pendingPairings.size, 'pairing');
  socket.send(JSON.stringify({ type: TeamOps.RUNTIME_PAIR, id: 'pair', teamId: team.id, code: runtime.pairingCode }));
  await until(() => runtime.encryptedHost?.endpoint, 'encrypted host');
  challenges = setInterval(() => enrollment.answerChallenges(team.id).catch(() => {}), 100);
  const projectId = runtime.descriptor().encryptedProjects[0].id;
  await enrollment.ownProject(team.id, projectId);
  const writer = runtime.descriptor().encryptedEndpoint;
  await ownerEndpoint.confirmEndpoint(writer, { confirmed: true });
  await teammateEndpoint.confirmEndpoint(writer, { confirmed: true });
  const tasks = new EncryptedTaskTransport({ url, token: owner.token });
  const task = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId, creatorUserId: owner.id };
  await createEncryptedTask(ownerEndpoint, tasks, { task, writer, payload: {
    title: 'Correct the synthetic maintenance window', provider: 'codex-cli',
    settings: { model: 'gpt-5.4-mini', effort: 'medium', approvalPolicy: 'on-request', sandboxPolicy: 'workspace-write' },
    objective: 'This temporary project contains synthetic test data only. List the project and read ANSWER.txt with the host tools. As boundary probes, call plexus_read_file for ../OUTSIDE_READ.txt and outside-link.txt; both must be refused, do not retry or guess their contents. The read tool returns JSON containing the exact file content with escaped whitespace. Use plexus_write_file to create WINDOW.md with exactly that content, preserving its final newline. Then call plexus_remove_path for build and wait for the host decision. If a teammate supplies a correction during that wait, after the host decision succeeds use plexus_write_file to replace WINDOW.md with the exact corrected contents. Then stop. Do not modify any other files.'
  } });
  const reader = new EncryptedTaskReader({ endpoint: ownerEndpoint, task, writer });
  const receipts = new Map();
  const refresh = async () => {
    for (const event of await ownerEndpoint.open(await ownerEndpoint.transport.drain())) {
      const receipt = readTaskReceipt(event, task, writer); if (receipt) receipts.set(receipt.commandId, receipt);
    }
    await reader.reconnect(tasks);
    if (reader.state.turn === 'failed') throw new Error('Native turn failed: ' + reader.state.events.findLast(event => event.type === 'turn.completed')?.payload.error);
    return reader.snapshot();
  };
  const firstSession = await until(() => runtime.sessions.get(task.id), 'runtime native session');
  const approval = await until(async () => { await refresh(); return reader.state.approvals.find(value => value.turnId === firstSession.turnId); }, 'first encrypted host approval');
  assert.equal(fs.readFileSync(path.join(workspace, 'WINDOW.md'), 'utf8'), initial);
  assert.ok(reader.state.tools.some(tool => tool.arguments.command === 'read_file ../OUTSIDE_READ.txt' && tool.result.status === 'declined'));
  assert.ok(reader.state.tools.some(tool => tool.arguments.command === 'read_file outside-link.txt' && tool.result.status === 'declined'));
  assert.equal(JSON.stringify(reader.state).includes(outsideMarker), false);
  assert.equal(fs.readFileSync(path.join(dir, 'OUTSIDE_READ.txt'), 'utf8'), outsideMarker);
  pass('real native task uses host reads; sibling and symlink reads are refused without disclosing the outside marker');
  pass('ordinary real file creation reaches encrypted diff history before intervention');

  await grantProjectAccess(ownerEndpoint, enrollment, { teamId: team.id, projectId,
    member: { userId: teammate.id, device: teammateEndpoint.device }, taskIds: [task.id] });
  const teammateTasks = new EncryptedTaskTransport({ url, token: teammate.token });
  let teammateReader; const admittedSessions = new Set(), teammateReceipts = new Map();
  const refreshTeammate = async () => {
    for (const event of await teammateEndpoint.open(await teammateEndpoint.transport.drain())) {
      const transfer = readTaskHistory(event, task);
      if (transfer) {
        const admitted = await acceptProjectAccess(teammateEndpoint, { history: transfer.history }, { writer });
        for (const value of admitted.sessions) admittedSessions.add(value);
        teammateReader = new EncryptedTaskReader({ endpoint: teammateEndpoint, task, writer, admittedSessions });
      }
      const receipt = readTaskReceipt(event, task, writer); if (receipt) teammateReceipts.set(receipt.commandId, receipt);
    }
    if (teammateReader) await teammateReader.reconnect(teammateTasks);
    return teammateReader?.snapshot();
  };
  await until(async () => (await refreshTeammate())?.approvals.some(value => value.id === approval.id), 'late teammate authenticated history');
  const control = async (actorEndpoint, actorReceipts, update, action, payload, commandId = newId('cmd')) => {
    await sendTaskControl(actorEndpoint, writer, { task, action, payload, commandId });
    const receipt = await until(async () => { await update(); return actorReceipts.get(commandId); }, action);
    return { ...receipt, commandId };
  };
  const ownerControl = (action, payload) => control(ownerEndpoint, receipts, refresh, action, payload);
  const teammateControl = (action, payload) => control(teammateEndpoint, teammateReceipts, refreshTeammate, action, payload);
  const correction = 'Correction from Bob: the maintenance window is Tuesday, not Monday. After the pending host removal succeeds, replace WINDOW.md with exactly this text including the final newline: ' + corrected;
  const queued = await teammateControl('turn.steer', { expectedTurnId: firstSession.turnId, input: [{ type: 'text', text: correction }] });
  assert.equal(queued.state, 'queued');
  const delivered = await until(async () => { await refresh(); return reader.state.receipts.find(value => value.commandId === queued.commandId && value.state === 'delivered'); }, 'provider acknowledged correction');
  assert.equal(delivered.actor, teammate.id);
  assert.ok(reader.state.messages.some(message => message.actor === teammate.id && message.text === correction));
  const answer = { requestId: approval.id, turnId: approval.turnId, fingerprint: approval.fingerprint, decision: 'accept' };
  const wrong = await ownerControl('approval.resolve', { ...answer, fingerprint: 'changed' });
  assert.equal(wrong.code, Errors.APPROVAL_ACTION_CHANGED);
  assert.ok(fs.existsSync(path.join(workspace, 'build/keep.txt')));
  const accepted = await ownerControl('approval.resolve', answer);
  assert.equal(accepted.state, 'delivered');
  await until(async () => (await refresh()).turn === 'completed', 'corrected native completion');
  assert.equal(fs.readFileSync(path.join(workspace, 'WINDOW.md'), 'utf8'), corrected);
  assert.equal(fs.existsSync(path.join(workspace, 'build')), false);
  assert.ok(reader.state.events.filter(event => event.type === 'diff.updated').length >= 2);
  assert.ok(JSON.stringify(reader.state.events).includes('Monday'));
  assert.ok(JSON.stringify(reader.state.diffs).includes('Tuesday'));
  report.turns.push({ status: 'completed', productTurnId: firstSession.turnId, providerThreadId: firstSession.providerSessionId });
  report.correction = { before: 'Monday', after: 'Tuesday', sourceActor: teammate.id, receipt: delivered.state };
  pass('confirmed teammate correction changes actual file bytes while preserving its actor, receipt and earlier history');
  pass('exact encrypted approval causes the real bounded deletion');

  const handover = await ownerControl('responsibility.handover', { to: teammate.id, note: 'Tuesday correction verified in WINDOW.md; Bob owns the outcome.' });
  assert.equal(handover.state, 'delivered');
  await until(async () => (await refreshTeammate())?.responsible === teammate.id, 'handoff history');
  assert.equal(teammateReader.state.handover.note, 'Tuesday correction verified in WINDOW.md; Bob owns the outcome.');
  assert.ok(JSON.stringify(teammateReader.state.diffs).includes('Tuesday'));
  pass('responsibility handoff preserves the verified corrected diff for the admitted teammate');
  const next = await teammateControl('turn.start', { input: [{ type: 'text', text: 'For this final synthetic stop test, call plexus_remove_path for pause and wait for the host decision. Do not change WINDOW.md.' }] });
  assert.equal(next.state, 'accepted');
  const secondSession = await until(() => { const value = runtime.sessions.get(task.id); return value?.turnId === next.result.turnId && value; }, 'resumed native session');
  const nextApproval = await until(async () => { await refresh(); return reader.state.approvals.find(value => value.turnId === next.result.turnId); }, 'resumed approval');
  assert.equal(secondSession.providerResume.state, 'acknowledged');
  assert.equal(secondSession.providerSessionId, firstSession.providerSessionId);
  const interrupted = await teammateControl('turn.interrupt', { turnId: nextApproval.turnId });
  assert.equal(interrupted.state, 'accepted');
  await until(async () => (await refresh()).turn === 'interrupted', 'native interrupted terminal');
  assert.equal(secondSession.providerInterrupt.state, 'confirmed');
  assert.ok(fs.existsSync(path.join(workspace, 'pause/keep.txt')));
  assert.equal(fs.readFileSync(path.join(workspace, 'WINDOW.md'), 'utf8'), corrected);
  report.turns.push({ status: 'interrupted', productTurnId: secondSession.turnId, providerThreadId: secondSession.providerSessionId,
    interrupt: secondSession.providerInterrupt.state, resume: secondSession.providerResume.state });
  pass('next responsible teammate explicitly resumes the same native thread and receives confirmed interruption without deletion');
  const outcome = await teammateControl('task.outcome', { outcome: 'completed' });
  assert.equal(outcome.state, 'delivered');
  await refresh(); assert.equal(reader.state.outcome, 'completed'); assert.equal(reader.state.completedBy, teammate.id);
  const relay = JSON.stringify({ events: await tasks.page(task.id), tasks: await tasks.list(team.id), runtimes: hub.store.listRuntimes(team.id) });
  assert.equal(relay.includes(marker), false); assert.equal(relay.includes(outsideMarker), false);
  assert.equal(/access_token|refresh_token|sk-[a-zA-Z0-9_-]{12,}/.test(relay), false);
  pass('real provider correction, handoff and outcome stay ciphertext-only at the relay');
  report.status = 'passed';
})().catch(error => {
  report.status = 'failed'; report.error = String(error.message || error); console.error('FAIL ' + report.error); process.exitCode = 1;
}).finally(async () => {
  clearInterval(challenges); socket?.close();
  try { await runtime?.stop(); } catch {}
  try { hostKeys?.close(); ownerEndpoint?.close(); teammateEndpoint?.close(); } catch {}
  try { await hub?.close(); } catch {}
  const out = path.resolve(__dirname, '../.artifacts/encrypted-codex-host-tools');
  fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(dir, { recursive: true, force: true });
});
