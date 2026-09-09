// Unit tests: policy engine, Codex exec JSONL translator, line diff, hub store.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decideCommand, decideFileWrite, PRESETS } = require('../packages/runtime/policy');
const { translate, sandboxFlags, buildArgs } = require('../packages/runtime/codex-exec');
const codexProbe = require('../packages/runtime/codex-probe');
const { Hub } = require('../packages/hub/server');
const { lineDiff } = require('../packages/runtime/diff');
const cc = require('../packages/runtime/claude-code');
const { HubStore } = require('../packages/hub/store');
const { Events } = require('../packages/protocol');
const desktop = require('../apps/desktop/lifecycle');

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
  assert.deepEqual(sandboxFlags('workspace-write'), ['--sandbox', 'workspace-write']);
  assert.deepEqual(sandboxFlags('danger-full-access'), ['--dangerously-bypass-approvals-and-sandbox']);
});

t('claude code: stream-json translates to protocol events', () => {
  const state = { cwd: '/w', tools: new Map(), n: 0, usage: null, error: null };
  assert.deepEqual(cc.translate({ type: 'system', subtype: 'init', session_id: 'cs_1' }, state), []);
  assert.equal(state.sessionId, 'cs_1');
  const a1 = cc.translate({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Looking…' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: '/w/src/a.js', content: 'x' } }, { type: 'tool_use', id: 'tu3', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }] } }] } }, state);
  assert.deepEqual(a1.map((e) => e.method), [Events.ITEM_STARTED, Events.ITEM_COMPLETED, Events.ITEM_STARTED, Events.ITEM_COMPLETED, Events.ITEM_STARTED, Events.ITEM_STARTED, Events.TURN_PLAN_UPDATED]);
  assert.equal(a1[0].item.type, 'reasoning'); assert.equal(a1[2].item.type, 'agentMessage');
  assert.equal(a1[4].item.type, 'commandExecution'); assert.equal(a1[4].item.command, 'npm test');
  assert.equal(a1[5].item.type, 'fileChange'); assert.equal(a1[5].item.changes[0].path, 'src/a.js');
  assert.deepEqual(a1[6].plan.map((p) => p.status), ['inProgress', 'pending']);
  const r1 = cc.translate({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok\n1 passing' }, { type: 'tool_result', tool_use_id: 'tu2', content: 'File written' }] } }, state);
  assert.equal(r1[0].item.status, 'completed'); assert.equal(r1[0].item.aggregatedOutput, 'ok\n1 passing'); assert.equal(r1[0].item.exitCode, 0);
  assert.equal(r1[1].item.type, 'fileChange'); assert.equal(r1[1].item.status, 'completed');
  cc.translate({ type: 'result', subtype: 'success', session_id: 'cs_1', usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 } }, state);
  assert.deepEqual(state.usage, { input: 150, output: 20 });
  cc.translate({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'max turns' }, state);
  assert.equal(state.error, 'max turns');
  assert.deepEqual(cc.permissionFlags('read-only'), ['--permission-mode', 'plan']);
  assert.deepEqual(cc.permissionFlags('danger-full-access'), ['--dangerously-skip-permissions']);
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

t('codex exec: buildArgs pins the workspace and resumes an existing session in order', () => {
  const fresh = buildArgs({ prompt: 'go', cwd: '/w', sandboxPolicy: 'workspace-write', model: 'gpt-5.4-mini' });
  assert.deepEqual(fresh, ['exec', '--json', '--skip-git-repo-check', '-C', '/w', '--sandbox', 'workspace-write', '-m', 'gpt-5.4-mini', 'go']);
  const resumed = buildArgs({ prompt: 'more', cwd: '/w', sandboxPolicy: 'read-only', sessionId: 'sess-1' });
  // `codex exec resume` rejects --cd and --sandbox outright: the session carries both.
  assert.deepEqual(resumed, ['exec', 'resume', '--json', '--skip-git-repo-check', 'sess-1', 'more']);
  assert.ok(!resumed.includes('-C') && !resumed.includes('--sandbox'));
});

t('codex probe: resolves a runnable command shape, or a blocker that says what to do', () => {
  const missing = codexProbe.resolveCodex('definitely-not-a-real-binary-xyz');
  assert.equal(missing.ok, false);
  const p = codexProbe.probe({ bin: 'definitely-not-a-real-binary-xyz' });
  assert.ok(p.blockers.length);
  assert.ok(p.blockers.every((b) => b.detail && b.alternative), 'every blocker carries an alternative');
  const real = codexProbe.resolveCodex();
  if (real.ok) assert.ok(Array.isArray(real.prefix) && real.bin, 'a resolved codex is [bin, ...prefix, ...args]');
});

t('hub: the command log evicts settled entries and never a command still in flight', () => {
  const hub = new Hub({ dbFile: ':memory:', log: () => {} });
  for (let i = 0; i < 5; i++) hub.commandLog.set('u/done' + i, { state: 'done', waiters: new Set() });
  hub.commandLog.set('u/pending', { state: 'pending', waiters: new Set() });
  hub.pruneCommandLog(2);
  assert.ok(hub.commandLog.has('u/pending'), 'the in-flight command survived pruning');
  assert.ok(hub.commandLog.size <= 3);
  hub.store.close();
});

t('hub: retries survive client disconnect and cannot change their target or payload', () => {
  const hub = new Hub({ dbFile: ':memory:', log: () => {} });
  const sent = [];
  const socket = () => ({ readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) });
  const runtimeWs = socket(), first = socket(), retry = socket();
  const ctx = { user: { id: 'u', name: 'alice' }, role: 'client', subs: new Set() };
  hub.store.runtimePairing = () => ({ teamId: 'team' });
  hub.store.membership = () => true;
  hub.store.isApprover = () => false;
  hub.runtimes.set('runtime', runtimeWs);
  const msg = { id: 'retry-id', runtimeId: 'runtime', command: { method: 'thread/start' } };
  hub.onCommand(first, ctx, msg);
  hub.onClose(first, ctx);
  hub.onCommand(retry, ctx, msg);
  assert.equal(sent.filter((m) => m.type === 'command').length, 1);
  assert.throws(() => hub.onCommand(retry, ctx, { ...msg, command: { method: 'thread/delete' } }), /different input/);
  assert.throws(() => hub.onCommand(retry, { ...ctx, user: { id: 'other' } }, msg));
  hub.handleMessage(runtimeWs, { role: 'runtime', user: {}, teamId: 'team', runtimeId: 'runtime' },
    { type: 'command.result', id: msg.id, ok: true, result: { value: 1 } });
  hub.onCommand(retry, ctx, msg);
  assert.equal(sent.at(-1).duplicate, true);
  assert.equal(sent.filter((m) => m.type === 'command').length, 1);
  hub.store.close();
});

t('hub: runtime disconnect settles retries without dispatching the action again', () => {
  const hub = new Hub({ dbFile: ':memory:', log: () => {} });
  const runtimeWs = { readyState: 1 }, received = [];
  const client = { readyState: 1, send: (raw) => received.push(JSON.parse(raw)) };
  const entry = { state: 'pending', waiters: new Set([client]), runtimeWs };
  hub.pendingCommands.set('uncertain', entry);
  hub.commandLog.set('u/uncertain', entry);
  hub.onClose(runtimeWs, { subs: new Set() });
  assert.equal(entry.state, 'done');
  assert.match(entry.result.error, /outcome may be unknown/);
  assert.equal(received.length, 1);
  assert.equal(hub.pendingCommands.size, 0);
  hub.store.close();
});

t('hub: a host that is quit still leaves anything it could not finish as unknown', () => {
  // #18 made an explicit quit report `interrupted`, which is honest because the host is still
  // there to say so. The risk is that it blurs #17's line: a host that goes away without
  // accounting for its work must still leave `unknown`, whether or not it said goodbye first.
  const hub = new Hub({ dbFile: ':memory:', log: () => {} });
  hub.store.upsertThread({ id: 'thr', orgId: 'team', runtimeId: 'rt', status: { type: 'active', activeFlags: [] }, activeTurnId: 'turn_1', pendingApproval: { requestId: 'req_1' } });
  const before = hub.store.eventsFrom('thr', 0).length;
  hub.markRunningThreadsUnknown('rt', 'team');
  const after = hub.store.getThread('thr');
  assert.equal(after.status.type, 'unknown');
  assert.equal(after.status.wasRunning, 'turn_1', 'and it names the turn it cannot account for');
  assert.equal(after.pendingApproval, null, 'an approval nobody can answer is withdrawn');
  // The important negative: no outcome was invented for the turn on the way past.
  assert.equal(hub.store.eventsFrom('thr', 0).length, before, 'no turn/completed and no turn/abandoned');
  hub.store.close();
});

t('desktop: closing a window only ends the session when there is no way back', () => {
  assert.equal(desktop.shouldQuitOnWindowClose({ hasTray: true }), false);
  // Without a tray icon there is nothing to reopen from, so hiding would strand the app with
  // no window and no way to reach it. On a desktop without one, close means close.
  assert.equal(desktop.shouldQuitOnWindowClose({ hasTray: false }), true);
});

t('desktop: the quit warning names the work it would end, and defaults to not doing it', () => {
  const idle = desktop.quitPlan({ activeTasks: 0 });
  assert.equal(idle.confirm, false);
  assert.match(idle.detail, /unavailable until you start Plexus again/);
  const one = desktop.quitPlan({ activeTasks: 1, activeTaskNames: ['Fix the flaky test'], blocked: 1 });
  assert.equal(one.confirm, true);
  assert.match(one.message, /One task is running/);
  assert.match(one.detail, /Fix the flaky test/);
  assert.match(one.detail, /teammate is waiting on an approval/);
  assert.match(one.detail, /interrupted rather than finished/);
  assert.match(one.detail, /Closing the window instead/);
  assert.deepEqual(one.buttons, ['Quit anyway', 'Keep running']);
  const many = desktop.quitPlan({ activeTasks: 5, activeTaskNames: ['a', 'b', 'c', 'd', 'e'] });
  assert.match(many.detail, /and others/, 'a long list is summarised, not silently truncated');
});

t('desktop: the tray says whether the host is up and what it is doing', () => {
  const closed = desktop.trayState({ runtimeRunning: true, activeTasks: 2, windowOpen: false });
  assert.match(closed.tooltip, /2 tasks running/);
  assert.match(closed.detail, /window is closed/);
  const open = desktop.trayState({ runtimeRunning: true, activeTasks: 0, windowOpen: true });
  assert.match(open.tooltip, /idle/);
  assert.equal(open.detail, null, 'with the window open there is nothing to explain');
  assert.match(desktop.trayState({ runtimeRunning: false }).tooltip, /stopped/);
});

t('desktop: reopening a window never starts a second host', () => {
  assert.equal(desktop.shouldLaunchRuntime(null), true);
  assert.equal(desktop.shouldLaunchRuntime({ exitCode: null, signalCode: null }), false);
  assert.equal(desktop.shouldLaunchRuntime({ exitCode: 1, signalCode: null }), true);
  assert.equal(desktop.shouldLaunchRuntime({ exitCode: null, signalCode: 'SIGKILL' }), true);
});

t('desktop: stopping a service reaches its children, per platform', () => {
  // Killing the parent leaves a provider CLI still running and a workspace still being written
  // to, so the sweep has to reach the tree. There is no portable way to say that.
  assert.deepEqual(desktop.killTreeCommand(4321, 'win32'), { file: 'taskkill', args: ['/pid', '4321', '/T', '/F'] });
  assert.deepEqual(desktop.killTreeCommand(4321, 'darwin'), { file: 'kill', args: ['-TERM', '-4321'] });
  assert.equal(desktop.killTreeCommand(0, 'win32'), null);
  assert.equal(desktop.killTreeCommand(-1, 'linux'), null);
});

t('desktop: a service is asked to stop over its own channel, and only while it has one', () => {
  const sent = [];
  assert.equal(desktop.requestShutdown({ pid: 1, connected: true, exitCode: null, send: (m) => sent.push(m) }), true);
  assert.deepEqual(sent, [{ type: 'shutdown', reason: 'quit' }]);
  // Windows cannot deliver a signal a child can act on, so this message is the only polite
  // stop that exists on every platform this ships to. A child with no channel left gets no
  // message and has to be taken by force instead.
  assert.equal(desktop.requestShutdown({ pid: 2, connected: false, exitCode: null, send: () => sent.push('never') }), false);
  assert.equal(desktop.requestShutdown(null), false);
  assert.equal(sent.length, 1);
});

t('desktop: restored setup carries no way to replay work', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-state-')), 'desktop-state.json');
  desktop.saveState(file, { hubUrl: 'http://127.0.0.1:7777', userName: 'dana', bounds: { x: 1, y: 2, width: 800, height: 600 } });
  // A caller that tries to stash a task, a turn or a command gets none of it back. The
  // allowlist is the guarantee - not the discipline of whoever writes the next feature.
  desktop.saveState(file, { threadId: 'thr_1', pendingCommand: { method: 'turn/start' } });
  assert.deepEqual(Object.keys(desktop.loadState(file)).sort(), ['bounds', 'hubUrl', 'userName']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).threadId, undefined);
  assert.deepEqual(desktop.loadState(file + '.missing'), {}, 'a first launch with no state still starts');
});

console.log(`\n${n} unit tests passed ✅`);
