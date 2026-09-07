'use strict';
// Acceptance test for issue #11 (P10): delegating approval rights and resolving a real
// action once.
//
// An approval is the moment a person takes responsibility for something a machine is about
// to do, so the interesting failures are all about identity and timing: an answer that names
// only a request id and not the action, two people answering at once, an answer that arrives
// after the host restarted, and a decision that quietly widens to cover a whole session.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { TurnSession } = require('../packages/runtime/session');
const { TeamOps, Commands, Errors, Events, ApprovalDecision } = require('../packages/protocol');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
async function refused(name, code, fn) {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  assert.ok(error, name + ': expected a refusal, but it succeeded');
  const got = String(error.error || error.message || error);
  assert.ok(got.includes(code), name + ': expected ' + code + ', got ' + got);
  results.push({ name, status: 'pass', refusal: code });
  console.log('  PASS ' + name + ' - ' + code);
  return got;
}
const waitFor = async (fn, label = '') => {
  for (let n = 0; n < 400; n++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout: ' + label);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-approval-'));
let hub, runtime, clients = [];

class Client {
  constructor(url, name) { this.url = url; this.name = name; this.events = []; this.waiters = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => this.ws.send(JSON.stringify({ type: 'hello', role: 'client', name: this.name })));
      this.ws.addEventListener('error', reject);
      this.ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'event') this.events.push(m);
        if (m.type === 'welcome') { this.me = m.user; resolve(m); }
        for (const w of this.waiters.slice()) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
      });
    });
  }
  op(msg) {
    const id = msg.id || 'op_' + randomBytes(8).toString('hex');
    this.ws.send(JSON.stringify({ ...msg, id }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout: ' + (msg.command?.method || msg.type))), 20000);
      this.waiters.push({
        pred: (m) => m.ref === id || (m.type === 'command.result' && m.id === id),
        resolve: (m) => {
          clearTimeout(timer);
          if (m.type === 'error') return reject(Object.assign(new Error(m.message || m.code), { error: m.code }));
          if (m.type === 'command.result' && !m.ok) return reject(Object.assign(new Error(m.error), { error: m.error }));
          resolve(m);
        }
      });
    });
  }
  command(threadId, command, id) { return this.op({ type: 'command', threadId, command, id }); }
  subscribe(threadId) { this.ws.send(JSON.stringify({ type: 'thread.subscribe', threadId })); }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  // ---------- the pure part: expiry, without waiting ten minutes ----------
  const expired = new TurnSession({
    thread: { id: 'thr_x', cwd: tmp }, by: { name: 'alice' }, input: [], provider: { id: 'demo' },
    settings: {}, executor: { id: 'local' }, emit: () => {}, approvalTtlMs: -1
  });
  const waiting = expired.requestApproval(Events.COMMAND_REQUEST_APPROVAL, { command: 'rm -rf build', cwd: tmp });
  const pendingId = [...expired.pendingApprovals.keys()][0];
  const pendingRec = expired.pendingApprovals.get(pendingId);
  let expiryCode = null;
  try {
    expired.resolveApproval(pendingId, ApprovalDecision.ACCEPT, { name: 'alice' }, { turnId: expired.turnId, fingerprint: pendingRec.fingerprint });
  } catch (e) { expiryCode = e.code; }
  assert.equal(expiryCode, Errors.APPROVAL_EXPIRED);
  assert.equal(await waiting, ApprovalDecision.DECLINE, 'an expired request declines rather than hanging');
  pass('an answer after the request expired is refused, and the action is declined', Errors.APPROVAL_EXPIRED);

  // ---------- and the whole path ----------
  hub = new Hub({ dbFile: path.join(tmp, 'hub.sqlite'), log: () => {} });
  const addr = await hub.listen();
  const url = 'http://127.0.0.1:' + addr.port;
  const project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build', 'out.txt'), 'x\n');
  runtime = new Runtime({ hubUrl: url.replace('http', 'ws'), userName: 'host', dataDir: path.join(tmp, 'runtime'), projects: [project] });
  await runtime.start();

  const alice = new Client(url.replace('http', 'ws'), 'alice');
  const bob = new Client(url.replace('http', 'ws'), 'bob');
  const carol = new Client(url.replace('http', 'ws'), 'carol');
  clients = [alice, bob, carol];
  await Promise.all([alice.connect(), bob.connect(), carol.connect()]);
  await waitFor(() => hub.pendingPairings.size, 'pairing');
  const team = (await alice.op({ type: TeamOps.TEAM_CREATE, name: 'Approval team' })).team;
  await alice.op({ type: TeamOps.RUNTIME_PAIR, teamId: team.id, code: runtime.pairingCode });
  await waitFor(() => runtime.teamId === team.id, 'paired');
  for (const guest of [bob, carol]) {
    const invite = await alice.op({ type: TeamOps.INVITE_CREATE, teamId: team.id, inviteeUserId: guest.me.id, ttlMs: 60000 });
    await guest.op({ type: TeamOps.INVITE_ACCEPT, code: invite.invitation.code });
  }
  const started = await alice.op({ type: 'command', runtimeId: runtime.id, command: { method: Commands.THREAD_START, cwd: project } });
  const threadId = started.result.thread.id;
  for (const c of clients) c.subscribe(threadId);

  const askFor = async (text) => {
    await alice.command(threadId, { method: Commands.TURN_START, input: [{ type: 'text', text }] });
    return waitFor(() => alice.events.find((e) => e.method === Events.COMMAND_REQUEST_APPROVAL && !e.seen && (e.seen = true)), 'approval request');
  };
  const request = await askFor('Delete the build directory');
  assert.ok(request.requestId && request.turnId && request.fingerprint, 'the request names itself, its turn and its action');

  // ================= criterion 4: per-action only =================

  assert.deepEqual(request.availableDecisions, [ApprovalDecision.ACCEPT, ApprovalDecision.DECLINE, ApprovalDecision.CANCEL]);
  assert.equal(request.availableDecisions.includes(ApprovalDecision.ACCEPT_FOR_SESSION), false);
  pass('session-wide approval is never offered', request.availableDecisions.join('/'));

  // ================= criterion 1: collaboration is not approval =================

  await refused('a teammate without the grant cannot approve', Errors.NOT_APPROVER,
    () => bob.command(threadId, { method: Commands.APPROVAL_RESOLVE, requestId: request.requestId, decision: 'accept', turnId: request.turnId, fingerprint: request.fingerprint }));

  await alice.op({ type: TeamOps.APPROVER_GRANT, teamId: team.id, userId: bob.me.id });
  await alice.op({ type: TeamOps.APPROVER_GRANT, teamId: team.id, userId: carol.me.id });

  await refused('an approver must still name the turn and the action', Errors.APPROVAL_BINDING_REQUIRED,
    () => bob.command(threadId, { method: Commands.APPROVAL_RESOLVE, requestId: request.requestId, decision: 'accept' }));

  await refused('an answer for a different turn is refused', Errors.STALE_TURN,
    () => bob.command(threadId, { method: Commands.APPROVAL_RESOLVE, requestId: request.requestId, decision: 'accept', turnId: 'turn_other', fingerprint: request.fingerprint }));

  await refused('an answer describing a different action is refused', Errors.APPROVAL_ACTION_CHANGED,
    () => bob.command(threadId, { method: Commands.APPROVAL_RESOLVE, requestId: request.requestId, decision: 'accept', turnId: request.turnId, fingerprint: 'deadbeef'.repeat(4) }));

  await refused('session-wide approval is refused if a client sends it anyway', Errors.APPROVAL_SCOPE_UNSUPPORTED,
    () => bob.command(threadId, { method: Commands.APPROVAL_RESOLVE, requestId: request.requestId, decision: ApprovalDecision.ACCEPT_FOR_SESSION, turnId: request.turnId, fingerprint: request.fingerprint }));

  // ================= criterion 2: the exact action, and one winner =================

  const shown = await waitFor(() => {
    const t = hub.store.getThread(threadId);
    return t && t.pendingApproval && t.pendingApproval.requestId === request.requestId ? t.pendingApproval : null;
  }, 'pending approval shown');
  assert.equal(shown.command, 'rm -rf build');
  assert.equal(shown.fingerprint, request.fingerprint);
  assert.ok(shown.reason, 'and why it is being asked');
  pass('the exact pending action and its context are shown', shown.command + ' - ' + shown.reason.slice(0, 40));

  const answer = (client, decision) => client.command(threadId, {
    method: Commands.APPROVAL_RESOLVE, requestId: request.requestId, decision,
    turnId: request.turnId, fingerprint: request.fingerprint
  }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: String(e.error || e.message) }));

  const [first, second] = await Promise.all([answer(bob, 'accept'), answer(carol, 'decline')]);
  const winners = [first, second].filter((x) => x.ok);
  const losers = [first, second].filter((x) => !x.ok);
  assert.equal(winners.length, 1, 'exactly one answer was authoritative');
  assert.equal(losers.length, 1);
  assert.match(losers[0].error, /approval_already_settled/);
  assert.match(losers[0].error, /bob|carol/, 'and it names who answered');
  pass('two competing answers yield one resolution, and the loser is told who won', losers[0].error);

  const resolved = await waitFor(() => alice.events.find((e) => e.method === Events.SERVER_REQUEST_RESOLVED && e.requestId === request.requestId), 'resolution broadcast');
  assert.ok(['bob', 'carol'].includes(resolved.by.name));
  assert.equal(resolved.decision, winners[0].r.result.settled.decision);
  pass('every client sees the authoritative actor and outcome', resolved.by.name + ' ' + resolved.decision);

  // ================= criterion 3: replays, stale grants, restarts =================

  const replay = await refused('replaying the winning answer is refused', Errors.APPROVAL_SETTLED,
    () => answer(bob, 'accept').then((x) => { if (!x.ok) throw Object.assign(new Error(x.error), { error: x.error }); return x; }));
  assert.match(replay, /bob|carol/, 'the replay is told who answered');
  pass('a replayed answer changes nothing and reports the original', replay);

  const dispatches = () => hub.store.eventsFrom(threadId).filter((e) => e.method === Events.ITEM_COMPLETED &&
    e.item?.type === 'commandExecution' && e.item.command === 'rm -rf build');
  await waitFor(() => hub.store.eventsFrom(threadId).some((e) => e.method === Events.TURN_COMPLETED), 'turn ended');
  assert.equal(dispatches().length, 1, 'the approved action was dispatched once');
  pass('an accepted action is dispatched once, not once per answer', dispatches().length + ' dispatch');

  // A grant is current, not remembered: revoke it and the next answer is refused.
  // The first approval actually deleted it, so give the agent something to ask about again.
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build', 'out.txt'), 'again');
  const second_ = await askFor('Delete the build directory');
  await alice.op({ type: TeamOps.APPROVER_REVOKE, teamId: team.id, userId: bob.me.id });
  await refused('an approver whose grant was revoked can no longer answer', Errors.NOT_APPROVER,
    () => bob.command(threadId, { method: Commands.APPROVAL_RESOLVE, requestId: second_.requestId, decision: 'accept', turnId: second_.turnId, fingerprint: second_.fingerprint }));
  pass('approval authority is checked when the answer arrives', 'revocation takes effect immediately');

  // The host restarts while a request is outstanding. An answer arriving afterwards must be
  // told the request did not survive, not silently accepted against a fresh session.
  await carol.command(threadId, { method: Commands.APPROVAL_RESOLVE, requestId: second_.requestId, decision: 'decline', turnId: second_.turnId, fingerprint: second_.fingerprint });
  const settledSecond = await waitFor(() => hub.store.eventsFrom(threadId).find((e) => e.method === Events.SERVER_REQUEST_RESOLVED && e.requestId === second_.requestId), 'second settled');
  assert.equal(settledSecond.by.name, 'carol');

  runtime.stop();
  await waitFor(() => !hub.runtimes.has(runtime.id), 'host gone');
  runtime = new Runtime({ hubUrl: url.replace('http', 'ws'), userName: 'host', dataDir: path.join(tmp, 'runtime'), projects: [project] });
  await runtime.start();
  await waitFor(() => hub.runtimes.has(runtime.id), 'host back');

  const afterRestart = await refused('an answer for a request the restarted host settled reports who settled it', Errors.APPROVAL_SETTLED,
    () => carol.command(threadId, { method: Commands.APPROVAL_RESOLVE, requestId: second_.requestId, decision: 'accept', turnId: second_.turnId, fingerprint: second_.fingerprint }));
  assert.match(afterRestart, /carol/, 'the record survived the restart');
  pass('a settled answer survives a host restart and is still authoritative', afterRestart);

  await refused('an answer naming a request the host never heard of says exactly that', Errors.APPROVAL_UNKNOWN,
    () => carol.command(threadId, { method: Commands.APPROVAL_RESOLVE, requestId: 'req_' + randomBytes(6).toString('hex'), decision: 'accept', turnId: second_.turnId, fingerprint: second_.fingerprint }));

  // A request that was genuinely outstanding when the host went away is a different case,
  // and gets a different answer.
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build', 'out.txt'), 'again');
  const orphan = await askFor('Delete the build directory');
  runtime.stop();
  await waitFor(() => !hub.runtimes.has(runtime.id), 'host gone again');
  runtime = new Runtime({ hubUrl: url.replace('http', 'ws'), userName: 'host', dataDir: path.join(tmp, 'runtime'), projects: [project] });
  await runtime.start();
  await waitFor(() => hub.runtimes.has(runtime.id), 'host back again');
  await refused('an answer to a request that did not survive the host says so', Errors.APPROVAL_STALE_AFTER_RESTART,
    () => carol.command(threadId, { method: Commands.APPROVAL_RESOLVE, requestId: orphan.requestId, decision: 'accept', turnId: orphan.turnId, fingerprint: orphan.fingerprint }));

  fs.mkdirSync(path.join(__dirname, '..', '.artifacts', 'approval-grants'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', '.artifacts', 'approval-grants', 'results.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log('\n' + results.length + ' approval checks passed');
})().then(async () => {
  for (const c of clients) c.close();
  try { runtime?.stop?.(); } catch {}
  await hub?.close?.(); process.exit(0);
}).catch(async (error) => {
  console.error('APPROVAL GRANTS FAILED\n', error);
  for (const c of clients) c.close();
  try { runtime?.stop?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
