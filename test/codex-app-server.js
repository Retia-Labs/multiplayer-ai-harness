'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexRpc, providerFailure } = require('../packages/runtime/codex-rpc');
const { CodexAppServerBackend, ConfinedCodexAppServerBackend, HostToolsCodexAppServerBackend, mapItem } = require('../packages/runtime/codex-app-server');
const { PROFILE_CONFIG, PROFILE_TOML, prepareHostProfile } = require('../packages/runtime/codex-host-profile');
const { TurnSession } = require('../packages/runtime/session');
const { Events } = require('../packages/protocol');

const tick = () => new Promise((resolve) => setImmediate(resolve));
class Provider extends EventEmitter {
  constructor(handle = () => {}) {
    super();
    this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.sent = []; this.pid = 123;
    this.stdin = new Writable({ write: (frame, _, done) => {
      const msg = JSON.parse(frame.toString()); this.sent.push(msg);
      queueMicrotask(() => handle(msg, this)); done();
    } });
  }
  send(msg) { this.stdout.write(JSON.stringify(msg) + '\n'); }
  answer(msg, result) { this.send({ id: msg.id, result }); }
  kill(signal = 'SIGTERM') { this.killed = true; this.signals ||= []; this.signals.push(signal); this.emit('close', 0); }
}
const scope = { threadId: 'provider-thread', turnId: 'provider-turn' };
function event(child, method, params) { child.send({ method, params: { ...scope, ...params } }); }
function terminal(child, status = 'completed', error) {
  event(child, Events.TURN_COMPLETED, { turn: { id: scope.turnId, status, error } });
}
function setup(onTurn = (c) => terminal(c), options = {}) {
  const child = new Provider((msg, c) => {
    if (options.onRpc?.(msg, c)) return;
    if (msg.method === 'initialize') c.answer(msg, { userAgent: 'fixture' });
    if (msg.method === 'thread/resume') c.answer(msg, { thread: { id: msg.params.threadId } });
    if (msg.method === 'turn/interrupt') { c.answer(msg, {}); terminal(c, 'interrupted'); }
    if (msg.method === 'thread/start') c.answer(msg, { thread: { id: scope.threadId } });
    if (msg.method === 'turn/start') { c.answer(msg, { turn: { id: scope.turnId } }); onTurn(c, msg); }
  });
  const session = { cwd: process.cwd(), thread: { id: 'product-task' }, turnId: 'product-turn',
    input: [{ type: 'text', text: 'Implement a feature' }], settings: { sandboxPolicy: 'read-only', approvalPolicy: 'on-request' },
    abort: new AbortController(), pendingApprovals: new Map(), steerQueue: [], events: [],
    emit(method, payload) { this.events.push({ method, ...payload }); }, async requestApproval() { return 'decline'; } };
  const backend = new CodexAppServerBackend({ bin: process.execPath, spawnProcess: () => child,
    requestTimeoutMs: 100, turnTimeoutMs: 100, ...options });
  return { child, session, backend, run: () => backend.run(session) };
}

test('handshake, sandbox schema, matching completion and separate product identifiers', async () => {
  const f = setup((c) => {
    event(c, Events.AGENT_MESSAGE_DELTA, { itemId: 'answer', delta: 'hello' });
    terminal(c);
  });
  await f.run();
  assert.deepEqual(f.child.sent.map((m) => m.method), ['initialize', 'initialized', 'thread/start', 'turn/start']);
  assert.equal(f.child.sent[2].params.sandbox, 'read-only');
  assert.equal(f.child.sent[2].params.sandboxPolicy, undefined);
  assert.equal(f.session.thread.id, 'product-task'); assert.equal(f.session.turnId, 'product-turn');
  assert.equal(f.session.providerSessionId, scope.threadId); assert.equal(f.session.providerTurnId, scope.turnId);
  assert.equal(f.session.events[0].delta, 'hello'); assert.equal(f.session.child, null); assert.ok(f.child.killed);
});
test('completion before turn/start response is retained until the acknowledged turn is known', async () => {
  const f = setup();
  f.child.stdin = new Writable({ write(frame, _, done) {
    const m = JSON.parse(frame); f.child.sent.push(m);
    queueMicrotask(() => {
      if (m.method === 'initialize') f.child.answer(m, {});
      if (m.method === 'thread/start') f.child.answer(m, { thread: { id: scope.threadId } });
      if (m.method === 'turn/start') { terminal(f.child); f.child.answer(m, { turn: { id: scope.turnId } }); }
    }); done();
  } });
  await f.run();
});
test('a foreign thread or stale turn cannot report success or emit task content', async () => {
  const f = setup((c) => {
    event(c, Events.AGENT_MESSAGE_DELTA, { threadId: 'foreign', itemId: 'bad', delta: 'wrong' });
    event(c, Events.TURN_COMPLETED, { turn: { id: 'stale', status: 'completed' } });
  });
  await assert.rejects(f.run(), /codex_turn_timeout/);
  assert.deepEqual(f.session.events, []);
});
test('terminal failures and interruption are not successful turns', async () => {
  for (const [status, error, code] of [['failed', { message: 'SECRET', codexErrorInfo: 'usageLimitExceeded' }, 'codex_usage_limit'],
    ['failed', { message: 'SECRET' }, 'codex_request_failed'], ['interrupted', null, 'codex_interrupted']]) {
    const f = setup((c) => terminal(c, status, error));
    await assert.rejects(f.run(), { message: code }); assert.ok(f.child.killed);
  }
});
test('exit without a terminal event fails and clears the child', async () => {
  const f = setup((c) => setImmediate(() => c.kill()));
  await assert.rejects(f.run(), /codex_disconnected/); assert.equal(f.session.child, null);
});
test('startup request timeout and pre-start cancellation both terminate the process', async () => {
  const f = setup(); f.child.stdin = new Writable({ write(_, __, done) { done(); } });
  await assert.rejects(f.run(), /codex_request_timeout/); assert.ok(f.child.killed);
  const cancelled = setup(); cancelled.session.abort.abort();
  await assert.rejects(cancelled.run(), /codex_interrupted/); assert.equal(cancelled.child.sent.length, 0);
});
test('cancellation while running rejects promptly', async () => {
  const f = setup(() => setImmediate(() => f.session.abort.abort()));
  await assert.rejects(f.run(), /codex_interrupted/); assert.ok(f.child.killed);
});
test('one scoped approval per provider request; session-wide permission is declined', async () => {
  const f = setup((c) => {
    const msg = { id: 90, method: Events.COMMAND_REQUEST_APPROVAL, params: { ...scope, itemId: 'tool', command: 'fixture' } };
    c.send(msg); c.send(msg);
  });
  let approvals = 0;
  f.session.requestApproval = async () => { approvals++; setImmediate(() => terminal(f.child)); return 'acceptForSession'; };
  await f.run();
  assert.equal(approvals, 1);
  assert.deepEqual(f.child.sent.filter((m) => m.id === 90), [{ id: 90, result: { decision: 'decline' } }]);
});
test('unknown requests and approvals for another task are explicitly refused', async () => {
  const f = setup((c) => {
    c.send({ id: 91, method: 'account/login/start', params: scope });
    c.send({ id: 92, method: Events.COMMAND_REQUEST_APPROVAL, params: { ...scope, threadId: 'foreign' } });
    setImmediate(() => terminal(c));
  });
  f.session.requestApproval = () => { assert.fail('unscoped approval'); };
  await f.run();
  for (const id of [91, 92]) assert.equal(f.child.sent.find((m) => m.id === id).error.code, -32601);
});
test('invalid settings or unsupported input never spawn a provider', async () => {
  for (const change of [(s) => { s.settings.sandboxPolicy = 'typo'; }, (s) => { s.settings.approvalPolicy = 'typo'; },
    (s) => { s.input = [{ type: 'image', url: 'private' }]; }]) {
    const f = setup(); let spawns = 0; f.backend.spawnProcess = () => { spawns++; return f.child; }; change(f.session);
    await assert.rejects(f.run(), /codex_(policy_invalid|input_unsupported)/); assert.equal(spawns, 0);
  }
});
test('real subprocess exit rejects outstanding RPC instead of hanging', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = new CodexRpc(child, { timeoutMs: 5000 });
  try { await assert.rejects(rpc.call('initialize', {}), /codex_disconnected/); assert.equal(rpc.pending.size, 0); }
  finally { rpc.close(); }
});
test('UTF-8 split across pipe chunks is preserved, including multiple frames', async () => {
  const child = new Provider(); const seen = []; const rpc = new CodexRpc(child, { onNotification: (m) => seen.push(m.params) });
  const frame = Buffer.from(JSON.stringify({ method: 'delta', params: 'hello 🌍' }) + '\n');
  const split = frame.indexOf(Buffer.from('🌍')) + 1;
  child.stdout.write(frame.subarray(0, split)); child.stdout.write(frame.subarray(split));
  child.stdout.write('{"method":"delta","params":"two"}\n{"method":"delta","params":"three"}\n');
  assert.deepEqual(seen, ['hello 🌍', 'two', 'three']); rpc.close();
});
test('malformed and oversized frames fail outstanding requests without reflecting content', async () => {
  for (const frame of ['SECRET\n', '[]\n', 'x'.repeat(300)]) {
    const child = new Provider(); const rpc = new CodexRpc(child, { maxFrameBytes: 256 });
    const call = rpc.call('initialize', {}); child.stdout.write(frame);
    await assert.rejects(call, /codex_(protocol_invalid|frame_too_large)/); assert.equal(rpc.pending.size, 0); rpc.close();
  }
});
test('request errors, stderr and error items cannot echo provider credentials', async () => {
  const child = new Provider((m, c) => c.send({ id: m.id, error: { code: -32602, message: 'SECRET credential' } }));
  const rpc = new CodexRpc(child);
  child.stderr.write('SECRET credential');
  await assert.rejects(rpc.call('thread/start', {}), { message: 'codex_protocol_unsupported' });
  assert.ok(!JSON.stringify(mapItem({ id: 'e', type: 'error', message: 'SECRET' })).includes('SECRET'));
  assert.equal(providerFailure({ message: 'SECRET' }).message, 'codex_request_failed'); rpc.close();
});
test('write failure and child spawn error reject every outstanding call', async () => {
  for (const streamError of [true, false]) {
    const child = new Provider(); const rpc = new CodexRpc(child);
    const a = rpc.call('one', {}); const b = rpc.call('two', {});
    (streamError ? child.stdin : child).emit('error', new Error('SECRET'));
    for (const promise of [a, b]) await assert.rejects(promise, /codex_(disconnected|unavailable)/);
    assert.equal(rpc.pending.size, 0); rpc.close();
  }
  await tick();
});

test('one bounded file approval is accepted and pending approvals settle on provider loss', async () => {
  const f = setup((c) => {
    event(c, Events.ITEM_STARTED, { item: { id: 'patch', type: 'fileChange', status: 'inProgress', changes: [{ path: 'x.txt', kind: { type: 'add' }, diff: '+new text' }] } });
    c.send({ id: 93, method: Events.FILECHANGE_REQUEST_APPROVAL, params: { ...scope, itemId: 'patch', changes: [] } });
  });
  f.session.requestApproval = async () => { setImmediate(() => terminal(f.child)); return 'accept'; };
  await f.run();
  assert.deepEqual(f.child.sent.find((m) => m.id === 93).result, { decision: 'accept' });
  const lost = setup((c) => {
    c.send({ id: 94, method: Events.COMMAND_REQUEST_APPROVAL, params: { ...scope, itemId: 'tool', command: 'fixture' } });
  });
  let decision;
  lost.session.requestApproval = () => new Promise((resolve) => {
    lost.session.pendingApprovals.set('local-approval', (value) => { decision = value; resolve(value); });
    setImmediate(() => lost.child.kill());
  });
  await assert.rejects(lost.run(), /codex_disconnected/);
  assert.equal(decision, 'cancel'); assert.equal(lost.session.pendingApprovals.size, 0);
});
test('invalid terminal statuses and notification handler failures cannot become success', async () => {
  const f = setup((c) => terminal(c, 'unknown'));
  await assert.rejects(f.run(), /codex_protocol_invalid/);
  const broken = setup((c) => event(c, Events.AGENT_MESSAGE_DELTA, { itemId: 'msg', delta: 'text' }));
  broken.session.emit = () => { throw new Error('PRIVATE error'); };
  await assert.rejects(broken.run(), { message: 'codex_protocol_invalid' });
});
test('production provider gate remains closed for both CLI adapters', () => {
  const { Runtime } = require('../packages/runtime');
  for (const id of ['codex-cli', 'codex-app-server']) {
    assert.throws(() => Runtime.prototype.provider.call({}, id), /project-confined reads and writes are proven/);
  }
});

test('a host without Codex still has reportable platform metadata and a concrete blocker', () => {
  const { probe } = require('../packages/runtime/codex-probe');
  const result = probe({ bin: 'plexus-intentionally-missing-codex-executable' });
  assert.equal(result.platform.os, process.platform);
  assert.equal(result.platform.node, process.version);
  assert.equal(result.auth, null);
  assert.equal(result.blockers[0].id, 'codex-not-found');
});

const until = async read => {
  for (let n = 0; n < 300; n++) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail('provider fixture did not reach expected state');
};
const direction = (seq, text = 'Keep this change small') => ({ seq, input: [{ type: 'text', text }], by: { userId: 'teammate', name: 'Teammate' } });

test('inline steer uses expected provider turn and waits for its matching acknowledgment', async () => {
  let request;
  const f = setup(() => {}, { turnTimeoutMs: 1000, onRpc: msg => {
    if (msg.method === 'turn/steer') { request = msg; return true; }
  } });
  const run = f.run(); await until(() => f.session.providerTurnId);
  const entry = direction(1); f.session.steerQueue.push(entry); f.session.providerControl.steer(entry);
  await until(() => request);
  assert.deepEqual(request.params, { threadId: scope.threadId, expectedTurnId: scope.turnId,
    input: entry.input, clientUserMessageId: 'plexus:product-turn:1' });
  assert.equal(f.session.events.some(event => event.method === Events.TURN_STEER_DELIVERED), false);
  assert.equal(f.session.steerQueue.length, 1);
  f.child.answer(request, { turnId: scope.turnId }); await tick(); terminal(f.child); await run;
  assert.deepEqual(f.session.events.find(event => event.method === Events.TURN_STEER_DELIVERED), {
    method: Events.TURN_STEER_DELIVERED, steerSeq: 1, by: entry.by });
  assert.equal(f.session.steerQueue.length, 0); assert.equal(f.session.thread.id, 'product-task');
});

test('steers are serialized and repeated command identity is not sent twice', async () => {
  const sent = [];
  const f = setup(() => {}, { turnTimeoutMs: 1000, onRpc: (msg, child) => {
    if (msg.method !== 'turn/steer') return false;
    sent.push(msg); child.answer(msg, { turnId: scope.turnId });
    if (sent.length === 2) setImmediate(() => terminal(child));
    return true;
  } });
  const run = f.run(); await until(() => f.session.providerTurnId);
  const first = direction(1), second = direction(2, 'Then run the test');
  f.session.steerQueue.push(first, second);
  f.session.providerControl.steer(first); f.session.providerControl.steer(first); f.session.providerControl.steer(second);
  await run;
  assert.deepEqual(sent.map(msg => msg.params.clientUserMessageId), ['plexus:product-turn:1', 'plexus:product-turn:2']);
  assert.deepEqual(f.session.events.filter(event => event.method === Events.TURN_STEER_DELIVERED).map(event => event.steerSeq), [1, 2]);
});

test('a stale steer acknowledgment never becomes delivered or starts another provider turn', async () => {
  const f = setup(() => {}, { onRpc: (msg, child) => {
    if (msg.method === 'turn/steer') { child.answer(msg, { turnId: 'different-turn' }); return true; }
  } });
  const run = f.run(); const rejected = assert.rejects(run, /codex_stale_turn/); await until(() => f.session.providerTurnId);
  const entry = direction(1); f.session.steerQueue.push(entry); f.session.providerControl.steer(entry); await rejected;
  assert.equal(f.session.events.some(event => event.method === Events.TURN_STEER_DELIVERED), false);
  assert.equal(f.child.sent.filter(msg => msg.method === 'turn/start').length, 1);
  assert.equal(f.session.steerQueue.length, 1);
});

test('explicit thread/resume acknowledges the saved provider identity and retains product identity', async () => {
  const f = setup(); f.session.thread.codexAppServerThreadId = scope.threadId;
  await f.run();
  const resume = f.child.sent.find(msg => msg.method === 'thread/resume');
  assert.deepEqual(resume.params, { threadId: scope.threadId, cwd: process.cwd(), approvalPolicy: 'on-request', sandbox: 'read-only' });
  assert.equal(f.child.sent.some(msg => msg.method === 'thread/start'), false);
  assert.equal(f.session.providerResume.state, 'acknowledged');
  assert.equal(f.session.thread.id, 'product-task'); assert.equal(f.session.turnId, 'product-turn');
});

test('a mismatched resume response fails before any turn starts, without changing the saved handle', async () => {
  const f = setup(undefined, { onRpc: (msg, child) => {
    if (msg.method === 'thread/resume') { child.answer(msg, { thread: { id: 'another-thread' } }); return true; }
  } });
  f.session.thread.codexAppServerThreadId = scope.threadId;
  await assert.rejects(f.run(), /codex_protocol_invalid/);
  assert.equal(f.child.sent.some(msg => msg.method === 'turn/start'), false);
  assert.equal(f.session.thread.codexAppServerThreadId, scope.threadId);
});

test('interrupt acknowledgment is separate from matching terminal confirmation', async () => {
  let request;
  const f = setup(() => {}, { turnTimeoutMs: 1000, interruptTimeoutMs: 1000, onRpc: msg => {
    if (msg.method === 'turn/interrupt') { request = msg; return true; }
  } });
  const run = f.run(); const rejected = assert.rejects(run, /codex_interrupted/); await until(() => f.session.providerTurnId);
  f.session.abort.abort(); await until(() => request);
  assert.deepEqual(request.params, scope); assert.equal(f.session.providerInterrupt.state, 'requested');
  assert.equal(f.child.killed, undefined);
  f.child.answer(request, {}); await tick();
  assert.equal(f.session.providerInterrupt.state, 'acknowledged'); assert.equal(f.child.killed, undefined);
  terminal(f.child, 'interrupted'); await rejected;
  assert.equal(f.session.providerInterrupt.state, 'confirmed');
  assert.equal(f.child.signals.includes('SIGKILL'), false);
});

test('acknowledged interruption without a matching terminal event forces a bounded shutdown', async () => {
  const f = setup(() => {}, { turnTimeoutMs: 1000, interruptTimeoutMs: 15, onRpc: (msg, child) => {
    if (msg.method === 'turn/interrupt') { child.answer(msg, {}); return true; }
  } });
  const run = f.run(); const rejected = assert.rejects(run, /codex_interrupt_timeout/); await until(() => f.session.providerTurnId);
  f.session.abort.abort(); await rejected;
  assert.equal(f.session.providerInterrupt.state, 'forced'); assert.ok(f.child.signals.includes('SIGKILL'));
});

test('missing file patch, broad root grant and missing command are declined without prompting', async () => {
  const f = setup(child => {
    child.send({ id: 201, method: Events.FILECHANGE_REQUEST_APPROVAL, params: { ...scope, itemId: 'unseen' } });
    child.send({ id: 202, method: Events.FILECHANGE_REQUEST_APPROVAL, params: { ...scope, itemId: 'patch', grantRoot: '/outside' } });
    child.send({ id: 203, method: Events.COMMAND_REQUEST_APPROVAL, params: { ...scope, itemId: 'no-command' } });
    setImmediate(() => terminal(child));
  });
  f.session.requestApproval = () => assert.fail('unbounded request reached human approval');
  await f.run();
  for (const id of [201, 202, 203]) assert.deepEqual(f.child.sent.find(msg => msg.id === id).result, { decision: 'decline' });
});

test('a file action changed after the prompt cannot use its earlier acceptance', async () => {
  const item = { id: 'patch', type: 'fileChange', status: 'inProgress', changes: [{ path: 'x.txt', kind: { type: 'add' }, diff: '+first' }] };
  const f = setup(child => {
    event(child, Events.ITEM_STARTED, { item });
    child.send({ id: 204, method: Events.FILECHANGE_REQUEST_APPROVAL, params: { ...scope, itemId: item.id } });
  });
  f.session.requestApproval = async (_, payload) => {
    assert.equal(payload.changes[0].diff, '+first');
    event(f.child, Events.ITEM_STARTED, { item: { ...item, changes: [{ path: 'x.txt', kind: { type: 'add' }, diff: '+changed' }] } });
    setImmediate(() => terminal(f.child)); return 'accept';
  };
  await f.run(); assert.deepEqual(f.child.sent.find(msg => msg.id === 204).result, { decision: 'decline' });
});

test('a settled provider approval retry returns the same decision without another host resolution', async () => {
  const msg = { id: 205, method: Events.COMMAND_REQUEST_APPROVAL, params: { ...scope, itemId: 'tool', command: 'fixture' } };
  const f = setup(child => child.send(msg)); let approvals = 0;
  f.session.requestApproval = async () => { approvals++; return 'accept'; };
  const run = f.run(); await until(() => f.child.sent.some(frame => frame.id === 205));
  f.child.send(msg); await tick(); terminal(f.child); await run;
  assert.equal(approvals, 1); assert.equal(f.child.sent.filter(frame => frame.id === 205).length, 2);
  assert.ok(f.child.sent.filter(frame => frame.id === 205).every(frame => frame.result.decision === 'accept'));
});

test('reusing a provider approval identity with changed content fails closed', async () => {
  const f = setup(child => {
    child.send({ id: 206, method: Events.COMMAND_REQUEST_APPROVAL, params: { ...scope, itemId: 'tool', command: 'first' } });
    child.send({ id: 206, method: Events.COMMAND_REQUEST_APPROVAL, params: { ...scope, itemId: 'tool', command: 'different' } });
  });
  f.session.requestApproval = async () => 'decline';
  await assert.rejects(f.run(), /codex_approval_changed/);
  assert.equal(f.child.sent.some(frame => frame.id === 206 && frame.result?.decision === 'accept'), false);
});

function hostToolFixture(t, onTurn, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-native-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = setup(onTurn, options), events = [];
  const backend = new ConfinedCodexAppServerBackend({ bin: process.execPath, spawnProcess: () => f.child,
    requestTimeoutMs: 300, turnTimeoutMs: 1000, interruptTimeoutMs: 50 });
  const session = new TurnSession({ thread: { id: 'product-task', cwd: root }, turnId: 'product-turn',
    input: [{ type: 'text', text: 'Synthetic contract task' }], by: { userId: 'owner', name: 'Owner' },
    settings: { sandboxPolicy: 'workspace-write', approvalPolicy: 'on-request', effort: 'high' }, provider: backend,
    emit: value => events.push(value) });
  const call = (id, callId, tool, args, extra = {}) => f.child.send({ id, method: 'item/tool/call',
    params: { ...scope, callId, tool, arguments: args, ...extra } });
  return { ...f, root, backend, session, events, call, run: () => session.run() };
}

test('confined dynamic tools use real host writes and one scoped removal despite duplicate calls', async t => {
  const f = hostToolFixture(t, () => {});
  fs.mkdirSync(path.join(f.root, 'build'));
  fs.writeFileSync(path.join(f.root, 'build/keep.txt'), 'synthetic fixture');
  let writes = 0, removes = 0;
  const write = f.session.workspace.writeFile.bind(f.session.workspace), remove = f.session.workspace.remove.bind(f.session.workspace);
  f.session.workspace.writeFile = (...args) => { writes++; return write(...args); };
  f.session.workspace.remove = (...args) => { removes++; return remove(...args); };
  const running = f.run();
  await until(() => f.session.providerTurnId);
  f.call(301, 'write-once', 'plexus_write_file', { path: 'RESULT.md', content: 'actual host bytes\n' });
  f.call(302, 'write-once', 'plexus_write_file', { path: 'RESULT.md', content: 'actual host bytes\n' });
  await until(() => f.child.sent.find(m => m.id === 302));
  assert.equal(fs.readFileSync(path.join(f.root, 'RESULT.md'), 'utf8'), 'actual host bytes\n');
  assert.equal(writes, 1);
  f.call(303, 'remove-once', 'plexus_remove_path', { path: 'build' });
  f.call(304, 'remove-once', 'plexus_remove_path', { path: 'build' });
  const approval = await until(() => f.events.find(e => e.method === Events.COMMAND_REQUEST_APPROVAL));
  assert.equal(approval.command, 'remove_path build');
  assert.equal(fs.existsSync(path.join(f.root, 'build/keep.txt')), true);
  assert.throws(() => f.session.resolveApproval(approval.requestId, 'accept', { userId: 'owner' },
    { turnId: f.session.turnId, fingerprint: 'mutated' }), /approval_action_changed/);
  f.session.resolveApproval(approval.requestId, 'accept', { userId: 'owner' },
    { turnId: f.session.turnId, fingerprint: approval.fingerprint });
  await until(() => f.child.sent.find(m => m.id === 304));
  assert.equal(removes, 1); assert.equal(fs.existsSync(path.join(f.root, 'build')), false);
  for (const id of [301, 302, 303, 304]) assert.equal(f.child.sent.find(m => m.id === id).result.success, true);
  terminal(f.child); assert.equal((await running).status, 'completed');
  const start = f.child.sent.find(m => m.method === 'thread/start');
  assert.equal(start.params.sandbox, 'read-only'); assert.equal(start.params.approvalPolicy, 'never');
  assert.deepEqual(start.params.dynamicTools.map(tool => tool.name), ['plexus_write_file', 'plexus_remove_path']);
  assert.deepEqual(f.child.sent[0].params.capabilities, { experimentalApi: true });
  assert.deepEqual(f.session.providerSpawns[0].args.slice(-3), ['-c', 'model_reasoning_effort="high"', 'app-server']);
});

test('native escalation is declined even when original host settings permit workspace writes', async t => {
  const f = hostToolFixture(t, c => {
    c.send({ id: 310, method: Events.COMMAND_REQUEST_APPROVAL, params: { ...scope, itemId: 'native', command: 'rm -rf build' } });
    setImmediate(() => terminal(c));
  });
  f.session.settings.sandboxPolicy = 'danger-full-access';
  f.session.requestApproval = () => assert.fail('native approval cannot reach host authority');
  assert.equal((await f.run()).status, 'completed');
  assert.deepEqual(f.child.sent.find(m => m.id === 310).result, { decision: 'decline' });
  assert.equal(f.child.sent.find(m => m.method === 'thread/start').params.sandbox, 'read-only');
});

test('host tools refuse traversal, symlinks, unexpected fields, unknown tools and oversized content', async t => {
  const f = hostToolFixture(t, () => {});
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-native-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'unchanged');
  fs.symlinkSync(outside, path.join(f.root, 'escape'));
  const running = f.run(); await until(() => f.session.providerTurnId);
  const calls = [
    ['plexus_write_file', { path: '../escape.txt', content: 'forbidden' }],
    ['plexus_write_file', { path: 'escape/keep.txt', content: 'forbidden' }],
    ['plexus_remove_path', { path: 'escape' }],
    ['plexus_write_file', { path: 'extra.txt', content: 'x', command: 'bad' }],
    ['plexus_write_file', { path: 'large.txt', content: 'x'.repeat(256 * 1024 + 1) }],
    ['shell', { path: 'keep.txt' }]
  ];
  for (let i = 0; i < calls.length; i++) f.call(320 + i, 'invalid-' + i, ...calls[i]);
  await until(() => f.child.sent.find(m => m.id === 325));
  for (let i = 0; i < calls.length; i++) assert.equal(f.child.sent.find(m => m.id === 320 + i).result.success, false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'unchanged');
  assert.equal(fs.existsSync(path.join(f.root, 'extra.txt')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'large.txt')), false);
  terminal(f.child); assert.equal((await running).status, 'completed');
});

test('interrupt after an approval answer still prevents the queued host filesystem mutation', async t => {
  const f = hostToolFixture(t, () => {});
  fs.mkdirSync(path.join(f.root, 'build')); fs.writeFileSync(path.join(f.root, 'build/keep.txt'), 'keep');
  const running = f.run(); await until(() => f.session.providerTurnId);
  f.call(340, 'remove', 'plexus_remove_path', { path: 'build' });
  const approval = await until(() => f.events.find(e => e.method === Events.COMMAND_REQUEST_APPROVAL));
  f.session.resolveApproval(approval.requestId, 'accept', { userId: 'owner' },
    { turnId: f.session.turnId, fingerprint: approval.fingerprint });
  f.session.requestInterrupt({ userId: 'owner' });
  assert.equal((await running).status, 'interrupted');
  assert.equal(fs.readFileSync(path.join(f.root, 'build/keep.txt'), 'utf8'), 'keep');
  assert.equal(f.session.providerInterrupt.state, 'confirmed');
});

test('changed host call identities fail closed and foreign turns never mutate', async t => {
  const f = hostToolFixture(t, () => {});
  const running = f.run(); await until(() => f.session.providerTurnId);
  f.call(350, 'foreign', 'plexus_write_file', { path: 'foreign.txt', content: 'bad' }, { turnId: 'other' });
  await until(() => f.child.sent.find(m => m.id === 350));
  assert.equal(f.child.sent.find(m => m.id === 350).error.code, -32601);
  f.call(351, 'same', 'plexus_write_file', { path: 'first.txt', content: 'one' });
  await until(() => f.child.sent.find(m => m.id === 351));
  f.call(352, 'same', 'plexus_write_file', { path: 'changed.txt', content: 'two' });
  const result = await running;
  assert.equal(result.status, 'failed'); assert.equal(result.error.message, 'codex_tool_changed');
  assert.equal(fs.existsSync(path.join(f.root, 'foreign.txt')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'changed.txt')), false);
});

test('acknowledged provider thread is persisted before the first model turn starts', async () => {
  const f = setup(); let persisted = false;
  f.session.onProviderStateChanged = async () => {
    assert.equal(f.session.thread.codexAppServerThreadId, scope.threadId);
    assert.equal(f.child.sent.some(m => m.method === 'turn/start'), false);
    await tick(); persisted = true;
  };
  await f.run(); assert.equal(persisted, true);
});

function supportedToolFixture(t, override) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-supported-contract-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const profileDir = path.join(base, 'profile'), authFile = path.join(base, 'synthetic-auth.json');
  fs.writeFileSync(authFile, '{}', { mode: 0o600 });
  let f;
  f = hostToolFixture(t, () => {}, { onRpc(msg, child) {
    if (override?.(msg, child, f)) return true;
    if (msg.method === 'configRequirements/read') { child.answer(msg, { requirements: null }); return true; }
    if (msg.method === 'config/read') {
      child.answer(msg, { config: { model_provider: 'openai', web_search: 'disabled' }, layers: [
        { name: { type: 'user', file: path.join(fs.realpathSync(profileDir), 'config.toml'), profile: null }, config: PROFILE_CONFIG },
        { name: { type: 'sessionFlags' }, config: { model_reasoning_effort: 'high' } },
        { name: { type: 'system' }, config: {} }
      ] }); return true;
    }
    if (msg.method === 'mcpServerStatus/list') { child.answer(msg, { data: [], nextCursor: null }); return true; }
    if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
      child.answer(msg, { thread: { id: msg.params.threadId || scope.threadId }, cwd: fs.realpathSync(profileDir),
        modelProvider: 'openai', model: 'gpt-5.4-mini', approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false }, instructionSources: [] }); return true;
    }
    return false;
  } });
  f.backend = new HostToolsCodexAppServerBackend({ bin: process.execPath, profileDir, authFile,
    versionProbe: () => 'codex-cli 0.153.4', spawnProcess: () => f.child, turnTimeoutMs: 1000, requestTimeoutMs: 200 });
  f.session.provider = f.backend;
  f.profileDir = profileDir; f.authFile = authFile;
  return f;
}

const supportedHost = process.platform === 'darwin' && process.arch === 'arm64';
test('supported mode clears every environment and reads only through real host capabilities', { skip: !supportedHost }, async t => {
  const f = supportedToolFixture(t), outside = path.join(path.dirname(f.authFile), 'OUTSIDE.txt');
  fs.writeFileSync(outside, 'synthetic outside marker');
  const inside = 'host-authorized inside bytes\n\n';
  fs.writeFileSync(path.join(f.root, 'INSIDE.txt'), inside);
  fs.writeFileSync(path.join(f.root, 'EMPTY.txt'), '');
  fs.symlinkSync(outside, path.join(f.root, 'escape'));
  const running = f.run(); await until(() => f.session.providerTurnId);
  f.call(401, 'inside', 'plexus_read_file', { path: 'INSIDE.txt' });
  f.call(402, 'list', 'plexus_list_files', { path: '.' });
  f.call(403, 'outside', 'plexus_read_file', { path: outside });
  f.call(404, 'symlink', 'plexus_read_file', { path: 'escape' });
  f.call(405, 'parent', 'plexus_list_files', { path: '..' });
  f.call(406, 'empty', 'plexus_read_file', { path: 'EMPTY.txt' });
  await until(() => f.child.sent.find(m => m.id === 406));
  assert.deepEqual(JSON.parse(f.child.sent.find(m => m.id === 401).result.contentItems[0].text),
    { path: 'INSIDE.txt', encoding: 'utf-8', content: inside });
  assert.equal(JSON.parse(f.child.sent.find(m => m.id === 406).result.contentItems[0].text).content, '');
  assert.ok(f.child.sent.find(m => m.id === 402).result.contentItems[0].text.includes('INSIDE.txt'));
  for (const id of [403, 404, 405]) assert.equal(f.child.sent.find(m => m.id === id).result.success, false);
  assert.equal(JSON.stringify(f.child.sent).includes('synthetic outside marker'), false);
  assert.deepEqual(f.child.sent.find(m => m.method === 'thread/start').params.environments, []);
  assert.deepEqual(f.child.sent.find(m => m.method === 'turn/start').params.environments, []);
  assert.notEqual(f.child.sent.find(m => m.method === 'thread/start').params.cwd, f.root);
  assert.deepEqual(f.child.sent.find(m => m.method === 'thread/start').params.dynamicTools.map(tool => tool.name),
    ['plexus_read_file', 'plexus_list_files', 'plexus_write_file', 'plexus_remove_path']);
  assert.equal(fs.lstatSync(path.join(f.profileDir, 'auth.json')).isSymbolicLink(), true);
  assert.equal(fs.statSync(f.profileDir).mode & 0o077, 0);
  terminal(f.child); assert.equal((await running).status, 'completed');
});

test('supported resume retains product identity and explicitly clears turn environments', { skip: !supportedHost }, async t => {
  const f = supportedToolFixture(t);
  f.session.thread.codexAppServerThreadId = scope.threadId;
  const running = f.run(); await until(() => f.session.providerTurnId);
  assert.equal(f.child.sent.some(m => m.method === 'thread/start'), false);
  assert.equal(f.child.sent.find(m => m.method === 'thread/resume').params.threadId, scope.threadId);
  assert.deepEqual(f.child.sent.find(m => m.method === 'turn/start').params.environments, []);
  assert.equal(f.session.thread.id, 'product-task');
  terminal(f.child); assert.equal((await running).status, 'completed');
});

test('managed requirements and ambient config, instructions or MCP fail before model dispatch', { skip: !supportedHost }, async t => {
  const scenarios = [
    ['configRequirements/read', { requirements: { featureRequirements: { apps: true } } }, 'codex_host_tools_managed_requirements_unproven'],
    ['config/read', { config: {}, layers: [{ name: { type: 'system' }, config: { mcp_servers: { unsafe: { command: 'fixture' } } } }] }, 'codex_host_tools_ambient_config'],
    ['mcpServerStatus/list', { data: [{ name: 'unexpected' }], nextCursor: null }, 'codex_host_tools_ambient_tools'],
    ['thread/start', { thread: { id: scope.threadId }, instructionSources: [{ path: 'ambient' }] }, 'codex_host_tools_policy_unverified']
  ];
  for (const [method, response, code] of scenarios) {
    const f = supportedToolFixture(t, (msg, child) => {
      if (msg.method !== method) return false;
      child.answer(msg, response); return true;
    });
    const result = await f.run();
    assert.equal(result.status, 'failed'); assert.equal(result.error.message, code);
    assert.equal(f.child.sent.some(m => m.method === 'turn/start'), false);
  }
});

test('unsupported version, modified profile and project-contained provider state never spawn', async t => {
  for (const mode of ['version', 'model', 'modified', 'contained', 'global-instructions']) {
    const f = supportedToolFixture(t); let spawns = 0;
    f.backend.spawnProcess = () => { spawns++; return f.child; };
    if (mode === 'version') f.backend.versionProbe = () => 'codex-cli 0.137.0';
    if (mode === 'model') f.session.model = 'unmeasured-model';
    if (mode === 'contained') f.backend.profileDir = path.join(f.root, 'provider-state');
    if (mode === 'modified' || mode === 'global-instructions') {
      fs.mkdirSync(f.profileDir, { mode: 0o700 });
      fs.writeFileSync(path.join(f.profileDir, mode === 'modified' ? 'config.toml' : 'AGENTS.md'), 'unexpected');
    }
    const result = await f.run();
    assert.equal(result.status, 'failed'); assert.match(result.error.message, /^codex_host_tools_/);
    assert.equal(spawns, 0);
  }
});

test('supported readiness checks the actual adapter boundary without starting a provider turn', { skip: !supportedHost }, async t => {
  const f = supportedToolFixture(t);
  const ready = await f.backend.checkHost({ workspace: f.root, settings: { effort: 'high' } });
  assert.equal(ready.ready, true); assert.equal(ready.version, '0.153.4');
  assert.equal(f.child.sent.some(message => message.method === 'turn/start'), false);
  assert.equal(f.child.sent.find(message => message.method === 'thread/start').params.ephemeral, true);
});
