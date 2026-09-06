'use strict';
// TurnSession: one agent turn on one thread. Emits protocol events through `emit`,
// runs tools through the executor under the policy engine, and exposes steering,
// interrupt, and approval resolution to the runtime (which routes them from the hub).
const crypto = require('crypto');
const path = require('path');
const { Events, ItemTypes, ItemStatus, TurnStatus, ApprovalDecision } = require('../protocol');
const { decideCommand, decideFileWrite } = require('./policy');
const { lineDiff } = require('./diff');
const { WorkspaceAccess } = require('./workspace');

const MAX_TOOL_OUTPUT = 20000;
const MAX_MODEL_ROUNDS = 32;
const uid = (p) => p + '_' + crypto.randomBytes(6).toString('hex');

const TOOLS = [
  { name: 'read_file', description: 'Read one regular text file inside the authorized workspace. Absolute paths, traversal, and symlinks are refused.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'list_files', description: 'List one directory inside the authorized workspace without following symlinks.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'write_file', description: 'Create or completely replace a file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'remove_path', description: 'Remove a relative file or directory inside the authorized workspace after policy approval.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'update_plan', description: 'Show or update a step checklist for the user. Statuses: pending, inProgress, completed.', parameters: { type: 'object', properties: { explanation: { type: 'string' }, plan: { type: 'array', items: { type: 'object', properties: { step: { type: 'string' }, status: { type: 'string', enum: ['pending', 'inProgress', 'completed'] } }, required: ['step', 'status'] } } }, required: ['plan'] } }
];

class TurnSession {
  constructor({ thread, turnId, by, input, provider, model, settings, executor, emit, history, teammates, log = () => {} }) {
    this.teammates = teammates || (() => []);
    this.thread = thread;
    this.turnId = turnId || uid('turn');
    this.by = by;
    this.input = input;
    this.provider = provider;     // adapter or { id: 'demo' } or { id: 'codex-cli', run }
    this.model = model;
    this.settings = settings;     // { approvalPolicy, sandboxPolicy, effort }
    this.executor = executor;
    this.workspace = new WorkspaceAccess(this.cwd);
    this._emit = emit;
    this.history = history || [];
    this.log = log;
    this.running = false;
    this.cancelled = false;
    this.pendingApprovals = new Map(); // requestId -> resolve(decision)
    this.steerQueue = [];
    this.usage = { input: 0, output: 0 };
    this.abort = new AbortController();
    this.child = null;
  }

  get cwd() { return this.thread.workDir || this.thread.cwd; }

  emit(method, payload) { this._emit({ method, turnId: this.turnId, ...payload }); }

  // ---------- public control surface ----------
  steer(input, by) {
    this.steerQueue.push({ input, by });
    this.emitUserMessage(input, by, 'steer');
  }

  interrupt() {
    this.cancelled = true;
    this.abort.abort();
    for (const resolve of this.pendingApprovals.values()) resolve(ApprovalDecision.CANCEL);
    this.pendingApprovals.clear();
    if (this.child) { try { this.child.kill('SIGKILL'); } catch {} }
  }

  resolveApproval(requestId, decision, by) {
    if (![ApprovalDecision.ACCEPT, ApprovalDecision.DECLINE, ApprovalDecision.CANCEL].includes(decision)) return false;
    const resolve = this.pendingApprovals.get(requestId);
    if (!resolve) return false;
    this.pendingApprovals.delete(requestId);
    this.emit(Events.SERVER_REQUEST_RESOLVED, { requestId, decision, by });
    resolve(decision);
    return true;
  }

  // ---------- turn lifecycle ----------
  async run() {
    this.running = true;
    this.emit(Events.TURN_STARTED, { by: this.by, model: this.model, provider: this.provider.id });
    this.emitUserMessage(this.input, this.by);
    let status = TurnStatus.COMPLETED;
    let error;
    try {
      if (this.provider.id === 'demo') await this.runDemo();
      else if (this.provider.id === 'codex-cli') await this.provider.run(this);
      else await this.runModel();
      if (this.cancelled) status = TurnStatus.INTERRUPTED;
    } catch (err) {
      if (this.cancelled) status = TurnStatus.INTERRUPTED;
      else { status = TurnStatus.FAILED; error = { message: String(err && err.message || err) }; }
    }
    this.running = false;
    this.emit(Events.TURN_COMPLETED, { status, usage: this.usage.input + this.usage.output ? this.usage : undefined, error });
    return { status, error };
  }

  // ---------- item helpers ----------
  emitUserMessage(input, by, delivery) {
    const text = input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
    const images = input.filter((i) => i.type === 'image').map((i) => i.url);
    const item = { id: uid('msg'), type: ItemTypes.USER_MESSAGE, text, images, by, delivery };
    this.emit(Events.ITEM_STARTED, { item });
    this.emit(Events.ITEM_COMPLETED, { item });
    return item;
  }

  startText(type) {
    const item = { id: uid(type === ItemTypes.REASONING ? 'rsn' : 'msg'), type, text: '' };
    this.emit(Events.ITEM_STARTED, { item });
    return item;
  }
  deltaText(item, delta) {
    item.text += delta;
    this.emit(item.type === ItemTypes.REASONING ? Events.REASONING_DELTA : Events.AGENT_MESSAGE_DELTA, { itemId: item.id, delta });
  }
  completeText(item) { this.emit(Events.ITEM_COMPLETED, { item }); }

  async streamText(type, text, chunk = 24, delay = 8) {
    const item = this.startText(type);
    for (let i = 0; i < text.length && !this.cancelled; i += chunk) {
      this.deltaText(item, text.slice(i, i + chunk));
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    this.completeText(item);
    return item;
  }

  updatePlan(plan, explanation) {
    this.emit(Events.TURN_PLAN_UPDATED, { explanation, plan });
    return 'Plan updated.';
  }

  async requestApproval(method, payload) {
    const requestId = uid('req');
    this.emit(method, {
      requestId,
      ...payload,
      availableDecisions: [ApprovalDecision.ACCEPT, ApprovalDecision.DECLINE, ApprovalDecision.CANCEL]
    });
    return await new Promise((resolve) => this.pendingApprovals.set(requestId, resolve));
  }

  // ---------- tools ----------
  async execCommand(command) {
    const item = { id: uid('cmd'), type: ItemTypes.COMMAND_EXECUTION, command, cwd: this.cwd, executor: this.executor.id, status: ItemStatus.IN_PROGRESS, aggregatedOutput: '' };
    const list = String(command).match(/^ls -la(?: ([A-Za-z0-9._/\\-]+))?$/);
    if (list) return (await this.listFiles(list[1] || '.', command)).item;
    const remove = String(command).match(/^rm -rf ([A-Za-z0-9._/\\-]+)$/);
    if (remove) return (await this.removePath(remove[1], command)).item;

    // Generic model providers receive structured workspace tools, never a local shell.
    // Keep this compatibility entry point fail-closed for old demo scenarios and records.
    this.emit(Events.ITEM_STARTED, { item });
    item.status = ItemStatus.DECLINED;
    item.exitCode = -1;
    item.aggregatedOutput = 'Unavailable: arbitrary shell and Git commands require a proven project-confined provider sandbox.';
    this.emit(Events.ITEM_COMPLETED, { item });
    return item;
  }

  async listFiles(relPath = '.', command = null) {
    const item = { id: uid('cmd'), type: ItemTypes.COMMAND_EXECUTION, command: command || `list_files ${relPath}`, cwd: this.cwd, executor: 'workspace', status: ItemStatus.IN_PROGRESS, aggregatedOutput: '' };
    this.emit(Events.ITEM_STARTED, { item });
    try {
      const rows = this.workspace.list(relPath);
      item.aggregatedOutput = rows.map((entry) => `${entry.type === 'directory' ? 'd' : entry.type === 'symlink' ? 'l' : '-'} ${entry.name}`).join('\n') + (rows.length ? '\n' : '');
      item.exitCode = 0;
      item.status = ItemStatus.COMPLETED;
    } catch (err) {
      item.aggregatedOutput = String(err && err.message || err);
      item.exitCode = -1;
      item.status = ItemStatus.DECLINED;
    }
    this.emit(Events.ITEM_COMPLETED, { item });
    return { item, result: item.aggregatedOutput };
  }

  async readFile(relPath) {
    const item = { id: uid('cmd'), type: ItemTypes.COMMAND_EXECUTION, command: `read_file ${relPath}`, cwd: this.cwd, executor: 'workspace', status: ItemStatus.IN_PROGRESS, aggregatedOutput: '' };
    this.emit(Events.ITEM_STARTED, { item });
    try {
      item.aggregatedOutput = this.workspace.readFile(relPath);
      item.exitCode = 0;
      item.status = ItemStatus.COMPLETED;
    } catch (err) {
      item.aggregatedOutput = String(err && err.message || err);
      item.exitCode = -1;
      item.status = ItemStatus.DECLINED;
    }
    this.emit(Events.ITEM_COMPLETED, { item });
    return { item, result: item.aggregatedOutput };
  }

  async removePath(relPath, command = null) {
    const label = command || `remove_path ${relPath}`;
    const item = { id: uid('cmd'), type: ItemTypes.COMMAND_EXECUTION, command: label, cwd: this.cwd, executor: 'workspace', status: ItemStatus.IN_PROGRESS, aggregatedOutput: '' };
    let target;
    try { target = this.workspace.inspect(relPath); }
    catch (err) {
      this.emit(Events.ITEM_STARTED, { item });
      item.status = ItemStatus.DECLINED; item.exitCode = -1; item.aggregatedOutput = String(err && err.message || err);
      this.emit(Events.ITEM_COMPLETED, { item });
      return { item, result: item.aggregatedOutput };
    }
    const policyCommand = command || `rm -rf ${target.relative}`;
    const decision = decideCommand(policyCommand, this.settings);
    this.emit(Events.ITEM_STARTED, { item });
    if (decision.verdict === 'deny') {
      item.status = ItemStatus.DECLINED; item.aggregatedOutput = 'Declined by policy: ' + decision.reason;
      this.emit(Events.ITEM_COMPLETED, { item });
      return { item, result: item.aggregatedOutput };
    }
    if (decision.verdict === 'ask') {
      const d = await this.requestApproval(Events.COMMAND_REQUEST_APPROVAL, { itemId: item.id, command: label, cwd: this.cwd, reason: decision.reason });
      if (d === ApprovalDecision.DECLINE || d === ApprovalDecision.CANCEL) {
        item.status = ItemStatus.DECLINED; item.aggregatedOutput = d === ApprovalDecision.CANCEL ? 'Cancelled.' : 'Declined by user.';
        this.emit(Events.ITEM_COMPLETED, { item });
        if (d === ApprovalDecision.CANCEL) this.interrupt();
        return { item, result: item.aggregatedOutput };
      }
    }
    const t0 = Date.now();
    try {
      this.workspace.remove(target.relative);
      item.exitCode = 0;
      item.aggregatedOutput = `Removed ${target.relative}\n`;
    } catch (err) {
      item.exitCode = -1;
      item.aggregatedOutput = String(err && err.message || err);
    }
    item.durationMs = Date.now() - t0;
    item.status = item.exitCode === 0 ? ItemStatus.COMPLETED : ItemStatus.FAILED;
    this.emit(Events.ITEM_COMPLETED, { item });
    return { item, result: item.aggregatedOutput };
  }

  async writeFile(relPath, content) {
    let target;
    let oldText = null;
    try {
      target = this.workspace.inspect(relPath, { allowMissing: true });
      if (!target.missing) oldText = this.workspace.readFile(target.relative);
    } catch (err) {
      const item = { id: uid('chg'), type: ItemTypes.FILE_CHANGE, status: ItemStatus.DECLINED, changes: [{ path: String(relPath), kind: 'update', additions: 0, deletions: 0, lines: [] }] };
      this.emit(Events.ITEM_STARTED, { item });
      this.emit(Events.ITEM_COMPLETED, { item });
      return { item, result: 'Declined by workspace boundary: ' + String(err && err.message || err) };
    }
    relPath = target.relative;
    const kind = oldText === null ? 'add' : 'update';
    const d = kind === 'add'
      ? { lines: content.split('\n').slice(0, 400).map((t) => ({ kind: 'add', text: t })), additions: content.split('\n').length, deletions: 0 }
      : lineDiff(oldText, content);
    const item = { id: uid('chg'), type: ItemTypes.FILE_CHANGE, status: ItemStatus.IN_PROGRESS, changes: [{ path: relPath, kind, additions: d.additions, deletions: d.deletions, lines: d.lines }] };
    let decision = decideFileWrite(target.path, { workspace: this.workspace.root, ...this.settings });
    const collision = decision.verdict === 'allow' && this.settings.approvalPolicy !== 'never' ? this.collisionFor(relPath) : null;
    if (collision) {
      const who = (collision.thread.by && collision.thread.by.name) || 'a teammate';
      decision = { verdict: 'ask', reason: `collision: ${who}'s thread "${collision.thread.name}" changed ${relPath} ${Math.round((Date.now() - collision.ts) / 60000)} min ago` };
      item.collision = { threadId: collision.thread.threadId, name: collision.thread.name, by: collision.thread.by };
    }
    this.emit(Events.ITEM_STARTED, { item });
    if (decision.verdict === 'deny') {
      item.status = ItemStatus.DECLINED; this.emit(Events.ITEM_COMPLETED, { item });
      return { item, result: 'Declined by policy: ' + decision.reason };
    }
    if (decision.verdict === 'ask') {
      const dec = await this.requestApproval(Events.FILECHANGE_REQUEST_APPROVAL, { itemId: item.id, changes: item.changes.map((c) => ({ path: c.path, kind: c.kind, additions: c.additions, deletions: c.deletions })), reason: decision.reason, collision: item.collision || null });
      if (dec === ApprovalDecision.DECLINE || dec === ApprovalDecision.CANCEL) {
        item.status = ItemStatus.DECLINED; this.emit(Events.ITEM_COMPLETED, { item });
        if (dec === ApprovalDecision.CANCEL) this.interrupt();
        return { item, result: 'Declined by user.' };
      }
    }
    try {
      this.workspace.writeFile(relPath, content);
      item.status = ItemStatus.COMPLETED;
    } catch (e) {
      item.status = ItemStatus.FAILED;
      this.emit(Events.ITEM_COMPLETED, { item });
      return { item, result: 'Write failed: ' + String(e) };
    }
    this.emit(Events.ITEM_COMPLETED, { item });
    return { item, result: `Wrote ${relPath} (${kind}, +${d.additions} −${d.deletions}).` };
  }

  // ---------- model-backed loop ----------
  systemPrompt() {
    const sb = this.settings.sandboxPolicy, ap = this.settings.approvalPolicy;
    return [
      'You are a coding agent running inside a multiplayer harness. Several people may be watching this thread live and can steer you or answer approval requests.',
      `Workspace directory: ${this.cwd}`,
      this.thread.worktree ? `You are in an isolated git worktree on branch ${this.thread.branch}.` : '',
      `Sandbox policy: ${sb}. Approval policy: ${ap}.`,
      'Tools are project-confined capabilities: `read_file`, `list_files`, `write_file`, and `remove_path` never follow symlinks or accept outside paths. `update_plan` shows a live checklist.',
      'Prefer small verifiable steps and use the structured tools. Local shell and Git subprocesses are unavailable until the host has a proven project-confined provider sandbox.',
      this.teamAwareness()
    ].filter(Boolean).join('\n');
  }

  // What teammates' agents are doing on this project right now — so agents divide work instead of colliding.
  teamAwareness() {
    const mates = this.teammates();
    if (!mates.length) return '';
    const lines = mates.map((t) => {
      const who = (t.by && t.by.name) || 'someone';
      const files = t.files.slice(0, 12).map((f) => f.path).join(', ');
      return `- ${who}'s thread "${t.name}" (${t.active ? 'running now' : 'recently active'}${t.worktree ? ', isolated worktree ' + t.branch : ''})${files ? ' touched: ' + files : ''}`;
    });
    return 'Team activity on this project (avoid duplicating or clobbering this work; coordinate through the user if you must touch the same files):\n' + lines.join('\n');
  }

  collisionFor(relPath) {
    if (this.thread.worktree) return null; // isolated branch: merge risk, not a live collision
    const HOT_MS = 30 * 60000;
    for (const t of this.teammates()) {
      if (t.worktree) continue;
      const hit = t.files.find((f) => f.path === relPath && Date.now() - f.ts < HOT_MS);
      if (hit) return { thread: t, ts: hit.ts };
    }
    return null;
  }

  buildMessages() {
    const msgs = [];
    for (const it of this.history) {
      if (it.type === ItemTypes.USER_MESSAGE) msgs.push({ role: 'user', content: it.text, images: it.images });
      else if (it.type === ItemTypes.AGENT_MESSAGE) msgs.push({ role: 'assistant', content: it.text });
      else if (it.type === ItemTypes.COMMAND_EXECUTION) msgs.push({ role: 'assistant', content: `[ran: ${it.command}]\n${(it.aggregatedOutput || '').slice(0, 1500)}` });
      else if (it.type === ItemTypes.FILE_CHANGE) msgs.push({ role: 'assistant', content: `[changed: ${it.changes.map((c) => c.path).join(', ')}]` });
    }
    const text = this.input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
    const images = this.input.filter((i) => i.type === 'image').map((i) => i.url);
    msgs.push({ role: 'user', content: text, images });
    return msgs;
  }

  async runModel() {
    const messages = this.buildMessages();
    const tools = this.settings.sandboxPolicy === 'read-only'
      ? TOOLS.filter((tool) => ['read_file', 'list_files', 'update_plan'].includes(tool.name))
      : TOOLS;
    for (let round = 0; round < MAX_MODEL_ROUNDS && !this.cancelled; round++) {
      while (this.steerQueue.length) {
        const s = this.steerQueue.shift();
        messages.push({ role: 'user', content: s.input.filter((i) => i.type === 'text').map((i) => i.text).join('\n') });
      }
      let msgItem = null, rsnItem = null;
      const calls = [];
      for await (const d of this.provider.stream({ model: this.model, system: this.systemPrompt(), messages, tools, effort: this.settings.effort, signal: this.abort.signal })) {
        if (this.cancelled) break;
        if (d.type === 'text') { if (!msgItem) msgItem = this.startText(ItemTypes.AGENT_MESSAGE); this.deltaText(msgItem, d.text); }
        else if (d.type === 'reasoning') { if (!rsnItem) rsnItem = this.startText(ItemTypes.REASONING); this.deltaText(rsnItem, d.text); }
        else if (d.type === 'tool_call') calls.push(d);
        else if (d.type === 'usage') { this.usage.input += d.input || 0; this.usage.output += d.output || 0; }
      }
      if (rsnItem) this.completeText(rsnItem);
      if (msgItem) this.completeText(msgItem);
      if (!calls.length) {
        if (this.steerQueue.length) continue;
        return;
      }
      messages.push({ role: 'assistant', content: msgItem ? msgItem.text : '', toolCalls: calls });
      for (const c of calls) {
        if (this.cancelled) return;
        let args = {}; try { args = JSON.parse(c.arguments || '{}'); } catch {}
        let result;
        if (c.name === 'read_file') {
          result = args.path != null ? (await this.readFile(String(args.path))).result.slice(0, MAX_TOOL_OUTPUT) : 'missing path';
        } else if (c.name === 'list_files') {
          result = (await this.listFiles(args.path == null ? '.' : String(args.path))).result.slice(0, MAX_TOOL_OUTPUT);
        } else if (c.name === 'write_file') {
          result = (args.path != null && args.content != null) ? (await this.writeFile(String(args.path), String(args.content))).result : 'missing path/content';
        } else if (c.name === 'remove_path') {
          result = args.path != null ? (await this.removePath(String(args.path))).result : 'missing path';
        } else if (c.name === 'update_plan') {
          result = Array.isArray(args.plan) ? this.updatePlan(args.plan, args.explanation) : 'missing plan';
        } else result = 'unknown tool ' + c.name;
        messages.push({ role: 'tool', toolCallId: c.id, content: result });
      }
    }
  }

  // ---------- demo backend (no key needed; drives the real tool/approval pipeline) ----------
  async runDemo() {
    // Every demo turn opens with a paced "thinking" phase, like a real model — this is also the
    // window in which teammates can steer.
    await this.streamText(ItemTypes.REASONING, 'Reading the request, checking team activity on this project, and deciding on the safest sequence of steps before touching anything.', 16, 70);
    await this.runDemoScenario();
    if (this.steerQueue.length && !this.cancelled) {
      const extra = this.steerQueue.splice(0).map((s) => s.input.filter((i) => i.type === 'text').map((i) => i.text).join(' ')).join('; ');
      await this.streamText(ItemTypes.AGENT_MESSAGE, `Noted the steer from a teammate: _${extra}_ — a live model would fold that into this turn (crabs included).`);
    }
  }

  async runDemoScenario() {
    const text = this.input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
    const lower = text.toLowerCase();
    const note = '\n\n_Demo agent — add a provider key on this runtime to connect a real model._';

    if (/\b(delete|remove|clean|wipe|install|deploy|push|reset)\b/.test(lower)) {
      const target = (text.match(/\b(?:delete|remove|clean|wipe)\s+(?:the\s+)?([\w./-]+)/i) || [])[1];
      const cmd = /\binstall\b/.test(lower) ? 'npm install' : /\bpush\b/.test(lower) ? 'git push origin HEAD' : `rm -rf ${target && target !== 'the' ? target : 'build'}`;
      this.updatePlan([{ step: 'Confirm scope', status: 'completed' }, { step: `Run \`${cmd}\``, status: 'inProgress' }, { step: 'Verify workspace', status: 'pending' }], 'Requires approval before the risky step.');
      const item = await this.execCommand(cmd);
      if (this.cancelled) return;
      this.updatePlan([{ step: 'Confirm scope', status: 'completed' }, { step: `Run \`${cmd}\``, status: 'completed' }, { step: 'Verify workspace', status: 'inProgress' }]);
      await this.execCommand('ls -la');
      this.updatePlan([{ step: 'Confirm scope', status: 'completed' }, { step: `Run \`${cmd}\``, status: 'completed' }, { step: 'Verify workspace', status: 'completed' }]);
      await this.streamText(ItemTypes.AGENT_MESSAGE, item.status === 'completed'
        ? `Done — \`${cmd}\` ran after approval (exit ${item.exitCode}). Workspace listing above.` + note
        : `I didn't run \`${cmd}\` — the request was **${item.status}**. Nothing was changed.` + note);
      return;
    }
    if (/\b(create|write|add|make|build|generate)\b/.test(lower) && !/\bdiff|changes\b/.test(lower)) {
      this.updatePlan([{ step: 'Inspect the workspace', status: 'inProgress' }, { step: 'Create the requested file', status: 'pending' }, { step: 'Verify the result', status: 'pending' }]);
      await this.execCommand('ls -la');
      this.updatePlan([{ step: 'Inspect the workspace', status: 'completed' }, { step: 'Create the requested file', status: 'inProgress' }, { step: 'Verify the result', status: 'pending' }]);
      const fname = (text.match(/([\w./-]+\.(?:md|txt|js|ts|py|json|html|css|sh))/i) || [])[1] || 'NOTES.md';
      const { item } = await this.writeFile(fname, `# Created by the Plexus demo agent\n\nYou asked:\n> ${text}\n\nWritten through the same write_file → policy → fileChange pipeline a real model uses.\n`);
      this.updatePlan([{ step: 'Inspect the workspace', status: 'completed' }, { step: 'Create the requested file', status: 'completed' }, { step: 'Verify the result', status: 'inProgress' }]);
      await this.execCommand(`ls -la ${fname.split('/')[0]}`);
      this.updatePlan([{ step: 'Inspect the workspace', status: 'completed' }, { step: 'Create the requested file', status: 'completed' }, { step: 'Verify the result', status: 'completed' }]);
      await this.streamText(ItemTypes.AGENT_MESSAGE, `Created **${fname}** (${item.status}). Open **Changes** to review, revert, or commit it.` + note);
      return;
    }
    if (/\b(what|show|list|look|explore|files|structure|around|repo)\b/.test(lower)) {
      const ls = await this.execCommand('ls -la');
      await this.execCommand('git status --short --branch');
      const n = Math.max((ls.aggregatedOutput || '').split('\n').filter(Boolean).length - 1, 0);
      await this.streamText(ItemTypes.AGENT_MESSAGE, `The workspace \`${path.basename(this.cwd)}\` has about **${n} entries** at the top level; git status is shown above.` + note);
      return;
    }
    if (/\b(diff|changes|changed)\b/.test(lower)) {
      await this.execCommand('git diff --stat');
      await this.streamText(ItemTypes.AGENT_MESSAGE, 'Those are the working-tree changes. The **Changes** panel has per-file diffs, revert, and commit.' + note);
      return;
    }
    await this.streamText(ItemTypes.AGENT_MESSAGE,
      `I'm the built-in **demo agent**, so I can't really work on:\n\n> ${text}\n\nTry: “**delete** the build directory” (approval flow), “**create** NOTES.md” (plan + file edit), “**explore** the repo”, or “show the **diff**”.` + note);
  }
}

module.exports = { TurnSession, TOOLS };
