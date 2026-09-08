'use strict';
// Plexus runtime daemon: the only process that holds provider keys and touches the
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
const { createExecutor, CrabboxExecutor } = require('./executors');
const { PRESETS } = require('./policy');
const { Commands, Events, ItemTypes, Errors, createPairingCode } = require('../protocol');
const { validateAuthMode } = require('./codex-host-profile');

const uid = (p) => p + '_' + crypto.randomBytes(8).toString('hex');

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function commandFingerprint(teamId, threadId, by, command) {
  return crypto.createHash('sha256').update(canonicalJson({
    teamId, threadId: threadId || null, userId: by && by.userId, command
  })).digest('hex');
}

function writeOwnerFileAtomic(file, contents) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch {}
    throw err;
  }
}

// Ordered from least to most authority. The host chooses a ceiling; callers may only choose
// a preset at or below it. `agent-untrusted` is stricter than `agent` because it asks before
// every command that is not on the trusted list.
const PRESET_ORDER = ['read-only', 'agent-untrusted', 'agent', 'full-access'];

class Runtime {
  constructor({ hubUrl, org = 'local', userName, dataDir, projects = [], providers = {}, executor = 'local', name, maxPreset = 'agent', encryptedTasksOnly = false, codexReadOnly = false, codexHostTools = null, encryptionAuthority = null, approvalAuthority = null, encryptedEndpointFactory, log = () => {} }) {
    this.hubUrl = hubUrl;
    this.org = org;
    this.encryptedTasksOnly = encryptedTasksOnly;
    // Retain old configuration for migration, but never treat read-only as a read boundary.
    // The installed provider successfully read a sibling file in the isolation proof.
    this.codexReadOnly = codexReadOnly === true;
    this.codexHostTools = codexHostTools &&
      typeof codexHostTools.bin === 'string' && path.isAbsolute(codexHostTools.bin) &&
      typeof codexHostTools.authFile === 'string' && path.isAbsolute(codexHostTools.authFile)
      ? { bin: codexHostTools.bin, authFile: codexHostTools.authFile, authMode: validateAuthMode(codexHostTools.authMode),
          ...(codexHostTools.accountBinding !== undefined ? { accountBinding: codexHostTools.accountBinding } : {}) } : null;
    this.userName = userName || os.userInfo().username;
    this.dataDir = dataDir || path.join(os.homedir(), '.harness');
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.store = new RuntimeStore(path.join(this.dataDir, 'runtime.sqlite'));
    this.id = this.store.getKv('runtimeId') || (() => { const id = uid('rt'); this.store.setKv('runtimeId', id); return id; })();
    writeOwnerFileAtomic(path.join(this.dataDir, 'runtime-id'), this.id + '\n');
    this.runtimeToken = this.store.getKv('runtimeToken') || (() => {
      const token = 'rtt_' + crypto.randomBytes(32).toString('hex');
      this.store.setKv('runtimeToken', token);
      return token;
    })();
    this.name = name || `${this.userName}@${os.hostname()}`;
    this.log = log;
    this.providerConfig = providers;   // { openai: {apiKey, baseUrl}, anthropic: {apiKey}, ollama: {baseUrl}, openrouter: {apiKey} }
    this.executor = createExecutor(executor);
    this.projects = new Map();
    for (const dir of projects) {
      this.projects.set(path.resolve(dir), {
        dir: path.resolve(dir), name: path.basename(dir), branch: null, dirty: null
      });
    }
    const mapped = this.store.getKv('encryptedProjects', {});
    this.encryptedProjects = new Map();
    for (const dir of this.projects.keys()) {
      mapped[dir] ||= 'ep_' + crypto.randomBytes(16).toString('hex');
      this.encryptedProjects.set(mapped[dir], dir);
    }
    this.store.setKv('encryptedProjects', mapped);
    this.encryptionAuthority = encryptionAuthority;
    this.approvalAuthority = approvalAuthority;
    this.encryptedEndpointFactory = encryptedEndpointFactory;
    this.encryptionState = 'awaiting-team';
    this.encryptedGeneration = 0;
    this.encryptedHost = null;
    this.encryptedExecution = null;
    this.encryptedClosing = Promise.resolve();
    this.sessions = new Map(); // threadId -> TurnSession
    this.activeCommands = new Set();
    // Only the operator of this machine decides which teams may drive it and how far a
    // remote teammate may escalate. Both survive restarts.
    this.teamId = this.store.getKv('teamId') || null;
    // The desktop shell supplies the code so it can show it to the operator sitting at
    // this machine; a headless host generates its own and prints it.
    this.pairingCode = process.env.HARNESS_PAIRING_CODE || createPairingCode();
    writeOwnerFileAtomic(path.join(this.dataDir, 'pairing-code'), this.pairingCode + '\n');
    if (!PRESETS[maxPreset]) throw new Error('unknown max preset: ' + maxPreset);
    this.maxPreset = maxPreset;
    this.hub = null;
    this.providerTap = null;   // (line, ev, session) - raw provider acknowledgments, for proofs
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
    list.push(this.codexHostTools && /^[a-f0-9]{64}$/.test(this.codexHostTools.accountBinding || '')
      ? { id: 'codex-cli', label: 'Codex', configured: true, writes: true, providerWrites: false,
          reason: 'reads and changes use this host’s authorized workspace tools; the supported provider version and isolated configuration are checked before each turn',
          models: ['gpt-5.4-mini'] }
      : this.codexHostTools ? { id: 'codex-cli', label: 'Codex (local setup required)', configured: false,
          reason: 'Repeat local Codex setup to authorize the current provider account before shared tasks can run.', models: [] }
      : { id: 'codex-cli', label: 'Codex CLI (isolation pending)', configured: false,
          reason: 'the read-only CLI can read outside the authorized workspace; enable the supported host-tool configuration locally', models: [] });
    list.push({ id: 'claude-code', label: 'Claude Code CLI (isolation pending)', configured: false, reason: 'project-confined provider sandbox not validated', models: [] });
    return list;
  }

  provider(id) {
    if (id === 'demo') return { id: 'demo' };
    if (id === 'codex-cli' && this.codexHostTools) {
      const { HostToolsCodexAppServerBackend } = require('./codex-app-server');
      const provider = new HostToolsCodexAppServerBackend({ ...this.codexHostTools,
        profileDir: path.join(this.dataDir, 'codex-host-profile'), requireConsentBinding: true });
      provider.id = 'codex-cli';
      return provider;
    }
    if (id === 'codex-cli' || id === 'codex-app-server' || id === 'claude-code') {
      throw new Error(Errors.PROVIDER_NOT_ISOLATED + ': this CLI adapter is hidden until project-confined reads and writes are proven');
    }
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
      projects: this.encryptedTasksOnly ? [] : [...this.projects.values()],
      taskProtocol: this.encryptedTasksOnly ? 'encrypted-v1' : 'legacy',
      ...(this.encryptedTasksOnly ? {
        encryptedProjects: [...this.encryptedProjects.keys()].map((id) => ({ id })),
        encryptionState: this.encryptionState,
        ...(this.encryptedHost?.endpoint ? { encryptedEndpoint: this.encryptedHost.endpoint.identity() } : {})
      } : {}),
      providers: this.providerList(),
      executors: [{ id: 'local', label: 'Structured workspace tools', shell: false }, { id: 'crabbox', label: 'Crabbox remote runner', available: CrabboxExecutor.available() }],
      executor: this.executor.id,
      presets: PRESET_ORDER.slice(0, PRESET_ORDER.indexOf(this.maxPreset) + 1),
      defaultPreset: this.defaultPreset()
    };
  }

  async start() {
    this.hub = new HubClient({
      url: this.hubUrl,
      hello: { role: 'runtime', name: this.userName, runtime: this.descriptor(), pairingCode: this.pairingCode, runtimeToken: this.runtimeToken },
      log: this.log
    });
    this.hub.on('welcome', (msg) => {
      if (process.send) process.send({ type: 'runtime.ready', runtimeId: this.id, paired: !!msg.paired });
      if (msg.paired) {
        this.clearPairingChallenge();
        this.log(`registered runtime ${this.id} (${this.name}) with hub`);
        // Reconcile before re-announcing, so nothing is published claiming to be running.
        this.reconcileAfterRestart();
        this.ensureEncryptedHost();
        for (const t of this.store.listThreads()) {
          if (!this.encryptedTasksOnly && t.orgId === this.teamId) this.hub.send({ type: 'thread.upsert', thread: this.publicThread(t) });
        }
      } else {
        this.announcePairing();
      }
    });
    this.hub.on('message', (msg) => {
      if (msg.type === 'command') this.onCommand(msg).catch((err) => this.log('command error: ' + err.message));
      else if (msg.type === 'workspace.activity') this.activity = { threads: msg.threads || [], overlaps: msg.overlaps || [] };
      else if (msg.type === 'paired') this.onPaired(msg);
      else if (msg.type === 'unpaired') this.onUnpaired();
    });
    this.hub.on('disconnect', () => {
      this.encryptedHost?.disconnect();
      if (!this.stopped && this.encryptedHost) this.setEncryptionState('membership_reconciliation_required');
    });
    this.hub.connect();
    this.writeEncryptedSetup();
    return this;
  }

  writeEncryptedSetup() {
    if (!this.encryptedTasksOnly) return;
    writeOwnerFileAtomic(path.join(this.dataDir, 'encrypted-setup.json'), JSON.stringify({
      runtimeId: this.id, teamId: this.teamId, state: this.encryptionState,
      authority: this.encryptionAuthority,
      freshnessAuthority: this.encryptedHost?.freshness?.record() || null,
      approvalAuthority: this.approvalAuthority,
      projects: [...this.encryptedProjects].map(([id, dir]) => ({ id, name: path.basename(dir) })),
      endpoint: this.encryptedHost?.endpoint?.identity() || null
    }));
  }

  setEncryptionState(state) {
    if (!this.encryptedTasksOnly) return;
    this.encryptionState = state;
    this.writeEncryptedSetup();
    if (!this.hub) return;
    this.hub.hello.runtime = this.descriptor();
    if (!this.stopped && this.hub.welcome) this.hub.send({ type: 'runtime.update', runtime: this.descriptor() });
  }

  retireEncryptedHost() {
    this.encryptedGeneration++;
    clearTimeout(this.encryptedPoll);
    this.encryptedPoll = null;
    const host = this.encryptedHost;
    const execution = this.encryptedExecution;
    this.encryptedHost = null;
    this.encryptedExecution = null;
    host?.disconnect();
    // Retain the old generation's objects until its in-flight work has finished. A
    // subsequent pairing must not open the same crypto store before it has closed.
    const closing = Promise.allSettled([this.encryptedClosing, execution?.close(),
      this.encryptedPolling, this.encryptedStarting]).then(() => host?.close());
    this.encryptedClosing = closing;
    closing.catch(error => this.log('encrypted host cleanup failed: ' + (error.code || 'crypto_close_failed')));
    return closing;
  }

  ensureEncryptedHost() {
    if (!this.encryptedTasksOnly || this.stopped || !this.teamId || this.encryptedStarting || this.encryptedHost) return;
    if (!this.encryptionAuthority || this.encryptionAuthority.teamId !== this.teamId) {
      this.setEncryptionState('awaiting-authority-confirmation');
      return;
    }
    const generation = this.encryptedGeneration;
    const teamId = this.teamId;
    const current = () => !this.stopped && generation === this.encryptedGeneration && teamId === this.teamId;
    this.encryptedStarting = (async () => {
      await this.encryptedClosing;
      if (!current()) return;
      this.setEncryptionState('opening_crypto_store');
      const { EncryptedHost } = require('./encrypted-host');
      const { EncryptedExecution } = require('./encrypted-execution');
      let execution;
      const host = new EncryptedHost({ runtime: this, url: this.hubUrl.replace(/^ws/, 'http'),
        statePath: path.join(this.dataDir, 'encrypted-host.sqlite'), projects: this.encryptedProjects,
        authority: this.encryptionAuthority, endpointFactory: this.encryptedEndpointFactory,
        onControl: (task, read, opened) => {
          if (!current()) throw Object.assign(new Error('host_stopped'), { code: 'host_stopped' });
          return execution.control(task, read, opened);
        }, log: this.log });
      try { await host.start(); }
      catch (error) { await host.close(); throw error; }
      if (!current()) { await host.close(); return; }
      this.encryptedHost = host;
      this.encryptedExecution = execution = new EncryptedExecution({ runtime: this, host });
      this.setEncryptionState('membership_reconciliation_required');
      this.encryptedPolling = this.pollEncryptedHost();
    })().catch((error) => {
      if (!current()) return;
      this.setEncryptionState(error.code || 'encryption-unavailable');
      this.log('encrypted host unavailable: ' + this.encryptionState);
    }).finally(() => {
      this.encryptedStarting = null;
      if (!current() && !this.stopped && this.teamId) this.ensureEncryptedHost();
    });
    return this.encryptedStarting;
  }

  async pollEncryptedHost() {
    if (this.stopped || !this.encryptedHost || !this.teamId) return;
    const host = this.encryptedHost;
    const execution = this.encryptedExecution;
    const generation = this.encryptedGeneration;
    const teamId = this.teamId;
    const current = () => !this.stopped && generation === this.encryptedGeneration && teamId === this.teamId && host === this.encryptedHost;
    try {
      if (!this.hub.welcome) return;
      await host.applyRevocations();
      if (!current()) return;
      await host.collect();
      if (!current()) return;
      if (this.encryptionState !== 'ready') this.setEncryptionState('ready');
      const listed = await host.tasks.list(teamId);
      for (const task of listed.tasks || []) {
        if (!current()) return;
        if (task.runtimeId !== this.id || !this.encryptedProjects.has(task.projectId)) continue;
        try {
          const opened = await host.openTask(task);
          if (!current()) return;
          await execution.reconcile(task, opened);
          if (!current()) return;
          await host.admitParticipants(task);
          if (!current()) return;
          if (!execution.state(task)) await execution.startTask(task, opened);
        } catch (error) {
          this.log('encrypted task unavailable: ' + (error.code || error.message));
        }
      }
    } catch (error) {
      if (current()) this.setEncryptionState(error.code || 'relay_unavailable');
      this.log('encrypted reconciliation pending: ' + (error.code || 'relay_unavailable'));
    } finally {
      if (current()) {
        this.encryptedPoll = setTimeout(() => { this.encryptedPolling = this.pollEncryptedHost(); }, 500);
        this.encryptedPoll.unref?.();
      }
    }
  }

  // Printed on the host, never sent to a client: a teammate has to be told this code by
  // whoever is sitting at the machine, or read it here themselves.
  announcePairing() {
    const line = '-'.repeat(52);
    this.log(`\n${line}\n  This host is not paired with a team yet.\n  Pairing code:  ${this.pairingCode}\n  Enter it in Plexus to share ${this.name}.\n${line}`);
  }

  onPaired(msg) {
    if (this.teamId && this.teamId !== msg.teamId) this.retireEncryptedHost();
    this.teamId = msg.teamId;
    this.clearPairingChallenge();
    this.store.setKv('teamId', msg.teamId);
    this.ensureEncryptedHost();
    this.log(`paired with team ${msg.teamId}${msg.pairedBy ? ' by ' + msg.pairedBy.name : ''}`);
    for (const t of this.store.listThreads()) {
      if (!this.encryptedTasksOnly && t.orgId === this.teamId) this.hub.send({ type: 'thread.upsert', thread: this.publicThread(t) });
    }
  }

  clearPairingChallenge() {
    this.pairingCode = null;
    if (this.hub) this.hub.hello.pairingCode = null;
    writeOwnerFileAtomic(path.join(this.dataDir, 'pairing-code'), '\n');
  }

  onUnpaired() {
    this.retireEncryptedHost();
    this.teamId = null;
    this.store.setKv('teamId', '');
    this.setEncryptionState('awaiting-team');
    // A code authorizes one pairing cycle. Rotate it even in the desktop process, whose
    // initial code came through the environment, so somebody who saw an old code cannot
    // reclaim the host after an owner detaches it.
    this.pairingCode = createPairingCode();
    writeOwnerFileAtomic(path.join(this.dataDir, 'pairing-code'), this.pairingCode + '\n');
    this.hub.hello.pairingCode = this.pairingCode;
    for (const s of this.sessions.values()) s.interrupt();
    this.log('this host was unpaired; running turns were stopped');
    this.hub.reconnect();
  }

  // The set of directories the operator explicitly shared. Nothing outside it is reachable,
  // whatever a remote caller asks for.
  isAuthorizedProject(dir) {
    return this.projects.has(path.resolve(dir));
  }

  // What a late answer is told: the code a client can branch on, and the fact a person needs.
  describeSettled(record) {
    const who = (record.by && record.by.name) || 'someone else';
    return Errors.APPROVAL_SETTLED + ': ' + who + ' already answered ' + record.decision;
  }

  stop() {
    if (this.stopped) return this.stopPromise;
    // Set before anything closes: an interrupted turn finishes asynchronously, and its
    // completion must not try to write to a store that is on its way out.
    this.stopped = true;
    const closing = this.retireEncryptedHost();
    this.setEncryptionState('stopped');
    for (const s of this.sessions.values()) s.interrupt();
    if (this.hub) this.hub.close();
    if (this.encryptedTasksOnly) this.stopPromise = closing.finally(() => this.store.close());
    else { this.store.close(); this.stopPromise = Promise.resolve(); }
    return this.stopPromise;
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
    if (this.encryptedTasksOnly) return reply(false, 'encrypted_route_required');
    const fingerprint = commandFingerprint(this.teamId, threadId, by, cmd);
    const prior = this.store.getCommand(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return reply(false, Errors.COMMAND_ID_CONFLICT);
      if (prior.state === 'completed' && prior.reply) return reply(prior.reply.ok, prior.reply.payload);
      return reply(false, this.activeCommands.has(id) ? Errors.COMMAND_IN_PROGRESS : Errors.COMMAND_OUTCOME_UNKNOWN);
    }
    if (!this.store.claimCommand(id, fingerprint)) return reply(false, Errors.COMMAND_IN_PROGRESS);
    this.activeCommands.add(id);
    try {
      const result = await this.dispatch(cmd, threadId, by);
      const finished = { ok: true, payload: result || {} };
      this.store.completeCommand(id, fingerprint, finished);
      this.activeCommands.delete(id);
      reply(finished.ok, finished.payload);
    } catch (err) {
      this.log(`command ${cmd.method} failed: ${err.message}`);
      const finished = { ok: false, payload: String(err && err.message || err) };
      this.store.completeCommand(id, fingerprint, finished);
      this.activeCommands.delete(id);
      reply(finished.ok, finished.payload);
    }
  }

  async dispatch(cmd, threadId, by) {
    if (this.encryptedTasksOnly) throw new Error('encrypted_route_required');
    const thread = threadId ? this.store.getThread(threadId) : null;
    if (!this.teamId) throw new Error(Errors.RUNTIME_UNPAIRED);
    if (threadId && !thread) throw new Error(Errors.UNKNOWN_THREAD + ': unknown thread on this runtime');
    if (thread && thread.orgId !== this.teamId) throw new Error(Errors.FOREIGN_THREAD + ': thread belongs to another team');
    switch (cmd.method) {
      case Commands.THREAD_START: return { thread: await this.threadStart(cmd, by) };
      case Commands.THREAD_DELETE: return this.threadDelete(threadId);
      case Commands.THREAD_NAME_SET:
        thread.name = cmd.name; this.store.upsertThread(thread);
        this.appendEvent(threadId, { method: Events.THREAD_NAME_UPDATED, name: cmd.name, by });
        return {};
      case Commands.THREAD_SETTINGS_UPDATE:
        thread.settings = this.resolveSettings(thread.settings, cmd.settings || {}); this.store.upsertThread(thread);
        this.appendEvent(threadId, { method: Events.THREAD_SETTINGS_UPDATED, settings: thread.settings, by });
        return { settings: thread.settings };
      case Commands.TURN_START: return this.turnStart(thread, cmd, by);
      case Commands.TURN_STEER: {
        const s = this.sessions.get(threadId);
        if (!s || !s.running) throw new Error(Errors.TURN_NOT_ACTIVE + ': no active turn to steer');
        // Naming the turn is mandatory. It used to be optional, which meant an instruction
        // written for a turn that had since ended was silently applied to whatever was
        // running instead - the exact confusion this binding exists to prevent.
        if (!cmd.expectedTurnId) throw new Error(Errors.TURN_BINDING_REQUIRED + ': steering must name the turn it was written for');
        if (cmd.expectedTurnId !== s.turnId) throw new Error(Errors.STALE_TURN + ': that turn is no longer the one running');
        return { turnId: s.turnId, ...s.steer(cmd.input, by) };
      }
      case Commands.TURN_INTERRUPT: {
        const s = this.sessions.get(threadId);
        if (!s || !s.running) throw new Error(Errors.TURN_NOT_ACTIVE + ': nothing is running to interrupt');
        if (!cmd.turnId) throw new Error(Errors.TURN_BINDING_REQUIRED + ': interrupting must name the turn');
        if (cmd.turnId !== s.turnId) throw new Error(Errors.STALE_TURN + ': that turn is no longer the one running');
        return s.requestInterrupt(by);
      }
      // Help goes to a person. It is recorded and attributed, and there is deliberately no
      // path from here into steerQueue or any provider call: the only way an agent ever sees
      // text is TURN_START or TURN_STEER, both of which a human types on purpose.
      case Commands.THREAD_HELP: {
        // Help is about a piece of work, so it belongs to a thread. Without this a request
        // addressed to nothing is recorded against a null thread and can never be answered.
        if (!thread) throw new Error(Errors.UNKNOWN_THREAD + ': a help request belongs to a thread');
        const text = typeof cmd.text === 'string' ? cmd.text.trim() : '';
        if (!text) throw new Error(Errors.HELP_IS_NOT_INPUT + ': a help request needs text for a person to read');
        const requestId = 'help_' + crypto.randomBytes(8).toString('hex');
        // Kept on the thread so it survives a host restart, and so resolving one can be
        // checked against something rather than believed.
        thread.openHelp = [...(thread.openHelp || []), requestId];
        this.store.upsertThread(thread);
        this.appendEvent(threadId, { method: Events.HELP_REQUESTED, requestId, text, to: cmd.to || null, by });
        return { requestId };
      }
      case Commands.THREAD_HELP_RESOLVE: {
        if (!thread) throw new Error(Errors.UNKNOWN_THREAD + ': a help request belongs to a thread');
        // Resolving something nobody asked for used to be accepted, which let an invented id
        // clear a real request and put a resolution in the log for a question never posed.
        if (typeof cmd.requestId !== 'string' || !(thread.openHelp || []).includes(cmd.requestId)) {
          throw new Error(Errors.UNKNOWN_HELP_REQUEST + ': no such open help request on this thread');
        }
        thread.openHelp = (thread.openHelp || []).filter((id) => id !== cmd.requestId);
        this.store.upsertThread(thread);
        this.appendEvent(threadId, { method: Events.HELP_RESOLVED, requestId: cmd.requestId, by });
        return { ok: true };
      }
      case Commands.APPROVAL_RESOLVE: {
        // Second check, on the machine that will actually run the command. The hub says who
        // it thinks is allowed; the host is the one taking the risk, so it says no too.
        if (!by || !by.approver) throw new Error(Errors.NOT_APPROVER + ': this teammate has not been delegated approval authority');
        // Somebody already answered. The late caller is refused - exactly one resolution is
        // authoritative - but the refusal names who settled it and how, and the same record
        // reaches every client as serverRequest/resolved.
        const settledBefore = (thread.settledApprovals || {})[cmd.requestId];
        if (settledBefore) throw new Error(this.describeSettled(settledBefore));
        const s = this.sessions.get(threadId);
        if (!s) {
          // Two different situations that used to give the same answer. If the host still
          // remembers asking, the answer is simply too late; if it has never heard of the
          // id, saying "stale after restart" would invent a history that did not happen.
          const outstanding = (thread.openApprovals || {})[cmd.requestId]
            || (thread.abandonedApprovals || {})[cmd.requestId];
          if (outstanding) throw new Error(Errors.APPROVAL_STALE_AFTER_RESTART + ': that request did not survive the host');
          throw new Error(Errors.APPROVAL_UNKNOWN + ': nothing is pending under that id');
        }
        try {
          return { settled: s.resolveApproval(cmd.requestId, cmd.decision, by, { turnId: cmd.turnId, fingerprint: cmd.fingerprint }) };
        } catch (error) {
          if (error.code === Errors.APPROVAL_SETTLED && error.settled) throw new Error(this.describeSettled(error.settled));
          throw error;
        }
      }
      case Commands.MODEL_LIST: {
        const p = this.provider(cmd.provider || 'demo');
        return { models: p.id === 'demo' ? DEFAULT_MODELS.demo : await p.listModels() };
      }
      case Commands.PROJECT_ADD:
        // Sharing a folder is a decision made at the machine, not over the network -
        // otherwise any team member could hand their agent an arbitrary path on someone
        // else's disk. The host operator adds projects with --project or runtime.json.
        throw new Error(Errors.PROJECT_ADD_LOCAL_ONLY + ': a project must be authorized on the host itself');
      case Commands.THREAD_ASSIGN: {
        // Responsibility belongs to a piece of work. Without this an assignment for a thread
        // that does not exist failed with a TypeError instead of an answer.
        if (!thread) throw new Error(Errors.UNKNOWN_THREAD + ': responsibility belongs to a thread');
        thread.assignee = cmd.assignee || null; thread.handoffNote = cmd.note || null; this.store.upsertThread(thread);
        this.appendEvent(threadId, { method: Events.THREAD_ASSIGNEE_UPDATED, assignee: thread.assignee, note: thread.handoffNote, by });
        return { assignee: thread.assignee };
      }
      case Commands.GIT_COMMIT:
        this.assertGitMutationAllowed(thread);
        throw new Error(Errors.PROJECT_OPERATION_UNAVAILABLE + ': remote Git subprocesses require a project-confined sandbox');
      case Commands.GIT_REVERT_FILE:
        this.assertGitMutationAllowed(thread);
        throw new Error(Errors.PROJECT_OPERATION_UNAVAILABLE + ': remote Git subprocesses require a project-confined sandbox');
      case Commands.GIT_DIFF:
      case Commands.GIT_PATCH:
        throw new Error(Errors.PROJECT_OPERATION_UNAVAILABLE + ': remote Git subprocesses require a project-confined sandbox');
      default: throw new Error('unknown command: ' + cmd.method);
    }
  }

  // What this host can and cannot account for after it restarts.
  //
  // A turn lives in a process. When that process ends the turn ends with it, and there is no
  // sense in which it is still running - so a thread this host persisted as active, with no
  // live session behind it, is a thread whose turn was abandoned. Saying so is different from
  // saying it completed, and the difference is the whole point: nobody should read a crash as
  // a result.
  //
  // Approvals that were outstanding go the same way. An answer to a request whose turn no
  // longer exists cannot authorise anything, and #11 already refuses one with
  // approval_stale_after_restart; this makes the thread stop advertising the prompt.
  reconcileAfterRestart() {
    const reconciled = [];
    for (const thread of this.store.listThreads()) {
      const running = thread.status && thread.status.type === 'active';
      const outstanding = Object.keys(thread.openApprovals || {});
      if (!running && !outstanding.length) continue;
      if (this.sessions.get(thread.id)) continue;   // still alive; nothing to reconcile
      const turnId = thread.activeTurnId || null;
      thread.status = { type: 'idle' };
      thread.activeTurnId = null;
      // Remembered, not forgotten. #11 distinguishes "you are too late, that request did not
      // survive" from "this host never asked anything under that id", and clearing the record
      // would collapse the first into the second - telling somebody who answered a real
      // question that they invented it.
      thread.abandonedApprovals = { ...(thread.abandonedApprovals || {}), ...(thread.openApprovals || {}) };
      thread.openApprovals = {};
      this.store.upsertThread(thread);
      // Recorded on the thread's own event stream, so a teammate reading the history later
      // sees what happened rather than an unexplained gap between a turn starting and the
      // next one beginning.
      this.appendEvent(thread.id, { method: Events.TURN_ABANDONED, turnId, reason: 'host_restarted' });
      reconciled.push({ threadId: thread.id, turnId, approvals: outstanding.length });
    }
    if (reconciled.length) {
      this.log('reconciled ' + reconciled.length + ' thread(s) after restart: no turn survives a host that stopped');
    }
    return reconciled;
  }

  teammatesFor(thread) {
    return this.activity.threads.filter((t) => t.threadId !== thread.id && t.projectKey === thread.cwd);
  }

  async threadStart(cmd, by) {
    const cwd = cmd.cwd ? path.resolve(cmd.cwd) : null;
    // This used to register any path that happened to exist, which let a remote caller
    // start an agent anywhere on the host's disk.
    if (!cwd || !this.isAuthorizedProject(cwd)) {
      throw new Error(Errors.PROJECT_NOT_AUTHORIZED + ': select a workspace shared on this host');
    }
    const settings = this.resolveSettings({}, cmd.settings || {});
    this.provider(settings.provider || 'demo');
    const thread = {
      id: uid('thr'), name: cmd.name || 'New thread', orgId: this.teamId, runtimeId: this.id, runtimeName: this.name,
      cwd, workDir: cwd, worktree: false, branch: null, createdBy: by, createdAt: Date.now(), updatedAt: Date.now(),
      status: { type: 'idle' },
      settings: { provider: 'demo', model: 'demo-agent', effort: 'medium', ...settings }
    };
    if (cmd.worktree) throw new Error(Errors.PROJECT_OPERATION_UNAVAILABLE + ': remote worktree creation requires a project-confined sandbox');
    const project = this.projects.get(cwd);
    thread.branch = project ? project.branch : null;
    this.store.upsertThread(thread);
    this.hub.send({ type: 'thread.upsert', thread: this.publicThread(thread) });
    return this.publicThread(thread);
  }

  async threadDelete(threadId) {
    const s = this.sessions.get(threadId);
    if (s) { s.interrupt(); this.sessions.delete(threadId); }
    // Old worktrees are left for the host operator to clean up. A remote delete must not
    // launch repository-controlled Git hooks or subprocesses.
    this.store.deleteThread(threadId);
    return {};
  }

  // A remote teammate may pick any preset up to the ceiling the operator set on this host.
  clampPreset(preset) {
    if (!PRESETS[preset]) throw new Error(Errors.POLICY_ESCALATION + ': unknown preset ' + preset);
    if (PRESET_ORDER.indexOf(preset) > PRESET_ORDER.indexOf(this.maxPreset)) {
      throw new Error(Errors.POLICY_ESCALATION + ': this host allows at most "' + this.maxPreset + '"');
    }
    return preset;
  }

  defaultPreset() {
    const agent = PRESET_ORDER.indexOf('agent');
    return PRESET_ORDER[Math.min(agent, PRESET_ORDER.indexOf(this.maxPreset))];
  }

  assertGitMutationAllowed(thread) {
    const settings = this.resolveSettings(thread.settings, {});
    if (settings.sandboxPolicy === PRESETS['read-only'].sandboxPolicy) {
      throw new Error(Errors.POLICY_ESCALATION + ': this thread is read-only');
    }
  }

  presetForSettings(settings = {}) {
    return Object.keys(PRESETS).find((name) => {
      const policy = PRESETS[name];
      return policy.approvalPolicy === settings.approvalPolicy && policy.sandboxPolicy === settings.sandboxPolicy;
    }) || null;
  }

  resolveSettings(current = {}, requested = {}) {
    const preset = this.clampPreset(requested.preset || current.preset || this.presetForSettings(current) || this.defaultPreset());
    const policy = PRESETS[preset];
    for (const field of ['approvalPolicy', 'sandboxPolicy']) {
      if (Object.prototype.hasOwnProperty.call(requested, field) && requested[field] !== policy[field]) {
        throw new Error(Errors.POLICY_ESCALATION + ': choose a named preset instead of overriding ' + field);
      }
    }
    return { ...current, ...requested, preset, ...policy };
  }

  async turnStart(thread, cmd, by) {
    const active = this.sessions.get(thread.id);
    if (active && active.running) throw new Error('a turn is already running — use turn/steer');
    const settings = this.resolveSettings(thread.settings, cmd.settings || {});
    const provider = this.provider(settings.provider || 'demo');
    thread.settings = settings;
    this.store.upsertThread(thread);
    const session = new TurnSession({
      thread, by, input: cmd.input, provider, model: settings.model, settings, executor: this.executor,
      history: this.store.listItems(thread.id), log: this.log,
      teammates: () => this.teammatesFor(thread),
      emit: (event) => this.appendEvent(thread.id, event),
      // Settled answers outlive the turn that asked. Persisting them on the thread is what
      // lets a restarted host say "Bob approved that" instead of "no such request".
      settledApprovals: Object.entries(thread.settledApprovals || {}),
      onApprovalRequested: (record) => {
        thread.openApprovals = { ...(thread.openApprovals || {}), [record.requestId]: record };
        if (!this.stopped) this.store.upsertThread(thread);
      },
      onApprovalSettled: (record) => {
        const { [record.requestId]: _gone, ...stillOpen } = thread.openApprovals || {};
        thread.openApprovals = stillOpen;
        thread.settledApprovals = { ...(thread.settledApprovals || {}), [record.requestId]: record };
        if (!this.stopped) this.store.upsertThread(thread);
      }
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
      if (this.stopped) return;
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
    else if (a === '--max-preset') out.maxPreset = next();
    else if (a === '--encrypted-tasks-only') out.encryptedTasksOnly = true;
    else if (a === '--codex-read-only') out.codexReadOnly = true;
    else if (a === '--codex-host-tools') out.codexHostTools = true;
    else if (a === '--codex-auth-mode') out.codexAuthMode = validateAuthMode(next() ?? null);
  }
  if (out.codexAuthMode && !out.codexHostTools) throw new Error('codex_host_tools_opt_in_required');
  return out;
}

function localCodexOptIn({ resolved, authFile, detectedMode, authMode }) {
  if (!resolved?.ok) throw new Error('codex_unavailable');
  const detected = validateAuthMode(detectedMode);
  const selected = authMode === undefined ? detected : validateAuthMode(authMode);
  if (selected !== detected) throw new Error('codex_host_tools_account_mode_mismatch');
  return { bin: path.resolve(resolved.path), authFile, authMode: selected };
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
  let codexHostTools = cfg.codexHostTools || null;
  if (args.codexHostTools) {
    const { resolveCodex, codexHome, authStatus } = require('./codex-probe');
    const resolved = resolveCodex();
    if (!resolved.ok) throw new Error('codex_unavailable');
    codexHostTools = localCodexOptIn({ resolved, authFile: path.join(codexHome(), 'auth.json'),
      detectedMode: authStatus(resolved).mode, authMode: args.codexAuthMode });
  }
  const rt = new Runtime({
    hubUrl: args.hub || cfg.hub || process.env.HUB_URL || 'ws://127.0.0.1:7777',
    org: args.org || cfg.org || process.env.HARNESS_ORG || 'local',
    userName: args.userName || cfg.user || process.env.HARNESS_USER,
    dataDir,
    projects: [...(cfg.projects || []), ...args.projects],
    providers: providersFromEnv(cfg),
    executor: args.executor || cfg.executor || 'local',
    name: args.name || cfg.runtimeName,
    maxPreset: args.maxPreset || cfg.maxPreset || 'agent',
    encryptedTasksOnly: args.encryptedTasksOnly || cfg.encryptedTasksOnly === true,
    codexReadOnly: args.codexReadOnly || cfg.codexReadOnly === true,
    codexHostTools,
    encryptionAuthority: cfg.encryptionAuthority || null,
    approvalAuthority: cfg.approvalAuthority || null,
    log: (m) => console.log('[runtime]', m)
  });
  const detachLocalControl = require('./local-control').attachLocalControl(rt);
  (async () => {
    if (args.codexHostTools) {
      const workspace = [...(cfg.projects || []), ...args.projects][0];
      if (!workspace) throw new Error('codex_host_tools_workspace_required');
      const ready = await rt.provider('codex-cli').checkHost({ workspace });
      rt.codexHostTools.accountBinding = ready.accountBinding;
    }
    await rt.start();
    console.log(`[runtime] ${rt.name} → ${rt.hubUrl}`);
  })().catch(error => { console.error('[runtime]', /^codex_[a-z_]+$/.test(error.message) ? error.message : 'runtime_start_failed'); process.exitCode = 1; rt.stop(); });
  let shutdown;
  const stop = () => {
    if (shutdown) { process.exit(1); return; }
    detachLocalControl();
    const deadline = setTimeout(() => process.exit(1), 1500);
    shutdown = Promise.resolve().then(() => rt.stop()).then(() => {
      clearTimeout(deadline); process.exit(0);
    }, () => { clearTimeout(deadline); process.exit(1); });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { Runtime, parseArgs, localCodexOptIn, providersFromEnv, commandFingerprint };
