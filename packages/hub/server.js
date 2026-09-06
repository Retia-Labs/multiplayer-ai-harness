'use strict';
// Plexus hub: the sync service. Holds append-only thread event logs, presence,
// the runtime fleet registry, and routes human commands (start/steer/approve) to
// the single runtime that owns each thread. It never sees provider keys or runs
// inference — runtimes talk to model providers directly.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { HubStore, uid } = require('./store');
const { TeamOps, Errors, Roles, Commands } = require('../protocol');

// Authorization failures carry a code so a caller can tell them apart. `fail` is used for
// every boundary in this file; a bare `throw new Error(...)` would collapse them back into
// one indistinguishable message.
function fail(code, detail) {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  return err;
}

const PAIRING_TTL_MS = 10 * 60 * 1000;   // a pairing code is short-lived on purpose

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

class Hub {
  constructor({ dbFile = ':memory:', staticDir = null, log = () => {} } = {}) {
    this.store = new HubStore(dbFile);
    this.staticDir = staticDir;
    this.log = log;
    this.clients = new Map();   // ws -> { user, role, runtimeId?, subs:Set<threadId> }
    this.runtimes = new Map();  // runtimeId -> ws
    this.pendingCommands = new Map(); // commandId -> origin ws
    // Hosts that have connected but are not attached to any team yet, keyed by the pairing
    // code printed on the host's own console. Reading that code is the local consent.
    this.pendingPairings = new Map(); // pairingCode -> { runtimeId, descriptor, at, ws }
    this.activity = new Map();  // threadId -> { threadId, projectKey, files: Map<path, ts>, branch, worktree, by, name, runtimeId, active, lastAt }
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => resolve(this.server.address()));
    });
  }

  close() {
    for (const ws of this.clients.keys()) { try { ws.close(); } catch {} }
    return new Promise((resolve) => { this.wss.close(() => this.server.close(() => { this.store.close(); resolve(); })); });
  }

  // ---------------- HTTP: static web UI + tiny API ----------------
  // Bearer token on the Authorization header, or ?token= for the polling fallback.
  httpAccount(req, url) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : url.searchParams.get('token');
    return token ? this.store.userByToken(token) : null;
  }

  httpError(res, status, code) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: code }));
  }

  handleHttp(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, runtimes: this.runtimes.size, clients: this.clients.size }));
    }
    const evm = url.pathname.match(/^\/api\/threads\/([^/]+)\/events$/);
    if (evm) {
      // This is the seq-cursor fallback for the live socket, so it carries exactly the
      // same content and needs exactly the same authorization.
      const user = this.httpAccount(req, url);
      if (!user) return this.httpError(res, 401, Errors.UNAUTHENTICATED);
      const thread = this.store.getThread(evm[1]);
      if (!thread) return this.httpError(res, 404, Errors.UNKNOWN_THREAD);
      if (!this.store.membership(thread.orgId, user.id)) return this.httpError(res, 403, Errors.NOT_A_MEMBER);
      const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 500);
      const events = this.store.eventsFrom(thread.id, after, limit);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ thread, events, nextSeq: events.length ? events[events.length - 1].seq : after }));
    }
    if (url.pathname === '/api/threads') {
      const user = this.httpAccount(req, url);
      if (!user) return this.httpError(res, 401, Errors.UNAUTHENTICATED);
      const teamId = url.searchParams.get('team');
      if (!teamId || !this.store.getTeam(teamId)) return this.httpError(res, 404, Errors.UNKNOWN_TEAM);
      if (!this.store.membership(teamId, user.id)) return this.httpError(res, 403, Errors.NOT_A_MEMBER);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ threads: this.store.listThreads(teamId) }));
    }
    if (!this.staticDir) { res.writeHead(404); return res.end('no ui'); }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(this.staticDir, p));
    if (!file.startsWith(this.staticDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  // ---------------- WebSocket ----------------
  onConnection(ws) {
    const ctx = { user: null, role: null, runtimeId: null, subs: new Set(), teamId: null };
    this.clients.set(ws, ctx);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try { this.handleMessage(ws, ctx, msg); } catch (err) {
        this.send(ws, { type: 'error', code: (err && err.code) || null, message: String((err && err.message) || err), ref: msg.id });
      }
    });
    ws.on('close', () => this.onClose(ws, ctx));
  }

  send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  broadcastTeam(teamId, msg, { roles = ['client'] } = {}) {
    if (!teamId) return;
    for (const [ws, ctx] of this.clients) {
      if (ctx.teamId === teamId && roles.includes(ctx.role)) this.send(ws, msg);
    }
  }

  onClose(ws, ctx) {
    this.clients.delete(ws);
    for (const threadId of ctx.subs) this.broadcastPresence(threadId);
    if (ctx.role === 'runtime' && ctx.runtimeId && this.runtimes.get(ctx.runtimeId) === ws) {
      this.runtimes.delete(ctx.runtimeId);
      if (ctx.teamId) this.broadcastRuntimes(ctx.teamId);
    }
  }

  handleMessage(ws, ctx, msg) {
    if (msg.type === 'hello') return this.onHello(ws, ctx, msg);
    if (!ctx.user) throw fail(Errors.UNAUTHENTICATED, 'send hello first');
    switch (msg.type) {
      // ---- team administration (never routed to a runtime) ----
      case TeamOps.TEAM_CREATE: {
        const team = this.store.createTeam(msg.name, ctx.user.id);
        this.joinTeamContext(ws, ctx, team.id);
        return this.send(ws, { type: 'team', team, membership: this.store.membership(team.id, ctx.user.id), ref: msg.id });
      }
      case TeamOps.TEAM_LIST:
        return this.send(ws, { type: 'teams', teams: this.store.teamsFor(ctx.user.id), ref: msg.id });
      case TeamOps.TEAM_MEMBERS:
        this.requireMember(ctx, msg.teamId);
        return this.send(ws, { type: 'users', users: this.store.listMembers(msg.teamId), ref: msg.id });
      case TeamOps.INVITE_CREATE: {
        this.requireOwner(ctx, msg.teamId);
        const ttl = Math.min(Math.max(parseInt(msg.ttlMs, 10) || 7 * 24 * 3600 * 1000, 60000), 30 * 24 * 3600 * 1000);
        const role = msg.role === Roles.OWNER ? Roles.OWNER : Roles.MEMBER;
        const invite = this.store.createInvitation(msg.teamId, ctx.user.id, role, ttl);
        return this.send(ws, { type: 'invitation', invitation: invite, ref: msg.id });
      }
      case TeamOps.INVITE_ACCEPT: {
        const r = this.store.redeemInvitation(String(msg.code || ''), ctx.user.id);
        if (!r.ok) throw fail(r.reason);
        const team = this.store.getTeam(r.invite.teamId);
        this.joinTeamContext(ws, ctx, team.id);
        this.broadcastTeam(team.id, { type: 'users', users: this.store.listMembers(team.id) });
        return this.send(ws, { type: 'team', team, membership: this.store.membership(team.id, ctx.user.id), ref: msg.id });
      }
      case TeamOps.INVITE_REVOKE: {
        const inv = this.store.getInvitation(String(msg.code || ''));
        if (!inv) throw fail(Errors.INVITE_INVALID);
        this.requireOwner(ctx, inv.team_id);
        this.store.revokeInvitation(inv.code);
        return this.send(ws, { type: 'ok', ref: msg.id });
      }
      case TeamOps.MEMBER_REMOVE: {
        this.requireOwner(ctx, msg.teamId);
        const team = this.store.getTeam(msg.teamId);
        if (msg.userId === team.ownerId) throw fail(Errors.OWNER_REQUIRED, 'the owner cannot be removed');
        this.store.removeMember(msg.teamId, msg.userId);
        // Drop the removed member's live subscriptions at once. Their connection keeps
        // pointing at the team on purpose: the next request then answers "not a member",
        // which is the true reason, rather than pretending the team never existed.
        for (const [cws, c] of this.clients) {
          if (c.role === 'client' && c.user && c.user.id === msg.userId && c.teamId === msg.teamId) {
            c.subs.clear();
            this.send(cws, { type: 'removed', teamId: msg.teamId });
          }
        }
        this.broadcastTeam(msg.teamId, { type: 'users', users: this.store.listMembers(msg.teamId) });
        return this.send(ws, { type: 'ok', ref: msg.id });
      }
      case TeamOps.APPROVER_GRANT: {
        this.requireOwner(ctx, msg.teamId);
        if (!this.store.membership(msg.teamId, msg.userId)) throw fail(Errors.NOT_A_MEMBER, 'that person is not in this team');
        this.store.grantApprover(msg.teamId, msg.userId, ctx.user.id);
        this.broadcastTeam(msg.teamId, { type: 'approvers', teamId: msg.teamId, approvers: this.store.listApprovers(msg.teamId) });
        return this.send(ws, { type: 'ok', ref: msg.id });
      }
      case TeamOps.APPROVER_REVOKE: {
        this.requireOwner(ctx, msg.teamId);
        this.store.revokeApprover(msg.teamId, msg.userId);
        this.broadcastTeam(msg.teamId, { type: 'approvers', teamId: msg.teamId, approvers: this.store.listApprovers(msg.teamId) });
        return this.send(ws, { type: 'ok', ref: msg.id });
      }
      case TeamOps.APPROVER_LIST:
        this.requireMember(ctx, msg.teamId);
        return this.send(ws, { type: 'approvers', teamId: msg.teamId, approvers: this.store.listApprovers(msg.teamId), ref: msg.id });
      case TeamOps.RUNTIME_PAIR: return this.pairRuntime(ws, ctx, msg);
      case TeamOps.RUNTIME_UNPAIR: {
        const pairing = this.store.runtimePairing(msg.runtimeId);
        if (!pairing) throw fail(Errors.UNKNOWN_RUNTIME);
        this.requireOwner(ctx, pairing.teamId);
        this.store.unpairRuntime(msg.runtimeId);
        const rws = this.runtimes.get(msg.runtimeId);
        if (rws) this.send(rws, { type: 'unpaired' });
        this.broadcastRuntimes(pairing.teamId);
        return this.send(ws, { type: 'ok', ref: msg.id });
      }
      case 'team.switch': {
        this.joinTeamContext(ws, ctx, msg.teamId);
        return this.send(ws, { type: 'team', team: this.store.getTeam(msg.teamId), membership: this.store.membership(msg.teamId, ctx.user.id), ref: msg.id });
      }

      // ---- team-scoped reads ----
      case 'threads.list':
        this.requireMember(ctx, ctx.teamId);
        return this.send(ws, { type: 'threads', threads: this.store.listThreads(ctx.teamId) });
      case 'runtimes.list':
        this.requireMember(ctx, ctx.teamId);
        return this.send(ws, { type: 'runtimes', runtimes: this.runtimeList(ctx.teamId) });
      case 'users.list':
        this.requireMember(ctx, ctx.teamId);
        return this.send(ws, { type: 'users', users: this.store.listMembers(ctx.teamId) });
      case 'thread.subscribe': return this.subscribe(ws, ctx, msg);
      case 'workspace.activity':
        this.requireMember(ctx, ctx.teamId);
        return this.send(ws, { type: 'workspace.activity', ...this.activitySnapshot(ctx.teamId) });
      case 'thread.unsubscribe':
        ctx.subs.delete(msg.threadId);
        return this.broadcastPresence(msg.threadId);
      case 'thread.delete': {
        const t = this.requireThread(ctx, msg.threadId);
        this.routeToRuntime(t.runtimeId, { type: 'command', id: uid('cmd'), threadId: t.id, by: this.who(ctx), command: { type: 'thread.delete' } });
        this.store.deleteThread(t.id);
        this.broadcastTeam(t.orgId, { type: 'thread.deleted', threadId: t.id });
        return;
      }
      case 'command': return this.onCommand(ws, ctx, msg);

      // ---- runtime-only messages ----
      case 'thread.upsert': return this.onThreadUpsert(ws, ctx, msg);
      case 'append': return this.onAppend(ws, ctx, msg);
      case 'command.result': {
        if (ctx.role !== 'runtime') throw fail(Errors.UNAUTHENTICATED, 'runtime only');
        const origin = this.pendingCommands.get(msg.id);
        this.pendingCommands.delete(msg.id);
        if (origin) this.send(origin, msg);
        return;
      }
      case 'runtime.update':
        if (ctx.role !== 'runtime') throw fail(Errors.UNAUTHENTICATED, 'runtime only');
        if (!ctx.teamId) throw fail(Errors.RUNTIME_UNPAIRED);
        this.store.upsertRuntime(ctx.teamId, { ...msg.runtime, id: ctx.runtimeId });
        return this.broadcastRuntimes(ctx.teamId);
      case 'ping': return this.send(ws, { type: 'pong' });
      default: throw new Error('unknown message type: ' + msg.type);
    }
  }

  // Attaching a host to a team needs the code the host printed on its own console. That
  // possession is the local consent: a remote member cannot claim a host it cannot see.
  pairRuntime(ws, ctx, msg) {
    this.requireOwner(ctx, msg.teamId);
    const code = String(msg.code || '').trim().toUpperCase();
    const pending = this.pendingPairings.get(code);
    if (!code || !pending) throw fail(Errors.PAIRING_INVALID);
    if (Date.now() - pending.at > PAIRING_TTL_MS) {
      this.pendingPairings.delete(code);
      throw fail(Errors.PAIRING_EXPIRED);
    }
    this.pendingPairings.delete(code);
    this.store.pairRuntime(pending.runtimeId, msg.teamId, ctx.user.id);
    this.store.upsertRuntime(msg.teamId, { ...pending.descriptor, ownerId: ctx.user.id, ownerName: ctx.user.name });
    const rctx = this.clients.get(pending.ws);
    if (rctx) rctx.teamId = msg.teamId;
    this.send(pending.ws, { type: 'paired', teamId: msg.teamId, pairedBy: this.who(ctx) });
    this.broadcastRuntimes(msg.teamId);
    return this.send(ws, { type: 'runtime.paired', runtimeId: pending.runtimeId, teamId: msg.teamId, ref: msg.id });
  }

  // A name is an identity claim, not an authorization one. Logging in by name mints a NEW
  // account with its own token; it never resolves to an existing account, so typing a
  // teammate's name gets you a same-named stranger with no memberships. Access comes only
  // from a membership row, and a membership row comes only from an accepted invitation.
  onHello(ws, ctx, msg) {
    let user = msg.token ? this.store.userByToken(msg.token) : null;
    if (msg.token && !user) throw fail(Errors.UNAUTHENTICATED, 'unknown token');
    if (!user) {
      if (!msg.name) throw fail(Errors.UNAUTHENTICATED, 'hello needs a token or a name');
      user = this.store.createAccount(msg.name, msg.color);
    }
    ctx.user = user;
    ctx.role = msg.role === 'runtime' ? 'runtime' : 'client';

    if (ctx.role === 'runtime') {
      if (!msg.runtime || !msg.runtime.id) throw fail(Errors.UNKNOWN_RUNTIME, 'runtime hello needs runtime.id');
      ctx.runtimeId = msg.runtime.id;
      const prev = this.runtimes.get(ctx.runtimeId);
      if (prev && prev !== ws) { try { prev.close(); } catch {} }
      this.runtimes.set(ctx.runtimeId, ws);
      ctx.runtimeDescriptor = msg.runtime;
      // A host with no pairing is parked, not admitted: it holds a code the operator can
      // read off its own console, and only someone with that code can attach it to a team.
      const pairing = this.store.runtimePairing(ctx.runtimeId);
      if (pairing) {
        ctx.teamId = pairing.teamId;
        this.store.upsertRuntime(pairing.teamId, { ...msg.runtime, ownerId: user.id, ownerName: user.name });
      } else {
        ctx.teamId = null;
        this.pendingPairings.set(String(msg.pairingCode || ''), { runtimeId: ctx.runtimeId, descriptor: msg.runtime, at: Date.now(), ws });
      }
    }

    const teams = ctx.role === 'client' ? this.store.teamsFor(user.id) : [];
    this.send(ws, {
      type: 'welcome',
      user: { id: user.id, name: user.name, color: user.color, token: user.token },
      role: ctx.role,
      teams,
      // No team yet is the normal first-run state, not an error: create one or accept an invite.
      teamId: ctx.teamId || (teams[0] && teams[0].id) || null,
      paired: ctx.role === 'runtime' ? !!ctx.teamId : undefined
    });
    if (ctx.role === 'client' && teams[0]) this.joinTeamContext(ws, ctx, teams[0].id);
    if (ctx.role === 'runtime' && ctx.teamId) this.broadcastRuntimes(ctx.teamId);
    this.log(`hello ${ctx.role} ${user.name}${ctx.runtimeId ? ' runtime=' + ctx.runtimeId + (ctx.teamId ? '' : ' (unpaired)') : ''}`);
  }

  // Point a client connection at one of its teams and send that team's snapshot.
  joinTeamContext(ws, ctx, teamId) {
    this.requireMember(ctx, teamId);
    ctx.teamId = teamId;
    this.send(ws, { type: 'threads', threads: this.store.listThreads(teamId) });
    this.send(ws, { type: 'runtimes', runtimes: this.runtimeList(teamId) });
    this.send(ws, { type: 'users', users: this.store.listMembers(teamId) });
    this.send(ws, { type: 'workspace.activity', ...this.activitySnapshot(teamId) });
  }

  // ---- authorization ----
  requireMember(ctx, teamId) {
    if (!ctx.user) throw fail(Errors.UNAUTHENTICATED);
    if (!teamId) throw fail(Errors.UNKNOWN_TEAM);
    if (!this.store.getTeam(teamId)) throw fail(Errors.UNKNOWN_TEAM);
    const m = this.store.membership(teamId, ctx.user.id);
    if (!m) throw fail(Errors.NOT_A_MEMBER);
    return m;
  }

  requireOwner(ctx, teamId) {
    const m = this.requireMember(ctx, teamId);
    if (m.role !== Roles.OWNER) throw fail(Errors.OWNER_REQUIRED);
    return m;
  }

  // The team that owns a thread, checked against the caller rather than trusted from them.
  requireThread(ctx, threadId) {
    const t = this.store.getThread(threadId);
    if (!t) throw fail(Errors.UNKNOWN_THREAD);
    this.requireMember(ctx, t.orgId);
    return t;
  }

  who(ctx) {
    return { userId: ctx.user.id, name: ctx.user.name, color: ctx.user.color };
  }

  runtimeList(orgId) {
    return this.store.listRuntimes(orgId).map((r) => ({ ...r, online: this.runtimes.has(r.id) }));
  }

  broadcastRuntimes(orgId) {
    this.broadcastTeam(orgId, { type: 'runtimes', runtimes: this.runtimeList(orgId) });
  }

  // ---- subscriptions & presence ----
  subscribe(ws, ctx, msg) {
    // An outsider asking for a thread id they guessed must not learn whether it exists,
    // but a member of another team must be told plainly that it is not theirs.
    const thread = this.requireThread(ctx, msg.threadId);
    ctx.subs.add(thread.id);
    const events = this.store.eventsFrom(thread.id, msg.afterSeq || 0);
    this.send(ws, { type: 'thread.snapshot', thread, events });
    this.broadcastPresence(thread.id);
  }

  viewers(threadId) {
    const out = [];
    for (const [, c] of this.clients) {
      if (c.role === 'client' && c.subs.has(threadId) && c.user) {
        if (!out.find((v) => v.userId === c.user.id)) out.push({ userId: c.user.id, name: c.user.name, color: c.user.color });
      }
    }
    return out;
  }

  broadcastPresence(threadId) {
    const viewers = this.viewers(threadId);
    const msg = { type: 'presence', threadId, viewers };
    for (const [ws, c] of this.clients) if (c.subs.has(threadId)) this.send(ws, msg);
  }

  // ---- commands: human -> owning runtime ----
  onCommand(ws, ctx, msg) {
    const cmd = msg.command || {};
    let runtimeId = msg.runtimeId;
    if (msg.threadId) {
      runtimeId = this.requireThread(ctx, msg.threadId).runtimeId;
    }
    if (!runtimeId) throw fail(Errors.UNKNOWN_RUNTIME, 'command needs threadId or runtimeId');
    // Routing is authorized against the host's pairing, not against what the caller says:
    // otherwise any member could drive a host belonging to somebody else's team.
    const pairing = this.store.runtimePairing(runtimeId);
    if (!pairing) throw fail(Errors.RUNTIME_UNPAIRED);
    if (!this.store.membership(pairing.teamId, ctx.user.id)) throw fail(Errors.FOREIGN_RUNTIME);
    // Being in the team lets you watch and steer. Letting an agent actually run a risky
    // action is a separate grant, and it is checked here rather than assumed from role.
    const isApproval = cmd.method === Commands.APPROVAL_RESOLVE;
    if (isApproval && !this.store.isApprover(pairing.teamId, ctx.user.id)) throw fail(Errors.NOT_APPROVER);
    const id = msg.id || uid('cmd');
    this.pendingCommands.set(id, ws);
    // The execution host is told whether the hub considered this caller an approver, so it
    // can refuse on its own account rather than trusting the routing alone.
    const by = { ...this.who(ctx), approver: this.store.isApprover(pairing.teamId, ctx.user.id) };
    const ok = this.routeToRuntime(runtimeId, { type: 'command', id, threadId: msg.threadId || null, by, command: cmd });
    if (!ok) {
      this.pendingCommands.delete(id);
      this.send(ws, { type: 'command.result', id, ok: false, error: 'runtime offline' });
    }
  }

  routeToRuntime(runtimeId, msg) {
    const rws = this.runtimes.get(runtimeId);
    if (!rws) return false;
    this.send(rws, msg);
    return true;
  }

  // ---- runtime writes ----
  onThreadUpsert(ws, ctx, msg) {
    if (ctx.role !== 'runtime') throw fail(Errors.UNAUTHENTICATED, 'runtime only');
    if (!ctx.teamId) throw fail(Errors.RUNTIME_UNPAIRED);
    const existing = this.store.getThread(msg.thread.id);
    const thread = { ...(existing || {}), ...msg.thread, orgId: ctx.teamId, runtimeId: ctx.runtimeId };
    thread.status = thread.status || { type: 'idle' };
    this.store.upsertThread(thread);
    this.broadcastTeam(ctx.teamId, { type: 'thread.updated', thread });
    if (thread.cwd) this.touchActivity(thread, ctx.teamId, {});
  }

  onAppend(ws, ctx, msg) {
    if (ctx.role !== 'runtime') throw fail(Errors.UNAUTHENTICATED, 'runtime only');
    if (!ctx.teamId) throw fail(Errors.RUNTIME_UNPAIRED);
    const thread = this.store.getThread(msg.threadId);
    if (!thread || thread.runtimeId !== ctx.runtimeId) throw fail(Errors.UNKNOWN_THREAD, 'not the owner of this thread');
    const { seq, ts } = this.store.append(thread.id, msg.event);
    const out = { type: 'event', threadId: thread.id, seq, ts, ...msg.event };
    for (const [cws, c] of this.clients) if (c.subs.has(thread.id)) this.send(cws, out);

    // Derive thread status for the fleet/sidebar from the event stream
    // (mirrors Codex's thread/status/changed: idle | active{activeFlags} | systemError).
    const ev = msg.event;
    const m = ev.method;
    let patch = null;
    if (m === 'turn/started') patch = { status: { type: 'active', activeFlags: [] }, activeTurnId: ev.turnId, pendingApproval: null, lastTurnBy: ev.by || null };
    else if (m === 'item/commandExecution/requestApproval' || m === 'item/fileChange/requestApproval') {
      patch = { status: { type: 'active', activeFlags: ['waitingOnApproval'] }, pendingApproval: { requestId: ev.requestId, itemId: ev.itemId, command: ev.command, changes: ev.changes, reason: ev.reason, kind: m === 'item/fileChange/requestApproval' ? 'fileChange' : 'command' } };
    } else if (m === 'serverRequest/resolved') patch = { status: { type: 'active', activeFlags: [] }, pendingApproval: null };
    else if (m === 'turn/completed') patch = { status: ev.status === 'failed' ? { type: 'systemError' } : { type: 'idle' }, activeTurnId: null, pendingApproval: null, lastTurnStatus: ev.status, lastTurnAt: Date.now() };
    else if (m === 'thread/name/updated') patch = { name: ev.name };
    else if (m === 'thread/settings/updated') patch = { settings: { ...(thread.settings || {}), ...(ev.settings || {}) } };
    if (patch) {
      const updated = { ...thread, ...patch, lastSeq: seq, updatedAt: Date.now() };
      this.store.upsertThread(updated);
      this.broadcastTeam(ctx.teamId, { type: 'thread.updated', thread: updated });
      if (m === 'turn/started') this.touchActivity(updated, ctx.teamId, { active: true });
      if (m === 'turn/completed') this.touchActivity(updated, ctx.teamId, { active: false });
    }
    if (m === 'item/completed' && ev.item && ev.item.type === 'fileChange' && ev.item.status === 'completed') {
      this.touchActivity(thread, ctx.teamId, { files: ev.item.changes.map((c) => c.path) });
    }
    if (m === 'thread/assignee/updated') {
      const updated = { ...thread, assignee: ev.assignee || null, handoffNote: ev.note || null, updatedAt: Date.now() };
      this.store.upsertThread(updated);
      this.broadcastTeam(ctx.teamId, { type: 'thread.updated', thread: updated });
    }
  }
}

// ---------------- team awareness: who is touching what, right now ----------------
Hub.prototype.touchActivity = function (thread, orgId, { files = [], active } = {}) {
  if (!thread.cwd) return;
  let a = this.activity.get(thread.id);
  if (!a) {
    a = { threadId: thread.id, orgId, projectKey: thread.cwd, name: thread.name, files: new Map(), branch: thread.branch, worktree: !!thread.worktree, by: thread.createdBy || null, runtimeId: thread.runtimeId, runtimeName: thread.runtimeName, active: false, lastAt: Date.now() };
    this.activity.set(thread.id, a);
  }
  a.name = thread.name; a.branch = thread.branch; a.worktree = !!thread.worktree;
  if (typeof active === 'boolean') a.active = active;
  for (const f of files) a.files.set(f, Date.now());
  a.lastAt = Date.now();
  this.broadcastActivity(orgId);
};

Hub.prototype.activitySnapshot = function (orgId) {
  const HOT_MS = 30 * 60000;
  const now = Date.now();
  const threads = [];
  for (const a of this.activity.values()) {
    if (a.orgId !== orgId) continue;
    if (!this.store.getThread(a.threadId)) { this.activity.delete(a.threadId); continue; }
    const files = [...a.files.entries()].filter(([, ts]) => now - ts < HOT_MS).map(([path, ts]) => ({ path, ts }));
    if (!a.active && !files.length) continue;
    threads.push({ threadId: a.threadId, name: a.name, projectKey: a.projectKey, branch: a.branch, worktree: a.worktree, by: a.by, runtimeId: a.runtimeId, runtimeName: a.runtimeName, active: a.active, lastAt: a.lastAt, files });
  }
  // Overlaps: same project, same file, ≥2 distinct threads.
  const byFile = new Map();
  for (const t of threads) for (const f of t.files) {
    const key = t.projectKey + '::' + f.path;
    if (!byFile.has(key)) byFile.set(key, { projectKey: t.projectKey, path: f.path, threads: [] });
    byFile.get(key).threads.push({ threadId: t.threadId, name: t.name, by: t.by, branch: t.branch, worktree: t.worktree, active: t.active, ts: f.ts });
  }
  const overlaps = [...byFile.values()].filter((o) => o.threads.length > 1)
    .map((o) => ({ ...o, severity: o.threads.every((t) => t.worktree) ? 'merge-risk' : 'collision' }));
  return { threads, overlaps, generatedAt: now };
};

Hub.prototype.broadcastActivity = function (orgId) {
  const snap = this.activitySnapshot(orgId);
  const msg = { type: 'workspace.activity', ...snap };
  for (const [ws, ctx] of this.clients) if (ctx.teamId === orgId && ctx.user) this.send(ws, msg);
};

module.exports = { Hub };

if (require.main === module) {
  const port = parseInt(process.env.HUB_PORT || process.argv[2] || '7777', 10);
  const hub = new Hub({
    dbFile: process.env.HUB_DB || path.join(process.cwd(), '.harness-hub.sqlite'),
    staticDir: path.join(__dirname, '..', '..', 'apps', 'web'),
    log: (m) => console.log('[hub]', m)
  });
  hub.listen(port, process.env.HUB_HOST || '127.0.0.1').then((addr) => {
    console.log(`[hub] listening on http://${addr.address}:${addr.port}`);
  });
}
