'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TurnSession } = require('../packages/runtime/session');
const { translate, EncryptedTaskRun } = require('../packages/runtime/encrypted-run');
const { Events } = require('../packages/protocol');
const { catchUp, openSource } = require('../packages/e2ee/catchup.mjs');

test('encrypted activity records an applied patch and never labels a refused write as a change', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-change-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const allowed of [false, true]) {
    const entries = [];
    const session = new TurnSession({
      thread: { id: 'task-evidence', cwd: dir }, by: { userId: 'alice' }, input: [],
      provider: { id: 'demo' }, executor: { id: 'local' },
      settings: { sandboxPolicy: allowed ? 'workspace-write' : 'read-only', approvalPolicy: 'never' },
      emit: (event) => { const entry = translate(event); if (entry) entries.push(entry); }
    });
    await session.writeFile('result.txt', 'Verified change\n');
    assert.equal(fs.existsSync(path.join(dir, 'result.txt')), allowed);
    const changes = entries.filter((entry) => entry.type === 'diff.updated');
    assert.equal(changes.length, allowed ? 1 : 0, 'only successful writes become diff evidence');
    if (allowed) {
      assert.equal(fs.readFileSync(path.join(dir, 'result.txt'), 'utf8'), 'Verified change\n');
      assert.match(changes[0].payload.files[0].patch, /\+Verified change/);
    } else {
      assert.equal(entries[0].type, 'tool.completed');
      assert.equal(entries[0].payload.result.status, 'declined');
    }
  }
});

test('catch-up attributes the current provider to its latest turn without rewriting the original objective', () => {
  const events = [
    { type: 'task.created', payload: { title: 'Original request', objective: 'Preserve the objective', provider: 'first-provider' } },
    { type: 'turn.started', payload: { turnId: 'turn_first', actor: 'alice', provider: 'first-provider' } },
    { type: 'turn.completed', payload: { status: 'completed', turnId: 'turn_first' } },
    { type: 'turn.started', payload: { turnId: 'turn_second', actor: 'alice', provider: 'fixture-provider' } }
  ];
  const snapshot = { events, seq: events.length, status: { state: 'caught-up' } };
  const projection = catchUp(snapshot, { hostConnected: true, provider: 'stale-context' });
  assert.equal(projection.provider.value, 'fixture-provider');
  assert.deepEqual(projection.provider.source, { seq: 4, type: 'turn.started' });
  assert.deepEqual(openSource(snapshot, projection.provider.source).event, events[3]);
  assert.equal(projection.objective.value, 'Preserve the objective');
  assert.equal(events[0].payload.provider, 'first-provider');
});

test('a failed append stops a live provider and never drains later events across the gap', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-append-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const failure = Object.assign(new Error('relay_unavailable'), { code: 'relay_unavailable' });
  let stopped = false;
  const appended = [];
  const run = new EncryptedTaskRun({ task: { id: 'et_' + '1'.repeat(32) },
    opened: { reader: { seq: 1 }, objective: {}, writer: { append: async entry => {
      appended.push(entry); throw failure;
    } } },
    onAppendFailure: error => { assert.equal(error, failure); stopped = true; },
    runTurn: async emit => {
      emit({ method: Events.TURN_STARTED, turnId: 'turn_fault', by: { userId: 'alice' } });
      emit({ method: Events.TURN_PLAN_UPDATED, plan: [{ step: 'Write after the first result', status: 'pending' }] });
      await new Promise(resolve => setTimeout(resolve, 40));
      if (!stopped) fs.writeFileSync(path.join(dir, 'must-not-run.txt'), 'unrecorded side effect');
      emit({ method: Events.TURN_COMPLETED, status: 'completed', turnId: 'turn_fault' });
    }
  });
  await assert.rejects(() => run.start(), error => error === failure);
  assert.equal(fs.existsSync(path.join(dir, 'must-not-run.txt')), false);
  assert.equal(appended.length, 1, 'events queued behind the failed append never reach the writer');
});

test('interruption between approval and dispatch prevents a workspace mutation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-cancel-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const action of ['write', 'remove']) {
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'original');
    const events = [];
    const session = new TurnSession({ thread: { id: 'dispatch-race', cwd: dir }, by: { userId: 'alice' }, input: [],
      provider: { id: 'demo' }, executor: { id: 'local' }, settings: { sandboxPolicy: 'workspace-write', approvalPolicy: 'on-request' },
      teammates: () => [{ threadId: 'another-task', name: 'Existing work', by: { name: 'Bob' }, files: [{ path: 'keep.txt', ts: Date.now() }] }],
      emit: event => events.push(event), onApprovalSettled: () => session.interrupt() });
    const result = action === 'write' ? session.writeFile('keep.txt', 'must not replace') : session.removePath('keep.txt');
    const request = events.find(event => event.requestId);
    assert.ok(request, action + ' reaches a real policy approval');
    session.resolveApproval(request.requestId, 'accept', { userId: 'alice' },
      { turnId: request.turnId, fingerprint: request.fingerprint });
    assert.equal((await result).item.status, 'declined');
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'original');
    assert.equal((await session.writeFile('later.txt', 'ignored')).item.status, 'declined');
    assert.equal((await session.removePath('keep.txt')).item.status, 'declined');
    assert.equal(fs.existsSync(path.join(dir, 'later.txt')), false);
  }
});
