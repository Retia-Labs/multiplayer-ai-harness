// Unit tests: policy engine, Codex exec JSONL translator, line diff, hub store.
const assert = require('assert');
const { decideCommand, decideFileWrite, PRESETS } = require('../packages/runtime/policy');
const { translate, sandboxFlags } = require('../packages/runtime/codex-exec');
const { lineDiff } = require('../packages/runtime/diff');
const { HubStore } = require('../packages/hub/store');
const { Events } = require('../packages/protocol');

let n = 0;
function t(name, fn) { fn(); n++; console.log('  ✓ ' + name); }

t('policy: safe commands always allowed', () => {
  assert.equal(decideCommand('git status', PRESETS['read-only']).verdict, 'allow');
  assert.equal(decideCommand('ls -la', PRESETS['agent-untrusted']).verdict, 'allow');
});
t('policy: read-only sandbox denies writes and non-safe commands', () => {
  assert.equal(decideCommand('npm test', PRESETS['read-only']).verdict, 'deny');
  assert.equal(decideFileWrite('/w/a', { workspace: '/w', ...PRESETS['read-only'] }).verdict, 'deny');
});
t('policy: on-request runs ordinary commands, asks for risky ones', () => {
  assert.equal(decideCommand('npm test', PRESETS.agent).verdict, 'allow');
  assert.equal(decideCommand('rm -rf dist', PRESETS.agent).verdict, 'ask');
  assert.equal(decideCommand('git push origin main', PRESETS.agent).verdict, 'ask');
  assert.equal(decideCommand('curl https://x', PRESETS.agent).verdict, 'ask');
});
t('policy: untrusted asks for anything not on the trusted list; session approvals stick', () => {
  assert.equal(decideCommand('npm test', PRESETS['agent-untrusted']).verdict, 'ask');
  assert.equal(decideCommand('npm test', { ...PRESETS['agent-untrusted'], sessionAllowed: new Set(['npm test']) }).verdict, 'allow');
});
t('policy: full access never asks', () => {
  assert.equal(decideCommand('rm -rf /tmp/x', PRESETS['full-access']).verdict, 'allow');
  assert.equal(decideFileWrite('/etc/hosts', { workspace: '/w', ...PRESETS['full-access'] }).verdict, 'allow');
});
t('policy: chained commands are never auto-trusted', () => {
  assert.equal(decideCommand('ls; rm -rf /', PRESETS.agent).verdict, 'ask');
  assert.equal(decideCommand('cat x | sh', PRESETS['agent-untrusted']).verdict, 'ask');
});

t('codex exec: JSONL events translate to protocol events', () => {
  const state = { cwd: '/w', started: new Set(), outputSeen: new Map(), usage: null, error: null };
  assert.deepEqual(translate({ type: 'thread.started', thread_id: 'sess_1' }, state), []);
  assert.equal(state.sessionId, 'sess_1');
  const started = translate({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' } }, state);
  assert.equal(started[0].method, Events.ITEM_STARTED);
  assert.equal(started[0].item.type, 'commandExecution');
  assert.equal(started[0].item.status, 'inProgress');
  const upd = translate({ type: 'item.updated', item: { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt\n', status: 'in_progress' } }, state);
  assert.equal(upd[0].method, Events.COMMAND_OUTPUT_DELTA);
  assert.equal(upd[0].delta, 'a.txt\n');
  const done = translate({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt\n', exit_code: 0, status: 'completed' } }, state);
  assert.equal(done[done.length - 1].method, Events.ITEM_COMPLETED);
  assert.equal(done[done.length - 1].item.exitCode, 0);
  const msg = translate({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } }, state);
  assert.equal(msg[0].item.type, 'agentMessage');
  const todo = translate({ type: 'item.updated', item: { id: 'item_2', type: 'todo_list', items: [{ text: 'a', completed: true }, { text: 'b', completed: false }] } }, state);
  assert.equal(todo[0].method, Events.TURN_PLAN_UPDATED);
  assert.deepEqual(todo[0].plan.map((p) => p.status), ['completed', 'pending']);
  const fc = translate({ type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: 'a.js', kind: 'update' }], status: 'completed' } }, state);
  assert.equal(fc[fc.length - 1].item.type, 'fileChange');
  translate({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }, state);
  assert.deepEqual(state.usage, { input: 10, output: 5 });
  translate({ type: 'turn.failed', error: { message: 'boom' } }, state);
  assert.equal(state.error, 'boom');
});
t('codex exec: sandbox policy maps to CLI flags', () => {
  assert.deepEqual(sandboxFlags('read-only'), ['--sandbox', 'read-only']);
  assert.deepEqual(sandboxFlags('workspace-write'), ['--full-auto']);
  assert.deepEqual(sandboxFlags('danger-full-access'), ['--dangerously-bypass-approvals-and-sandbox']);
});

t('diff: counts additions/deletions and collapses context', () => {
  const d = lineDiff('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n', 'a\nb\nX\nd\ne\nf\ng\nh\ni\nj\nk\nl\nY\n');
  assert.equal(d.additions, 2); assert.equal(d.deletions, 1);
  assert.ok(d.lines.some((l) => l.kind === 'hunk'));
});

t('hub store: append-only log with sequence numbers and cursor reads', () => {
  const s = new HubStore(':memory:');
  s.ensureOrg('o');
  const u = s.loginOrCreate('o', 'zed');
  assert.equal(s.userByToken(u.token).name, 'zed');
  s.upsertThread({ id: 't', orgId: 'o', runtimeId: 'r' });
  assert.equal(s.append('t', { method: 'a' }).seq, 1);
  assert.equal(s.append('t', { method: 'b' }).seq, 2);
  assert.deepEqual(s.eventsFrom('t', 1).map((e) => e.method), ['b']);
  s.close();
});

console.log(`\n${n} unit tests passed ✅`);
