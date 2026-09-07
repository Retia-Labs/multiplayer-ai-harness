'use strict';
// Acceptance test for issue #17 (P16): what everybody sees after a disconnection, a host
// restart, a stale answer and a command whose outcome nobody knows.
//
// The defect this issue was pointing at is the first one below. A host that vanished mid-turn
// left the thread marked active on every client, forever - the hub failed the pending command
// and marked the runtime offline, and then went on saying a turn was running on a machine that
// was not answering. When the host came back it re-announced that same stale status.
//
// The rule underneath all four scenarios: connectivity is not an outcome. Not knowing has to
// be sayable, because the alternatives are claiming work is still running or claiming it
// finished, and the second one is the dangerous claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { Commands, Events, Errors, ApprovalDecision } = require('../packages/protocol');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
async function refused(name, code, fn) {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  assert.ok(error, name + ': expected a refusal, but it succeeded');
  const got = error.code || String(error.message || error);
  assert.ok(got === code || got.includes(code), name + ': expected ' + code + ', got ' + got);
  results.push({ name, status: 'pass', refusal: code });
  console.log('  PASS ' + name + ' - ' + code);
}

class Client {
  constructor(url, name) { this.url = url; this.name = name; this.msgs = []; this.waiters = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => this.ws.send(JSON.stringify({ type: 'hello', role: 'client', name: this.name, token: this.token })));
      this.ws.addEventListener('error', reject);
      this.ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        if (m.type === 'welcome') { this.me = m.user; this.token = m.user.token; resolve(m); }
        for (const w of this.waiters.slice()) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
      });
    });
  }
  op(msg, replyType) {
    const id = 'op_' + randomBytes(8).toString('hex');
    this.ws.send(JSON.stringify({ ...msg, id }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout: ' + msg.type)), 15000);
      this.waiters.push({
        pred: (m) => m.ref === id || (m.type === 'error' && m.ref === id),
        resolve: (m) => {
          clearTimeout(timer);
          if (m.type === 'error') { const err = new Error(m.message || m.code); err.code = m.code; return reject(err); }
          if (replyType && m.type !== replyType) return reject(new Error('unexpected reply ' + m.type));
          resolve(m);
        }
      });
    });
  }
  command(threadId, command, runtimeId, id) {
    const cid = id || 'cmd_' + randomBytes(8).toString('hex');
    this.ws.send(JSON.stringify({ type: 'command', id: cid, threadId, runtimeId, command }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout: ' + command.method)), 15000);
      this.waiters.push({
        // A command can be refused by the hub before it ever reaches the host, and that
        // arrives as an error rather than a result. Both are answers.
        pred: (m) => (m.type === 'command.result' && m.id === cid) || (m.type === 'error' && m.ref === cid),
        resolve: (m) => {
          clearTimeout(timer);
          if (m.type === 'error') { const err = new Error(m.message || m.code); err.code = m.code; return reject(err); }
          if (!m.ok) { const err = new Error(m.error || 'refused'); err.code = m.error; return reject(err); }
          resolve(m);
        }
      });
    });
  }
  thread(id) { return this.msgs.filter((m) => m.type === 'thread.updated' && m.thread.id === id).pop(); }
  close() { try { this.ws.close(); } catch {} }
}

const waitFor = async (fn, label = '') => {
  for (let n = 0; n < 600; n++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout: ' + label);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-recover-'));
const project = path.join(tmp, 'workspace');
let hub, runtime, alice;

async function startRuntime(dataDir) {
  const rt = new Runtime({
    hubUrl: hub.url.replace('http', 'ws'), userName: 'host',
    dataDir, projects: [project], maxPreset: 'agent'
  });
  await rt.start();
  return rt;
}

(async () => {
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build', 'out.txt'), 'built');

  hub = new Hub({ dbFile: path.join(tmp, 'hub.sqlite'), log: () => {} });
  const addr = await hub.listen();
  hub.url = 'http://127.0.0.1:' + addr.port;
  const dataDir = path.join(tmp, 'runtime');

  runtime = await startRuntime(dataDir);
  alice = new Client(hub.url.replace('http', 'ws'), 'alice');
  await alice.connect();
  await waitFor(() => hub.pendingPairings.size, 'pairing offered');
  const team = (await alice.op({ type: 'team/create', name: 'Recovery team' }, 'team')).team;
  await alice.op({ type: 'runtime/pair', teamId: team.id, code: runtime.pairingCode });
  await waitFor(() => runtime.teamId === team.id, 'paired');

  // Answering approvals is a delegated right, not a consequence of owning the team.
  await alice.op({ type: 'team/approver/grant', teamId: team.id, userId: alice.me.id });
  const started = await alice.command(null, { method: Commands.THREAD_START, cwd: project, name: 'Recovery' }, runtime.id);
  const threadId = started.result.thread.id;
  alice.ws.send(JSON.stringify({ type: 'thread.subscribe', threadId }));

  // ---- a turn that parks on an approval, so there is something genuinely in flight ----
  // Not awaited: the turn parks on the approval and only settles later, which is the state
  // this whole test is about. A rejection would still surface, rather than being swallowed.
  const inFlight = alice.command(threadId, {
    method: Commands.TURN_START, input: [{ type: 'text', text: 'delete the build directory' }]
  }, runtime.id);
  inFlight.catch((error) => { if (!/runtime offline/.test(String(error.message))) throw error; });
  const asked = await waitFor(() => alice.msgs.find((m) => m.type === 'thread.updated' && m.thread.pendingApproval), 'approval asked');
  const pending = asked.thread.pendingApproval;
  assert.equal(asked.thread.status.type, 'active');
  pass('a turn is genuinely in flight, parked on an approval', pending.requestId);

  // ---- scenario 1: the host disappears ----
  runtime.hub.ws.close();
  const unknown = await waitFor(() => {
    const t = alice.thread(threadId);
    return t && t.thread.status.type === 'unknown' ? t : null;
  }, 'thread goes unknown');
  assert.equal(unknown.thread.status.wasRunning, pending.turnId);
  assert.equal(unknown.thread.pendingApproval, null, 'the prompt is withdrawn with the host');
  pass('a host that vanishes mid-turn leaves the work unknown, not running and not finished',
    'status unknown, was running ' + unknown.thread.status.wasRunning);

  // The distinction that matters: unknown is not idle, and not a completed turn.
  assert.notEqual(unknown.thread.status.type, 'idle');
  assert.notEqual(unknown.thread.lastTurnStatus, 'completed');
  pass('losing connectivity is not reported as a task that finished', 'never idle, never completed');

  // ---- scenario 2: the host restarts and says what it can account for ----
  try { runtime.stop?.(); } catch {}
  runtime = await startRuntime(dataDir);
  await waitFor(() => runtime.teamId === team.id, 'host back');
  const back = await waitFor(() => {
    const t = alice.thread(threadId);
    return t && t.thread.status.type === 'idle' ? t : null;
  }, 'thread reconciled');
  assert.equal(back.thread.lastTurnStatus, 'abandoned', 'abandoned, not completed: ' + back.thread.lastTurnStatus);
  assert.equal(back.thread.activeTurnId, null);
  pass('the restarted host records the turn as abandoned rather than finished', 'lastTurnStatus abandoned');

  const events = await (await fetch(hub.url + '/api/threads/' + threadId + '/events?limit=500', {
    headers: { authorization: 'Bearer ' + alice.token }
  })).json();
  const abandoned = (events.events || []).filter((e) => (e.method || '') === Events.TURN_ABANDONED);
  assert.equal(abandoned.length, 1, JSON.stringify((events.events || []).map((e) => e.method)));
  assert.equal(abandoned[0].reason, 'host_restarted');
  pass('the history says so too, so a teammate reading it later sees no unexplained gap', 'turn/abandoned recorded');

  // ---- scenario 3: a stale answer to a request that did not survive ----
  await refused('answering an approval whose turn did not survive is refused', Errors.APPROVAL_STALE_AFTER_RESTART,
    () => alice.command(threadId, {
      method: Commands.APPROVAL_RESOLVE, requestId: pending.requestId, decision: ApprovalDecision.ACCEPT,
      turnId: pending.turnId, fingerprint: pending.fingerprint
    }, runtime.id));

  await refused('and an id the host never issued is a different answer', Errors.APPROVAL_UNKNOWN,
    () => alice.command(threadId, {
      method: Commands.APPROVAL_RESOLVE, requestId: 'req_' + randomBytes(6).toString('hex'),
      decision: ApprovalDecision.ACCEPT, turnId: pending.turnId, fingerprint: pending.fingerprint
    }, runtime.id));

  // ---- scenario 4: a command whose completion nobody witnessed ----
  //
  // The same command id is sent twice. The second is not executed again: a side-effecting
  // command replayed because a client lost the answer is exactly what this criterion forbids.
  const cid = 'cmd_' + randomBytes(8).toString('hex');
  const first = await alice.command(threadId, { method: Commands.THREAD_NAME_SET, name: 'Renamed once' }, runtime.id, cid);
  assert.equal(first.ok, true);
  const second = await alice.command(threadId, { method: Commands.THREAD_NAME_SET, name: 'Renamed once' }, runtime.id, cid);
  assert.equal(second.duplicate, true, JSON.stringify(second));
  pass('a command re-sent under the same id returns the first answer instead of running again',
    'marked duplicate');

  await refused('the same id carrying different input is refused rather than silently applied',
    Errors.COMMAND_ID_CONFLICT,
    () => alice.command(threadId, { method: Commands.THREAD_NAME_SET, name: 'Something else' }, runtime.id, cid));

  // ---- and the thread is usable again, from a client that reconnects fresh ----
  const bob = new Client(hub.url.replace('http', 'ws'), 'alice');
  bob.token = alice.token;
  await bob.connect();
  bob.ws.send(JSON.stringify({ type: 'threads.list' }));
  const listed = await waitFor(() => bob.msgs.find((m) => m.type === 'threads'), 'threads listed');
  const seen = listed.threads.find((t) => t.id === threadId);
  assert.equal(seen.status.type, 'idle');
  assert.equal(seen.pendingApproval, null);
  assert.equal(seen.lastTurnStatus, 'abandoned');
  pass('a client connecting fresh is told the same story, not a stale one', 'idle, no prompt, abandoned');

  // No settings override: asking for a weaker approval policy than the host's preset allows
  // is refused as an escalation, which is its own correct behaviour and not this test's point.
  const ran = await bob.command(threadId, {
    method: Commands.TURN_START, input: [{ type: 'text', text: 'explore the repo' }]
  }, runtime.id);
  assert.ok(ran.ok);
  pass('and the task can be worked on again after the host comes back', 'a new turn runs');
  bob.close();

  const out = path.join(__dirname, '..', '.artifacts', 'recover-after-loss');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log('\n' + results.length + ' recovery-after-loss checks passed');
})().then(async () => {
  alice?.close();
  try { runtime?.stop?.(); } catch {}
  await hub?.close?.(); process.exit(0);
}).catch(async (error) => {
  console.error('RECOVERY AFTER LOSS FAILED\n', error);
  alice?.close();
  try { runtime?.stop?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
