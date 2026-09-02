'use strict';
// Harness runtime daemon: the only process that holds provider keys and touches the
// workspace. It registers with a hub, owns threads, runs turns, and executes commands
// routed from any client (start, steer, interrupt, approvals, git operations).
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HubClient } = require('./hub-client');
const { RuntimeStore } = require('./store');
const { TurnSession } = require('./session');
const { createProvider, DEFAULT_MODELS } = require('./providers');
const { CodexExecBackend, available: codexAvailable } = require('./codex-exec');
const { ClaudeCodeBackend, available: claudeAvailable } = require('./claude-code');
const { createExecutor, CrabboxExecutor } = require('./executors');
const { PRESETS } = require('./policy');
const git = require('./git');
const { Commands, Events, ItemTypes } = require('../protocol');

const uid = (p) => p + '_' + crypto.randomBytes(8).toString('hex');

class Runtime {
  constructor({ hubUrl, org = 'local', userName, dataDir, projects = [], providers = {}, executor = 'local', name, log = () => {} }) {
    this.hubUrl = hubUrl;
    this.org = org;
    this.userName = userName || os.userInfo().username;
    this.dataDir = dataDir || path.join(os.homedir(), '.harness');
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.store = new RuntimeStore(path.join(this.dataDir, 'runtime.sqlite'));
    this.id = this.store.getKv('runtimeId') || (() => { const id = uid('rt'); this.store.setKv('runtimeId', id); return id; })();
    this.name = name || `${this.userName}@${os.hostname()}`;
    this.log = log;
    this.providerConfig = providers;   // { openai: {apiKey, baseUrl}, anthropic: {apiKey}, ollama: {baseUrl}, openrouter: {apiKey} }
    this.executor = createExecutor(executor);
    this.projects = new Map();
    for (const dir of projects) this.projects.set(path.resolve(dir), { dir: path.resolve(dir), name: path.basename(dir) });
    this.sessions = new Map(); // threadId -> TurnSession
    this.hub = null;
    this.activity = { threads: [], overlaps: [] }; // team awareness snapshot pushed by the hub
  }

  // ---------- providers ----------
  providerList() {
    const list = [{ id: 'demo', label: 'Demo agent (no key)', configured: true, models: DEFAULT_MODELS.demo }];
    for (const id of ['openai', 'anthropic', 'openrouter']) {
      const cfg = this.providerConfig[id];
      list.push({ id, label: { openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter' }[id], configured: !!(cfg && cfg.apiKey), models: DEFAULT_MODELS[id] || [] });
    }
    list.push({ id: 'ollama', label: 'Ollama / local', configured: true, models: DEFAULT_MODELS.ollama });
    list.push({ id: 'codex-cli', label: 'Codex CLI (codex exec)', configured: codexAvailable(), models: ['gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5.1-codex-mini'] });
    list.push({ id: 'claude-code', label: 'Claude Code CLI (your subscription)', configured: claudeAvailable(), models: ['default', 'sonnet', 'opus', 'haiku'] });
    return list;
  }

  provider(id) {
    if (id === 'demo') return { id: 'demo' };
    if (id === 'codex-cli') return new CodexExecBackend();
    if (id === 'claude-code') return new ClaudeCodeBackend();
    const cfg = this.providerConfig[id] || {};
    if ((id === 'openai' || id === 'anthropic' || id === 'openrouter') && !cfg.apiKey) throw new Error(`No API key configured for ${id} on runtime ${this.name}`);
    return createProvider({ id, ...cfg });
  }

  // ---------- hub connection ----------
  descriptor() {
    return {
      id: this.id,
      name: this.name,
      host: os.hostname(),
      platform: process.platform,
      projects: [...this.projects.values()],
      providers: this.providerList(),
      executors: [{ id: 'local', label: 'This machine' }, { id: 'crabbox', label: 'Crabbox remote runner', available: CrabboxExecutor.available() }],
      executor: this.executor.id,
      presets: Object.keys(PRESETS)
    };
  }

  async start() {
    for (const p of this.projects.values()) await this.describeProject(p);
    this.hub = new HubClient({ url: this.hubUrl, hello: { role: 'runtime', org: this.org, name: this.userName, runtime: this.descriptor() }, log: this.log });
    this.hub.on('welcome', () => {
      this.log(`registered runtime ${this.id} (${this.name}) with hub`);
      for (const t of this.store.listThreads()) this.hub.send({ type: 'thread.upsert', thread: this.publicThread(t) });
    });
    this.hub.on('message', (msg) => {
      if (msg.type === 'command') this.onCommand(msg).catch((err) => this.log('command error: ' + err.message));
      else if (msg.type === 'workspace.activity') this.activity = { threads: msg.threads || [], overlaps: msg.overlaps || [] };
    });
    this.hub.connect();
    return this;
  }

  stop() {
    for (const s of this.sessions.values()) s.interrupt();
    if (this.hub) this.hub.close();
    this.store.close();
  }

  async describeProject(p) {
    p.branch = await git.currentBranch(p.dir);
    p.dirty = await git.isDirty(p.dir);
    return p;
  }

  publicThread(t) {
    const { codexSessionId, claudeSessionId, ...rest } = t; // keep provider session handles local
    return rest;
  }

  appendEvent(threadId, event) {
    this.hub.send({ type: 'append', threadId, event });
    if (event.method === Events.ITEM_COMPLETED) {
      const it = event.item;
      if ([ItemTypes.USER_MESSAGE, ItemTypes.AGENT_MESSAGE, ItemTypes.COMMAND_EXECUTION, ItemTypes.FILE_CHANGE].includes(it.type)) {
        const slim = it.type === ItemTypes.FILE_CHANGE ? { ...it, changes: it.changes.map((c) => ({ path: c.path, kind: c.kind })) } : it;
        this.store.appendItem(threadId, slim);
      }
    }
  }

  // ---------- commands ----------
  async onCommand(msg) {
    const { id, threadId, by } = msg;
    const cmd = msg.command || {};
    const reply = (ok, payload) => this.hub.send({ type: 'command.result', id, ok, ...(ok ? { result: payload } : { error: payload }) });
    try {
      const result = await this.dispatch(cmd, threadId, by);
      reply(true, result || {});
    } catch (err) {
      this.log(`command ${cmd.method} failed: ${err.message}`);
      reply(false, String(err && err.message || err));
    }
  }

  async dispatch(cmd, threadId, by) {
    const thread = threadId ? this.store.getThread(threadId) : null;
    if (threadId && !thread && cmd.method !== Commands.THREAD_DELETE) throw new Error('unknown thread on this runtime');
    switch (cmd.method) {
      case Commands.THREAD_START: return { thread: await this.threadStart(cmd, by) };
      case Commands.THREAD_DELETE: return this.threadDelete(threadId);
      case Commands.THREAD_NAME_SET:
        thread.name = cmd.name; this.store.upsertThread(thread);
        this.appendEvent(threadId, { method: Events.THREAD_NAME_UPDATED, name: cmd.name, by });
        return {};
      case Commands.THREAD_SETTINGS_UPDATE:
        thread.settings = { ...thread.settings, ...cmd.settings }; this.store.upsertThread(thread);
        this.appendEvent(threadId, { method: Events.THREAD_SETTINGS_UPDATED, settings: thread.settings, by });
        return { settings: thread.settings };
      case Commands.TURN_START: return this.turnStart(thread, cmd, by);
      case Commands.TURN_STEER: {
        const s = this.sessions.get(threadId);
        if (!s || !s.running) throw new Error('no active turn to steer');
        if (cmd.expectedTurnId && cmd.expectedTurnId !== s.turnId) throw new Error('expectedTurnId does not match the active turn');
        s.steer(cmd.input, by);
        return { turnId: s.turnId };
      }
      case Commands.TURN_INTERRUPT: {
        const s = this.sessions.get(threadId);
        if (s) s.interrupt();
        return {};
      }
      case Commands.APPROVAL_RESOLVE: {
        const s = this.sessions.get(threadId);
        if (!s || !s.resolveApproval(cmd.requestId, cmd.decision, by)) throw new Error('no such pending approval');
        return {};
      }
      case Commands.MODEL_LIST: {
        const p = this.provider(cmd.provider || 'demo');
        return { models: p.id === 'demo' ? DEFAULT_MODELS.demo : await p.listModels() };
      }
      case Commands.PROJECT_ADD: {
        const dir = path.resolve(cmd.dir);
        if (!fs.existsSync(dir)) throw new Error('directory does not exist: ' + dir);
        const p = { dir, name: path.basename(dir) };
        await this.describeProject(p);
        this.projects.set(dir, p);
        this.hub.send({ type: 'runtime.update', runtime: this.descriptor() });
        return { project: p };
      }
      case Commands.THREAD_ASSIGN: {
        thread.assignee = cmd.assignee || null; thread.handoffNote = cmd.note || null; this.store.upsertThread(thread);
        this.appendEvent(threadId, { method: Events.THREAD_ASSIGNEE_UPDATED, assignee: thread.assignee, note: thread.handoffNote, by });
        return { assignee: thread.assignee };
      }
      case Commands.GIT_DIFF: return { files: await git.diff(thread.workDir), branch: await git.currentBranch(thread.workDir) };
      case Commands.GIT_COMMIT: return await git.commitAll(thread.workDir, cmd.message);
      case Commands.GIT_REVERT_FILE: return await git.revertFile(thread.workDir, cmd.path, !!cmd.untracked);
      case Commands.GIT_PATCH: return { patch: await git.patchText(thread.workDir) };
      default: throw new Error('unknown command: ' + cmd.method);
    }
  }

  teammatesFor(thread) {
    return this.activity.threads.filter((t) => t.threadId !== thread.id && t.projectKey === thread.cwd);
  }

  async threadStart(cmd, by) {
    const cwd = cmd.cwd ? path.resolve(cmd.cwd) : null;
    if (cwd && !this.projects.has(cwd)) {
      if (!fs.existsSync(cwd)) throw new Error('unknown project: ' + cwd);
      const p = { dir: cwd, name: path.basename(cwd) }; await this.describeProject(p); this.projects.set(cwd, p);
    }
    const preset = PRESETS[cmd.settings && cmd.settings.preset] || PRESETS.agent;
    const thread = {
      id: uid('thr'), name: cmd.name || 'New thread', orgId: this.org, runtimeId: this.id, runtimeName: this.name,
      cwd, workDir: cwd, worktree: false, branch: null, createdBy: by, createdAt: Date.now(), updatedAt: Date.now(),
      status: { type: 'idle' },
      settings: { provider: 'demo', model: 'demo-agent', effort: 'medium', ...preset, ...(cmd.settings || {}) }
    };
    if (cmd.worktree && cwd) {
      const wt = await git.createWorktree(cwd, this.dataDir, thread.id);
      if (wt.ok) { thread.worktree = true; thread.workDir = wt.dir; thread.branch = wt.branch; }
    }
    if (!thread.branch && cwd) thread.branch = await git.currentBranch(cwd);
    this.store.upsertThread(thread);
    this.hub.send({ type: 'thread.upsert', thread: this.publicThread(thread) });
    return this.publicThread(thread);
  }

  async threadDelete(threadId) {
    const s = this.sessions.get(threadId);
    if (s) { s.interrupt(); this.sessions.delete(threadId); }
    const t = this.store.getThread(threadId);
    if (t && t.worktree && t.workDir && t.cwd) await git.removeWorktree(t.cwd, t.workDir);
    this.store.deleteThread(threadId);
    return {};
  }

  async turnStart(thread, cmd, by) {
    const active = this.sessions.get(thread.id);
    if (active && active.running) throw new Error('a turn is already running — use turn/steer');
    const settings = { ...thread.settings, ...(cmd.settings || {}) };
    if (cmd.settings) { thread.settings = settings; this.store.upsertThread(thread); }
    const provider = this.provider(settings.provider || 'demo');
    const session = new TurnSession({
      thread, by, input: cmd.input, provider, model: settings.model, settings, executor: this.executor,
      history: this.store.listItems(thread.id), log: this.log,
      teammates: () => this.teammatesFor(thread),
      emit: (event) => this.appendEvent(thread.id, event)
    });
    this.sessions.set(thread.id, session);
    if (thread.name === 'New thread') {
      const text = cmd.input.filter((i) => i.type === 'text').map((i) => i.text).join(' ').trim();
      if (text) {
        thread.name = text.length > 48 ? text.slice(0, 48) + '…' : text;
        this.store.upsertThread(thread);
        this.appendEvent(thread.id, { method: Events.THREAD_NAME_UPDATED, name: thread.name });
      }
    }
    session.run().then(() => {
      thread.updatedAt = Date.now(); this.store.upsertThread(thread);
      if (this.sessions.get(thread.id) === session) this.sessions.delete(thread.id);
    });
    return { turnId: session.turnId };
  }
}

// ---------- CLI ----------
function parseArgs(argv) {
  const out = { projects: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--hub') out.hub = next();
    else if (a === '--org') out.org = next();
    else if (a === '--name') out.userName = next();
    else if (a === '--data') out.dataDir = next();
    else if (a === '--project' || a === '-p') out.projects.push(next());
    else if (a === '--executor') out.executor = next();
    else if (a === '--runtime-name') out.name = next();
  }
  return out;
}

function loadConfig(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')); } catch { return {}; }
}

function providersFromEnv(cfg = {}) {
  const p = { ...(cfg.providers || {}) };
  if (process.env.OPENAI_API_KEY) p.openai = { ...(p.openai || {}), apiKey: process.env.OPENAI_API_KEY };
  if (process.env.ANTHROPIC_API_KEY) p.anthropic = { ...(p.anthropic || {}), apiKey: process.env.ANTHROPIC_API_KEY };
  if (process.env.OPENROUTER_API_KEY) p.openrouter = { ...(p.openrouter || {}), apiKey: process.env.OPENROUTER_API_KEY };
  if (process.env.OLLAMA_BASE_URL) p.ollama = { baseUrl: process.env.OLLAMA_BASE_URL };
  return p;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir || process.env.HARNESS_DATA || path.join(os.homedir(), '.harness');
  fs.mkdirSync(dataDir, { recursive: true });
  const cfg = loadConfig(dataDir);
  const rt = new Runtime({
    hubUrl: args.hub || cfg.hub || process.env.HUB_URL || 'ws://127.0.0.1:7777',
    org: args.org || cfg.org || process.env.HARNESS_ORG || 'local',
    userName: args.userName || cfg.user || process.env.HARNESS_USER,
    dataDir,
    projects: [...(cfg.projects || []), ...args.projects],
    providers: providersFromEnv(cfg),
    executor: args.executor || cfg.executor || 'local',
    name: args.name || cfg.runtimeName,
    log: (m) => console.log('[runtime]', m)
  });
  rt.start().then(() => console.log(`[runtime] ${rt.name} → ${rt.hubUrl}`));
  process.on('SIGINT', () => { rt.stop(); process.exit(0); });
}

module.exports = { Runtime, parseArgs, providersFromEnv };
