/**
 * Tests for the detached runner.
 *
 * The claim being checked is the one the whole product rests on: the run is not
 * inside anybody's window. A client can connect, disconnect entirely, and come
 * back to find the work continued without it - and a second client, which never
 * saw the beginning, can pick up the full history and steer.
 *
 * These spawn a real runner process and talk to it over the real protocol, so
 * they are slower than the rest of the suite and worth every second.
 *
 * Run with: npm run test:runner
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { EventLog } = require('../src/main/log');
const kernel = require('../src/main/kernel');
const { SessionClient } = require('../src/net/client');
const registry = require('../src/runner/registry');

const RUNNER = path.join(__dirname, '..', 'src', 'runner', 'runner.js');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-runner-'));
  const logdir = path.join(dir, 'sessions');
  const workdir = path.join(dir, 'project');
  fs.mkdirSync(logdir, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(workdir, 'hello.js'), 'console.log("hello");\n');
  const settingsFile = path.join(dir, 'settings.json');
  // No API key: the agent runs its offline path, which still drives the real
  // tool pipeline and so exercises everything except the network call.
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ openaiApiKey: '', model: 'gpt-5.1-codex-max', mode: 'agent', displayName: 'priya' })
  );
  return { dir, logdir, workdir, settingsFile };
}

/** Start a runner and resolve once it announces the port it got. */
function startRunner({ sessionId, logdir, workdir, settingsFile, token = null }) {
  const args = [
    RUNNER,
    '--session', sessionId,
    '--logdir', logdir,
    '--workdir', workdir,
    '--settings', settingsFile,
    '--port', '0'
  ];
  if (token) args.push('--token', token);

  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error('runner did not announce itself. stderr: ' + stderr)),
      20000
    );
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.trim().startsWith('{'));
      if (!line) return;
      try {
        const info = JSON.parse(line);
        if (!info.ready) return;
        clearTimeout(timer);
        resolve({ child, info, stderrText: () => stderr });
      } catch {
        /* partial line */
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('runner exited early with ' + code + '. stderr: ' + stderr));
    });
  });
}

async function until(fn, ms = 25000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Timed out waiting for ' + label);
}

function stateOf(logdir, sessionId) {
  return kernel.reduce(sessionId, new EventLog(logdir).read(sessionId));
}

test('a runner starts, announces itself and records that it is online', async () => {
  const { logdir, workdir, settingsFile } = scratch();
  const { child, info } = await startRunner({ sessionId: 'sess_a', logdir, workdir, settingsFile });
  try {
    assert.ok(info.port > 0, 'it reports the port the OS gave it');
    assert.equal(info.sessionId, 'sess_a');
    assert.ok(info.pid > 0);

    // It leaves a pid file so the desktop can find runs it did not start.
    const pidFile = path.join(logdir, 'sess_a.runner.json');
    await until(() => fs.existsSync(pidFile), 5000, 'pid file');
    assert.equal(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid, info.pid);

    const c = new SessionClient({ base: info.base, sessionId: 'sess_a' });
    const { meta } = await c.state();
    assert.equal(meta.pid, info.pid);
    assert.equal(meta.workDir, workdir);
  } finally {
    child.kill();
  }
});

test('the runner does the work when a person asks, and records all of it', async () => {
  const { logdir, workdir, settingsFile } = scratch();
  const { child, info, stderrText } = await startRunner({
    sessionId: 'sess_b', logdir, workdir, settingsFile
  });
  try {
    const c = new SessionClient({ base: info.base, sessionId: 'sess_b' });
    await c.submit({
      kind: 'turn.started',
      actor: 'human:priya',
      payload: { turnId: 'turn_1', text: 'Create a NOTES.md summarizing this repo' }
    });

    await until(
      async () => {
        const s = stateOf(logdir, 'sess_b');
        return s.changes.length > 0 && s.turns.some((t) => t.messages.length > 0);
      },
      30000,
      'the agent to work. stderr: ' + stderrText()
    );

    const s = stateOf(logdir, 'sess_b');
    assert.ok(s.changes.find((f) => f.path === 'NOTES.md'), 'it wrote the file it was asked for');
    assert.ok(fs.existsSync(path.join(workdir, 'NOTES.md')), 'and the file is really on disk');
    assert.ok(s.steps.length > 0, 'it recorded a plan');
    assert.equal(new EventLog(logdir).verify('sess_b').ok, true, 'the chain is intact');
  } finally {
    child.kill();
  }
});

test('the run survives its client disconnecting entirely', async () => {
  const { logdir, workdir, settingsFile } = scratch();
  const { child, info } = await startRunner({ sessionId: 'sess_c', logdir, workdir, settingsFile });
  try {
    // A client connects, starts work, and then vanishes the way a quit app does.
    const first = new SessionClient({ base: info.base, sessionId: 'sess_c', as: 'priya' });
    first.connect();
    await first.submit({
      kind: 'turn.started',
      actor: 'human:priya',
      payload: { turnId: 'turn_1', text: 'Create a NOTES.md summarizing this repo' }
    });
    await until(() => stateOf(logdir, 'sess_c').turns.length > 0, 15000, 'the turn to open');
    first.close();

    // Nobody is watching. The work continues regardless.
    await until(
      () => stateOf(logdir, 'sess_c').changes.length > 0,
      30000,
      'work to continue with no client attached'
    );

    // A completely fresh client - a reopened app, or a colleague - picks up the
    // whole history, not just what happens from now on.
    const second = new SessionClient({ base: info.base, sessionId: 'sess_c', as: 'sam' });
    const seen = [];
    second.on('events', (evs) => seen.push(...evs));
    second.connect();
    await until(() => seen.length > 3, 10000, 'backfill to the new client');

    assert.equal(seen[0].seq, 1, 'the new client is given the run from the beginning');
    assert.ok(seen.some((e) => e.kind === 'artifact.changed'), 'including work done while nobody watched');
    second.close();
  } finally {
    child.kill();
  }
});

test('a directive from another machine reaches a running agent', async () => {
  const { logdir, workdir, settingsFile } = scratch();
  const { child, info } = await startRunner({ sessionId: 'sess_d', logdir, workdir, settingsFile });
  try {
    const c = new SessionClient({ base: info.base, sessionId: 'sess_d' });
    await c.submit({
      kind: 'turn.started',
      actor: 'human:priya',
      payload: { turnId: 'turn_1', text: 'Create a NOTES.md summarizing this repo' }
    });
    await until(() => stateOf(logdir, 'sess_d').turns.length > 0, 15000, 'a turn to be running');

    // Someone else, somewhere else, steers the run.
    await c.submit({
      kind: 'directive.sent',
      actor: 'human:sam',
      payload: { id: 'dir_1', text: 'use British spelling throughout' }
    });

    await until(
      () => {
        const d = stateOf(logdir, 'sess_d').directives.find((x) => x.id === 'dir_1');
        return d && d.appliedAt;
      },
      20000,
      'the runner to apply the directive'
    );

    const d = stateOf(logdir, 'sess_d').directives.find((x) => x.id === 'dir_1');
    assert.equal(d.by, 'sam', 'attributed to whoever sent it');
    assert.ok(d.appliedAt, 'the agent merged it into its context');
  } finally {
    child.kill();
  }
});

test('a token-protected runner refuses a client without it', async () => {
  const { logdir, workdir, settingsFile } = scratch();
  const { child, info } = await startRunner({
    sessionId: 'sess_e', logdir, workdir, settingsFile, token: 'room-code-abcdef'
  });
  try {
    const anon = new SessionClient({ base: info.base, sessionId: 'sess_e' });
    await assert.rejects(() => anon.state(), /Bad or missing token/);

    const member = new SessionClient({ base: info.base, sessionId: 'sess_e', token: 'room-code-abcdef' });
    assert.ok((await member.state()).state);
  } finally {
    child.kill();
  }
});

test('a dead runner is never reported as live, however it died', async () => {
  // Deliberately not asserting that the runner tidies up on the way out. On
  // Windows, terminating a process does not run its signal handlers at all, so
  // a claim WILL be left behind by any hard kill on any platform. Believing
  // such a claim is the dangerous failure - the app would show a live run that
  // cannot hear anyone - so liveness is checked rather than assumed.
  const { logdir, workdir, settingsFile } = scratch();
  const { child, info } = await startRunner({ sessionId: 'sess_f', logdir, workdir, settingsFile });
  await until(() => registry.findRunner(logdir, 'sess_f'), 5000, 'the runner to claim the session');
  assert.equal(registry.findRunner(logdir, 'sess_f').pid, info.pid);

  child.kill();
  await until(() => !registry.pidAlive(info.pid), 10000, 'the process to be gone');

  assert.equal(registry.findRunner(logdir, 'sess_f'), null, 'a dead runner is not a runner');
  assert.ok(
    !fs.existsSync(path.join(logdir, 'sess_f.runner.json')),
    'and asking cleans the stale claim up'
  );
});

test('listRunners reports live runs and forgets dead ones', async () => {
  const { logdir, workdir, settingsFile } = scratch();
  const a = await startRunner({ sessionId: 'sess_g', logdir, workdir, settingsFile });
  const b = await startRunner({ sessionId: 'sess_h', logdir, workdir, settingsFile });
  try {
    await until(() => registry.listRunners(logdir).length === 2, 8000, 'both runners');
    const ids = registry.listRunners(logdir).map((r) => r.sessionId).sort();
    assert.deepEqual(ids, ['sess_g', 'sess_h']);

    b.child.kill();
    await until(() => !registry.pidAlive(b.info.pid), 10000, 'one to exit');
    assert.deepEqual(registry.listRunners(logdir).map((r) => r.sessionId), ['sess_g']);
    assert.equal(registry.reap(logdir), 0, 'listing already reaped the dead one');
  } finally {
    a.child.kill();
  }
});

test('stopRunner stops a live runner and reports when there is none', async () => {
  const { logdir, workdir, settingsFile } = scratch();
  const { child, info } = await startRunner({ sessionId: 'sess_i', logdir, workdir, settingsFile });
  await until(() => registry.findRunner(logdir, 'sess_i'), 5000, 'the runner');

  const res = await registry.stopRunner(logdir, 'sess_i');
  assert.equal(res.stopped, true);
  assert.equal(registry.pidAlive(info.pid), false, 'the process is really gone');
  assert.equal(registry.findRunner(logdir, 'sess_i'), null);

  const again = await registry.stopRunner(logdir, 'sess_i');
  assert.equal(again.stopped, false);
  assert.equal(again.reason, 'no live runner');
  child.kill();
});
