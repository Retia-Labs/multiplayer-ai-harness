/**
 * Tests for the session protocol.
 *
 * This is the layer that makes solo and shared the same code path, so what
 * matters here is the multiplayer behaviour: two clients on one session see
 * the same ordering, a late joiner is caught up rather than shown only the
 * future, and a reconnect replays exactly what was missed and nothing else.
 *
 * Run with: npm run test:net
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EventLog } = require('../src/main/log');
const { createSessionServer } = require('../src/net/server');
const { SessionClient, waitForServer } = require('../src/net/client');

const S = 'sess_net';

function tmpLog() {
  return new EventLog(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-net-')));
}

/** Boot a server on an OS-assigned port and hand back its base URL. */
async function boot(opts = {}) {
  const log = opts.log || tmpLog();
  const api = createSessionServer({ log, ...opts });
  const addr = await api.listen(0, '127.0.0.1');
  return { log, api, base: 'http://127.0.0.1:' + addr.port };
}

/** Wait for a condition, so tests never depend on a fixed sleep. */
async function until(fn, ms = 4000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timed out waiting for condition');
}

const ev = (kind, actor, payload = {}) => ({ kind, actor, payload });

/* ---------------- basics ---------------- */

test('health answers before any session exists', async () => {
  const { api, base } = await boot();
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  await api.close();
});

test('submitted events come back with sequence numbers and a chain', async () => {
  const { api, base } = await boot();
  const c = new SessionClient({ base, sessionId: S });

  const r = await c.submit([
    ev('session.started', 'human:priya', { title: 'Fix auth' }),
    ev('note.posted', 'human:priya', { text: 'starting' })
  ]);
  assert.equal(r.written.length, 2);
  assert.deepEqual(r.written.map((e) => e.seq), [1, 2]);
  assert.equal(r.written[1].prevHash, r.written[0].hash);

  const verified = await c.verify();
  assert.equal(verified.ok, true);
  await api.close();
});

test('state is the reduced session, not the raw log', async () => {
  const { api, base } = await boot();
  const c = new SessionClient({ base, sessionId: S });
  await c.submit([
    ev('session.started', 'human:priya', { title: 'Fix auth', agent: 'quorum' }),
    ev('plan.set', 'agent:quorum', { steps: [{ id: 's1', title: 'read' }] }),
    ev('step.started', 'agent:quorum', { id: 's1' })
  ]);
  const { state } = await c.state();
  assert.equal(state.title, 'Fix auth');
  assert.equal(state.steps[0].status, 'running');
  assert.equal(state.driver, 'priya');
  await api.close();
});

test('malformed submissions are dropped, not appended', async () => {
  const { api, base, log } = await boot();
  const c = new SessionClient({ base, sessionId: S });
  await c.submit([{ nope: true }, { kind: 'note.posted' }, ev('note.posted', 'human:x', { text: 'ok' })]);
  const events = log.read(S);
  assert.equal(events.length, 1, 'only the well-formed event survives');
  assert.equal(events[0].kind, 'note.posted');
  await api.close();
});

/* ---------------- auth ---------------- */

test('a room token is required when one is set', async () => {
  const { api, base } = await boot({ token: 'secret-room-code' });

  const anon = await fetch(base + '/s/' + S + '/state');
  assert.equal(anon.status, 401, 'no token is refused');

  const wrong = new SessionClient({ base, sessionId: S, token: 'wrong-length-code' });
  await assert.rejects(() => wrong.state(), /Bad or missing token/);

  const right = new SessionClient({ base, sessionId: S, token: 'secret-room-code' });
  const { state } = await right.state();
  assert.ok(state);
  await api.close();
});

test('authorize can refuse a session the caller is not in', async () => {
  const { api, base } = await boot({ authorize: (id) => id === 'sess_allowed' });
  const denied = new SessionClient({ base, sessionId: 'sess_other' });
  await assert.rejects(() => denied.state(), /Not a member/);
  const ok = new SessionClient({ base, sessionId: 'sess_allowed' });
  assert.ok(await ok.state());
  await api.close();
});

/* ---------------- the live stream ---------------- */

test('two clients on one session see the same events in the same order', async () => {
  const { api, base } = await boot();
  const a = new SessionClient({ base, sessionId: S, as: 'priya' });
  const b = new SessionClient({ base, sessionId: S, as: 'sam' });
  const seenA = [];
  const seenB = [];
  a.on('events', (evs) => seenA.push(...evs));
  b.on('events', (evs) => seenB.push(...evs));
  a.connect();
  b.connect();
  await until(() => a.lastSeq >= 0 && b.lastSeq >= 0);

  await a.submit(ev('note.posted', 'human:priya', { text: 'from A' }));
  await b.submit(ev('note.posted', 'human:sam', { text: 'from B' }));

  await until(() => seenA.length >= 2 && seenB.length >= 2);
  assert.deepEqual(
    seenA.map((e) => e.seq),
    seenB.map((e) => e.seq),
    'both sides agree on the ordering'
  );
  assert.deepEqual(seenA.map((e) => e.payload.text), ['from A', 'from B']);

  a.close();
  b.close();
  await api.close();
});

test('a late joiner is caught up on everything it missed', async () => {
  const { api, base } = await boot();
  const early = new SessionClient({ base, sessionId: S });
  await early.submit([
    ev('session.started', 'human:priya', { title: 'Long run' }),
    ev('note.posted', 'human:priya', { text: 'happened before you arrived' })
  ]);

  const late = new SessionClient({ base, sessionId: S, as: 'sam' });
  const seen = [];
  late.on('events', (evs) => seen.push(...evs));
  late.connect();

  await until(() => seen.length >= 2);
  assert.equal(seen[0].kind, 'session.started', 'the stream backfills, it does not start from now');
  assert.equal(late.lastSeq, 2);
  late.close();
  await api.close();
});

test('reconnecting replays only what was missed', async () => {
  const { api, base } = await boot();
  const c = new SessionClient({ base, sessionId: S, as: 'priya' });
  const seen = [];
  c.on('events', (evs) => seen.push(...evs));

  await c.submit(ev('note.posted', 'human:priya', { text: 'one' }));
  c.connect();
  await until(() => seen.length >= 1);
  assert.equal(c.lastSeq, 1);

  // Drop the connection the way a sleeping laptop would.
  c.req.destroy();
  await c.submit(ev('note.posted', 'human:priya', { text: 'two' }));

  await until(() => seen.length >= 2, 8000);
  assert.equal(seen.filter((e) => e.seq === 1).length, 1, 'event 1 is not delivered twice');
  assert.equal(seen[seen.length - 1].payload.text, 'two');
  c.close();
  await api.close();
});

test('a resent submission is not duplicated', async () => {
  const { api, base, log } = await boot();
  const c = new SessionClient({ base, sessionId: S });
  const once = { ...ev('note.posted', 'human:priya', { text: 'hi' }), clientId: 'c-1' };
  await c.submit(once);
  const again = await c.submit(once); // the retry after a timeout
  assert.equal(again.written.length, 0);
  assert.equal(log.read(S).length, 1);
  await api.close();
});

/* ---------------- presence ---------------- */

test('presence reports who is in the room and what they are looking at', async () => {
  const { api, base } = await boot();
  const a = new SessionClient({ base, sessionId: S, as: 'priya' });
  const rosters = [];
  a.on('presence', (p) => rosters.push(p));
  a.connect();
  await until(() => rosters.length >= 1);
  assert.equal(rosters[rosters.length - 1][0].name, 'priya');

  const b = new SessionClient({ base, sessionId: S, as: 'sam' });
  b.connect();
  await until(() => (rosters[rosters.length - 1] || []).length === 2);

  await b.presence('src/index.js');
  await until(() => {
    const last = rosters[rosters.length - 1] || [];
    return last.find((m) => m.name === 'sam' && m.viewing === 'src/index.js');
  });

  b.close();
  await until(() => (rosters[rosters.length - 1] || []).length === 1, 6000);
  assert.equal(rosters[rosters.length - 1][0].name, 'priya', 'leaving the room removes you from it');
  a.close();
  await api.close();
});

/* ---------------- waiting for a server ---------------- */

test('waitForServer resolves once a server answers, and gives up otherwise', async () => {
  const { api, base } = await boot();
  assert.equal(await waitForServer(base), true);
  await api.close();
  assert.equal(await waitForServer(base, { timeoutMs: 600 }), false);
});
