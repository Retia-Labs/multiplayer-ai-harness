'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const { CodexRpc, providerFailure } = require('../packages/runtime/codex-rpc');
const { CodexAppServerBackend, mapItem } = require('../packages/runtime/codex-app-server');
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
  kill() { this.killed = true; this.emit('close', 0); }
}
const scope = { threadId: 'provider-thread', turnId: 'provider-turn' };
function event(child, method, params) { child.send({ method, params: { ...scope, ...params } }); }
function terminal(child, status = 'completed', error) {
  event(child, Events.TURN_COMPLETED, { turn: { id: scope.turnId, status, error } });
}
function setup(onTurn = (c) => terminal(c), options = {}) {
  const child = new Provider((msg, c) => {
    if (msg.method === 'initialize') c.answer(msg, { userAgent: 'fixture' });
    if (msg.method === 'thread/start') c.answer(msg, { thread: { id: scope.threadId } });
    if (msg.method === 'turn/start') { c.answer(msg, { turn: { id: scope.turnId } }); onTurn(c, msg); }
  });
  const session = { cwd: process.cwd(), thread: { id: 'product-task' }, turnId: 'product-turn',
    input: [{ type: 'text', text: 'Implement a feature' }], settings: { sandboxPolicy: 'read-only', approvalPolicy: 'on-request' },
    abort: new AbortController(), pendingApprovals: new Map(), events: [],
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
    c.send({ id: 93, method: Events.FILECHANGE_REQUEST_APPROVAL, params: { ...scope, itemId: 'patch', changes: [] } });
  });
  f.session.requestApproval = async () => { setImmediate(() => terminal(f.child)); return 'accept'; };
  await f.run();
  assert.deepEqual(f.child.sent.find((m) => m.id === 93).result, { decision: 'accept' });
  const lost = setup((c) => {
    c.send({ id: 94, method: Events.COMMAND_REQUEST_APPROVAL, params: { ...scope, itemId: 'tool' } });
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
