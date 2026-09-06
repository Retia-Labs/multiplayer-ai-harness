'use strict';
// Backend that drives the real Codex CLI through `codex app-server` over JSON-RPC.
//
// This exists because `codex exec` cannot ask a human anything: it enforces its own sandbox
// and never emits an approval request, so a teammate can never approve a command Codex is
// about to run. The app-server protocol does emit them, which is the whole point.
//
// The mapping is unusually direct because the harness protocol was modelled on this one:
// `turn/started`, `item/completed`, `item/commandExecution/outputDelta` and
// `item/commandExecution/requestApproval` are the same names on both sides. What this file
// adds is the transport, the approval round-trip, and the honest edges.
//
// app-server is marked experimental in the Codex CLI. Treat its shape as unstable.
const { spawn } = require('child_process');
const { Events, ItemTypes, ItemStatus, ApprovalDecision } = require('../protocol');
const { resolveCodex } = require('./codex-probe');

const STDERR_KEEP = 4000;

// app-server names its sandbox as { type } in camelCase, not { mode } in kebab-case.
function sandboxMode(policy) {
  if (policy === 'read-only') return 'readOnly';
  if (policy === 'danger-full-access') return 'dangerFullAccess';
  return 'workspaceWrite';
}

// The harness asks for approval on risky things; `on-request` is the matching Codex policy.
function approvalPolicy(policy) {
  if (policy === 'never') return 'never';
  if (policy === 'untrusted') return 'untrusted';
  return 'on-request';
}

function mapStatus(s) {
  return { in_progress: ItemStatus.IN_PROGRESS, completed: ItemStatus.COMPLETED, failed: ItemStatus.FAILED, declined: ItemStatus.DECLINED }[s] || ItemStatus.COMPLETED;
}

// Codex item -> harness item. Same idea as the exec adapter, but app-server already uses
// camelCase and the harness's own type names for most of it.
function mapItem(it, cwd) {
  if (!it) return null;
  const base = { id: 'codex_' + (it.id || Math.random().toString(36).slice(2)) };
  switch (it.type || it.item_type) {
    case 'agentMessage': case 'agent_message':
      return { ...base, type: ItemTypes.AGENT_MESSAGE, text: it.text || '' };
    case 'reasoning':
      return { ...base, type: ItemTypes.REASONING, text: it.text || '' };
    case 'commandExecution': case 'command_execution':
      return { ...base, type: ItemTypes.COMMAND_EXECUTION, command: it.command, cwd: it.cwd || cwd, executor: 'codex', status: mapStatus(it.status), aggregatedOutput: it.aggregatedOutput || it.aggregated_output || '', exitCode: it.exitCode ?? it.exit_code };
    case 'fileChange': case 'file_change':
      return { ...base, type: ItemTypes.FILE_CHANGE, status: mapStatus(it.status), changes: (it.changes || []).map((c) => ({ path: c.path, kind: c.kind === 'delete' ? 'delete' : c.kind === 'add' ? 'add' : 'update', additions: 0, deletions: 0, lines: [] })) };
    case 'error':
      return { ...base, type: ItemTypes.AGENT_MESSAGE, text: '⚠ ' + (it.message || 'error') };
    default:
      return null;
  }
}

class CodexAppServerBackend {
  constructor({ bin = 'codex', onRaw = null } = {}) {
    this.id = 'codex-app-server';
    this.label = 'Codex CLI (app-server)';
    this.onRaw = onRaw;
    this.resolved = resolveCodex(bin);
  }
  capabilities() { return { toolCalls: true, reasoning: 'summary', images: false, steer: 'inline', approvals: true }; }
  async listModels() { return ['gpt-5.5', 'gpt-5.4-mini']; }

  async run(session) {
    const prompt = session.input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
    const state = { stderr: '', threadId: null, started: new Set(), error: null };
    session.providerSpawns = [];

    const child = spawn(this.resolved.bin, [...this.resolved.prefix, 'app-server'], {
      cwd: session.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe']
    });
    session.child = child;
    session.providerSpawns.push({ pid: child.pid, args: ['app-server'] });

    let nextId = 1;
    const pending = new Map();               // our request id -> resolve
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const reply = (id, result) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');

    // The approval round-trip: Codex asks, the harness routes it to whichever human is
    // watching, and the answer goes back on the same request id. This is the capability
    // `codex exec` does not have.
    const onServerRequest = async (msg) => {
      const p = msg.params || {};
      if (msg.method === Events.COMMAND_REQUEST_APPROVAL) {
        const decision = await session.requestApproval(Events.COMMAND_REQUEST_APPROVAL, {
          itemId: 'codex_' + (p.itemId || ''), command: p.command || (p.commandActions || []).join(' '),
          cwd: p.cwd || session.cwd, reason: p.reason || 'Codex is asking before running this'
        });
        return reply(msg.id, { decision: decision === ApprovalDecision.CANCEL ? 'decline' : decision });
      }
      if (msg.method === Events.FILECHANGE_REQUEST_APPROVAL) {
        const decision = await session.requestApproval(Events.FILECHANGE_REQUEST_APPROVAL, {
          itemId: 'codex_' + (p.itemId || ''), changes: (p.changes || []).map((c) => ({ path: c.path, kind: c.kind })),
          reason: p.reason || 'Codex is asking before changing files'
        });
        return reply(msg.id, { decision: decision === ApprovalDecision.CANCEL ? 'decline' : decision });
      }
      // Anything else the server asks for is declined rather than guessed at.
      return reply(msg.id, {});
    };

    const onNotification = (msg) => {
      const p = msg.params || {};
      switch (msg.method) {
        case 'thread/started': state.threadId = p.threadId || state.threadId; break;
        case Events.TURN_PLAN_UPDATED:
          session.emit(Events.TURN_PLAN_UPDATED, { explanation: p.explanation, plan: (p.plan || []).map((s) => ({ step: s.step || s.text, status: s.status || (s.completed ? 'completed' : 'pending') })) });
          break;
        case Events.ITEM_STARTED: {
          const item = mapItem(p.item, session.cwd);
          if (item) { state.started.add(item.id); session.emit(Events.ITEM_STARTED, { item }); }
          break;
        }
        case Events.ITEM_COMPLETED: {
          const item = mapItem(p.item, session.cwd);
          if (!item) break;
          if (!state.started.has(item.id)) session.emit(Events.ITEM_STARTED, { item });
          session.emit(Events.ITEM_COMPLETED, { item });
          break;
        }
        case Events.AGENT_MESSAGE_DELTA:
          session.emit(Events.AGENT_MESSAGE_DELTA, { itemId: 'codex_' + (p.itemId || ''), delta: p.delta || '' });
          break;
        case Events.COMMAND_OUTPUT_DELTA:
          session.emit(Events.COMMAND_OUTPUT_DELTA, { itemId: 'codex_' + (p.itemId || ''), delta: p.delta || p.chunk || '' });
          break;
        case 'error':
          state.error = p.message || 'app-server error';
          break;
      }
    };

    const done = new Promise((resolve) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (this.onRaw) { try { this.onRaw(line, msg, session); } catch {} }
          if (msg.id !== undefined && msg.method) { onServerRequest(msg).catch(() => {}); continue; }
          if (msg.id !== undefined && pending.has(msg.id)) {
            const { resolve: r, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else r(msg.result);
            continue;
          }
          if (msg.method) {
            onNotification(msg);
            if (msg.method === Events.TURN_COMPLETED) resolve(msg.params || {});
            if (msg.method === 'turn/failed') { state.error = (msg.params && msg.params.error && msg.params.error.message) || 'turn failed'; resolve({}); }
          }
        }
      });
      child.stderr.on('data', (d) => { state.stderr = (state.stderr + d.toString()).slice(-STDERR_KEEP); });
      child.on('close', () => resolve({}));
      child.on('error', (err) => { state.error = String(err); resolve({}); });
    });

    try {
      await call('initialize', { clientInfo: { name: 'plexus', version: '0.1.0' } });
      const thread = await call('thread/start', {
        cwd: session.cwd,
        approvalPolicy: approvalPolicy(session.settings.approvalPolicy),
        sandboxPolicy: { type: sandboxMode(session.settings.sandboxPolicy) },
        model: session.model || undefined
      });
      // thread/start answers { thread: { id, sessionId, ... } } - the id is nested, and
      // reading it from the top level sends turn/start a missing threadId.
      state.threadId = (thread && thread.thread && thread.thread.id) || (thread && thread.threadId) || state.threadId;
      session.providerSessionId = state.threadId;
      await call('turn/start', { threadId: state.threadId, input: [{ type: 'text', text: prompt }] });
      await done;
    } finally {
      try { child.kill(); } catch {}
      session.child = null;
    }

    if (state.error) throw new Error(state.error + (state.stderr ? ' — ' + state.stderr.trim().split('\n').slice(-2).join(' ') : ''));
  }
}

module.exports = { CodexAppServerBackend, mapItem, sandboxMode, approvalPolicy };
