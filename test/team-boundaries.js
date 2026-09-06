// Acceptance test for issue #5 (P04): "Create a private team and pair an explicitly shared
// execution host". Every check is a boundary, so most of them assert that something is
// *refused*, and that it is refused with its own distinct error code - a suite where every
// denial says "unknown thread" would hide exactly the bugs this ticket is about.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime/index');
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
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => this.ws.send(JSON.stringify({ type: 'hello', role: 'client', ...hello })));
      this.ws.addEventListener('error', reject);
      this.ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        if (m.type === 'welcome') { this.me = m.user; this.teams = m.teams; this.teamId = m.teamId; resolve(m); }
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

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-'));
  const shared = path.join(tmp, 'shared-project');
  const secret = path.join(tmp, 'not-shared');
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(secret, { recursive: true });
  fs.writeFileSync(path.join(shared, 'hello.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(secret, 'private.txt'), 'do not touch\n');

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

  const inv = await alice.op({ type: TeamOps.INVITE_CREATE, teamId, ttlMs: 60000 }, 'invitation');
  assert.ok(inv.invitation.code && inv.invitation.expiresAt > Date.now());
  ok('the owner can issue an expiring invitation', `expires in ${Math.round((inv.invitation.expiresAt - Date.now()) / 1000)}s`);

  const bob = new Client(url, 'bob'); await bob.connect({ name: 'bob' });
  await refused('an invitation cannot be read as membership by an outsider', Errors.NOT_A_MEMBER,
    () => bob.op({ type: TeamOps.TEAM_MEMBERS, teamId }, 'users'));

  const joined = await bob.op({ type: TeamOps.INVITE_ACCEPT, code: inv.invitation.code }, 'team');
  assert.equal(joined.team.id, teamId);
  assert.equal(joined.membership.role, 'member');
  ok('an authenticated user can accept the invitation', 'bob joined as member');

  await refused('the same invitation cannot be redeemed twice', Errors.INVITE_USED,
    () => bob.op({ type: TeamOps.INVITE_ACCEPT, code: inv.invitation.code }, 'team'));

  const shortInv = await alice.op({ type: TeamOps.INVITE_CREATE, teamId, ttlMs: 60000 }, 'invitation');
  hub.store.getInvitation(shortInv.invitation.code); // exists
  hub.store._stmts.insertInvite; // (schema touched above)
  const expired = new Client(url, 'dave'); await expired.connect({ name: 'dave' });
  // Force expiry by redeeming with a clock past the TTL, through the store the hub uses.
  const expiredResult = hub.store.redeemInvitation(shortInv.invitation.code, 'u_nobody', Date.now() + 120000);
  assert.equal(expiredResult.reason, Errors.INVITE_EXPIRED);
  seenCodes.add(Errors.INVITE_EXPIRED);
  ok('an invitation past its expiry is refused', Errors.INVITE_EXPIRED);

  const revoked = await alice.op({ type: TeamOps.INVITE_CREATE, teamId }, 'invitation');
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
    projects: [shared], maxPreset: 'agent', log: () => {}
  });
  await rt.start();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(rt.pairingCode && !rt.teamId, 'an unpaired host holds a code and no team');
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

  await refused('a remote caller cannot register a path on the host', Errors.PROJECT_ADD_LOCAL_ONLY,
    () => bob.command(null, { method: Commands.PROJECT_ADD, dir: secret }, rt.id));

  await refused('a thread cannot be started outside a shared project', Errors.PROJECT_NOT_AUTHORIZED,
    () => bob.command(null, { method: Commands.THREAD_START, cwd: secret, name: 'sneaky' }, rt.id));

  const thread = (await bob.command(null, { method: Commands.THREAD_START, cwd: shared, name: 'legit' }, rt.id)).thread;
  ok('a member can start a thread in a shared project', thread.id);

  await refused('a turn cannot escalate past the host policy ceiling', Errors.POLICY_ESCALATION,
    () => bob.command(thread.id, { method: Commands.TURN_START, input: [{ type: 'text', text: 'hi' }], settings: { preset: 'full-access' } }));
  await refused('thread settings cannot escalate it either', Errors.POLICY_ESCALATION,
    () => bob.command(thread.id, { method: Commands.THREAD_SETTINGS_UPDATE, settings: { preset: 'full-access' } }));

  // --------------------------------------------------- AC3: protocol + HTTP ----
  console.log('\nAC3  direct protocol and HTTP boundaries');
  const carol = new Client(url, 'carol'); await carol.connect({ name: 'carol' });
  const otherTeam = (await carol.op({ type: TeamOps.TEAM_CREATE, name: 'Other' }, 'team')).team;

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

  // ------------------------------------- AC4: administration is not authority ----
  console.log('\nAC4  administration is neither decryption nor approval authority');
  const members = (await alice.op({ type: TeamOps.TEAM_MEMBERS, teamId }, 'users')).users;
  assert.ok(members.every((m) => m.enrollment === 'pending'), 'every membership is enrollment-pending');
  ok('membership records encryption enrollment as pending', members.map((m) => `${m.name}:${m.role}/${m.enrollment}`).join(', '));
  const ownerMembership = members.find((m) => m.role === 'owner');
  assert.ok(!('decryption' in ownerMembership) && !('approver' in ownerMembership),
    'the membership row must not carry decryption or approval grants');
  ok('an owner row grants no decryption and no approval authority', 'role is administration only');

  // Removal ends access immediately.
  await alice.op({ type: TeamOps.MEMBER_REMOVE, teamId, userId: bob.me.id }, 'ok');
  await refused('a removed member loses team access at once', Errors.NOT_A_MEMBER,
    () => bob.op({ type: 'threads.list' }, 'threads'));
  const removedHttp = await http(`${httpBase}/api/threads/${thread.id}/events?token=${bob.me.token}`);
  assert.equal(removedHttp.status, 403);
  ok('a removed member also loses the HTTP fallback', '403 ' + removedHttp.body.error);

  // ---------------------------------------------------------------- summary ----
  assert.ok(seenCodes.size >= 10, 'the boundaries should fail with distinct codes');
  ok('boundaries fail distinguishably', `${seenCodes.size} distinct error codes`);

  for (const c of [alice, bob, carol, expired, impostor]) c.close();
  rt.stop();
  await hub.close();
  console.log(`\n${passed} boundary checks passed ✅`);
  process.exit(0);
})().catch((err) => { console.error('\nFAILED:', err && err.message); console.error(err); process.exit(1); });
