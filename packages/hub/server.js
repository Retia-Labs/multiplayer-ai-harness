'use strict';
// Harness hub: the sync service. Holds append-only thread event logs, presence,
// the runtime fleet registry, and routes human commands (start/steer/approve) to
// the single runtime that owns each thread. It never sees provider keys or runs
// inference — runtimes talk to model providers directly.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { HubStore, uid } = require('./store');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

class Hub {
  constructor({ dbFile = ':memory:', staticDir = null, log = () => {} } = {}) {
    this.store = new HubStore(dbFile);
    this.staticDir = staticDir;
    this.log = log;
    this.clients = new Map();   // ws -> { user, role, runtimeId?, subs:Set<threadId> }
    this.runtimes = new Map();  // runtimeId -> ws
    this.pendingCommands = new Map(); // commandId -> origin ws
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
  handleHttp(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, runtimes: this.runtimes.size, clients: this.clients.size }));
    }
    const evm = url.pathname.match(/^\/api\/threads\/([^/]+)\/events$/);
    if (evm) {
      const thread = this.store.getThread(evm[1]);
      if (!thread) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not_found"}'); }
      const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 500);
      const events = this.store.eventsFrom(thread.id, after, limit);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ thread, events, nextSeq: events.length ? events[events.length - 1].seq : after }));
    }
    if (url.pathname === '/api/threads') {
      const org = url.searchParams.get('org') || 'local';
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ threads: this.store.listThreads(org) }));
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
    const ctx = { user: null, role: null, runtimeId: null, subs: new Set(), org: null };
    this.clients.set(ws, ctx);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try { this.handleMessage(ws, ctx, msg); } catch (err) {
        this.send(ws, { type: 'error', message: String(err && err.message || err), ref: msg.id });
      }
    });
    ws.on('close', () => this.onClose(ws, ctx));
  }

  send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  broadcastOrg(orgId, msg, { roles = ['client'] } = {}) {
    for (const [ws, ctx] of this.clients) {
      if (ctx.org === orgId && roles.includes(ctx.role)) this.send(ws, msg);
    }
  }

  onClose(ws, ctx) {
    this.clients.delete(ws);
    for (const threadId of ctx.subs) this.broadcastPresence(threadId);
    if (ctx.role === 'runtime' && ctx.runtimeId && this.runtimes.get(ctx.runtimeId) === ws) {
      this.runtimes.delete(ctx.runtimeId);
      if (ctx.org) this.broadcastRuntimes(ctx.org);
    }
  }

  handleMessage(ws, ctx, msg) {
    if (msg.type === 'hello') return this.onHello(ws, ctx, msg);
    if (!ctx.user) throw new Error('not authenticated — send hello first');
    switch (msg.type) {
      case 'threads.list':
        return this.send(ws, { type: 'threads', threads: this.store.listThreads(ctx.org) });
      case 'runtimes.list':
        return this.send(ws, { type: 'runtimes', runtimes: this.runtimeList(ctx.org) });
      case 'users.list':
        return this.send(ws, { type: 'users', users: this.store.listUsers(ctx.org) });
      case 'thread.subscribe': return this.subscribe(ws, ctx, msg);
      case 'workspace.activity': return this.send(ws, { type: 'workspace.activity', ...this.activitySnapshot(ctx.org) });
      case 'thread.unsubscribe':
        ctx.subs.delete(msg.threadId);
        return this.broadcastPresence(msg.threadId);
      case 'thread.delete': {
        const t = this.store.getThread(msg.threadId);
        if (t && t.orgId === ctx.org) {
          this.routeToRuntime(t.runtimeId, { type: 'command', id: uid('cmd'), threadId: t.id, by: this.who(ctx), command: { type: 'thread.delete' } });
          this.store.deleteThread(t.id);
          this.broadcastOrg(ctx.org, { type: 'thread.deleted', threadId: t.id });
        }
        return;
      }
      case 'command': return this.onCommand(ws, ctx, msg);
      // ---- runtime-only messages ----
      case 'thread.upsert': return this.onThreadUpsert(ws, ctx, msg);
      case 'append': return this.onAppend(ws, ctx, msg);
      case 'command.result': {
        const origin = this.pendingCommands.get(msg.id);
        this.pendingCommands.delete(msg.id);
        if (origin) this.send(origin, msg);
        return;
      }
      case 'runtime.update':
        if (ctx.role !== 'runtime') throw new Error('runtime only');
        this.store.upsertRuntime(ctx.org, { ...msg.runtime, id: ctx.runtimeId });
        return this.broadcastRuntimes(ctx.org);
      case 'ping': return this.send(ws, { type: 'pong' });
      default: throw new Error('unknown message type: ' + msg.type);
    }
  }

  onHello(ws, ctx, msg) {
    const orgId = msg.org || 'local';
    this.store.ensureOrg(orgId);
    let user = msg.token ? this.store.userByToken(msg.token) : null;
    let created = false;
    if (!user && msg.name) {
      const before = this.store.listUsers(orgId).length;
      user = this.store.loginOrCreate(orgId, msg.name, msg.color);
      created = this.store.listUsers(orgId).length > before;
    }
    if (!user) throw new Error('hello needs a token or a name');
    ctx.user = user; ctx.org = user.org_id; ctx.role = msg.role === 'runtime' ? 'runtime' : 'client';
    if (ctx.role === 'runtime') {
      if (!msg.runtime || !msg.runtime.id) throw new Error('runtime hello needs runtime.id');
      ctx.runtimeId = msg.runtime.id;
      const prev = this.runtimes.get(ctx.runtimeId);
      if (prev && prev !== ws) { try { prev.close(); } catch {} }
      this.runtimes.set(ctx.runtimeId, ws);
      this.store.upsertRuntime(ctx.org, { ...msg.runtime, ownerId: user.id, ownerName: user.name });
    }
    this.send(ws, {
      type: 'welcome',
      user: { id: user.id, name: user.name, color: user.color, token: user.token },
      org: ctx.org, role: ctx.role
    });
    if (ctx.role === 'runtime') this.broadcastRuntimes(ctx.org);
    if (created) this.broadcastOrg(ctx.org, { type: 'users', users: this.store.listUsers(ctx.org) });
    this.send(ws, { type: 'workspace.activity', ...this.activitySnapshot(ctx.org) });
    this.log(`hello ${ctx.role} ${user.name}${ctx.runtimeId ? ' runtime=' + ctx.runtimeId : ''}`);
  }

  who(ctx) {
    return { userId: ctx.user.id, name: ctx.user.name, color: ctx.user.color };
  }

  runtimeList(orgId) {
    return this.store.listRuntimes(orgId).map((r) => ({ ...r, online: this.runtimes.has(r.id) }));
  }

  broadcastRuntimes(orgId) {
    this.broadcastOrg(orgId, { type: 'runtimes', runtimes: this.runtimeList(orgId) });
  }

  // ---- subscriptions & presence ----
  subscribe(ws, ctx, msg) {
    const thread = this.store.getThread(msg.threadId);
    if (!thread || thread.orgId !== ctx.org) throw new Error('unknown thread');
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
      const t = this.store.getThread(msg.threadId);
      if (!t || t.orgId !== ctx.org) throw new Error('unknown thread');
      runtimeId = t.runtimeId;
    }
    if (!runtimeId) throw new Error('command needs threadId or runtimeId');
    const id = msg.id || uid('cmd');
    this.pendingCommands.set(id, ws);
    const ok = this.routeToRuntime(runtimeId, { type: 'command', id, threadId: msg.threadId || null, by: this.who(ctx), command: cmd });
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
    if (ctx.role !== 'runtime') throw new Error('runtime only');
    const existing = this.store.getThread(msg.thread.id);
    const thread = { ...(existing || {}), ...msg.thread, orgId: ctx.org, runtimeId: ctx.runtimeId };
    thread.status = thread.status || { type: 'idle' };
    this.store.upsertThread(thread);
    this.broadcastOrg(ctx.org, { type: 'thread.updated', thread });
    if (thread.cwd) this.touchActivity(thread, ctx.org, {});
  }

  onAppend(ws, ctx, msg) {
    if (ctx.role !== 'runtime') throw new Error('runtime only');
    const thread = this.store.getThread(msg.threadId);
    if (!thread || thread.runtimeId !== ctx.runtimeId) throw new Error('not the owner of this thread');
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
      this.broadcastOrg(ctx.org, { type: 'thread.updated', thread: updated });
      if (m === 'turn/started') this.touchActivity(updated, ctx.org, { active: true });
      if (m === 'turn/completed') this.touchActivity(updated, ctx.org, { active: false });
    }
    if (m === 'item/completed' && ev.item && ev.item.type === 'fileChange' && ev.item.status === 'completed') {
      this.touchActivity(thread, ctx.org, { files: ev.item.changes.map((c) => c.path) });
    }
    if (m === 'thread/assignee/updated') {
      const updated = { ...thread, assignee: ev.assignee || null, handoffNote: ev.note || null, updatedAt: Date.now() };
      this.store.upsertThread(updated);
      this.broadcastOrg(ctx.org, { type: 'thread.updated', thread: updated });
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
  for (const [ws, ctx] of this.clients) if (ctx.org === orgId && ctx.user) this.send(ws, msg);
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
