// Acceptance test for issue #5 (P04): "Create a private team and pair an explicitly shared
// execution host". Every check is a boundary, so most of them assert that something is
// *refused*, and that it is refused with its own distinct error code - a suite where every
// denial says "unknown thread" would hide exactly the bugs this ticket is about.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hub } = require('../packages/hub/server');
const { Runtime, commandFingerprint } = require('../packages/runtime/index');
const { TurnSession, TOOLS } = require('../packages/runtime/session');
const { TeamOps, Errors, Commands } = require('../packages/protocol');

let passed = 0;
const seenCodes = new Set();
function ok(name, detail) { passed++; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); }

// Asserts the operation fails, and with the exact code we expect.
async function refused(name, code, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, name + ': expected a refusal, but it succeeded');
  const got = err.code || String(err.message || err);
  assert.ok(got === code || got.startsWith(code), `${name}: expected ${code}, got ${got}`);
  seenCodes.add(code);
  ok(name, code);
}

class Client {
  constructor(url, label) { this.url = url; this.label = label; this.msgs = []; this.waiters = []; }
  connect(hello) {
    return new Promise((resolve, reject) => {
      let welcomed = false;
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => this.ws.send(JSON.stringify({ type: 'hello', role: 'client', ...hello })));
      this.ws.addEventListener('error', reject);
      this.ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        if (m.type === 'error' && !welcomed) {
          const err = new Error(m.message);
          err.code = m.code;
          reject(err);
        }
        if (m.type === 'welcome') {
          welcomed = true;
          this.me = m.user;
          this.teams = m.teams;
          this.teamId = m.teamId;
          resolve(m);
        }
        for (const w of this.waiters.slice()) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
      });
    });
  }
  close() { try { this.ws.close(); } catch {} }
  waitFrom(from, pred, ms = 10000, label = '') {
    const hit = this.msgs.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout: ' + label)), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  // Sends one message and resolves with its reply, rejecting with an Error carrying .code
  // when the hub refuses it.
  async op(msg, replyType) {
    const from = this.msgs.length;
    const id = 'op_' + Math.random().toString(36).slice(2);
    this.ws.send(JSON.stringify({ ...msg, id }));
    const m = await this.waitFrom(from, (x) => (x.type === 'error') || (replyType ? x.type === replyType : x.ref === id), 10000, msg.type);
    if (m.type === 'error') { const e = new Error(m.message); e.code = m.code; throw e; }
    return m;
  }
  command(threadId, command, runtimeId) {
    const from = this.msgs.length;
    const id = 'cmd_' + Math.random().toString(36).slice(2);
    this.ws.send(JSON.stringify({ type: 'command', id, threadId, runtimeId, command }));
    return this.waitFrom(from, (m) => (m.type === 'command.result' && m.id === id) || m.type === 'error', 20000, command.method)
      .then((m) => {
        if (m.type === 'error') { const e = new Error(m.message); e.code = m.code; throw e; }
        if (!m.ok) { const e = new Error(m.error); e.code = String(m.error).split(':')[0]; throw e; }
        return m.result;
      });
  }
}

async function http(url, opts = {}) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-'));
  const shared = path.join(tmp, 'shared-project');
  const secret = path.join(tmp, 'not-shared');
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(secret, { recursive: true });
  fs.writeFileSync(path.join(shared, 'hello.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(secret, 'private.txt'), 'do not touch\n');
  fs.symlinkSync(shared, path.join(secret, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(secret, path.join(shared, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');

  const hub = new Hub({ dbFile: ':memory:', log: () => {} });
  const addr = await hub.listen(0);
  const url = `ws://127.0.0.1:${addr.port}`;
  const httpBase = `http://127.0.0.1:${addr.port}`;

  console.log('\nP04 team + pairing boundaries\n');

  // ---------------------------------------------------------------- AC1: teams ----
  console.log('AC1  team, invitation, membership');
  const alice = new Client(url, 'alice'); await alice.connect({ name: 'alice' });
  assert.deepEqual(alice.teams, [], 'a brand new account belongs to no team');
  ok('a new account starts with no team', 'teams=[]');

  await refused('reads before joining a team are refused', Errors.UNKNOWN_TEAM,
    () => alice.op({ type: 'threads.list' }, 'threads'));

  const created = await alice.op({ type: TeamOps.TEAM_CREATE, name: 'Retia' }, 'team');
  const teamId = created.team.id;
  assert.equal(created.membership.role, 'owner');
  ok('the creator of a team is its owner', teamId);

  const bob = new Client(url, 'bob'); await bob.connect({ name: 'bob' });
  const inv = await alice.op({ type: TeamOps.INVITE_CREATE, teamId, inviteeUserId: bob.me.id, ttlMs: 60000 }, 'invitation');
  assert.ok(inv.invitation.code && inv.invitation.expiresAt > Date.now());
  assert.equal(inv.invitation.invitee.userId, bob.me.id);
  assert.equal(inv.invitation.invitee.name, 'bob');
  ok('the owner can issue an expiring invitation to a named account', `bob, expires in ${Math.round((inv.invitation.expiresAt - Date.now()) / 1000)}s`);
  const staleAfterRemoval = await alice.op({ type: TeamOps.INVITE_CREATE, teamId, inviteeUserId: bob.me.id }, 'invitation');

  await refused('an invitation cannot be read as membership by an outsider', Errors.NOT_A_MEMBER,
    () => bob.op({ type: TeamOps.TEAM_MEMBERS, teamId }, 'users'));

  const expired = new Client(url, 'dave'); await expired.connect({ name: 'dave' });
  await refused('an invitation cannot be redeemed by a different authenticated account', Errors.INVITE_RECIPIENT_MISMATCH,
    () => expired.op({ type: TeamOps.INVITE_ACCEPT, code: inv.invitation.code }, 'team'));

  const joined = await bob.op({ type: TeamOps.INVITE_ACCEPT, code: inv.invitation.code }, 'team');
  assert.equal(joined.team.id, teamId);
  assert.equal(joined.membership.role, 'member');
  ok('an authenticated user can accept the invitation', 'bob joined as member');

  await refused('an invitation cannot replace an existing membership role', Errors.ALREADY_MEMBER,
    () => alice.op({ type: TeamOps.INVITE_CREATE, teamId, inviteeUserId: bob.me.id, role: 'owner' }, 'invitation'));

  await refused('the same invitation cannot be redeemed twice', Errors.INVITE_USED,
    () => bob.op({ type: TeamOps.INVITE_ACCEPT, code: inv.invitation.code }, 'team'));

  const shortInv = await alice.op({ type: TeamOps.INVITE_CREATE, teamId, inviteeUserId: expired.me.id, ttlMs: 60000 }, 'invitation');
  hub.store.getInvitation(shortInv.invitation.code); // exists
  hub.store._stmts.insertInvite; // (schema touched above)
  // Force expiry by redeeming with a clock past the TTL, through the store the hub uses.
  const expiredResult = hub.store.redeemInvitation(shortInv.invitation.code, expired.me.id, Date.now() + 120000);
  assert.equal(expiredResult.reason, Errors.INVITE_EXPIRED);
  seenCodes.add(Errors.INVITE_EXPIRED);
  ok('an invitation past its expiry is refused', Errors.INVITE_EXPIRED);

  const revoked = await alice.op({ type: TeamOps.INVITE_CREATE, teamId, inviteeUserId: expired.me.id }, 'invitation');
  await alice.op({ type: TeamOps.INVITE_REVOKE, code: revoked.invitation.code }, 'ok');
  await refused('a revoked invitation is refused', Errors.INVITE_REVOKED,
    () => expired.op({ type: TeamOps.INVITE_ACCEPT, code: revoked.invitation.code }, 'team'));

  // The bypass this ticket names: logging in as an existing member's name.
  const impostor = new Client(url, 'impostor'); await impostor.connect({ name: 'alice' });
  assert.notEqual(impostor.me.id, alice.me.id, 'same name must not resolve to the same account');
  assert.deepEqual(impostor.teams, [], 'a same-named stranger inherits nothing');
  ok('name-only login does not become an existing account', `${impostor.me.id} != ${alice.me.id}`);
  await refused('a same-named stranger cannot read the team', Errors.NOT_A_MEMBER,
    () => impostor.op({ type: TeamOps.TEAM_MEMBERS, teamId }, 'users'));

  // Caller-supplied roles: bob is a member and says so; the hub asks the database instead.
  await refused('a member cannot issue invitations', Errors.OWNER_REQUIRED,
    () => bob.op({ type: TeamOps.INVITE_CREATE, teamId, role: 'owner' }, 'invitation'));
  await refused('a member cannot remove members', Errors.OWNER_REQUIRED,
    () => bob.op({ type: TeamOps.MEMBER_REMOVE, teamId, userId: alice.me.id }, 'ok'));

  // ------------------------------------------------------------- AC2: pairing ----
  console.log('\nAC2  execution host pairing and authorized workspaces');
  const rt = new Runtime({
    hubUrl: url, userName: 'alice', dataDir: path.join(tmp, 'rt'),
    projects: [shared], maxPreset: 'read-only', log: () => {}
  });
  await rt.start();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(rt.pairingCode && !rt.teamId, 'an unpaired host holds a code and no team');
  const initialPairingCode = rt.pairingCode;
  ok('a fresh host is unpaired and shows a local code', rt.pairingCode);

  await refused('pairing with a wrong code is refused', Errors.PAIRING_INVALID,
    () => alice.op({ type: TeamOps.RUNTIME_PAIR, teamId, code: 'ZZZZ-ZZZZ' }, 'runtime.paired'));
  await refused('a member cannot pair a host to the team', Errors.OWNER_REQUIRED,
    () => bob.op({ type: TeamOps.RUNTIME_PAIR, teamId, code: rt.pairingCode }, 'runtime.paired'));

  const paired = await alice.op({ type: TeamOps.RUNTIME_PAIR, teamId, code: rt.pairingCode }, 'runtime.paired');
  assert.equal(paired.runtimeId, rt.id);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(rt.teamId, teamId, 'the host learned it is paired');
  ok('the code shown on the host pairs it to the team', `${rt.id} -> ${teamId}`);

  const runtimeImpostor = new Client(url, 'runtime impostor');
  await refused('claiming a paired runtime id without its host credential is refused', Errors.RUNTIME_AUTHENTICATION,
    () => runtimeImpostor.connect({
      role: 'runtime', name: 'mallory', runtimeToken: 'wrong-runtime-secret',
      runtime: { id: rt.id, name: 'hijacked host', projects: [] }, pairingCode: 'MALL-0RY1'
    }));
  const runtimesAfterImpersonation = await alice.op({ type: 'runtimes.list' }, 'runtimes');
  const listedRuntime = runtimesAfterImpersonation.runtimes.find((r) => r.id === rt.id);
  assert.ok(listedRuntime && listedRuntime.name !== 'hijacked host' && listedRuntime.online);
  assert.deepEqual(listedRuntime.presets, ['read-only']);
  assert.equal(listedRuntime.defaultPreset, 'read-only');
  ok('the fleet advertises only presets the host permits', 'read-only default');

  await refused('a remote caller cannot register a path on the host', Errors.PROJECT_ADD_LOCAL_ONLY,
    () => bob.command(null, { method: Commands.PROJECT_ADD, dir: secret }, rt.id));

  await refused('a thread cannot be started outside a shared project', Errors.PROJECT_NOT_AUTHORIZED,
    () => bob.command(null, { method: Commands.THREAD_START, cwd: secret, name: 'sneaky' }, rt.id));

  const thread = (await bob.command(null, { method: Commands.THREAD_START, cwd: shared, name: 'legit' }, rt.id)).thread;
  assert.equal(thread.orgId, teamId, 'the host persists the team boundary with its local thread');
  assert.equal(thread.settings.preset, 'read-only');
  assert.equal(thread.settings.sandboxPolicy, 'read-only');
  ok('a host policy ceiling also constrains the default preset', 'read-only');
  ok('a member can start a thread in a shared project', thread.id);

  await refused('a thread requires an explicitly authorized workspace', Errors.PROJECT_NOT_AUTHORIZED,
    () => bob.command(null, { method: Commands.THREAD_START, name: 'no workspace' }, rt.id));
  await refused('raw policy fields cannot bypass the host ceiling', Errors.POLICY_ESCALATION,
    () => bob.command(null, { method: Commands.THREAD_START, cwd: shared, settings: { approvalPolicy: 'never', sandboxPolicy: 'danger-full-access' } }, rt.id));

  await refused('a turn cannot escalate past the host policy ceiling', Errors.POLICY_ESCALATION,
    () => bob.command(thread.id, { method: Commands.TURN_START, input: [{ type: 'text', text: 'hi' }], settings: { preset: 'full-access' } }));
  await refused('thread settings cannot escalate it either', Errors.POLICY_ESCALATION,
    () => bob.command(thread.id, { method: Commands.THREAD_SETTINGS_UPDATE, settings: { preset: 'full-access' } }));
  await refused('direct git mutation also obeys the read-only ceiling', Errors.POLICY_ESCALATION,
    () => bob.command(thread.id, { method: Commands.GIT_COMMIT, message: 'must not run' }));
  await refused('remote Git inspection stays disabled without a project-confined sandbox', Errors.PROJECT_OPERATION_UNAVAILABLE,
    () => bob.command(thread.id, { method: Commands.GIT_DIFF }));
  await refused('remote worktree creation stays disabled without a project-confined sandbox', Errors.PROJECT_OPERATION_UNAVAILABLE,
    () => bob.command(null, { method: Commands.THREAD_START, cwd: shared, worktree: true }, rt.id));
  await refused('a raw client cannot select a hidden CLI provider', Errors.PROVIDER_NOT_ISOLATED,
    () => bob.command(thread.id, {
      method: Commands.TURN_START, input: [{ type: 'text', text: 'read outside the project' }],
      settings: { preset: 'read-only', provider: 'codex-cli' }
    }));

  const workspaceSession = new TurnSession({
    thread: { id: 'thr_workspace_boundary', cwd: shared, workDir: shared, settings: {} },
    by: { userId: bob.me.id, name: 'bob' }, input: [], provider: { id: 'demo' }, model: 'demo-agent',
    settings: { approvalPolicy: 'never', sandboxPolicy: 'workspace-write' }, executor: rt.executor,
    emit: () => {}, history: []
  });
  const absoluteRead = await workspaceSession.readFile(path.join(secret, 'private.txt'));
  const traversalWrite = await workspaceSession.writeFile('../not-shared/private.txt', 'stolen\n');
  const symlinkRead = await workspaceSession.readFile('outside-link/private.txt');
  const symlinkWrite = await workspaceSession.writeFile('outside-link/new.txt', 'stolen\n');
  const gitConfigWrite = await workspaceSession.writeFile('.git/config', '[core]\n\tfsmonitor = touch /tmp/outside\n');
  const approvedRemove = await workspaceSession.removePath('../not-shared/private.txt');
  const rawShell = await rt.executor.run(`cat ${path.join(secret, 'private.txt')}`, { cwd: shared });
  assert.equal(absoluteRead.item.status, 'declined');
  assert.equal(traversalWrite.item.status, 'declined');
  assert.equal(symlinkRead.item.status, 'declined');
  assert.equal(symlinkWrite.item.status, 'declined');
  assert.equal(gitConfigWrite.item.status, 'declined');
  assert.equal(approvedRemove.item.status, 'declined');
  assert.equal(rawShell.code, -1);
  assert.equal(fs.readFileSync(path.join(secret, 'private.txt'), 'utf8'), 'do not touch\n');
  assert.ok(!fs.existsSync(path.join(secret, 'new.txt')));
  assert.ok(!TOOLS.some((tool) => tool.name === 'shell'));
  ok('model tools cannot read, write, remove, or shell outside the authorized workspace', 'structured capability refused every escape');

  // --------------------------------------------------- AC3: protocol + HTTP ----
  console.log('\nAC3  direct protocol and HTTP boundaries');
  const carol = new Client(url, 'carol'); await carol.connect({ name: 'carol' });
  const otherTeam = (await carol.op({ type: TeamOps.TEAM_CREATE, name: 'Other' }, 'team')).team;

  const foreignRuntime = new Runtime({
    hubUrl: url, userName: 'carol', dataDir: path.join(tmp, 'foreign-rt'),
    projects: [secret], log: () => {}
  });
  await foreignRuntime.start();
  await delay(200);
  await carol.op({ type: TeamOps.RUNTIME_PAIR, teamId: otherTeam.id, code: foreignRuntime.pairingCode }, 'runtime.paired');

  await refused('a rejected runtime credential never becomes a pairable challenge', Errors.PAIRING_INVALID,
    () => carol.op({ type: TeamOps.RUNTIME_PAIR, teamId: otherTeam.id, code: 'MALL-0RY1' }, 'runtime.paired'));

  const foreignThread = (await carol.command(null, {
    method: Commands.THREAD_START, cwd: secret, name: 'foreign workspace containment'
  }, foreignRuntime.id)).thread;

  // Hold one command open on a paired test host so another authenticated runtime can try
  // to forge the result. The hub must bind the result to the exact target socket.
  const fakeRuntime = new Client(url, 'result target');
  const fakeRuntimeId = 'rt_result_target';
  await fakeRuntime.connect({
    role: 'runtime', name: 'result target', runtimeToken: 'target-runtime-secret', pairingCode: 'FAKE-HOST',
    runtime: { id: fakeRuntimeId, name: 'result target', projects: [], presets: ['read-only'], defaultPreset: 'read-only' }
  });
  await alice.op({ type: TeamOps.RUNTIME_PAIR, teamId, code: 'FAKE-HOST' }, 'runtime.paired');
  const commandId = 'cmd_result_target';
  const aliceFrom = alice.msgs.length;
  const targetFrom = fakeRuntime.msgs.length;
  alice.ws.send(JSON.stringify({
    type: 'command', id: commandId, runtimeId: fakeRuntimeId,
    command: { method: Commands.MODEL_LIST }
  }));
  await fakeRuntime.waitFrom(targetFrom, (m) => m.type === 'command' && m.id === commandId, 10000, 'target command');
  const forgeryError = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: forged result refusal')), 5000);
    const onMessage = (m) => {
      if (m.type !== 'error') return;
      clearTimeout(timer);
      foreignRuntime.hub.off('message', onMessage);
      resolve(m);
    };
    foreignRuntime.hub.on('message', onMessage);
  });
  foreignRuntime.hub.send({ type: 'command.result', id: commandId, ok: true, result: { source: 'forged' } });
  const forgedFailure = await forgeryError;
  assert.equal(forgedFailure.code, Errors.RUNTIME_AUTHENTICATION);
  fakeRuntime.ws.send(JSON.stringify({ type: 'command.result', id: commandId, ok: true, result: { source: 'target' } }));
  const targetResult = await alice.waitFrom(aliceFrom,
    (m) => m.type === 'command.result' && m.id === commandId, 10000, 'authenticated target result');
  assert.equal(targetResult.result.source, 'target');
  ok('only the authenticated target runtime can resolve its command', Errors.RUNTIME_AUTHENTICATION);

  // The execution host, not merely the relay, owns command idempotency. A live duplicate
  // is refused, a completed retry returns the saved result, altered reuse conflicts, and a
  // pending record found after restart is never executed again with an invented outcome.
  const ledgerDir = path.join(tmp, 'command-ledger-runtime');
  const ledgerRuntime = new Runtime({ hubUrl: url, dataDir: ledgerDir, projects: [shared], log: () => {} });
  ledgerRuntime.teamId = teamId;
  const ledgerReplies = [];
  ledgerRuntime.hub = { send: (message) => ledgerReplies.push(message) };
  let releaseActive;
  const activeGate = new Promise((resolve) => { releaseActive = resolve; });
  let dispatches = 0;
  ledgerRuntime.dispatch = async () => { dispatches++; await activeGate; return { executed: dispatches }; };
  const ledgerBy = { userId: alice.me.id, name: 'alice' };
  const ledgerMessage = { id: 'cmd_ledger_once', threadId: null, by: ledgerBy, command: { method: Commands.MODEL_LIST } };
  const firstExecution = ledgerRuntime.onCommand(ledgerMessage);
  await delay(0);
  await ledgerRuntime.onCommand(ledgerMessage);
  assert.equal(ledgerReplies.at(-1).error, Errors.COMMAND_IN_PROGRESS);
  releaseActive();
  await firstExecution;
  await ledgerRuntime.onCommand(ledgerMessage);
  assert.equal(ledgerReplies.at(-1).result.executed, 1);
  assert.equal(dispatches, 1);
  await ledgerRuntime.onCommand({ ...ledgerMessage, command: { method: Commands.PROJECT_ADD } });
  assert.equal(ledgerReplies.at(-1).error, Errors.COMMAND_ID_CONFLICT);
  const uncertainMessage = { id: 'cmd_accepted_before_restart', threadId: null, by: ledgerBy, command: { method: Commands.MODEL_LIST } };
  ledgerRuntime.store.claimCommand(uncertainMessage.id,
    commandFingerprint(teamId, uncertainMessage.threadId, uncertainMessage.by, uncertainMessage.command));
  ledgerRuntime.store.close();
  const restartedLedgerRuntime = new Runtime({ hubUrl: url, dataDir: ledgerDir, projects: [shared], log: () => {} });
  restartedLedgerRuntime.teamId = teamId;
  const restartReplies = [];
  restartedLedgerRuntime.hub = { send: (message) => restartReplies.push(message) };
  await restartedLedgerRuntime.onCommand(uncertainMessage);
  assert.equal(restartReplies.at(-1).error, Errors.COMMAND_OUTCOME_UNKNOWN);
  restartedLedgerRuntime.hub = null;
  restartedLedgerRuntime.stop();
  ok('the host deduplicates command IDs and fails closed on a restart-uncertain outcome', 'one dispatch, cached retry, conflict and uncertain refusal');

  await refused('a member of another team cannot drive this host', Errors.FOREIGN_RUNTIME,
    () => carol.command(null, { method: Commands.THREAD_START, cwd: shared }, rt.id));
  await refused('an outsider cannot subscribe to the thread', Errors.NOT_A_MEMBER,
    () => carol.op({ type: 'thread.subscribe', threadId: thread.id }, 'thread.snapshot'));
  await refused('a thread that does not exist says so distinctly', Errors.UNKNOWN_THREAD,
    () => alice.op({ type: 'thread.subscribe', threadId: 'thr_does_not_exist' }, 'thread.snapshot'));

  const anon = await http(`${httpBase}/api/threads/${thread.id}/events`);
  assert.equal(anon.status, 401); assert.equal(anon.body.error, Errors.UNAUTHENTICATED);
  seenCodes.add(Errors.UNAUTHENTICATED);
  ok('the HTTP event fallback rejects an anonymous read', '401 ' + anon.body.error);

  const outsider = await http(`${httpBase}/api/threads/${thread.id}/events?token=${carol.me.token}`);
  assert.equal(outsider.status, 403); assert.equal(outsider.body.error, Errors.NOT_A_MEMBER);
  ok('the HTTP event fallback rejects a non-member', '403 ' + outsider.body.error);

  const missing = await http(`${httpBase}/api/threads/thr_nope/events?token=${alice.me.token}`);
  assert.equal(missing.status, 404); assert.equal(missing.body.error, Errors.UNKNOWN_THREAD);
  ok('an unknown thread over HTTP is distinct from a forbidden one', '404 ' + missing.body.error);

  const member = await http(`${httpBase}/api/threads/${thread.id}/events`, { headers: { authorization: 'Bearer ' + bob.me.token } });
  assert.equal(member.status, 200);
  ok('a member can still read history over HTTP', `200, ${member.body.events.length} events`);

  const foreignList = await http(`${httpBase}/api/threads?team=${teamId}&token=${carol.me.token}`);
  assert.equal(foreignList.status, 403);
  ok('the thread list is team-scoped over HTTP', '403 ' + foreignList.body.error);

  const foreignUpsertError = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: foreign thread upsert refusal')), 5000);
    const onMessage = (m) => {
      if (m.type !== 'error') return;
      clearTimeout(timer);
      foreignRuntime.hub.off('message', onMessage);
      resolve(m);
    };
    foreignRuntime.hub.on('message', onMessage);
  });
  foreignRuntime.hub.send({ type: 'thread.upsert', thread: { ...thread, name: 'stolen thread' } });
  const upsertFailure = await foreignUpsertError;
  assert.equal(upsertFailure.code, Errors.FOREIGN_THREAD);
  const stillPrivate = await http(`${httpBase}/api/threads/${thread.id}/events?token=${carol.me.token}`);
  assert.equal(stillPrivate.status, 403);
  ok('a foreign host cannot take over a known thread or its history', Errors.FOREIGN_THREAD);

  const deleteCandidate = (await alice.command(null, {
    method: Commands.THREAD_START, cwd: shared, name: 'delete from both stores'
  }, rt.id)).thread;
  const deleteOrigin = new Client(url, 'delete origin');
  await deleteOrigin.connect({ token: alice.me.token });
  const originalThreadDelete = rt.threadDelete.bind(rt);
  let releaseDelete;
  const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  rt.threadDelete = async (threadId) => { await deleteGate; return originalThreadDelete(threadId); };
  deleteOrigin.ws.send(JSON.stringify({ type: 'thread.delete', id: 'cmd_delete_both_stores', threadId: deleteCandidate.id }));
  for (let i = 0; i < 100 && !rt.activeCommands.has('cmd_delete_both_stores'); i++) await delay(10);
  assert.ok(rt.activeCommands.has('cmd_delete_both_stores'), 'host accepted the delete before the requester disconnected');
  deleteOrigin.close();
  await delay(100);
  releaseDelete();
  for (let i = 0; i < 100 && (hub.store.getThread(deleteCandidate.id) || rt.store.getThread(deleteCandidate.id)); i++) await delay(10);
  rt.threadDelete = originalThreadDelete;
  assert.equal(hub.store.getThread(deleteCandidate.id), null);
  assert.equal(rt.store.getThread(deleteCandidate.id), null);
  ok('thread deletion reconciles both stores after the requester disconnects', deleteCandidate.id);

  // ------------------------------------- AC4: administration is not authority ----
  console.log('\nAC4  administration is neither decryption nor approval authority');
  const members = (await alice.op({ type: TeamOps.TEAM_MEMBERS, teamId }, 'users')).users;
  assert.ok(members.every((m) => m.enrollment === 'pending'), 'every membership is enrollment-pending');
  ok('membership records encryption enrollment as pending', members.map((m) => `${m.name}:${m.role}/${m.enrollment}`).join(', '));
  const ownerMembership = members.find((m) => m.role === 'owner');
  assert.ok(!('decryption' in ownerMembership) && !('approver' in ownerMembership),
    'the membership row must not carry decryption or approval grants');
  ok('an owner row grants no decryption and no approval authority', 'role is administration only');

  // The criterion says administration alone grants no approval authority. That has to be
  // enforced, not merely reflected in the shape of a row.
  await refused('a member cannot resolve an approval', Errors.NOT_APPROVER,
    () => bob.command(thread.id, { method: Commands.APPROVAL_RESOLVE, requestId: 'req_x', decision: 'accept' }));
  await refused('the team owner cannot either, until delegated', Errors.NOT_APPROVER,
    () => alice.command(thread.id, { method: Commands.APPROVAL_RESOLVE, requestId: 'req_x', decision: 'accept' }));
  await refused('a member cannot grant themselves approval authority', Errors.OWNER_REQUIRED,
    () => bob.op({ type: TeamOps.APPROVER_GRANT, teamId, userId: bob.me.id }, 'ok'));

  await alice.op({ type: TeamOps.APPROVER_GRANT, teamId, userId: bob.me.id }, 'ok');
  const approvers = (await alice.op({ type: TeamOps.APPROVER_LIST, teamId }, 'approvers')).approvers;
  assert.equal(approvers.length, 1);
  assert.equal(approvers[0].userId, bob.me.id);
  ok('an owner delegates approval authority explicitly', `${approvers[0].name} granted by alice`);

  // Now the grant is what carries him past the gate - his membership is unchanged.
  await refused('a delegated approver reaches the host and is judged there', 'no such pending approval',
    () => bob.command(thread.id, { method: Commands.APPROVAL_RESOLVE, requestId: 'req_x', decision: 'accept' }));

  const memberRows = (await alice.op({ type: TeamOps.TEAM_MEMBERS, teamId }, 'users')).users;
  assert.ok(memberRows.every((m) => !('approver' in m)), 'the membership row must not carry approval authority');
  ok('approval authority lives apart from membership', 'separate grant, separate table');

  await alice.op({ type: TeamOps.APPROVER_REVOKE, teamId, userId: bob.me.id }, 'ok');
  await refused('revoking the grant ends approval authority', Errors.NOT_APPROVER,
    () => bob.command(thread.id, { method: Commands.APPROVAL_RESOLVE, requestId: 'req_x', decision: 'accept' }));

  // A removal in one team must not cancel this account's already-routed command in another.
  const bobOtherInvite = await carol.op({ type: TeamOps.INVITE_CREATE, teamId: otherTeam.id, inviteeUserId: bob.me.id }, 'invitation');
  await bob.op({ type: TeamOps.INVITE_ACCEPT, code: bobOtherInvite.invitation.code }, 'team');
  await bob.op({ type: 'team.switch', teamId }, 'team');
  const otherFakeRuntime = new Client(url, 'other team result target');
  const otherFakeRuntimeId = 'rt_other_result_target';
  await otherFakeRuntime.connect({
    role: 'runtime', name: 'other result target', runtimeToken: 'other-target-runtime-secret', pairingCode: 'OTHR-HOST',
    runtime: { id: otherFakeRuntimeId, name: 'other result target', projects: [], presets: ['read-only'], defaultPreset: 'read-only' }
  });
  await carol.op({ type: TeamOps.RUNTIME_PAIR, teamId: otherTeam.id, code: 'OTHR-HOST' }, 'runtime.paired');
  const crossTeamCommandId = 'cmd_other_team_survives_removal';
  const otherTargetFrom = otherFakeRuntime.msgs.length;
  const bobResultFrom = bob.msgs.length;
  bob.ws.send(JSON.stringify({ type: 'command', id: crossTeamCommandId, runtimeId: otherFakeRuntimeId, command: { method: Commands.MODEL_LIST } }));
  await otherFakeRuntime.waitFrom(otherTargetFrom, (m) => m.type === 'command' && m.id === crossTeamCommandId, 10000, 'other-team pending command');

  // Removal ends direct access and all content delivery on an already-open socket.
  await bob.op({ type: 'thread.subscribe', threadId: thread.id }, 'thread.snapshot');
  await alice.op({ type: TeamOps.MEMBER_REMOVE, teamId, userId: bob.me.id }, 'ok');
  otherFakeRuntime.ws.send(JSON.stringify({ type: 'command.result', id: crossTeamCommandId, ok: true, result: { preserved: true } }));
  const preservedResult = await bob.waitFrom(bobResultFrom,
    (m) => m.type === 'command.result' && m.id === crossTeamCommandId, 10000, 'other-team result after removal');
  assert.equal(preservedResult.result.preserved, true);
  ok('removal does not discard the member’s in-flight command in another team', otherTeam.id);
  await refused('a removed member loses team access at once', Errors.NOT_A_MEMBER,
    () => bob.op({ type: 'threads.list' }, 'threads'));
  const removedHttp = await http(`${httpBase}/api/threads/${thread.id}/events?token=${bob.me.token}`);
  assert.equal(removedHttp.status, 403);
  ok('a removed member also loses the HTTP fallback', '403 ' + removedHttp.body.error);
  const removedAt = bob.msgs.length;
  const canary = 'private-after-removal-' + Date.now();
  await alice.command(thread.id, { method: Commands.THREAD_NAME_SET, name: canary });
  await bob.op({ type: 'ping' }, 'pong');
  assert.ok(!bob.msgs.slice(removedAt).some((m) => JSON.stringify(m).includes(canary)));
  ok('a removed member receives no future thread content', 'existing socket stayed excluded');
  await refused('removal revokes older unused invitations for that account', Errors.INVITE_REVOKED,
    () => bob.op({ type: TeamOps.INVITE_ACCEPT, code: staleAfterRemoval.invitation.code }, 'team'));

  // Unpair detaches the team but keeps the installation credential reserved. The same
  // installation may present a fresh local code; a different machine cannot take its ID.
  await alice.op({ type: TeamOps.RUNTIME_UNPAIR, runtimeId: rt.id }, 'ok');
  for (let i = 0; i < 60 && (!rt.pairingCode || !hub.pendingPairings.has(rt.pairingCode)); i++) await delay(50);
  assert.ok(rt.pairingCode && hub.pendingPairings.has(rt.pairingCode), 'the original host offered a fresh local pairing challenge');
  assert.notEqual(rt.pairingCode, initialPairingCode, 'pairing codes are single-cycle credentials');
  const unpairedFleet = await alice.op({ type: 'runtimes.list' }, 'runtimes');
  assert.ok(!unpairedFleet.runtimes.some((runtime) => runtime.id === rt.id));
  ok('unpair removes the stale runtime descriptor from the team', rt.id);

  const runtimeReclaimer = new Client(url, 'runtime reclaimer');
  await refused('unpair does not make the runtime id claimable by another installation', Errors.RUNTIME_AUTHENTICATION,
    () => runtimeReclaimer.connect({
      role: 'runtime', name: 'mallory', runtimeToken: 'another-runtime-secret', pairingCode: 'TAKE-HOST',
      runtime: { id: rt.id, name: 'replacement host', projects: [] }
    }));
  await carol.op({ type: TeamOps.RUNTIME_PAIR, teamId: otherTeam.id, code: rt.pairingCode }, 'runtime.paired');
  await delay(100);
  assert.equal(rt.teamId, otherTeam.id);
  await refused('a re-paired host cannot run a command for its previous team thread', Errors.FOREIGN_RUNTIME,
    () => alice.command(thread.id, { method: Commands.THREAD_NAME_SET, name: 'must stay private' }));
  await refused('a re-paired host cannot delete its previous team thread', Errors.FOREIGN_RUNTIME,
    () => alice.op({ type: 'thread.delete', threadId: thread.id }, 'thread.deleted'));
  await assert.rejects(
    () => rt.dispatch({ method: Commands.THREAD_NAME_SET, name: 'host must refuse too' }, thread.id, { userId: alice.me.id }),
    new RegExp(Errors.FOREIGN_THREAD)
  );
  assert.ok(hub.store.getThread(thread.id) && rt.store.getThread(thread.id));
  ok('both the hub and execution host reject old-team routing after re-pairing', `${teamId} → ${otherTeam.id}`);
  await carol.op({ type: TeamOps.RUNTIME_UNPAIR, runtimeId: rt.id }, 'ok');
  for (let i = 0; i < 60 && (!rt.pairingCode || !hub.pendingPairings.has(rt.pairingCode)); i++) await delay(50);
  await alice.op({ type: TeamOps.RUNTIME_PAIR, teamId, code: rt.pairingCode }, 'runtime.paired');
  await delay(100);
  assert.equal(rt.teamId, teamId);
  ok('the original installation can re-pair with its reserved credential', rt.id);

  // ---------------------------------------------------------------- summary ----
  assert.ok(seenCodes.size >= 10, 'the boundaries should fail with distinct codes');
  ok('boundaries fail distinguishably', `${seenCodes.size} distinct error codes`);

  for (const c of [alice, bob, carol, expired, impostor, runtimeImpostor, runtimeReclaimer, fakeRuntime, otherFakeRuntime, deleteOrigin]) c.close();
  rt.stop();
  foreignRuntime.stop();
  await hub.close();
  console.log(`\n${passed} boundary checks passed ✅`);
  process.exit(0);
})().catch((err) => { console.error('\nFAILED:', err && err.message); console.error(err); process.exit(1); });
