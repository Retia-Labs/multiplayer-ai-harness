'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { Hub } = require('../packages/hub/server');
const auth = { origin: 'https://app.tryplexus.dev', clientId: 'test-client', clientSecret: 'test-secret' };

test('hosted service refuses name-only browser identity over WebSocket', async t => {
  const hub = new Hub({ auth }); const address = await hub.listen();
  t.after(() => hub.close());
  const ws = new WebSocket('ws://127.0.0.1:' + address.port, { origin: auth.origin });
  t.after(() => ws.terminate()); await once(ws, 'open');
  const response = once(ws, 'message'); ws.send(JSON.stringify({ type: 'hello', name: 'Alice', role: 'client' }));
  const message = JSON.parse((await response)[0]);
  assert.equal(message.type, 'error'); assert.equal(message.code, 'unauthenticated');
});

test('oversized unauthenticated frames close only the offending socket', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const { sessionCookie } = await f.finish(await f.login());
  const peer = await f.socket(sessionCookie);
  assert.equal(peer.message.type, 'welcome');
  const attacker = new WebSocket('ws://127.0.0.1:' + f.hub.server.address().port, { origin: auth.origin });
  t.after(() => attacker.terminate());
  await once(attacker, 'open');
  const closed = once(attacker, 'close');
  attacker.send(Buffer.alloc(1024 * 1024 + 1));
  assert.equal((await closed)[0], 1009);
  assert.equal((await f.request('/api/health')).status, 200);
  assert.equal(peer.ws.readyState, WebSocket.OPEN);
  const reply = once(peer.ws, 'pong');
  peer.ws.ping('still-connected');
  assert.equal((await reply)[0].toString(), 'still-connected');
});

async function fixture(t, options = {}, hubOptions = {}) {
  let person = { id: 42, login: 'alice', name: 'Alice' };
  let emails = [{ email: 'alice@example.test', primary: true, verified: true }];
  let clock = Date.now();
  const calls = [];
  const hub = new Hub({ ...hubOptions, auth: { ...auth, allowedIds: ['42'], now: () => clock, ...options,
    fetch: async (url, request) => {
      calls.push({ url, request });
      return { ok: true, json: async () => url.endsWith('access_token') ? { access_token: 'provider-secret' } : url.endsWith('/emails') ? emails : person };
    } } });
  const address = await hub.listen();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await hub.close(); } };
  t.after(close);
  const base = 'http://127.0.0.1:' + address.port;
  const request = (path, options) => fetch(base + path, { redirect: 'manual', ...options });
  async function login(returnTo = '/') {
    const start = await request('/api/auth/login?returnTo=' + encodeURIComponent(returnTo));
    assert.equal(start.status, 302);
    const destination = new URL(start.headers.get('location'));
    const binding = start.headers.getSetCookie()[0].split(';')[0];
    const callback = '/api/auth/callback?code=test-code&state=' + destination.searchParams.get('state');
    return { start, destination, binding, callback };
  }
  async function finish(flow) {
    const response = await request(flow.callback, { headers: { Cookie: flow.binding } });
    const sessionCookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-plexus-session='))?.split(';')[0];
    return { response, sessionCookie };
  }
  async function socket(sessionCookie, origin = auth.origin, hello = {}) {
    const ws = new WebSocket(base.replace('http:', 'ws:'), { origin, headers: sessionCookie ? { Cookie: sessionCookie } : {} });
    t.after(() => ws.terminate()); await once(ws, 'open');
    const next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'hello', role: 'client', ...hello }));
    return { ws, message: JSON.parse((await next)[0]) };
  }
  return { hub, close, request, login, finish, socket, calls, setPerson: value => { person = value; }, setEmails: value => { emails = value; }, advance: ms => { clock += ms; } };
}

test('OAuth uses browser-bound single-use state and S256; session cookies do not expose tokens in responses', async t => {
  const f = await fixture(t); const flow = await f.login('/t/task_1');
  assert.equal(flow.destination.origin, 'https://github.com');
  assert.equal(flow.destination.searchParams.get('code_challenge_method'), 'S256');
  assert.match(flow.start.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await f.request(flow.callback)).status, 401);
  assert.equal(f.calls.length, 0);
  const { response, sessionCookie } = await f.finish(flow);
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/t/task_1');
  const verifier = new URLSearchParams(f.calls[0].request.body).get('code_verifier');
  assert.equal(require('node:crypto').createHash('sha256').update(verifier).digest('base64url'), flow.destination.searchParams.get('code_challenge'));
  assert.equal((await f.finish(flow)).response.status, 401);
  const session = await f.request('/api/auth/session', { headers: { Cookie: sessionCookie } });
  assert.equal(session.status, 200); const body = await session.json();
  assert.equal(body.user.name, 'Alice'); assert.equal(body.user.token, undefined);
  const { message } = await f.socket(sessionCookie);
  assert.equal(message.type, 'welcome'); assert.equal(message.user.token, null);
  assert.deepEqual(message.teams, []);
});

test('hosted login rejects open redirects, expired state, unverified email and non-invited identities', async t => {
  const f = await fixture(t);
  for (const path of ['https://evil.test', '//evil.test', '/t/a/../../api/auth/logout']) {
    assert.equal((await f.request('/api/auth/login?returnTo=' + encodeURIComponent(path))).status, 400);
  }
  const expired = await f.login(); f.advance(600001);
  assert.equal((await f.finish(expired)).response.status, 401);
  f.setEmails([{ email: 'alice@example.test', verified: false }]);
  assert.equal((await f.finish(await f.login())).response.status, 403);
  f.setEmails([{ email: 'alice@example.test', verified: true }]);
  f.setPerson({ id: 43, login: 'alice' });
  assert.equal((await f.finish(await f.login())).response.status, 403);
});

test('immutable provider identity survives rename and never adopts a legacy name account', async t => {
  const f = await fixture(t); const legacy = f.hub.store.createAccount('Alice');
  const first = await f.finish(await f.login());
  const getUser = async sessionCookie => (await (await f.request('/api/auth/session', { headers: { Cookie: sessionCookie } })).json()).user;
  const user = await getUser(first.sessionCookie);
  assert.notEqual(user.id, legacy.id);
  f.setPerson({ id: 42, login: 'renamed', name: 'New name' });
  const second = await f.finish(await f.login());
  assert.equal((await getUser(second.sessionCookie)).id, user.id);
  assert.equal((await f.socket(null, auth.origin, { token: legacy.token })).message.code, 'unauthenticated');
  assert.equal((await f.request('/api/auth/session', { headers: { Authorization: 'Bearer ' + legacy.token } })).status, 401);
});

test('cross-origin session use is rejected and logout revokes the session and its live socket', async t => {
  const f = await fixture(t); const { sessionCookie } = await f.finish(await f.login());
  assert.equal((await f.socket(sessionCookie, 'https://evil.test')).message.code, 'unauthenticated');
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', headers: { Cookie: sessionCookie, Origin: 'https://evil.test' } })).status, 403);
  const { ws, message } = await f.socket(sessionCookie); assert.equal(message.type, 'welcome');
  const closed = once(ws, 'close');
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', headers: { Cookie: sessionCookie, Origin: auth.origin } })).status, 200);
  assert.equal((await closed)[0], 4001);
  assert.equal((await f.request('/api/auth/session', { headers: { Cookie: sessionCookie } })).status, 401);
});

test('expired sessions fail HTTP and live WebSocket commands', async t => {
  const f = await fixture(t); const { sessionCookie } = await f.finish(await f.login());
  const { ws } = await f.socket(sessionCookie); f.advance(7 * 86400000 + 1);
  assert.equal((await f.request('/api/auth/session', { headers: { Cookie: sessionCookie } })).status, 401);
  const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'team.create', name: 'Forbidden' }));
  assert.equal((await closed)[0], 4001);
});

test('hosted configuration fails closed for exposed local mode and missing alpha allowlist', () => {
  const { hostedConfiguration } = require('../packages/hub/auth');
  assert.equal(hostedConfiguration({}), null);
  for (const env of [{ RENDER: 'true' }, { NODE_ENV: 'production' }, { HUB_HOST: '0.0.0.0' }, { PLEXUS_AUTH_MODE: 'github' }]) {
    assert.throws(() => hostedConfiguration(env));
  }
});

test('desktop sign-in requires authenticated consent and the originating installation verifier, then consumes once', async t => {
  const f = await fixture(t);
  const verifier = require('node:crypto').randomBytes(32).toString('base64url');
  const challenge = require('node:crypto').createHash('sha256').update(verifier).digest('base64url');
  const post = (path, body, sessionCookie) => f.request(path, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(sessionCookie ? { Cookie: sessionCookie, Origin: auth.origin } : {})
  }, body: JSON.stringify(body) });
  const start = await post('/api/auth/desktop/start', { challenge });
  assert.equal(start.status, 200); const device = await start.json();
  assert.equal((await post('/api/auth/desktop/exchange', { id: device.id, verifier })).status, 202);
  assert.equal((await post('/api/auth/desktop/' + device.id, { code: device.code })).status, 401);
  const { sessionCookie } = await f.finish(await f.login('/connect/' + device.id));
  assert.equal((await post('/api/auth/desktop/' + device.id, { code: 'wrong' }, sessionCookie)).status, 403);
  assert.equal((await post('/api/auth/desktop/' + device.id, { code: device.code }, sessionCookie)).status, 200);
  assert.equal((await post('/api/auth/desktop/exchange', { id: device.id, verifier: 'wrong' })).status, 403);
  const exchanged = await post('/api/auth/desktop/exchange', { id: device.id, verifier });
  assert.equal(exchanged.status, 200); const { token } = await exchanged.json();
  assert.equal((await f.socket(null, auth.origin, { token })).message.type, 'welcome');
  assert.equal((await post('/api/auth/desktop/exchange', { id: device.id, verifier })).status, 401);
  assert.equal((await f.request('/api/auth/session', { headers: { Cookie: sessionCookie } })).status, 200);
});

test('sessions persist across a relay restart, store only hashes and remain revoked after another restart', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbFile = path.join(dir, 'hub.sqlite');
  const first = await fixture(t, {}, { dbFile });
  const { sessionCookie } = await first.finish(await first.login());
  const token = sessionCookie.split('=')[1];
  const rows = first.hub.store.db.prepare('SELECT * FROM account_sessions').all();
  assert.equal(rows.length, 1); assert.equal(JSON.stringify(rows).includes(token), false);
  await first.close();
  const second = await fixture(t, {}, { dbFile });
  assert.equal((await second.request('/api/auth/session', { headers: { Cookie: sessionCookie } })).status, 200);
  assert.equal((await second.request('/api/auth/logout', { method: 'POST', headers: { Cookie: sessionCookie, Origin: auth.origin } })).status, 200);
  await second.close();
  const third = await fixture(t, {}, { dbFile });
  assert.equal((await third.request('/api/auth/session', { headers: { Cookie: sessionCookie } })).status, 401);
  await third.close();
});

test('a parked execution host cannot create teams or use a failed hello to gain client authority', async t => {
  const f = await fixture(t);
  const { ws, message } = await f.socket(null, auth.origin, { role: 'runtime', runtime: { id: 'runtime-test' }, runtimeToken: 'installation-secret', pairingCode: 'ABC123' });
  assert.equal(message.type, 'welcome');
  const next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'team/create', name: 'Forbidden' }));
  assert.equal(JSON.parse((await next)[0]).code, 'unauthenticated');
  const failed = await f.socket(null, auth.origin, { role: 'runtime', runtime: { id: 'failed' } });
  assert.equal(failed.message.type, 'error');
  const rejected = once(failed.ws, 'message'); failed.ws.send(JSON.stringify({ type: 'team/create', name: 'Forbidden' }));
  assert.equal(JSON.parse((await rejected)[0]).code, 'unauthenticated');
});

test('hosted invitations resolve verified email, require an owner and bind acceptance to the intended account', async t => {
  const f = await fixture(t, { allowedIds: ['42', '43'] });
  const aliceLogin = await f.finish(await f.login()); const alice = await f.socket(aliceLogin.sessionCookie);
  f.setPerson({ id: 43, login: 'bob', name: 'Bob' }); f.setEmails([{ email: 'bob@example.test', verified: true }]);
  const bobLogin = await f.finish(await f.login()); const bob = await f.socket(bobLogin.sessionCookie);
  let sequence = 0;
  const command = (ws, message) => new Promise((resolve, reject) => {
    const id = 'request-' + ++sequence;
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('No response to ' + message.type)); }, 2000);
    const onMessage = data => { const result = JSON.parse(data); if (result.ref === id) { clearTimeout(timer); ws.off('message', onMessage); resolve(result); } };
    ws.on('message', onMessage); ws.send(JSON.stringify({ ...message, id }));
  });
  const created = await command(alice.ws, { type: 'team/create', name: 'Private team' }); const teamId = created.team.id;
  assert.equal((await command(bob.ws, { type: 'team/invite', teamId, inviteeEmail: 'alice@example.test' })).type, 'error');
  assert.equal((await command(alice.ws, { type: 'team/invite', teamId, inviteeEmail: 'missing@example.test' })).code, 'unknown_user');
  const invited = await command(alice.ws, { type: 'team/invite', teamId, inviteeEmail: ' BOB@example.test ' });
  assert.ok(invited.invitation.code);
  assert.equal((await command(alice.ws, { type: 'team/invite/accept', code: invited.invitation.code })).code, 'invitation_recipient_mismatch');
  const accepted = await command(bob.ws, { type: 'team/invite/accept', code: invited.invitation.code });
  assert.equal(accepted.team.id, teamId); assert.equal(accepted.membership.role, 'member');
});
