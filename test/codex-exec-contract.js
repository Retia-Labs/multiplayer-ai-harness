'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexExecBackend, ConfinedCodexExecBackend, translate } = require('../packages/runtime/codex-exec');
const { TurnSession } = require('../packages/runtime/session');
const { Events } = require('../packages/protocol');
const { authStatus, codexConfigArgs } = require('../packages/runtime/codex-probe');

test('a saved read-only opt-in cannot enable a provider whose read boundary failed', () => {
  const { Runtime } = require('../packages/runtime');
  const runtime = { codexReadOnly: true, providerConfig: {} };
  assert.equal(Runtime.prototype.providerList.call(runtime).find(p => p.id === 'codex-cli').configured, false);
  assert.throws(() => Runtime.prototype.provider.call(runtime, 'codex-cli'), /project-confined reads and writes are proven/);
});

test('the shared Codex name preserves native inline steering capability', () => {
  const provider = { id: 'codex-cli', capabilities: () => ({ steer: 'inline' }) };
  assert.equal(TurnSession.prototype.deliveryMode.call({ provider }), 'inline');
});

test('account probing reads supported stderr status and separates configuration failure from logout', () => {
  const resolved = { bin: 'codex', prefix: [] };
  const inspect = (result) => authStatus(resolved, { invoke: (bin, args) => {
    assert.deepEqual(args.slice(0, 2), codexConfigArgs());
    return result;
  } });
  assert.equal(inspect({ status: 0, stderr: 'Logged in using ChatGPT' }).mode, 'chatgpt');
  assert.equal(inspect({ status: 1, stderr: 'Not logged in' }).mode, 'none');
  const config = inspect({ status: 1, stderr: 'Error loading configuration: SECRET_CONFIG_CANARY' });
  assert.equal(config.mode, 'config_error');
  assert.equal(JSON.stringify(config).includes('SECRET_CONFIG_CANARY'), false);
  assert.equal(inspect({ status: 1, stderr: 'Process failed' }).mode, 'unavailable');
});

function fakeProcess(run) {
  return (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 123;
    child.kill = () => { child.emit('close', null); return true; };
    queueMicrotask(() => run(child, args));
    return child;
  };
}
function frame(child, event) { child.stdout.write(JSON.stringify(event) + '\n'); }
function createSession(t, backend, name = 'one') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-exec-contract-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const events = [];
  const session = new TurnSession({ thread: { id: name, cwd }, provider: backend,
    by: { userId: name, name }, input: [{ type: 'text', text: name }],
    settings: { sandboxPolicy: 'workspace-write', approvalPolicy: 'never' },
    executor: { id: 'local' }, emit: (event) => events.push(event) });
  return { session, events, cwd };
}

test('provider failures expose fixed actionable codes without credential-bearing text', async (t) => {
  const secret = 'CREDENTIAL_CANARY_DO_NOT_RELAY';
  const state = { cwd: '.', started: new Set(), outputSeen: new Map() };
  const output = translate({ type: 'item.completed', item: { id: 'error', type: 'error', message: secret } }, state);
  assert.equal(JSON.stringify(output).includes(secret), false);
  translate({ type: 'turn.failed', error: { message: 'usage limit exceeded ' + secret } }, state);
  assert.equal(state.error, 'codex_usage_limit');
  const backend = new CodexExecBackend({ bin: process.execPath, spawnProcess: fakeProcess((child) => {
    child.stderr.write('Not logged in ' + secret);
    child.emit('close', 1);
  }) });
  const { session, events } = createSession(t, backend);
  const result = await session.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error.message, 'codex_auth_required');
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test('an exit without provider completion cannot apply a proposed edit or report success', async (t) => {
  const backend = new ConfinedCodexExecBackend({ bin: process.execPath, spawnProcess: fakeProcess((child) => {
    frame(child, { type: 'thread.started', thread_id: 'provider-one' });
    frame(child, { type: 'item.completed', item: { id: 'proposal', type: 'agent_message',
      text: '```plexus-edits\n{"path":"NOTES.md","contents":"unconfirmed"}\n```' } });
    child.emit('close', 0);
  }) });
  const { session, cwd } = createSession(t, backend);
  const result = await session.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error.message, 'codex_completion_missing');
  assert.equal(fs.existsSync(path.join(cwd, 'NOTES.md')), false);
});

test('concurrent tasks on one provider apply only their own proposals', async (t) => {
  const pending = [];
  const backend = new ConfinedCodexExecBackend({ bin: process.execPath, spawnProcess: fakeProcess((child, args) => {
    pending.push({ child, args });
    if (pending.length !== 2) return;
    for (const [i, entry] of pending.entries()) {
      frame(entry.child, { type: 'thread.started', thread_id: 'provider-' + i });
      frame(entry.child, { type: 'item.completed', item: { id: 'proposal', type: 'agent_message',
        text: '```plexus-edits\n' + JSON.stringify({ path: 'NOTES.md', contents: 'task-' + i }) + '\n```' } });
    }
    for (const entry of pending) {
      frame(entry.child, { type: 'turn.completed' });
      entry.child.emit('close', 0);
    }
  }) });
  const one = createSession(t, backend, 'one'), two = createSession(t, backend, 'two');
  const results = await Promise.all([one.session.run(), two.session.run()]);
  assert.deepEqual(results.map((result) => result.status), ['completed', 'completed']);
  assert.equal(fs.readFileSync(path.join(one.cwd, 'NOTES.md'), 'utf8'), 'task-0');
  assert.equal(fs.readFileSync(path.join(two.cwd, 'NOTES.md'), 'utf8'), 'task-1');
  assert.equal(pending.every(({ args }) => args[args.indexOf('--sandbox') + 1] === 'read-only'), true);
});

test('resumed steering records delivery only after a matching provider start', async (t) => {
  let calls = 0;
  const backend = new CodexExecBackend({ bin: process.execPath, spawnProcess: fakeProcess((child, args) => {
    calls++;
    if (calls === 2) assert.equal(args.includes('provider-thread'), true);
    frame(child, { type: 'thread.started', thread_id: 'provider-thread' });
    frame(child, { type: 'turn.started' });
    frame(child, { type: 'turn.completed' });
    child.emit('close', 0);
  }) });
  const { session, events } = createSession(t, backend);
  session.steer([{ type: 'text', text: 'correction' }], { userId: 'two', name: 'two' });
  assert.equal(events.some((event) => event.method === Events.TURN_STEER_DELIVERED), false);
  assert.equal((await session.run()).status, 'completed');
  assert.equal(calls, 2);
  const delivered = events.filter((event) => event.method === Events.TURN_STEER_DELIVERED);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].steerSeq, 1);
  assert.equal(delivered[0].by.userId, 'two');
});

test('cancelling before provider start spawns nothing', async (t) => {
  let spawned = false;
  const backend = new ConfinedCodexExecBackend({ bin: process.execPath,
    spawnProcess: () => { spawned = true; throw new Error('must not spawn'); } });
  const { session } = createSession(t, backend);
  session.interrupt();
  assert.equal((await session.run()).status, 'interrupted');
  assert.equal(spawned, false);
});
