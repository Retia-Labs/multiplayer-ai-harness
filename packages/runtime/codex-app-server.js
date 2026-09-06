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

const { CodexRpc, CodexProviderError, failure, providerFailure } = require('./codex-rpc');

// thread/start uses the kebab-case sandbox enum, not turn/start's policy object.
function sandboxMode(policy = 'read-only') {
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy)) throw failure('codex_policy_invalid');
  return policy;
}
function approvalPolicy(policy = 'on-request') {
  if (!['never', 'untrusted', 'on-request'].includes(policy)) throw failure('codex_policy_invalid');
  return policy;
}

function mapStatus(s) {
  return { inProgress: ItemStatus.IN_PROGRESS, in_progress: ItemStatus.IN_PROGRESS, completed: ItemStatus.COMPLETED, failed: ItemStatus.FAILED, declined: ItemStatus.DECLINED }[s] || ItemStatus.FAILED;
}

// Codex item -> harness item. Same idea as the exec adapter, but app-server already uses
// camelCase and the harness's own type names for most of it.
function mapItem(it, cwd) {
  if (!it || typeof it.id !== 'string' || !it.id) return null;
  const base = { id: 'codex_' + it.id };
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
      return { ...base, type: ItemTypes.AGENT_MESSAGE, text: 'Codex reported an error. Check the provider on the execution host.' };
    default:
      return null;
  }
}

class CodexAppServerBackend {
  constructor({ bin, spawnProcess = spawn, requestTimeoutMs = 30000, turnTimeoutMs = 600000 } = {}) {
    this.id = 'codex-app-server';
    this.label = 'Codex CLI (app-server)';
    this.resolved = resolveCodex(bin);
    this.spawnProcess = spawnProcess;
    this.requestTimeoutMs = requestTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
  }
  // Steering/resume must be wired to provider acknowledgments before advertising them.
  capabilities() { return { toolCalls: true, reasoning: 'summary', images: false, steer: 'none', approvals: true }; }
  async listModels() { return []; } // Discover locally; never claim hard-coded account entitlements.

  async run(session) {
    if (!this.resolved.ok) throw failure('codex_unavailable');
    const sandbox = sandboxMode(session.settings.sandboxPolicy);
    const approvals = approvalPolicy(session.settings.approvalPolicy);
    if (!Array.isArray(session.input) || !session.input.length || session.input.some((i) => i.type !== 'text' || typeof i.text !== 'string')) {
      throw failure('codex_input_unsupported');
    }
    const prompt = session.input.map((i) => i.text).join('\n');
    const state = { threadId: null, turnId: null, started: new Set(), completed: false, buffered: [], bytes: 0 };
    let complete, ready;
    const done = new Promise((resolve) => { complete = resolve; });
    const turnReady = new Promise((resolve) => { ready = resolve; });
    let child;
    try {
      child = this.spawnProcess(this.resolved.bin, [...this.resolved.prefix, 'app-server'], {
        cwd: session.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch { throw failure('codex_unavailable'); }
    session.child = child;
    session.providerSpawns = [{ pid: child.pid, args: ['app-server'] }];

    const onNotification = (msg) => {
      const p = msg.params || {};
      if (!state.threadId || p.threadId !== state.threadId || state.completed) return;
      if (!state.turnId) {
        state.bytes += Buffer.byteLength(JSON.stringify(msg));
        if (state.buffered.length >= 128 || state.bytes > 1024 * 1024) throw failure('codex_protocol_invalid');
        state.buffered.push(msg);
        return;
      }
      if ((p.turnId || p.turn?.id) !== state.turnId || (p.turn?.id && p.turn.id !== state.turnId)) return;
      switch (msg.method) {
        case Events.TURN_COMPLETED:
          if (!p.turn || !['completed', 'failed', 'interrupted'].includes(p.turn.status)) throw failure('codex_protocol_invalid');
          state.completed = true;
          complete(p.turn);
          break;
        case Events.TURN_PLAN_UPDATED:
          session.emit(Events.TURN_PLAN_UPDATED, { explanation: p.explanation, plan: (p.plan || []).map((s) => ({ step: s.step, status: s.status })) });
          break;
        case Events.ITEM_STARTED: case Events.ITEM_COMPLETED: {
          const item = mapItem(p.item, session.cwd);
          if (!item) break;
          if (!state.started.has(item.id)) { state.started.add(item.id); session.emit(Events.ITEM_STARTED, { item }); }
          if (msg.method === Events.ITEM_COMPLETED) session.emit(Events.ITEM_COMPLETED, { item });
          break;
        }
        case Events.AGENT_MESSAGE_DELTA: case Events.COMMAND_OUTPUT_DELTA:
          session.emit(msg.method, { itemId: 'codex_' + (p.itemId || ''), delta: p.delta || '' });
          break;
      }
    };
    const requests = new Set();
    const rpc = new CodexRpc(child, {
      timeoutMs: this.requestTimeoutMs,
      onNotification,
      onRequest: async (msg) => {
        // The provider may ask immediately before its turn/start response arrives.
        await turnReady;
        if (rpc.error) return;
        const p = msg.params || {};
        if (!state.turnId || state.completed || p.threadId !== state.threadId || p.turnId !== state.turnId ||
            ![Events.COMMAND_REQUEST_APPROVAL, Events.FILECHANGE_REQUEST_APPROVAL].includes(msg.method)) return rpc.refuse(msg.id);
        if (requests.has(msg.id)) return; // One host decision per provider request identity.
        if (requests.size >= 128) return rpc.fail('codex_request_limit');
        requests.add(msg.id);
        // Approvals confer only this action; session-wide accepts/permission changes
        // and unknown server requests are never translated into success.
        const decision = await session.requestApproval(msg.method, {
          itemId: 'codex_' + (p.itemId || ''), command: p.command,
          cwd: p.cwd || session.cwd, reason: p.reason,
          ...(msg.method === Events.FILECHANGE_REQUEST_APPROVAL ? { changes: p.changes || [] } : {})
        });
        if (!rpc.error && !state.completed) rpc.reply(msg.id, {
          decision: decision === ApprovalDecision.ACCEPT ? 'accept' : 'decline'
        });
      }
    });
    let timer;
    const onAbort = () => rpc.fail('codex_interrupted');
    session.abort?.signal.addEventListener('abort', onAbort, { once: true });
    if (session.abort?.signal.aborted) onAbort();
    try {
      await rpc.call('initialize', { clientInfo: { name: 'plexus', version: '0.1.0' } });
      rpc.notify('initialized');
      const result = await rpc.call('thread/start', {
        cwd: session.cwd, approvalPolicy: approvals, sandbox, ...(session.model ? { model: session.model } : {})
      });
      if (typeof result?.thread?.id !== 'string' || !result.thread.id) throw failure('codex_protocol_invalid');
      state.threadId = result.thread.id;
      session.providerSessionId = state.threadId;
      const turn = await rpc.call('turn/start', { threadId: state.threadId, input: [{ type: 'text', text: prompt }] });
      if (typeof turn?.turn?.id !== 'string' || !turn.turn.id) throw failure('codex_protocol_invalid');
      state.turnId = turn.turn.id;
      session.providerTurnId = state.turnId;
      for (const msg of state.buffered) onNotification(msg);
      state.buffered = [];
      ready();
      timer = setTimeout(() => rpc.fail('codex_turn_timeout'), this.turnTimeoutMs);
      const terminal = await Promise.race([done, rpc.closed.then((error) => { throw error; })]);
      if (terminal.status === 'failed') throw providerFailure(terminal.error);
      if (terminal.status === 'interrupted') throw failure('codex_interrupted');
    } catch (error) {
      throw error instanceof CodexProviderError ? error : failure('codex_protocol_invalid');
    } finally {
      ready();
      clearTimeout(timer);
      session.abort?.signal.removeEventListener('abort', onAbort);
      rpc.close();
      for (const resolve of session.pendingApprovals?.values() || []) resolve(ApprovalDecision.CANCEL);
      session.pendingApprovals?.clear();
      session.child = null;
    }
  }
}

module.exports = { CodexAppServerBackend, mapItem, sandboxMode, approvalPolicy };
