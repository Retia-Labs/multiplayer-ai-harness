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
const { EncryptedTasks } = require('./encrypted-tasks');
const { Enrollment } = require('./enrollment');
const { KeyExchange } = require('./key-exchange');
const { HostedAuth, hostedConfiguration } = require('./auth');
const { TeamOps, Errors, Roles, Commands, ThreadStatus } = require('../protocol');

// Authorization failures carry a code so a caller can tell them apart. `fail` is used for
// every boundary in this file; a bare `throw new Error(...)` would collapse them back into
// one indistinguishable message.
function fail(code, detail) {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  return err;
}

const PAIRING_TTL_MS = 10 * 60 * 1000;   // a pairing code is short-lived on purpose

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

class Hub {
  constructor({ dbFile = ':memory:', staticDir = null, service, auth, desktopReleaseDir, log = () => {} } = {}) {
    this.desktopDownload = new (require('./desktop-download').DesktopDownload)(desktopReleaseDir);
    this.store = new HubStore(dbFile);
    this.auth = auth ? new HostedAuth(this.store, auth) : null;
    this.enrollment = new Enrollment(this.store, { service });
    this.keyExchange = new KeyExchange(this.store);
    this.encryptedTasks = new EncryptedTasks(this.store, this.enrollment);
    this.retention = new (require('./retention').Retention)(this.store, { dbFile });
    this.store.retention = this.retention;
    this.enrollment.retention = this.retention;
    this.pilot = new (require('./pilot').Pilot)(this.store, this.enrollment);
    this.retentionTimer = setInterval(() => {
      try { this.retention.pruneBackups(); this.pilot.prune(); this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
      catch { log('retention_maintenance_failed'); }
    }, 60000);
    this.retentionTimer.unref();
    this.staticDir = staticDir;
    this.log = log;
    this.clients = new Map();   // ws -> { user, role, runtimeId?, subs:Set<threadId> }
    this.runtimes = new Map();  // runtimeId -> ws
    this.commandLog = new Map(); // userId/commandId -> pending or settled result
    this.pendingCommands = new Map(); // wire commandId -> authenticated runtime and retry entry
    this.pendingPairings = new Map(); // pairingCode -> { runtimeId, descriptor, at, ws }
    this.activity = new Map();  // threadId -> { threadId, projectKey, files: Map<path, ts>, branch, worktree, by, name, runtimeId, active, lastAt }
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server, maxPayload: 1024 * 1024 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
  }

  listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => resolve(this.server.address()));
    });
  }

  close() {
    clearInterval(this.retentionTimer);
    for (const ws of this.clients.keys()) { try { ws.close(); } catch {} }
    return new Promise((resolve) => { this.wss.close(() => this.server.close(() => { this.store.close(); resolve(); })); });
  }

  // ---------------- HTTP: static web UI + tiny API ----------------
  // Bearer token on the Authorization header, or ?token= for the polling fallback.
  httpAccount(req, url) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (this.auth ? null : url.searchParams.get('token'));
    return token ? this.store.userByToken(token) : null;
  }

  httpError(res, status, code) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: code }));
  }

  handleHttp(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/auth/')) {
      if (!this.auth) {
        if (url.pathname === '/api/auth/config' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          return res.end(JSON.stringify({ mode: 'local' }));
        }
        return this.httpError(res, 404, 'not_found');
      }
      return this.auth.handle(req, res, url, token => {
        for (const [ws, ctx] of this.clients) if (ctx.sessionToken === token) ws.close(4001, 'signed_out');
      }).catch(error => this.auth.failure(res, error, url.pathname === '/api/auth/callback'));
    }
    if (this.auth) {
      try { this.auth.prepare(req); } catch (error) { return this.httpError(res, error.status, error.code); }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    }
    if (['/api/desktop-release', '/api/desktop-download'].includes(url.pathname)) {
      return this.desktopDownload.handle(req, res, url.pathname, this.httpAccount(req, url));
    }
    if (url.pathname.startsWith('/api/pilot/')) return this.pilot.handle(req, res, url);
    if (url.pathname.startsWith('/api/e2ee/')) {
      return this.keyExchange.handle(req, res, url);
    }
    if (url.pathname === '/api/enrollment' || url.pathname.startsWith('/api/enrollment/')) {
      return this.enrollment.handle(req, res, url);
    }
    if (url.pathname === '/api/encrypted-tasks' || url.pathname.startsWith('/api/encrypted-tasks/')) {
      return this.encryptedTasks.handle(req, res, url);
    }
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, runtimes: this.runtimes.size, clients: this.clients.size }));
    }
    const evm = url.pathname.match(/^\/api\/threads\/([^/]+)\/events$/);
    if (evm) {
      if (evm[1].startsWith('et_')) return this.httpError(res, 409, 'encrypted_route_required');
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
    // Browser-side encryption needs two things this hub does not keep in apps/web: the
    // crypto WASM, and the shared modules that already run in both Node and a browser.
    //
    // Both are served from an explicit allowlist rather than by exposing a directory.
    // packages/ holds the hub's own store and server code, and a path-prefix rule that
    // happened to serve those would be a very quiet way to publish them.
    if (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/shared/')) {
      return this.serveModule(res, url.pathname);
    }
    if (!this.staticDir) { res.writeHead(404); return res.end('no ui'); }
    // A private task link. The relay serves the same application shell it serves everybody -
    // no task, no title, nothing that says whether that id even exists - and every check that
    // matters happens afterwards, in the client, against an endpoint somebody confirmed.
    // Answering differently for a real id than for an invented one would leak the one thing
    // an unauthorized visitor could otherwise not find out.
    let p = url.pathname === '/' || /^\/(t|connect)\/[A-Za-z0-9_-]{1,80}$/.test(url.pathname)
      ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(this.staticDir, p));
    if (!file.startsWith(this.staticDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  // ---------------- WebSocket ----------------
  onConnection(ws, req) {
    const ctx = { user: null, role: null, runtimeId: null, subs: new Set(), teamId: null, request: req };
    this.clients.set(ws, ctx);
    // ws closes malformed/oversized connections itself. Consume its error event
    // so an unauthenticated peer cannot crash the relay; cleanup runs on close.
    ws.on('error', () => this.log('websocket_connection_error'));
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
      if (ctx.teamId !== teamId || !roles.includes(ctx.role)) continue;
      if (ctx.role === 'client' && (!ctx.user || !this.store.membership(teamId, ctx.user.id))) continue;
      if (ctx.role === 'runtime' && this.runtimes.get(ctx.runtimeId) !== ws) continue;
      this.send(ws, msg);
    }
  }

  onClose(ws, ctx) {
    clearTimeout(ctx.sessionTimer);
    this.clients.delete(ws);
    for (const [commandId, pending] of this.pendingCommands) {
      pending.waiters.delete(ws);
      if (pending.runtimeWs === ws) {
        this.settleCommand({ type: 'command.result', id: commandId, ok: false, error: 'runtime offline; execution outcome may be unknown' });
      }
    }
    for (const [code, pending] of this.pendingPairings) {
      if (pending.ws === ws) this.pendingPairings.delete(code);
    }
    for (const threadId of ctx.subs) this.broadcastPresence(threadId);
    if (ctx.role === 'runtime' && ctx.runtimeId && this.runtimes.get(ctx.runtimeId) === ws) {
      this.runtimes.delete(ctx.runtimeId);
      this.markRunningThreadsUnknown(ctx.runtimeId, ctx.teamId);
      if (ctx.teamId) this.broadcastRuntimes(ctx.teamId);
    }
  }

  // A host that vanished mid-turn leaves work whose outcome nobody here knows. Saying it is
  // still running is a claim about a machine that is not answering; saying it is idle reads as
  // "finished", which is the worse of the two guesses. So it becomes unknown, and stays
  // unknown until the host itself says what happened.
  markRunningThreadsUnknown(runtimeId, teamId) {
    if (!teamId) return;
    for (const thread of this.store.listThreads(teamId)) {
      if (thread.runtimeId !== runtimeId) continue;
      if (!thread.status || thread.status.type !== 'active') continue;
      const updated = {
        ...thread,
        status: ThreadStatus.unknown(thread.activeTurnId || null),
        // The pending approval goes with it. Answering a request whose host is gone cannot
        // authorise anything, and leaving the prompt up invites somebody to try.
        pendingApproval: null,
        updatedAt: Date.now()
      };
      this.store.upsertThread(updated);
      this.broadcastTeam(teamId, { type: 'thread.updated', thread: updated });
      this.touchActivity(updated, teamId, { active: false });
    }
  }

  handleMessage(ws, ctx, msg) {
    if (msg.type === 'hello') return this.onHello(ws, ctx, msg);
    if (!ctx.user) throw fail(Errors.UNAUTHENTICATED, 'send hello first');
    if (this.auth && ctx.role === 'client' && !this.auth.account(ctx.sessionToken)) { ws.close(4001, 'session_expired'); throw fail(Errors.UNAUTHENTICATED); }
    if (this.auth && ctx.role === 'runtime' && !['thread.upsert', 'append', 'command.result', 'runtime.update', 'runtime.offline', 'ping'].includes(msg.type)) throw fail(Errors.UNAUTHENTICATED);
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
      case TeamOps.INVITE_LIST:
        this.requireOwner(ctx, msg.teamId);
        return this.send(ws, { type: 'invitations', teamId: msg.teamId, invitations: this.store.listInvitations(msg.teamId), ref: msg.id });
      case TeamOps.INVITE_CREATE: {
        this.requireOwner(ctx, msg.teamId);
        const invitee = this.auth ? this.auth.invitee(msg.inviteeEmail) : this.store.userById(String(msg.inviteeUserId || ''));
        if (!invitee) throw fail(Errors.UNKNOWN_USER, 'inviteeUserId must identify an existing account');
        if (this.store.membership(msg.teamId, invitee.id)) throw fail(Errors.ALREADY_MEMBER);
        const ttl = Math.min(Math.max(parseInt(msg.ttlMs, 10) || 7 * 24 * 3600 * 1000, 60000), 30 * 24 * 3600 * 1000);
        const role = msg.role === Roles.OWNER ? Roles.OWNER : Roles.MEMBER;
        const invite = this.store.createInvitation(msg.teamId, ctx.user.id, invitee.id, role, ttl);
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
        const changedSubscriptions = new Set();
        for (const [cws, c] of this.clients) {
          if (c.role !== 'client' || !c.user || c.user.id !== msg.userId) continue;
          for (const threadId of [...c.subs]) {
            const thread = this.store.getThread(threadId);
            if (thread && thread.orgId === msg.teamId) {
              c.subs.delete(threadId);
              changedSubscriptions.add(threadId);
            }
          }
          for (const [commandId, pending] of this.pendingCommands) {
            if (pending.teamId === msg.teamId) pending.waiters.delete(cws);
          }
          if (c.teamId === msg.teamId) this.send(cws, { type: 'removed', teamId: msg.teamId });
        }
        for (const threadId of changedSubscriptions) this.broadcastPresence(threadId);
        this.broadcastTeam(msg.teamId, { type: 'users', users: this.store.listMembers(msg.teamId) });
        this.broadcastTeam(msg.teamId, { type: 'approvers', teamId: msg.teamId, approvers: this.store.listApprovers(msg.teamId) });
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
        this.store.deleteRuntime(msg.runtimeId);
        for (const [code, pending] of this.pendingPairings) {
          if (pending.runtimeId === msg.runtimeId) this.pendingPairings.delete(code);
        }
        const rws = this.runtimes.get(msg.runtimeId);
        if (rws) {
          const rctx = this.clients.get(rws);
          if (rctx) rctx.teamId = null;
          this.runtimes.delete(msg.runtimeId);
          this.send(rws, { type: 'unpaired' });
        }
        for (const [commandId, pending] of this.pendingCommands) {
          if (pending.runtimeId !== msg.runtimeId) continue;
          this.settleCommand({ type: 'command.result', id: commandId, ok: false, error: Errors.RUNTIME_UNPAIRED });
        }
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
        return this.onCommand(ws, ctx, { ...msg, type: 'command', command: { method: Commands.THREAD_DELETE } });
      }
      case 'command': return this.onCommand(ws, ctx, msg);

      // ---- runtime-only messages ----
      case 'thread.upsert': return this.onThreadUpsert(ws, ctx, msg);
      case 'append': return this.onAppend(ws, ctx, msg);
      case 'command.result': {
        if (ctx.role !== 'runtime') throw fail(Errors.UNAUTHENTICATED, 'runtime only');
        if (!ctx.teamId || this.runtimes.get(ctx.runtimeId) !== ws) throw fail(Errors.RUNTIME_AUTHENTICATION);
        const pending = this.pendingCommands.get(msg.id);
        if (pending && (pending.runtimeId !== ctx.runtimeId || pending.runtimeWs !== ws)) {
          throw fail(Errors.RUNTIME_AUTHENTICATION, 'command result came from a different runtime');
        }
        if (pending && msg.ok && pending.commandMethod === Commands.THREAD_DELETE) {
          const thread = this.store.getThread(pending.threadId);
          if (thread && thread.orgId === pending.teamId && thread.runtimeId === pending.runtimeId) {
            this.store.deleteThread(thread.id);
            this.broadcastTeam(thread.orgId, { type: 'thread.deleted', threadId: thread.id });
          }
        }
        this.settleCommand(msg);
        return;
      }
      case 'runtime.update':
        if (ctx.role !== 'runtime') throw fail(Errors.UNAUTHENTICATED, 'runtime only');
        if (!ctx.teamId) throw fail(Errors.RUNTIME_UNPAIRED);
        if (this.runtimes.get(ctx.runtimeId) !== ws) throw fail(Errors.RUNTIME_AUTHENTICATION);
        {
          const stored = this.store.getRuntime(ctx.runtimeId);
          this.store.upsertRuntime(ctx.teamId, {
            ...msg.runtime,
            id: ctx.runtimeId,
            ownerId: stored && stored.ownerId,
            ownerName: stored && stored.ownerName
          });
        }
        return this.broadcastRuntimes(ctx.teamId);
      // A host leaving on purpose says so before it goes, so the fleet can show that its
      // owner quit rather than leaving people to read a silence. It changes nothing about
      // #17's rule: anything still running when the socket closes is still `unknown`, because
      // a reason for an absence is not an outcome for a turn.
      case 'runtime.offline': {
        if (ctx.role !== 'runtime') throw fail(Errors.UNAUTHENTICATED, 'runtime only');
        if (this.runtimes.get(ctx.runtimeId) !== ws) throw fail(Errors.RUNTIME_AUTHENTICATION);
        const stored = ctx.teamId ? this.store.getRuntime(ctx.runtimeId) : null;
        if (stored) {
          this.store.upsertRuntime(ctx.teamId, { ...stored, lastOffline: { reason: msg.reason || 'quit', at: Date.now() } });
          this.broadcastRuntimes(ctx.teamId);
        }
        return this.send(ws, { type: 'runtime.offline.ack' });
      }
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
    const pendingCtx = this.clients.get(pending.ws);
    if (pending.ws.readyState !== 1 || !pendingCtx || pendingCtx.role !== 'runtime' || pendingCtx.runtimeId !== pending.runtimeId) {
      this.pendingPairings.delete(code);
      throw fail(Errors.PAIRING_INVALID, 'runtime disconnected');
    }
    const pairing = this.store.pairRuntime(pending.runtimeId, msg.teamId, ctx.user.id, pending.runtimeToken);
    if (!pairing) {
      this.pendingPairings.delete(code);
      throw fail(Errors.RUNTIME_AUTHENTICATION, 'runtime identity is already reserved');
    }
    for (const [pendingCode, candidate] of this.pendingPairings) {
      if (candidate.runtimeId === pending.runtimeId) this.pendingPairings.delete(pendingCode);
    }
    this.store.upsertRuntime(msg.teamId, { ...pending.descriptor, ownerId: ctx.user.id, ownerName: ctx.user.name });
    const rctx = this.clients.get(pending.ws);
    if (rctx) rctx.teamId = msg.teamId;
    const previous = this.runtimes.get(pending.runtimeId);
    if (previous && previous !== pending.ws) { try { previous.close(); } catch {} }
    this.runtimes.set(pending.runtimeId, pending.ws);
    this.send(pending.ws, { type: 'paired', teamId: msg.teamId, pairedBy: this.who(ctx) });
    this.broadcastRuntimes(msg.teamId);
    return this.send(ws, { type: 'runtime.paired', runtimeId: pending.runtimeId, teamId: msg.teamId, ref: msg.id });
  }

  // A name is an identity claim, not an authorization one. Logging in by name mints a NEW
  // account with its own token; it never resolves to an existing account, so typing a
  // teammate's name gets you a same-named stranger with no memberships. Access comes only
  // from a membership row, and a membership row comes only from an accepted invitation.
  onHello(ws, ctx, msg) {
    if (ctx.user) throw fail(Errors.UNAUTHENTICATED, 'hello was already received on this connection');
    let user;
    if (this.auth && msg.role !== 'runtime') {
      const cookieToken = this.auth.token(ctx.request);
      if (cookieToken && ctx.request.headers.origin !== this.auth.origin) throw fail(Errors.UNAUTHENTICATED);
      ctx.sessionToken = msg.token || cookieToken;
      user = this.auth.account(ctx.sessionToken);
      if (!user) throw fail(Errors.UNAUTHENTICATED);
      ctx.sessionTimer = setTimeout(() => ws.close(4001, 'session_expired'), user.sessionExpiresAt - this.auth.now());
      ctx.sessionTimer.unref();
    } else if (this.auth) {
      // Runtime authority comes exclusively from its installation credential and pairing.
      user = { id: msg.runtime?.id, name: 'Execution host', color: '#888' };
    } else user = msg.token ? this.store.userByToken(msg.token) : null;
    if (msg.token && !user) throw fail(Errors.UNAUTHENTICATED, 'unknown token');
    if (!user) {
      if (!msg.name) throw fail(Errors.UNAUTHENTICATED, 'hello needs a token or a name');
      user = this.store.createAccount(msg.name, msg.color);
    }
    ctx.role = msg.role === 'runtime' ? 'runtime' : 'client';

    if (ctx.role === 'runtime') {
      if (!msg.runtime || !msg.runtime.id) throw fail(Errors.UNKNOWN_RUNTIME, 'runtime hello needs runtime.id');
      ctx.runtimeId = msg.runtime.id;
      ctx.runtimeDescriptor = msg.runtime;
      // A host with no pairing is parked, not admitted: it holds a code the operator can
      // read off its own console, and only someone with that code can attach it to a team.
      const pairing = this.store.runtimePairing(ctx.runtimeId);
      const hasCredential = this.store.runtimeCredentialExists(ctx.runtimeId);
      const credentialMatches = this.store.runtimeCredentialMatches(ctx.runtimeId, msg.runtimeToken);
      if (pairing && !hasCredential) {
        throw fail(Errors.RUNTIME_AUTHENTICATION, 'legacy runtime identity must be unpaired before enrollment');
      }
      if (hasCredential && !credentialMatches) {
        throw fail(Errors.RUNTIME_AUTHENTICATION, 'runtime identity belongs to another installation');
      }
      if (pairing && credentialMatches) {
        for (const [code, pending] of this.pendingPairings) {
          if (pending.runtimeId === ctx.runtimeId) this.pendingPairings.delete(code);
        }
        const prev = this.runtimes.get(ctx.runtimeId);
        if (prev && prev !== ws) { try { prev.close(); } catch {} }
        this.runtimes.set(ctx.runtimeId, ws);
        ctx.teamId = pairing.teamId;
        const stored = this.store.getRuntime(ctx.runtimeId);
        this.store.upsertRuntime(pairing.teamId, {
          ...msg.runtime,
          ownerId: stored ? stored.ownerId : pairing.pairedBy,
          ownerName: stored && stored.ownerName
        });
      } else {
        const code = String(msg.pairingCode || '').trim().toUpperCase();
        if (!code || !msg.runtimeToken) throw fail(Errors.RUNTIME_AUTHENTICATION, 'pair this host again from its local code');
        const existing = this.pendingPairings.get(code);
        if (existing && existing.ws !== ws) throw fail(Errors.PAIRING_INVALID, 'pairing code is already in use');
        ctx.teamId = null;
        this.pendingPairings.set(code, { runtimeId: ctx.runtimeId, descriptor: msg.runtime, runtimeToken: msg.runtimeToken, at: Date.now(), ws });
      }
    }

    ctx.user = user;
    const teams = ctx.role === 'client' ? this.store.teamsFor(user.id) : [];
    this.send(ws, {
      type: 'welcome',
      user: { id: user.id, name: user.name, color: user.color, ...(this.auth && ctx.role === 'client' ? { verifiedEmail: user.verifiedEmail } : {}), token: this.auth ? (ctx.role === 'client' && msg.token ? msg.token : null) : user.token },
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
    if (String(threadId || '').startsWith('et_')) throw fail('encrypted_route_required');
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
    const thread = this.store.getThread(threadId);
    if (!thread) return [];
    const out = [];
    for (const [, c] of this.clients) {
      if (c.role === 'client' && c.subs.has(threadId) && c.user && this.store.membership(thread.orgId, c.user.id)) {
        if (!out.find((v) => v.userId === c.user.id)) out.push({ userId: c.user.id, name: c.user.name, color: c.user.color });
      }
    }
    return out;
  }

  broadcastPresence(threadId) {
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    const viewers = this.viewers(threadId);
    const msg = { type: 'presence', threadId, viewers };
    for (const [ws, c] of this.clients) {
      if (!c.subs.has(threadId)) continue;
      if (c.role !== 'client' || !c.user || !this.store.membership(thread.orgId, c.user.id)) {
        c.subs.delete(threadId);
        continue;
      }
      this.send(ws, msg);
    }
  }

  // ---- commands: human -> owning runtime ----
  onCommand(ws, ctx, msg) {
    if (String(msg.threadId || '').startsWith('et_')) throw fail('encrypted_route_required');
    const cmd = msg.command || {};
    let runtimeId = msg.runtimeId;
    let thread = null;
    if (msg.threadId) {
      thread = this.requireThread(ctx, msg.threadId);
      runtimeId = thread.runtimeId;
    }
    if (!runtimeId) throw fail(Errors.UNKNOWN_RUNTIME, 'command needs threadId or runtimeId');
    // Routing is authorized against the host's pairing, not against what the caller says:
    // otherwise any member could drive a host belonging to somebody else's team.
    const pairing = this.store.runtimePairing(runtimeId);
    if (!pairing) throw fail(Errors.RUNTIME_UNPAIRED);
    if (thread && thread.orgId !== pairing.teamId) throw fail(Errors.FOREIGN_RUNTIME, 'the thread host is paired to a different team');
    if (!this.store.membership(pairing.teamId, ctx.user.id)) throw fail(Errors.FOREIGN_RUNTIME);
    if (this.store.getRuntime(runtimeId)?.taskProtocol === 'encrypted-v1') throw fail('encrypted_route_required');
    // Being in the team lets you watch and steer. Letting an agent actually run a risky
    // action is a separate grant, and it is checked here rather than assumed from role.
    const isApproval = cmd.method === Commands.APPROVAL_RESOLVE;
    if (isApproval && !this.store.isApprover(pairing.teamId, ctx.user.id)) throw fail(Errors.NOT_APPROVER);
    // A question or a handover addressed to somebody has to name somebody who can actually
    // receive it. These used to be whatever the caller typed, so work could be handed to a
    // name nobody has and then sit there looking assigned to every client that rendered it.
    // Membership is what this hub knows, so this is where it is checked.
    const addressed = cmd.method === Commands.THREAD_HELP ? cmd.to
      : cmd.method === Commands.THREAD_ASSIGN ? cmd.assignee : undefined;
    if (addressed !== undefined && addressed !== null) {
      const wanted = typeof addressed === 'string' ? addressed : addressed.userId;
      if (typeof wanted !== 'string' || !this.store.membership(pairing.teamId, wanted)) {
        throw fail(Errors.RECIPIENT_NOT_AUTHORIZED, 'that person is not on this team');
      }
    }
    const id = msg.id || uid('cmd');
    const key = ctx.user.id + '/' + id;
    const fingerprint = JSON.stringify([runtimeId, msg.threadId || null, cmd]);
    const prior = this.commandLog.get(key);
    if (prior) {
      // A reused id carrying different input is a conflict, not a command that is running.
      // Calling it "in progress" sends somebody looking for work that is not there, when the
      // problem is the id. The host says command_id_conflict for the same situation, and two
      // layers answering the same question differently is how a caller learns to ignore both.
      if (prior.fingerprint !== fingerprint) throw fail(Errors.COMMAND_ID_CONFLICT, 'command identity reused with different input');
      if (prior.state === 'done') this.send(ws, { ...prior.result, id, duplicate: true });
      else prior.waiters.add(ws);
      return;
    }
    if (this.pendingCommands.has(id)) throw fail(Errors.COMMAND_IN_PROGRESS);
    const by = { ...this.who(ctx), approver: this.store.isApprover(pairing.teamId, ctx.user.id) };
    const runtimeWs = this.runtimes.get(runtimeId);
    const entry = {
      state: 'pending', waiters: new Set([ws]), key, fingerprint, result: null,
      runtimeId, runtimeWs, teamId: pairing.teamId,
      threadId: msg.threadId || null, commandMethod: cmd.method
    };
    this.commandLog.set(key, entry);
    this.pruneCommandLog();
    if (runtimeWs) this.pendingCommands.set(id, entry);
    const ok = runtimeWs ? this.routeToRuntime(runtimeId, { type: 'command', id, threadId: msg.threadId || null, by, command: cmd }) : false;
    if (!ok) {
      this.commandLog.delete(key);
      this.pendingCommands.delete(id);
      this.send(ws, { type: 'command.result', id, ok: false, error: 'runtime offline' });
    }
  }

  // The only modules a browser may load from this process, named one by one.
  static SHARED_MODULES = new Set([
    'e2ee/membership.mjs',
    'e2ee/owner-recovery.mjs',
    'e2ee/owner-recovery-kit.mjs',
    'protocol/recovery-epoch.mjs',
    'e2ee/endpoint-core.mjs',
    'e2ee/task-log.mjs',
    'e2ee/enrollment.mjs',
    'e2ee/catchup.mjs',
    'e2ee/hub-key-transport.mjs',
    'e2ee/task-control.mjs',
    'e2ee/recovery.mjs',
    'protocol/encrypted-task.mjs',
    'protocol/related-work.mjs',
    'product/diagnostics.mjs',
    'product/measurement.mjs'
  ]);

  serveModule(res, pathname) {
    const deny = () => { res.writeHead(404); res.end('not found'); };
    const root = path.join(__dirname, '..', '..');
    let file = null;
    if (pathname.startsWith('/shared/')) {
      const rel = pathname.slice('/shared/'.length);
      if (!Hub.SHARED_MODULES.has(rel)) return deny();
      file = path.join(root, 'packages', rel);
    } else {
      // The SDK ships its own file layout, so this serves the package directory rather
      // than an allowlist - but only that package, and only after normalising.
      const base = path.join(root, 'node_modules', '@matrix-org', 'matrix-sdk-crypto-wasm');
      const candidate = path.normalize(path.join(base, pathname.slice('/vendor/'.length)));
      if (!candidate.startsWith(base)) return deny();
      file = candidate;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return deny();
    const type = file.endsWith('.wasm') ? 'application/wasm'
      : file.endsWith('.mjs') || file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  }

  settleCommand(msg) {
    const entry = this.pendingCommands.get(msg.id);
    if (!entry) return;             // thread.delete and other hub-issued commands have no caller
    this.pendingCommands.delete(msg.id);
    entry.state = 'done';
    entry.result = msg;
    for (const ws of entry.waiters) this.send(ws, msg);
    entry.waiters.clear();
  }

  // Only settled entries are evictable: dropping one still in flight would let its retry
  // run the action a second time.
  pruneCommandLog(max = 2000) {
    if (this.commandLog.size <= max) return;
    for (const [key, entry] of this.commandLog) {
      if (entry.state !== 'done') continue;
      this.commandLog.delete(key);
      if (this.commandLog.size <= max) return;
    }
  }

  routeToRuntime(runtimeId, msg) {
    const rws = this.runtimes.get(runtimeId);
    if (!rws || rws.readyState !== 1) return false;
    this.send(rws, msg);
    return true;
  }

  // ---- runtime writes ----
  onThreadUpsert(ws, ctx, msg) {
    if (String(msg.thread?.id || '').startsWith('et_')) throw fail('encrypted_route_required');
    if (ctx.role !== 'runtime') throw fail(Errors.UNAUTHENTICATED, 'runtime only');
    if (!ctx.teamId) throw fail(Errors.RUNTIME_UNPAIRED);
    if (this.runtimes.get(ctx.runtimeId) !== ws) throw fail(Errors.RUNTIME_AUTHENTICATION);
    if (!msg.thread || !msg.thread.id) throw fail(Errors.UNKNOWN_THREAD);
    const existing = this.store.getThread(msg.thread.id);
    if (existing && (existing.orgId !== ctx.teamId || existing.runtimeId !== ctx.runtimeId)) {
      throw fail(Errors.FOREIGN_THREAD, 'thread ownership cannot be changed');
    }
    const thread = { ...(existing || {}), ...msg.thread, orgId: ctx.teamId, runtimeId: ctx.runtimeId };
    thread.status = thread.status || { type: 'idle' };
    this.store.upsertThread(thread);
    this.broadcastTeam(ctx.teamId, { type: 'thread.updated', thread });
    if (thread.cwd) this.touchActivity(thread, ctx.teamId, {});
  }

  onAppend(ws, ctx, msg) {
    if (String(msg.threadId || '').startsWith('et_')) throw fail('encrypted_route_required');
    if (ctx.role !== 'runtime') throw fail(Errors.UNAUTHENTICATED, 'runtime only');
    if (!ctx.teamId) throw fail(Errors.RUNTIME_UNPAIRED);
    if (this.runtimes.get(ctx.runtimeId) !== ws) throw fail(Errors.RUNTIME_AUTHENTICATION);
    const thread = this.store.getThread(msg.threadId);
    if (!thread || thread.orgId !== ctx.teamId || thread.runtimeId !== ctx.runtimeId) {
      throw fail(Errors.FOREIGN_THREAD, 'not the owner of this thread');
    }
    const { seq, ts } = this.store.append(thread.id, msg.event);
    const out = { ...msg.event, type: 'event', threadId: thread.id, seq, ts };
    for (const [cws, c] of this.clients) {
      if (!c.subs.has(thread.id)) continue;
      if (c.role !== 'client' || !c.user || !this.store.membership(thread.orgId, c.user.id)) {
        c.subs.delete(thread.id);
        continue;
      }
      this.send(cws, out);
    }

    // Derive thread status for the fleet/sidebar from the event stream
    // (mirrors Codex's thread/status/changed: idle | active{activeFlags} | systemError).
    const ev = msg.event;
    const m = ev.method;
    let patch = null;
    if (m === 'turn/started') patch = { status: { type: 'active', activeFlags: [] }, activeTurnId: ev.turnId, pendingApproval: null, lastTurnBy: ev.by || null };
    else if (m === 'item/commandExecution/requestApproval' || m === 'item/fileChange/requestApproval') {
      patch = { status: { type: 'active', activeFlags: ['waitingOnApproval'] }, pendingApproval: { requestId: ev.requestId, itemId: ev.itemId, command: ev.command, changes: ev.changes, reason: ev.reason, availableDecisions: ev.availableDecisions, turnId: ev.turnId, fingerprint: ev.fingerprint, expiresAt: ev.expiresAt, kind: m === 'item/fileChange/requestApproval' ? 'fileChange' : 'command' } };
    } else if (m === 'serverRequest/resolved') patch = { status: { type: 'active', activeFlags: [] }, pendingApproval: null };
    // Requested is not stopped. The turn keeps running until it ends, and whatever it
    // already did stays done - the flag says a stop was asked for, nothing more.
    else if (m === 'turn/interrupt/requested') patch = { status: { type: 'active', activeFlags: ['stopping'] }, interruptRequestedBy: ev.by || null };
    else if (m === 'help/requested') patch = { openHelp: { requestId: ev.requestId, by: ev.by || null, to: ev.to || null, at: Date.now() } };
    else if (m === 'help/resolved') patch = { openHelp: null };
    else if (m === 'turn/completed') patch = { status: ev.status === 'failed' ? { type: 'systemError' } : { type: 'idle' }, activeTurnId: null, pendingApproval: null, interruptRequestedBy: null, lastTurnStatus: ev.status, lastTurnAt: Date.now() };
    // The host came back without this turn. It is idle now, and the record says the turn was
    // abandoned rather than completed - which is a different thing and reads differently.
    else if (m === 'turn/abandoned') patch = { status: { type: 'idle' }, activeTurnId: null, pendingApproval: null, interruptRequestedBy: null, lastTurnStatus: 'abandoned', lastTurnAt: Date.now() };
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
  this.broadcastTeam(orgId, { type: 'workspace.activity', ...snap }, { roles: ['client', 'runtime'] });
};

module.exports = { Hub };

if (require.main === module) {
  const port = parseInt(process.env.PORT || process.env.HUB_PORT || process.argv[2] || '7777', 10);
  const hub = new Hub({
    service: process.env.PLEXUS_PUBLIC_ORIGIN,
    auth: hostedConfiguration(process.env),
    desktopReleaseDir: process.env.PLEXUS_DESKTOP_RELEASE_DIR,
    dbFile: process.env.HUB_DB || path.join(process.cwd(), '.harness-hub.sqlite'),
    staticDir: path.join(__dirname, '..', '..', 'apps', 'web'),
    log: (m) => console.log('[hub]', m)
  });
  // Spawned by the desktop shell with an IPC channel, and asked to stop over it for the same
  // reason the host is: a signal is not something a Windows child can be asked with.
  const closeHub = () => hub.close().then(() => process.exit(0), () => process.exit(0));
  process.on('message', (msg) => { if (msg && msg.type === 'shutdown') closeHub(); });
  process.on('disconnect', closeHub);
  process.on('SIGTERM', closeHub);
  process.on('SIGINT', closeHub);
  hub.listen(port, process.env.HUB_HOST || '127.0.0.1').then((addr) => {
    console.log(`[hub] listening on http://${addr.address}:${addr.port}`);
  });
}
