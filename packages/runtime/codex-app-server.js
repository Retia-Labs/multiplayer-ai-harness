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
const fs = require('node:fs');
const { Events, ItemTypes, ItemStatus, ApprovalDecision } = require('../protocol');
const { resolveCodex, codexConfigArgs } = require('./codex-probe');

const { CodexRpc, CodexProviderError, failure, providerFailure } = require('./codex-rpc');
const { prepareHostProfile, verifyProfileConfiguration, SUPPORTED_CODEX_VERSION } = require('./codex-host-profile');

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
      return { ...base, type: ItemTypes.FILE_CHANGE, status: mapStatus(it.status), changes: (it.changes || []).map((c) => ({ path: c.path, kind: (c.kind?.type || c.kind) === 'delete' ? 'delete' : (c.kind?.type || c.kind) === 'add' ? 'add' : 'update', additions: 0, deletions: 0, lines: [], ...(typeof c.diff === 'string' ? { diff: c.diff } : {}) })) };
    case 'error':
      return { ...base, type: ItemTypes.AGENT_MESSAGE, text: 'Codex reported an error. Check the provider on the execution host.' };
    default:
      return null;
  }
}

class CodexAppServerBackend {
  constructor({ bin, spawnProcess = spawn, requestTimeoutMs = 30000, turnTimeoutMs = 600000,
    interruptTimeoutMs = 5000 } = {}) {
    this.id = 'codex-app-server'; this.label = 'Codex CLI (app-server)';
    this.resolved = resolveCodex(bin); this.spawnProcess = spawnProcess;
    this.requestTimeoutMs = requestTimeoutMs; this.turnTimeoutMs = turnTimeoutMs;
    this.interruptTimeoutMs = interruptTimeoutMs;
  }
  capabilities() { return { toolCalls: true, reasoning: 'summary', images: false, steer: 'inline', approvals: true,
    resume: 'explicit-provider-thread', interrupt: 'acknowledged-with-timeout' }; }
  async listModels() { return []; }
  nativePolicy(session) { return { sandbox: sandboxMode(session.settings.sandboxPolicy), approvalPolicy: approvalPolicy(session.settings.approvalPolicy) }; }
  dynamicTools() { return null; }
  allowsNativeApproval() { return true; }
  async prepare() {}
  processOptions(session) { return { cwd: session.cwd, env: process.env }; }
  threadOptions() { return {}; }
  turnOptions() { return {}; }
  async verifyConfiguration() {}
  async verifyThread() {}

  async run(session) {
    if (!this.resolved.ok) throw failure('codex_unavailable');
    await this.prepare(session);
    const { sandbox, approvalPolicy: approvals } = this.nativePolicy(session);
    const dynamicTools = this.dynamicTools();
    const input = textInput(session.input);
    const resumeId = session.thread.codexAppServerThreadId;
    if (resumeId !== undefined && (typeof resumeId !== 'string' || !resumeId)) throw failure('codex_resume_invalid');
    const state = { threadId: null, turnId: null, started: new Set(), items: new Map(), completed: false,
      buffered: [], bytes: 0, steers: new Map(), interruptRequested: false };
    let complete, ready;
    const done = new Promise(resolve => { complete = resolve; });
    const turnReady = new Promise(resolve => { ready = resolve; });
    let child;
    const args = [...this.resolved.prefix, ...codexConfigArgs(session.settings), 'app-server'];
    try {
      child = this.spawnProcess(this.resolved.bin, args, {
        ...this.processOptions(session), stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch { throw failure('codex_unavailable'); }
    session.child = child;
    session.providerSpawns = [{ pid: child.pid, args }];
    let rpc, turnTimer, interruptTimer, steerWork = Promise.resolve();
    const requests = new Map(), hostCalls = new Map();
    let hostToolWork = Promise.resolve();
    const onNotification = (msg) => {
      const p = msg.params || {};
      if (!state.threadId || p.threadId !== state.threadId || state.completed) return;
      if (!state.turnId) {
        state.bytes += Buffer.byteLength(JSON.stringify(msg));
        if (state.buffered.length >= 128 || state.bytes > 1024 * 1024) throw failure('codex_protocol_invalid');
        state.buffered.push(msg); return;
      }
      if ((p.turnId || p.turn?.id) !== state.turnId || (p.turn?.id && p.turn.id !== state.turnId)) return;
      switch (msg.method) {
        case Events.TURN_COMPLETED:
          if (!p.turn || !['completed', 'failed', 'interrupted'].includes(p.turn.status)) throw failure('codex_protocol_invalid');
          state.completed = true;
          if (state.interruptRequested) session.providerInterrupt = { ...session.providerInterrupt,
            state: p.turn.status === 'interrupted' ? 'confirmed' : 'terminal-after-request', terminalStatus: p.turn.status };
          complete(p.turn); break;
        case Events.TURN_PLAN_UPDATED:
          session.emit(Events.TURN_PLAN_UPDATED, { explanation: p.explanation, plan: (p.plan || []).map(s => ({ step: s.step, status: s.status })) }); break;
        case Events.ITEM_STARTED: case Events.ITEM_COMPLETED: {
          const item = mapItem(p.item, session.cwd); if (!item) break;
          if (state.items.size >= 512 && !state.items.has(p.item.id)) throw failure('codex_request_limit');
          state.items.set(p.item.id, structuredClone(p.item));
          if (!state.started.has(item.id)) { state.started.add(item.id); session.emit(Events.ITEM_STARTED, { item }); }
          if (msg.method === Events.ITEM_COMPLETED) session.emit(Events.ITEM_COMPLETED, { item });
          break;
        }
        case Events.AGENT_MESSAGE_DELTA: case Events.COMMAND_OUTPUT_DELTA:
          session.emit(msg.method, { itemId: 'codex_' + (p.itemId || ''), delta: p.delta || '' }); break;
      }
    };
    rpc = new CodexRpc(child, {
      timeoutMs: this.requestTimeoutMs, onNotification,
      onRequest: async msg => {
        await turnReady;
        if (rpc.error) return;
        const p = msg.params || {};
        if (!['string', 'number'].includes(typeof msg.id)) return rpc.fail('codex_protocol_invalid');
        if (!state.turnId || state.completed || state.interruptRequested || p.threadId !== state.threadId || p.turnId !== state.turnId) return rpc.refuse(msg.id);
        if (msg.method === 'item/tool/call' && dynamicTools) {
          if (typeof p.callId !== 'string' || !p.callId || (p.namespace !== null && p.namespace !== undefined)) return rpc.refuse(msg.id);
          const binding = JSON.stringify([p.tool, p.arguments, p.threadId, p.turnId]);
          let held = hostCalls.get(p.callId);
          if (held && held.binding !== binding) return rpc.fail('codex_tool_changed');
          if (!held) {
            if (hostCalls.size >= 64) return rpc.fail('codex_request_limit');
            held = { binding }; hostCalls.set(p.callId, held);
            held.promise = hostToolWork = hostToolWork.then(() => {
              if (state.completed || state.interruptRequested || rpc.error) return toolResult(false, 'Host tool cancelled.');
              return this.callHostTool(session, p);
            }).catch(() => toolResult(false, 'Host tool failed.'));
          }
          const result = await held.promise;
          if (!rpc.error && !state.completed) rpc.reply(msg.id, result);
          return;
        }
        if (![Events.COMMAND_REQUEST_APPROVAL, Events.FILECHANGE_REQUEST_APPROVAL].includes(msg.method)) return rpc.refuse(msg.id);
        if (!this.allowsNativeApproval()) return rpc.reply(msg.id, { decision: 'decline' });
        const key = JSON.stringify(msg.id), binding = JSON.stringify([msg.method, p]);
        const prior = requests.get(key);
        if (prior) {
          if (prior.binding !== binding) return rpc.fail('codex_approval_changed');
          if (prior.result) rpc.reply(msg.id, prior.result);
          return;
        }
        if (requests.size >= 128) return rpc.fail('codex_request_limit');
        const record = { binding }; requests.set(key, record);
        const payload = approvalPayload(msg, state.items, session.cwd);
        if (!payload) { record.result = { decision: 'decline' }; return rpc.reply(msg.id, record.result); }
        const action = JSON.stringify(payload);
        // The shared session supplies request identities, fingerprints, approver grants,
        // expiry and cancellation. This adapter never grants session-wide authority.
        const decision = await session.requestApproval(msg.method, payload);
        if (!rpc.error && !state.completed) {
          const unchanged = JSON.stringify(approvalPayload(msg, state.items, session.cwd)) === action;
          record.result = { decision: unchanged && !state.interruptRequested && decision === ApprovalDecision.ACCEPT ? 'accept' : 'decline' };
          rpc.reply(msg.id, record.result);
        }
      }
    });

    // A queue entry is removed and reported delivered only after the provider names the
    // same active turn in its acknowledgment. clientUserMessageId is a stable correlation
    // identity; the protocol does not promise durable exactly-once external effects.
    const sendSteer = async entry => {
      await turnReady;
      if (rpc.error) throw rpc.error;
      const value = textInput(entry.input);
      if (!Number.isSafeInteger(entry.seq) || entry.seq <= 0) throw failure('codex_steer_invalid');
      const binding = JSON.stringify(value), prior = state.steers.get(entry.seq);
      if (prior) { if (prior !== binding) throw failure('codex_steer_changed'); return; }
      if (state.completed || state.interruptRequested || !state.turnId) throw failure('codex_stale_turn');
      state.steers.set(entry.seq, binding);
      const result = await rpc.call('turn/steer', { threadId: state.threadId, expectedTurnId: state.turnId,
        input: value, clientUserMessageId: 'plexus:' + session.turnId + ':' + entry.seq });
      if (result?.turnId !== state.turnId) throw failure('codex_stale_turn');
      if (state.interruptRequested) throw failure('codex_interrupted');
      const index = session.steerQueue?.indexOf(entry);
      if (index >= 0) session.steerQueue.splice(index, 1);
      session.emit(Events.TURN_STEER_DELIVERED, { steerSeq: entry.seq, by: entry.by });
    };
    const controls = {
      // Session's synchronous acceptance stays queued; this hook owns all async failures.
      steer: entry => { steerWork = steerWork.then(() => sendSteer(entry)).catch(error => rpc.fail(error.code || 'codex_steer_failed')); },
      interrupt: () => onAbort()
    };
    const onAbort = () => {
      if (state.interruptRequested || state.completed || rpc.error) return;
      state.interruptRequested = true;
      if (!state.turnId) return rpc.fail('codex_interrupted');
      session.providerInterrupt = { state: 'requested', providerTurnId: state.turnId };
      clearTimeout(turnTimer);
      const force = code => {
        if (state.completed) return;
        session.providerInterrupt = { ...session.providerInterrupt, state: 'forced', reason: code };
        rpc.fail(code); try { child.kill('SIGKILL'); } catch {}
      };
      interruptTimer = setTimeout(() => force('codex_interrupt_timeout'), this.interruptTimeoutMs);
      rpc.call('turn/interrupt', { threadId: state.threadId, turnId: state.turnId }).then(result => {
        if (!result || typeof result !== 'object' || Array.isArray(result)) return rpc.fail('codex_protocol_invalid');
        if (!state.completed) session.providerInterrupt = { ...session.providerInterrupt, state: 'acknowledged' };
      }).catch(error => force(error.code || 'codex_interrupt_failed'));
    };
    session.providerControl = controls;
    session.abort?.signal.addEventListener('abort', onAbort, { once: true });
    if (session.abort?.signal.aborted) onAbort();
    try {
      await rpc.call('initialize', { clientInfo: { name: 'plexus', version: '0.1.0' }, ...(dynamicTools ? { capabilities: { experimentalApi: true } } : {}) });
      rpc.notify('initialized');
      await this.verifyConfiguration(rpc, session);
      const method = resumeId ? 'thread/resume' : 'thread/start';
      const result = await rpc.call(method, { ...(resumeId ? { threadId: resumeId } : {}),
        cwd: session.cwd, approvalPolicy: approvals, sandbox, ...(session.model ? { model: session.model } : {}),
        ...(dynamicTools ? { developerInstructions: HOST_TOOL_INSTRUCTIONS, ...(!resumeId ? { dynamicTools } : {}) } : {}),
        ...this.threadOptions(session, { resume: Boolean(resumeId) }) });
      if (typeof result?.thread?.id !== 'string' || !result.thread.id || (resumeId && result.thread.id !== resumeId)) throw failure('codex_protocol_invalid');
      await this.verifyThread(rpc, session, result);
      state.threadId = result.thread.id;
      session.providerSessionId = state.threadId;
      session.thread.codexAppServerThreadId = state.threadId;
      await session.onProviderStateChanged?.();
      session.providerResume = { state: resumeId ? 'acknowledged' : 'new-thread', providerThreadId: state.threadId };
      const turn = await rpc.call('turn/start', { threadId: state.threadId, input,
        clientUserMessageId: 'plexus:' + session.turnId + ':start', ...this.turnOptions(session) });
      if (typeof turn?.turn?.id !== 'string' || !turn.turn.id) throw failure('codex_protocol_invalid');
      state.turnId = turn.turn.id; session.providerTurnId = state.turnId;
      for (const msg of state.buffered) onNotification(msg);
      state.buffered = []; ready();
      for (const entry of session.steerQueue || []) controls.steer(entry);
      turnTimer = setTimeout(() => rpc.fail('codex_turn_timeout'), this.turnTimeoutMs);
      const terminal = await Promise.race([done, rpc.closed.then(error => { throw error; })]);
      await steerWork;
      if (rpc.error) throw rpc.error;
      if (terminal.status === 'failed') throw providerFailure(terminal.error);
      if (terminal.status === 'interrupted' || state.interruptRequested) throw failure('codex_interrupted');
    } catch (error) {
      throw error instanceof CodexProviderError ? error : failure('codex_protocol_invalid');
    } finally {
      ready(); clearTimeout(turnTimer); clearTimeout(interruptTimer);
      session.abort?.signal.removeEventListener('abort', onAbort);
      if (session.providerControl === controls) session.providerControl = null;
      rpc.close();
      if (session.cancelPendingApprovals) session.cancelPendingApprovals('provider_disconnected');
      else {
        for (const pending of session.pendingApprovals?.values() || []) (typeof pending === 'function' ? pending : pending.resolve)(ApprovalDecision.CANCEL);
        session.pendingApprovals?.clear();
      }
      session.child = null;
    }
  }
}

function textInput(input) {
  if (!Array.isArray(input) || !input.length || input.some(item => item.type !== 'text' || typeof item.text !== 'string' || !item.text.trim())) throw failure('codex_input_unsupported');
  return input.map(item => ({ type: 'text', text: item.text }));
}

function approvalPayload(msg, items, cwd) {
  const p = msg.params || {}, item = items.get(p.itemId);
  if (typeof p.itemId !== 'string' || !p.itemId || p.grantRoot) return null;
  if (msg.method === Events.COMMAND_REQUEST_APPROVAL) {
    const command = p.command || (item?.type === 'commandExecution' && item.command);
    if (typeof command !== 'string' || !command.trim()) return null;
    return { itemId: 'codex_' + p.itemId, command, cwd: p.cwd || item?.cwd || cwd, ...(p.reason ? { reason: p.reason } : {}) };
  }
  // v0.137.0 file approval contains no patch. Bind to the previously observed item;
  // a missing/empty patch or a session-wide grantRoot is never an approvable action.
  const changes = item?.type === 'fileChange' && item.changes;
  if (!Array.isArray(changes) || !changes.length || changes.some(change =>
    typeof change.path !== 'string' || !change.path || typeof change.diff !== 'string' || !change.diff)) return null;
  return { itemId: 'codex_' + p.itemId, cwd, changes: structuredClone(changes), ...(p.reason ? { reason: p.reason } : {}) };
}


const HOST_TOOL_INSTRUCTIONS = 'Native tools may inspect this project read-only. For all mutations use plexus_write_file or plexus_remove_path. These tools run on the execution host, enforce its workspace and approval policy, and their returned success is authoritative. Never request native sandbox escalation or use a native tool to write. Paths must be relative to the authorized project.';
const HOST_TOOLS = [
  { name: 'plexus_write_file', description: 'Create or replace one project file with its complete contents through the execution host policy. Relative paths only.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'plexus_remove_path', description: 'Remove one relative project file or directory through the execution host policy. Destructive removal requires a scoped human decision.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }
];
const toolResult = (success, text) => ({ success, contentItems: [{ type: 'inputText', text }] });

// The native process never gets write permission. Only these two host-owned methods can
// mutate the workspace, through the same policy, approval and symlink checks as other tools.
class ConfinedCodexAppServerBackend extends CodexAppServerBackend {
  constructor(options = {}) { super(options); this.label = 'Codex interactive (read-only provider, host tools)'; }
  nativePolicy() { return { sandbox: 'read-only', approvalPolicy: 'never' }; }
  dynamicTools() { return structuredClone(HOST_TOOLS); }
  allowsNativeApproval() { return false; }
  capabilities() { return { ...super.capabilities(), providerWrites: false, writes: true, writesVia: 'host-workspace-tools',
    sandbox: 'read-only', nativeApprovals: false, approvals: true }; }
  async callHostTool(session, request) {
    const args = request.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.path !== 'string' ||
        !args.path || args.path.length > 4096 || session.cancelled || session.abort?.signal.aborted) return toolResult(false, 'Host tool declined.');
    let result;
    if (request.tool === 'plexus_write_file') {
      if (Object.keys(args).some(key => !['path', 'content'].includes(key)) || typeof args.content !== 'string' ||
          Buffer.byteLength(args.content) > 256 * 1024) return toolResult(false, 'Host tool arguments refused.');
      result = await session.writeFile(args.path, args.content);
    } else if (request.tool === 'plexus_remove_path') {
      if (Object.keys(args).some(key => key !== 'path')) return toolResult(false, 'Host tool arguments refused.');
      result = await session.removePath(args.path);
    } else return toolResult(false, 'Host tool unavailable.');
    const success = result?.item?.status === ItemStatus.COMPLETED && (result.item.exitCode === undefined || result.item.exitCode === 0);
    return toolResult(success, success ? 'The execution host completed the requested workspace action.' : 'The execution host declined or failed this workspace action.');
  }
}

const READ_TOOLS = [
  { name: 'plexus_read_file', description: 'Read one bounded UTF-8 text file inside the authorized project. Returns JSON with path, encoding and exact content; preserve whitespace and escaped final newlines when copying content. Relative paths only; traversal, absolute paths and symlinks are refused.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'plexus_list_files', description: 'List one project directory through the execution host without following symlinks. Use path . for the project root.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }
];
const HOST_ONLY_INSTRUCTIONS = 'The execution host is the sole workspace authority. You have no native environments, terminal, file tools, MCP, apps, plugins, web search or other external tools. Read and list project files only with plexus_read_file and plexus_list_files; write or remove them only with plexus_write_file and plexus_remove_path. Paths are relative to the authorized project; absolute paths, traversal and symlinks are refused. Host results are authoritative. Never treat the provider profile directory as the project. A declined action did not happen. Request no alternate tool or escalation to bypass a refusal.';

// Version-pinned environment-free provider. Native process tools are neither exposed nor
// registered; every project read/write runs through host-owned workspace capabilities.
class HostToolsCodexAppServerBackend extends ConfinedCodexAppServerBackend {
  constructor({ profileDir, authFile, versionProbe, ...options } = {}) {
    super(options);
    this.profileDir = profileDir; this.authFile = authFile; this.versionProbe = versionProbe;
    this.label = 'Codex interactive (host workspace tools)';
  }
  capabilities() { return { ...super.capabilities(), nativeTools: false, providerReads: false,
    reads: true, readsVia: 'host-workspace-tools', writesVia: 'host-workspace-tools',
    supportedVersion: SUPPORTED_CODEX_VERSION, supportedPlatform: 'darwin-arm64' }; }
  dynamicTools() { return structuredClone([...READ_TOOLS, ...HOST_TOOLS]); }
  async prepare(session) {
    if (session.model && session.model !== 'gpt-5.4-mini') throw failure('codex_host_tools_model_unsupported');
    session.model = 'gpt-5.4-mini';
    this.profile = prepareHostProfile({ profileDir: this.profileDir, authFile: this.authFile,
      workspace: session.cwd, resolved: this.resolved, versionProbe: this.versionProbe });
  }
  // Host-local readiness check: validates the same configuration and empty instruction
  // sources as a task, but starts no model turn and retains no provider thread history.
  async checkHost({ workspace, settings = {} }) {
    const session = { cwd: workspace, settings };
    await this.prepare(session);
    const child = this.spawnProcess(this.resolved.bin, [...this.resolved.prefix, ...codexConfigArgs(settings), 'app-server'],
      { ...this.processOptions(session), stdio: ['pipe', 'pipe', 'pipe'] });
    const rpc = new CodexRpc(child, { timeoutMs: this.requestTimeoutMs, onRequest: message => rpc.refuse(message.id) });
    try {
      await rpc.call('initialize', { clientInfo: { name: 'plexus', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      rpc.notify('initialized');
      await this.verifyConfiguration(rpc, session);
      const result = await rpc.call('thread/start', { ...this.threadOptions(session), dynamicTools: this.dynamicTools(),
        model: 'gpt-5.4-mini', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
      await this.verifyThread(rpc, session, result);
      return { ready: true, version: this.profile.version, capabilities: this.capabilities() };
    } finally { rpc.close(); }
  }
  processOptions() { return { cwd: this.profile.profileDir, env: this.profile.environment }; }
  threadOptions(session, { resume } = {}) {
    return { cwd: this.profile.profileDir, modelProvider: 'openai',
      developerInstructions: HOST_ONLY_INSTRUCTIONS, ...(!resume ? { environments: [] } : {}) };
  }
  turnOptions() { return { environments: [] }; }
  async verifyConfiguration(rpc, session) {
    const managed = await rpc.call('configRequirements/read', {});
    if (!managed || managed.requirements !== null) throw failure('codex_host_tools_managed_requirements_unproven');
    const read = await rpc.call('config/read', { includeLayers: true, cwd: this.profile.profileDir });
    verifyProfileConfiguration(read, { profileDir: this.profile.profileDir, effort: session.settings.effort || 'medium' });
    const inventory = await rpc.call('mcpServerStatus/list', {});
    if (!Array.isArray(inventory?.data) || inventory.data.length || inventory.nextCursor) throw failure('codex_host_tools_ambient_tools');
  }
  async verifyThread(rpc, session, result) {
    if (result.cwd !== this.profile.profileDir || result.modelProvider !== 'openai' || result.model !== 'gpt-5.4-mini' || result.approvalPolicy !== 'never' ||
        result.sandbox?.type !== 'readOnly' || result.sandbox.networkAccess !== false ||
        !Array.isArray(result.instructionSources) || result.instructionSources.length) throw failure('codex_host_tools_policy_unverified');
    const inventory = await rpc.call('mcpServerStatus/list', { threadId: result.thread.id });
    if (!Array.isArray(inventory?.data) || inventory.data.length || inventory.nextCursor) throw failure('codex_host_tools_ambient_tools');
  }
  async callHostTool(session, request) {
    if (!['plexus_read_file', 'plexus_list_files'].includes(request.tool)) return super.callHostTool(session, request);
    const args = request.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'path') ||
        typeof args.path !== 'string' || !args.path || args.path.length > 4096 || session.cancelled || session.abort?.signal.aborted) return toolResult(false, 'Host tool arguments refused.');
    try {
      if (request.tool === 'plexus_read_file') {
        // Invalid paths still pass through the public host read seam so their refusal is
        // recorded in the encrypted task history. Only the size preflight returns early.
        let target;
        try { target = session.workspace.inspect(args.path); } catch {}
        if (target && fs.statSync(target.path).size > 256 * 1024) return toolResult(false, 'Host file exceeds the bounded reader size.');
      }
      const result = request.tool === 'plexus_read_file' ? await session.readFile(args.path) : await session.listFiles(args.path);
      if (result?.item?.status !== ItemStatus.COMPLETED || result.item.exitCode !== 0 || Buffer.byteLength(result.result || '') > 256 * 1024) return toolResult(false, 'The execution host refused this read.');
      return toolResult(true, request.tool === 'plexus_read_file'
        ? JSON.stringify({ path: args.path, encoding: 'utf-8', content: result.result })
        : result.result || '(Empty directory)');
    } catch { return toolResult(false, 'The execution host refused this read.'); }
  }
}

module.exports = { CodexAppServerBackend, ConfinedCodexAppServerBackend, HostToolsCodexAppServerBackend, mapItem, sandboxMode, approvalPolicy };
