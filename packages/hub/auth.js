'use strict';
const crypto = require('node:crypto');
const COOKIE = '__Host-plexus-session';
const STATE_COOKIE = '__Host-plexus-login';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_MS = 10 * 60 * 1000;
const secret = () => crypto.randomBytes(32).toString('base64url');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const readCookie = (req, name) => (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1) || '';
const problem = (code, status = 400) => Object.assign(new Error(code), { code, status });

// Account login establishes a person, never device trust, membership or host authority.
class HostedAuth {
  constructor(store, { origin, clientId, clientSecret, allowedIds, fetch: fetchProvider = fetch, now = Date.now }) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || !clientId || !clientSecret) throw new Error('hosted_auth_configuration_required');
    this.origin = origin; this.clientId = clientId; this.clientSecret = clientSecret;
    this.allowedIds = allowedIds ? new Set(allowedIds) : null;
    this.fetch = fetchProvider; this.now = now; this.store = store; this.pending = new Map(); this.devices = new Map();
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS account_identities (
        provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL,
        login TEXT NOT NULL, email TEXT NOT NULL, PRIMARY KEY(provider,subject));
      CREATE TABLE IF NOT EXISTS account_sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS account_sessions_user ON account_sessions(user_id);
    `);
    store.accountAuthentication = token => this.account(token);
  }
  account(token) {
    if (typeof token !== 'string' || !/^ps_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.store.db.prepare('SELECT user_id, expires_at FROM account_sessions WHERE token_hash=? AND expires_at>?').get(hash(token), this.now());
    if (!row) return null;
    const user = this.store.userById(row.user_id);
    const identity = this.store.db.prepare('SELECT email, subject FROM account_identities WHERE user_id=?').get(row.user_id);
    if (!identity || (this.allowedIds && !this.allowedIds.has(identity.subject))) return null;
    return user ? { ...user, token, verifiedEmail: identity?.email, sessionExpiresAt: row.expires_at } : null;
  }
  invitee(email) {
    if (typeof email !== 'string' || email.length > 254) return null;
    const rows = this.store.db.prepare('SELECT DISTINCT user_id FROM account_identities WHERE email=?').all(email.trim().toLowerCase());
    return rows.length === 1 ? this.store.userById(rows[0].user_id) : null;
  }
  session(userId) {
    const token = 'ps_' + secret();
    this.store.db.prepare('DELETE FROM account_sessions WHERE expires_at<=?').run(this.now());
    this.store.db.prepare('INSERT INTO account_sessions VALUES (?,?,?)').run(hash(token), userId, this.now() + SESSION_MS);
    return token;
  }
  token(req) {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    return bearer && !['null', 'undefined'].includes(bearer) ? bearer : readCookie(req, COOKIE);
  }
  prepare(req) {
    const token = this.token(req);
    if (readCookie(req, COOKIE) && !['GET', 'HEAD'].includes(req.method) && req.headers.origin !== this.origin) throw problem('origin_rejected', 403);
    if (token) req.headers.authorization = 'Bearer ' + token;
    return token;
  }
  async providerJson(url, options) {
    const response = await this.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw problem('identity_provider_unavailable', 502);
    return response.json();
  }
  async githubUser(code, verifier) {
    const exchanged = await this.providerJson('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, code,
        redirect_uri: this.origin + '/api/auth/callback', code_verifier: verifier }).toString()
    });
    if (typeof exchanged.access_token !== 'string') throw problem('sign_in_failed', 401);
    const headers = { Authorization: 'Bearer ' + exchanged.access_token, Accept: 'application/vnd.github+json', 'User-Agent': 'Plexus' };
    const person = await this.providerJson('https://api.github.com/user', { headers });
    const emails = await this.providerJson('https://api.github.com/user/emails', { headers });
    const email = Array.isArray(emails) && (emails.find(entry => entry.verified && entry.primary) || emails.find(entry => entry.verified));
    if (!Number.isSafeInteger(person.id) || person.id <= 0 || !person.login || !email?.email) throw problem('verified_identity_required', 403);
    const subject = String(person.id);
    if (this.allowedIds && !this.allowedIds.has(subject)) throw problem('alpha_invitation_required', 403);
    const held = this.store.db.prepare('SELECT user_id FROM account_identities WHERE provider=? AND subject=?').get('github', subject);
    // Never attach a provider to an old account by display name or email.
    const user = held ? this.store.userById(held.user_id) : this.store.createAccount(person.name || person.login);
    if (!user) throw problem('account_unavailable', 401);
    this.store.db.prepare(`INSERT INTO account_identities VALUES (?,?,?,?,?) ON CONFLICT(provider,subject)
      DO UPDATE SET login=excluded.login,email=excluded.email`).run('github', subject, user.id, person.login, email.email.toLowerCase());
    return user;
  }
  failure(res, error, callback) {
    if (!callback) return this.json(res, error.status || 503, { error: error.code || 'sign_in_unavailable' });
    const messages = {
      sign_in_expired: 'This sign-in expired. Start again from Plexus.',
      sign_in_cancelled: 'Sign-in was cancelled. You can try again when you are ready.',
      alpha_invitation_required: 'Your GitHub account is not on the early-access list yet. Ask your Plexus contact for access.',
      verified_identity_required: 'Add and verify an email address in GitHub, then try again.'
    };
    const message = messages[error.code] || 'GitHub sign-in is unavailable right now. Please try again.';
    res.writeHead(error.status || 503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Plexus</title><link rel="stylesheet" href="/styles.css"></head><body data-theme="dark"><main class="login"><div class="login-card"><div class="brand big"><img src="/brand/plexus-lockup-primary.svg" alt="Plexus"></div><h1>Could not sign in</h1><p class="login-sub">${message}</p><a class="primary-btn" href="/">Return to Plexus</a></div></main></body></html>`);
  }
  async body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw problem('json_required', 415);
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 4096) throw problem('request_too_large', 413);
    }
    try {
      const body = JSON.parse(text);
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
      return body;
    } catch { throw problem('invalid_json'); }
  }
  json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body));
  }
  async handle(req, res, url, revoke) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (url.pathname === '/api/auth/config' && req.method === 'GET') return this.json(res, 200, { mode: 'github' });
    if (url.pathname === '/api/auth/login' && req.method === 'GET') {
      for (const [id, held] of this.pending) if (held.expires <= this.now()) this.pending.delete(id);
      if (this.pending.size >= 1000) throw problem('sign_in_busy', 429);
      const state = secret(), verifier = secret(), binding = secret();
      const returnTo = url.searchParams.get('returnTo') || '/';
      if (returnTo !== '/' && !/^\/(t|connect)\/[A-Za-z0-9_-]{1,80}$/.test(returnTo)) throw problem('invalid_return_path');
      this.pending.set(hash(state), { verifier, binding: hash(binding), returnTo, expires: this.now() + LOGIN_MS });
      const destination = new URL('https://github.com/login/oauth/authorize');
      destination.search = new URLSearchParams({ client_id: this.clientId, redirect_uri: this.origin + '/api/auth/callback',
        scope: 'read:user user:email', state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      res.writeHead(302, { Location: destination.href, 'Set-Cookie': cookie(STATE_COOKIE, binding, LOGIN_MS / 1000) }); return res.end();
    }
    if (url.pathname === '/api/auth/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state') || '';
      const held = this.pending.get(hash(state));
      if (!held || held.expires <= this.now() || held.binding !== hash(readCookie(req, STATE_COOKIE))) throw problem('sign_in_expired', 401);
      this.pending.delete(hash(state));
      res.setHeader('Set-Cookie', cookie(STATE_COOKIE, '', 0));
      if (url.searchParams.has('error') || !url.searchParams.get('code')) throw problem('sign_in_cancelled', 401);
      const user = await this.githubUser(url.searchParams.get('code'), held.verifier);
      const token = this.session(user.id);
      res.writeHead(302, { Location: held.returnTo, 'Set-Cookie': [cookie(STATE_COOKIE, '', 0), cookie(COOKIE, token, SESSION_MS / 1000)] }); return res.end();
    }
    if (url.pathname === '/api/auth/desktop/start' && req.method === 'POST') {
      const body = await this.body(req);
      if (!/^[A-Za-z0-9_-]{43}$/.test(body.challenge || '')) throw problem('invalid_challenge');
      for (const [id, held] of this.devices) if (held.expires <= this.now()) this.devices.delete(id);
      if (this.devices.size >= 1000) throw problem('sign_in_busy', 429);
      const id = secret();
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      this.devices.set(id, { challenge: body.challenge, code, expires: this.now() + LOGIN_MS });
      return this.json(res, 200, { id, code, url: this.origin + '/connect/' + id, expiresIn: LOGIN_MS / 1000 });
    }
    if (url.pathname === '/api/auth/desktop/exchange' && req.method === 'POST') {
      const body = await this.body(req), held = this.devices.get(body.id);
      if (!held || held.expires <= this.now()) throw problem('desktop_sign_in_expired', 401);
      if (typeof body.verifier !== 'string' || body.verifier.length > 128 ||
          crypto.createHash('sha256').update(body.verifier).digest('base64url') !== held.challenge) throw problem('invalid_verifier', 403);
      if (!held.userId) return this.json(res, 202, { pending: true });
      this.devices.delete(body.id);
      return this.json(res, 200, { token: this.session(held.userId) });
    }
    const token = this.prepare(req), user = this.account(token);
    if (url.pathname.startsWith('/api/auth/desktop/')) {
      if (!user) throw problem('unauthenticated', 401);
      const id = url.pathname.slice('/api/auth/desktop/'.length), held = this.devices.get(id);
      if (!held || held.expires <= this.now()) throw problem('desktop_sign_in_expired', 401);
      if (req.method === 'GET') return this.json(res, 200, { code: held.code, approved: !!held.userId });
      if (req.method === 'POST') {
        if (held.userId) throw problem('desktop_already_approved', 409);
        const body = await this.body(req);
        if (body.code !== held.code) throw problem('desktop_code_mismatch', 403);
        held.userId = user.id;
        return this.json(res, 200, { approved: true });
      }
      throw problem('method_not_allowed', 405);
    }
    if (url.pathname === '/api/auth/session' && req.method === 'GET') {
      return this.json(res, user ? 200 : 401, user ? { user: { id: user.id, name: user.name }, expiresAt: user.sessionExpiresAt } : { error: 'unauthenticated' });
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      if (user) { this.store.db.prepare('DELETE FROM account_sessions WHERE token_hash=?').run(hash(token)); revoke(token); }
      res.setHeader('Set-Cookie', cookie(COOKIE, '', 0)); return this.json(res, 200, { signedOut: true });
    }
    throw problem('not_found', 404);
  }
}

function hostedConfiguration(env) {
  if (!env.PLEXUS_AUTH_MODE || env.PLEXUS_AUTH_MODE === 'local') {
    if (env.RENDER || env.NODE_ENV === 'production' || (env.HUB_HOST && !['127.0.0.1', '::1', 'localhost'].includes(env.HUB_HOST))) throw new Error('hosted_auth_configuration_required');
    return null;
  }
  if (env.PLEXUS_AUTH_MODE !== 'github') throw new Error('unknown_auth_mode');
  if (!env.PLEXUS_ALPHA_GITHUB_IDS?.trim()) throw new Error('alpha_account_allowlist_required');
  if (!env.PLEXUS_ALPHA_GITHUB_IDS.split(',').every(id => /^[1-9][0-9]*$/.test(id.trim()))) throw new Error('invalid_alpha_account_allowlist');
  return { origin: env.PLEXUS_PUBLIC_ORIGIN, clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET,
    allowedIds: env.PLEXUS_ALPHA_GITHUB_IDS.split(',').map(id => id.trim()) };
}
module.exports = { HostedAuth, hostedConfiguration };
