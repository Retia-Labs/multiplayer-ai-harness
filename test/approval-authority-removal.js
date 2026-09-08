'use strict';
// Execution's authenticated-membership boundary. Real runtime, SQLite, TurnSession
// approvals and workspace effects; the event-log I/O is an in-memory recorder here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Runtime } = require('../packages/runtime');
const { EncryptedExecution } = require('../packages/runtime/encrypted-execution');
const { EncryptedTaskState } = require('../packages/runtime/encrypted-task');
const { newId } = require('../packages/e2ee/task-log.mjs');
const original = { user: '@owner:plexus.local', device: 'ORIGINAL', curve25519: 'original-encryption', ed25519: 'original-signing' };
const removedHead = { endpoints: [{ ...original, state: 'revoked' }] };
const until = async read => {
  for (let i = 0; i < 200; i++) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Expected local execution state did not arrive');
};
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-approval-removal-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(workspace, 'build')); fs.writeFileSync(path.join(workspace, 'build/keep.txt'), 'retain');
  const runtime = new Runtime({ dataDir: path.join(dir, 'runtime'), projects: [workspace], encryptedTasksOnly: true,
    approvalAuthority: { ...original, teamId: 'team' } });
  runtime.teamId = 'team';
  const state = new EncryptedTaskState(path.join(dir, 'host.sqlite'));
  const projectId = newId('ep');
  const host = { state, projects: new Map([[projectId, workspace]]), membership: { endpoints: [{ ...original, state: 'verified' }] },
    participants: async () => new Map([['owner', {}], ['bob', {}]]) };
  const execution = new EncryptedExecution({ runtime, host });
  t.after(async () => { await execution.close(); await runtime.stop(); state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const task = () => {
    const task = { id: newId('et'), projectId, creatorUserId: 'owner', runtimeId: runtime.id, teamId: 'team' }, events = [];
    const opened = { reader: { seq: 1, state: { messages: [], approvals: [], decisions: [], diffs: [] } },
      objective: { title: 'Approval removal', objective: 'Remove build', provider: 'approval-fixture' },
      writer: { append: async event => { events.push(event); opened.reader.seq++; } } };
    return { task, opened, events };
  };
  return { runtime, host, execution, workspace, task };
}

test('removing the configured approval device cancels outstanding delegated approval before workspace action', async t => {
  const f = fixture(t), { task, opened, events } = f.task();
  f.runtime.provider = () => ({ id: 'approval-fixture', run: session => session.removePath('build') });
  const turn = await f.execution.startTask(task, opened);
  const active = await until(() => f.execution.active.get(task.id));
  const request = await until(() => [...active.session.pendingApprovals.entries()][0]);
  const [requestId, pending] = request;
  await f.execution.control(task, { action: 'approval.grant', sender: 'owner', senderDevice: 'ORIGINAL', commandId: 'grant',
    payload: { userId: 'bob', requestId, turnId: turn.turnId, expiresAt: Math.min(Date.now() + 10000, pending.expiresAt) } }, opened);
  assert.ok(f.execution.state(task).grants.bob);
  f.host.membership = removedHead;
  await f.execution.applyMembership(removedHead);
  await until(() => !f.execution.active.has(task.id));
  assert.equal(fs.readFileSync(path.join(f.workspace, 'build/keep.txt'), 'utf8'), 'retain');
  assert.deepEqual(f.execution.state(task).grants, {});
  assert.equal(f.execution.state(task).settledApprovals[requestId].reason, 'approval_authority_revoked');
  assert.ok(events.some(event => event.type === 'decision.recorded' && event.payload.reason === 'approval_authority_revoked'));
  await assert.rejects(() => f.execution.control(task, { action: 'approval.resolve', sender: 'bob', senderDevice: 'BOB', commandId: 'late',
    payload: { requestId, turnId: turn.turnId, decision: 'accept', fingerprint: pending.fingerprint } }, opened));
  assert.deepEqual(f.runtime.approvalAuthority, { ...original, teamId: 'team' }, 'removal never appoints a new approver');
  assert.equal(f.execution.closed, false, 'freshness-capable host can run later ordinary work');
});

test('a later ordinary turn has no recovered approval authority and survives repeated membership reconciliation', async t => {
  const f = fixture(t); f.host.membership = removedHead;
  await f.execution.applyMembership(removedHead);
  let release; const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.runtime.provider = () => ({ id: 'ordinary-fixture', run: async session => { await gate; await session.writeFile('after.txt', 'after removal'); } });
  const { task, opened } = f.task();
  await f.execution.startTask(task, opened);
  await until(() => f.execution.active.has(task.id));
  await f.execution.applyMembership(removedHead);
  release(); await until(() => !f.execution.active.has(task.id));
  assert.equal(fs.readFileSync(path.join(f.workspace, 'after.txt'), 'utf8'), 'after removal');
  assert.equal(f.execution.state(task).approvalAuthority, null);
  assert.equal(f.execution.approvalOwner(), null);
  assert.deepEqual(f.execution.state(task).grants, {});
});

test('a failed revocation write still interrupts every affected task before further workspace effects', async t => {
  const f = fixture(t), tasks = [f.task(), f.task()];
  let release; const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.runtime.provider = () => ({ id: 'gated-fixture', run: async session => {
    await gate; await session.writeFile(session.thread.id + '.txt', 'must not execute after removal');
  } });
  for (const item of tasks) await f.execution.startTask(item.task, item.opened);
  await until(() => f.execution.active.size === 2);
  f.host.state.db.exec("CREATE TRIGGER fail_execution BEFORE INSERT ON encrypted_task_state WHEN NEW.id LIKE 'execution:%' BEGIN SELECT RAISE(ABORT, 'synthetic_disk_failure'); END;");
  f.host.membership = removedHead;
  try { await assert.rejects(() => f.execution.applyMembership(removedHead), /synthetic_disk_failure/); }
  finally { f.host.state.db.exec('DROP TRIGGER fail_execution'); release(); }
  await until(() => f.execution.active.size === 0);
  assert.deepEqual(tasks.map(item => fs.existsSync(path.join(f.workspace, item.task.id + '.txt'))), [false, false]);
});

test('failed approval receipt storage releases all cancelled waiters without performing their actions', async t => {
  const f = fixture(t), { task, opened } = f.task();
  f.runtime.provider = () => ({ id: 'parallel-approvals', run: session => Promise.all([
    session.removePath('build'), session.removePath('build')
  ]) });
  await f.execution.startTask(task, opened);
  const active = await until(() => f.execution.active.get(task.id));
  await until(() => active.session.pendingApprovals.size === 2);
  f.host.state.db.exec("CREATE TRIGGER fail_execution BEFORE INSERT ON encrypted_task_state WHEN NEW.id LIKE 'execution:%' BEGIN SELECT RAISE(ABORT, 'synthetic_disk_failure'); END;");
  f.host.membership = removedHead;
  try { await assert.rejects(() => f.execution.applyMembership(removedHead), /synthetic_disk_failure/); }
  finally { f.host.state.db.exec('DROP TRIGGER fail_execution'); }
  await until(() => !f.execution.active.has(task.id));
  assert.equal(active.session.pendingApprovals.size, 0);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'build/keep.txt'), 'utf8'), 'retain');
});

test('a failed accepted-decision write remains cancelled in reopened storage, history and later replies', async t => {
  const f = fixture(t), { task, opened, events } = f.task();
  f.runtime.provider = () => ({ id: 'approval-fixture', run: session => session.removePath('build') });
  const turn = await f.execution.startTask(task, opened);
  const active = await until(() => f.execution.active.get(task.id));
  const [requestId, pending] = await until(() => [...active.session.pendingApprovals.entries()][0]);
  const save = f.execution.save.bind(f.execution);
  let injected = false;
  f.execution.save = (target, value) => {
    if (!injected && target.id === task.id && value.settledApprovals?.[requestId]?.decision === 'accept') {
      injected = true;
      f.host.state.db.exec("CREATE TRIGGER fail_accepted BEFORE INSERT ON encrypted_task_state WHEN NEW.id LIKE 'execution:%' BEGIN SELECT RAISE(ABORT, 'synthetic_accepted_write_failure'); END;");
      try { return save(target, value); }
      finally { f.host.state.db.exec('DROP TRIGGER fail_accepted'); }
    }
    return save(target, value);
  };
  const resolve = commandId => f.execution.control(task, { action: 'approval.resolve', sender: 'owner', senderDevice: 'ORIGINAL', commandId,
    payload: { requestId, turnId: turn.turnId, decision: 'accept', fingerprint: pending.fingerprint } }, opened);
  await assert.rejects(() => resolve('first'), /synthetic_accepted_write_failure/);
  await until(() => !f.execution.active.has(task.id));
  const reopened = new EncryptedTaskState(path.join(path.dirname(f.workspace), 'host.sqlite'));
  try {
    const settled = reopened.load('execution:' + task.id).settledApprovals[requestId];
    assert.equal(settled.decision, 'cancel');
    assert.equal(settled.reason, 'approval_settlement_failed');
  } finally { reopened.close(); }
  assert.equal(active.session.settledApprovals.get(requestId).decision, 'cancel');
  await assert.rejects(() => resolve('retry'), error => error.code === 'approval_already_settled' && error.settled?.decision === 'cancel');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'build/keep.txt'), 'utf8'), 'retain');
  const decisions = events.filter(event => event.type === 'decision.recorded' && event.payload.basis === requestId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].payload.decision, 'cancel');
  assert.equal(decisions[0].payload.reason, 'approval_settlement_failed');
});
