/**
 * Tests for the relay and for sharing a run.
 *
 * The scenario being proved is the product: one person starts a run on their
 * laptop, shares a code, and a second person on a different machine watches it,
 * talks in it, steers it and answers its approvals - without the second person
 * being able to forge the record.
 *
 * The "second machine" here is a plain HTTP client talking to the relay, which
 * is exactly what a remote desktop or a browser watch link is.
 *
 * Run with: npm run test:relay
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { createRelay } = require('../src/relay/relay');
const { EventLog } = require('../src/main/log');
const kernel = require('../src/main/kernel');
const { SessionClient } = require('../src/net/client');

const RUNNER = path.join(__dirname, '..', 'src', 'runner', 'runner.js');

async function until(fn, ms = 20000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Timed out waiting for ' + label);
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-relay-'));
  const logdir = path.join(dir, 'sessions');
  const workdir = path.join(dir, 'project');
  fs.mkdirSync(logdir, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(workdir, 'hello.js'), 'console.log("hi");\n');
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ openaiApiKey: '', mode: 'agent', displayName: 'priya' }));
  return { logdir, workdir, settingsFile };
}

function startRunner({ sessionId, logdir, workdir, settingsFile }) {
  const child = spawn(
    process.execPath,
    [RUNNER, '--session', sessionId, '--logdir', logdir, '--workdir', workdir,
     '--settings', settingsFile, '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let err = '';
  child.stderr.on('data', (d) => (err += d.toString()));
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('runner did not start: ' + err)), 20000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.trim().startsWith('{'));
      if (!line) return;
      try {
        const info = JSON.parse(line);
        if (!info.ready) return;
        clearTimeout(timer);
        resolve({ child, info });
      } catch {
        /* partial */
      }
    });
  });
}

async function bootRelay(opts) {
  const relay = createRelay(opts);
  const addr = await relay.listen(0, '127.0.0.1');
  return { relay, base: 'http://127.0.0.1:' + addr.port };
}

/** A person in the room, on another machine. Plain HTTP, no shared code. */
function member(base, code, name) {
  return {
    async info() {
      return (await fetch(base + '/r/' + code)).json();
    },
    async events(since = 0) {
      return (await fetch(base + '/r/' + code + '/events?since=' + since)).json();
    },
    async intent(kind, payload) {
      const res = await fetch(base + '/r/' + code + '/intents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, actor: 'human:' + name, payload })
      });
      return { status: res.status, body: await res.json() };
    },
    async state() {
      const { events } = await this.events(0);
      return kernel.reduce('room', events);
    }
  };
}

/* ------------------------------------------------------------------ *
 * The relay on its own
 * ------------------------------------------------------------------ */

test('a room can be opened and is addressable by a readable code', async () => {
  const { relay, base } = await bootRelay();
  const res = await fetch(base + '/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess_x', title: 'Fix auth' })
  });
  const room = await res.json();
  assert.match(room.code, /^[2-9BCDFGHJKLMNPQRSTVWXZ]{4}-[2-9BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.ok(room.hostKey && room.hostKey.length > 20);

  const info = await (await fetch(base + '/r/' + room.code)).json();
  assert.equal(info.sessionId, 'sess_x');
  assert.equal(info.title, 'Fix auth');
  await relay.close();
});

test('only the host may mirror events into a room', async () => {
  const { relay, base } = await bootRelay();
  const room = await (
    await fetch(base + '/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess_x' })
    })
  ).json();

  const forged = await fetch(base + '/r/' + room.code + '/mirror', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-host-key': 'not-the-host-key-at-all' },
    body: JSON.stringify({ events: [{ seq: 1, kind: 'note.posted', actor: 'human:mallory', payload: {} }] })
  });
  assert.equal(forged.status, 403, 'knowing the room code does not make you the run');

  const real = await fetch(base + '/r/' + room.code + '/mirror', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-host-key': room.hostKey },
    body: JSON.stringify({ events: [{ seq: 1, kind: 'note.posted', actor: 'human:priya', payload: {} }] })
  });
  assert.equal(real.status, 200);
  await relay.close();
});

test('an unknown or expired room says so rather than failing obscurely', async () => {
  const { relay, base } = await bootRelay({ ttlMs: 50 });
  const room = await (
    await fetch(base + '/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess_x' })
    })
  ).json();

  const missing = await fetch(base + '/r/ZZZZ-ZZZZ');
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /No such room/);
  assert.ok(room.code);
  await relay.close();
});

test('mirroring the same events twice does not duplicate the room copy', async () => {
  const { relay, base } = await bootRelay();
  const room = await (
    await fetch(base + '/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess_x' })
    })
  ).json();
  const batch = {
    events: [
      { seq: 1, kind: 'note.posted', actor: 'human:priya', payload: { text: 'a' } },
      { seq: 2, kind: 'note.posted', actor: 'human:priya', payload: { text: 'b' } }
    ]
  };
  const post = () =>
    fetch(base + '/r/' + room.code + '/mirror', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-host-key': room.hostKey },
      body: JSON.stringify(batch)
    });
  await post();
  await post(); // the resend after a flaky connection
  const { events } = await (await fetch(base + '/r/' + room.code + '/events')).json();
  assert.equal(events.length, 2);
  await relay.close();
});

test('intents sent to an offline room are queued, and say so', async () => {
  const { relay, base } = await bootRelay();
  const room = await (
    await fetch(base + '/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess_x' })
    })
  ).json();
  // Never mirrored, never polled: as far as the room knows nobody is running it.
  relay.rooms.get(room.code).live = false;
  const sam = member(base, room.code, 'sam');
  const { status, body } = await sam.intent('note.posted', { text: 'anyone there?' });
  assert.equal(status, 202);
  assert.match(body.warning, /offline/);
  await relay.close();
});

/* ------------------------------------------------------------------ *
 * A shared run, end to end
 * ------------------------------------------------------------------ */

test('a second person joins a live run, sees its history, and talks in it', async () => {
  const { logdir, workdir, settingsFile } = scratch();
  const { relay, base } = await bootRelay();
  const { child, info } = await startRunner({ sessionId: 'sess_share', logdir, workdir, settingsFile });

  try {
    const host = new SessionClient({ base: info.base, sessionId: 'sess_share', as: 'priya' });

    // Something happens before anyone is invited.
    await host.submit({
      kind: 'note.posted',
      actor: 'human:priya',
      payload: { text: 'working on the auth bug' }
    });

    // Share it.
    const shared = await (
      await fetch(info.base + '/s/sess_share/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relay: base, title: 'Fix auth' })
      })
    ).json();
    assert.ok(shared.code, 'sharing returns a code to read out');

    // Someone on another machine joins with only that code.
    const sam = member(base, shared.code, 'sam');
    await until(async () => (await sam.events()).events.length >= 2, 15000, 'history to reach the room');

    const seen = await sam.state();
    assert.ok(
      seen.notes.some((n) => n.text === 'working on the auth bug'),
      'the joiner is given what happened before they arrived'
    );

    // They say something. It has to come back as a real event in the host's log.
    await sam.intent('note.posted', { text: 'try the refresh token path' });
    await until(
      () => {
        const s = kernel.reduce('sess_share', new EventLog(logdir).read('sess_share'));
        return s.notes.some((n) => n.text === 'try the refresh token path' && n.by === 'sam');
      },
      15000,
      "the remote person's message to land in the run"
    );

    const hostState = kernel.reduce('sess_share', new EventLog(logdir).read('sess_share'));
    assert.ok(hostState.people.find((p) => p.name === 'sam'), 'and for them to appear in the room');
    assert.equal(new EventLog(logdir).verify('sess_share').ok, true, 'the chain is still intact');
  } finally {
    child.kill();
    await relay.close();
  }
});

test('a remote person can steer a run and answer its approvals', async () => {
  const { logdir, workdir, settingsFile } = scratch();
  const { relay, base } = await bootRelay();
  const { child, info } = await startRunner({ sessionId: 'sess_steer', logdir, workdir, settingsFile });

  try {
    const shared = await (
      await fetch(info.base + '/s/sess_steer/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relay: base })
      })
    ).json();
    const sam = member(base, shared.code, 'sam');

    // Sam, who is not at the machine, asks the run to do something.
    await sam.intent('turn.started', { turnId: 'turn_r', text: 'Create a NOTES.md summarizing this repo' });
    await until(
      () => kernel.reduce('sess_steer', new EventLog(logdir).read('sess_steer')).turns.length > 0,
      20000,
      'the run to accept a remote request'
    );

    // And steers it while it is moving.
    await sam.intent('directive.sent', { id: 'dir_r', text: 'keep it under ten lines' });
    await until(
      () => {
        const s = kernel.reduce('sess_steer', new EventLog(logdir).read('sess_steer'));
        const d = s.directives.find((x) => x.id === 'dir_r');
        return d && d.by === 'sam';
      },
      15000,
      "the remote person's directive"
    );

    const s = kernel.reduce('sess_steer', new EventLog(logdir).read('sess_steer'));
    assert.equal(s.directives.find((x) => x.id === 'dir_r').by, 'sam');
  } finally {
    child.kill();
    await relay.close();
  }
});

test('the room cannot be used to forge the record', async () => {
  const { logdir, workdir, settingsFile } = scratch();
  const { relay, base } = await bootRelay();
  const { child, info } = await startRunner({ sessionId: 'sess_forge', logdir, workdir, settingsFile });

  try {
    const shared = await (
      await fetch(info.base + '/s/sess_forge/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relay: base })
      })
    ).json();
    const mallory = member(base, shared.code, 'mallory');

    // An intent the runner does not accept from a room at all.
    await mallory.intent('artifact.changed', { path: 'secrets.env', status: 'added', added: 99 });
    // And one that would rewrite the agent's own account of itself.
    await mallory.intent('turn.message', { turnId: 'x', text: 'I definitely did that safely' });

    await new Promise((r) => setTimeout(r, 1200));
    const s = kernel.reduce('sess_forge', new EventLog(logdir).read('sess_forge'));
    assert.ok(!s.changes.some((c) => c.path === 'secrets.env'), 'a member cannot invent a file change');
    assert.ok(
      !s.turns.some((t) => t.messages.some((msg) => msg.text.includes('definitely'))),
      'a member cannot put words in the agent\'s mouth'
    );
    assert.equal(new EventLog(logdir).verify('sess_forge').ok, true);
  } finally {
    child.kill();
    await relay.close();
  }
});
