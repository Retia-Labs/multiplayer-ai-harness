'use strict';
// Backend that delegates a turn to the real OpenAI Codex CLI (`codex exec --json`)
// and translates its JSONL thread events into harness protocol events. Requires the
// `codex` binary (see codex-probe.js for how it is found) and Codex auth on this
// machine. Approvals cannot be routed - `codex exec` enforces its own sandbox and never
// asks the caller - so the sandbox policy is passed as a flag instead; see
// docs/proofs/codex-shared-control.md for the app-server alternative.
const { spawn } = require('child_process');
const { Events, ItemTypes, ItemStatus } = require('../protocol');
const { resolveCodex } = require('./codex-probe');

// A steer that lands after `codex exec` has already been handed the prompt cannot be
// injected into that process, so it is delivered as an immediate resumed turn on the same
// Codex session. Bounded so a chatty thread cannot extend one turn indefinitely.
const MAX_STEER_FOLLOWUPS = 4;
const STDERR_KEEP = 4000;

function available(bin = 'codex') {
  return resolveCodex(bin).ok;
}

function sandboxFlags(sandboxPolicy) {
  if (sandboxPolicy === 'read-only') return ['--sandbox', 'read-only'];
  if (sandboxPolicy === 'danger-full-access') return ['--dangerously-bypass-approvals-and-sandbox'];
  // `--full-auto` is deprecated and absent from `codex exec --help` in every proved build.
  return ['--sandbox', 'workspace-write'];
}

// Map one `codex exec --json` line into zero or more harness events.
function translate(ev, state) {
  const out = [];
  const mapItem = (it) => {
    const base = { id: 'codex_' + it.id };
    switch (it.type) {
      case 'agent_message': return { ...base, type: ItemTypes.AGENT_MESSAGE, text: it.text || '' };
      case 'reasoning': return { ...base, type: ItemTypes.REASONING, text: it.text || '' };
      case 'command_execution': return { ...base, type: ItemTypes.COMMAND_EXECUTION, command: it.command, cwd: state.cwd, executor: 'codex', status: mapStatus(it.status), aggregatedOutput: it.aggregated_output || '', exitCode: it.exit_code };
      case 'file_change': return { ...base, type: ItemTypes.FILE_CHANGE, status: mapStatus(it.status), changes: (it.changes || []).map((c) => ({ path: c.path, kind: c.kind === 'delete' ? 'delete' : c.kind === 'add' ? 'add' : 'update', additions: 0, deletions: 0, lines: [] })) };
      case 'error': return { ...base, type: ItemTypes.AGENT_MESSAGE, text: '⚠ ' + (it.message || 'error') };
      default: return null;
    }
  };
  switch (ev.type) {
    case 'thread.started': state.sessionId = ev.thread_id; break;
    case 'item.started': case 'item.updated': case 'item.completed': {
      if (ev.item && ev.item.type === 'todo_list') {
        out.push({ method: Events.TURN_PLAN_UPDATED, plan: (ev.item.items || []).map((t) => ({ step: t.text, status: t.completed ? 'completed' : 'pending' })) });
        break;
      }
      const item = ev.item && mapItem(ev.item);
      if (!item) break;
      if (ev.type === 'item.started') out.push({ method: Events.ITEM_STARTED, item });
      else if (ev.type === 'item.updated') {
        if (!state.started.has(item.id)) { state.started.add(item.id); out.push({ method: Events.ITEM_STARTED, item }); }
        if (item.type === ItemTypes.COMMAND_EXECUTION) out.push({ method: Events.COMMAND_OUTPUT_DELTA, itemId: item.id, delta: item.aggregatedOutput.slice(state.outputSeen.get(item.id) || 0) });
        state.outputSeen.set(item.id, item.aggregatedOutput ? item.aggregatedOutput.length : 0);
      } else {
        if (!state.started.has(item.id)) out.push({ method: Events.ITEM_STARTED, item });
        out.push({ method: Events.ITEM_COMPLETED, item });
      }
      if (ev.type === 'item.started') state.started.add(item.id);
      break;
    }
    case 'turn.completed':
      if (ev.usage) state.usage = { input: ev.usage.input_tokens || 0, output: ev.usage.output_tokens || 0 };
      break;
    case 'turn.failed': case 'error':
      state.error = (ev.error && ev.error.message) || ev.message || 'codex exec failed';
      break;
  }
  return out;
}

function mapStatus(s) {
  return { in_progress: ItemStatus.IN_PROGRESS, completed: ItemStatus.COMPLETED, failed: ItemStatus.FAILED, declined: ItemStatus.DECLINED }[s] || ItemStatus.COMPLETED;
}

// Argument order follows `codex exec [resume [OPTIONS] [SESSION_ID]] [PROMPT]`.
function buildArgs({ prompt, cwd, sandboxPolicy, model, sessionId }) {
  // `codex exec resume` takes a much smaller option set than `codex exec`: no --cd and no
  // --sandbox, because the working root and sandbox policy come from the recorded session.
  // Passing them is a hard parse error, so resume relies on the child's cwd instead.
  if (sessionId) {
    const flags = ['--json', '--skip-git-repo-check'];
    if (model) flags.push('-m', model);
    if (sandboxPolicy === 'danger-full-access') flags.push('--dangerously-bypass-approvals-and-sandbox');
    return ['exec', 'resume', ...flags, sessionId, prompt];
  }
  const flags = ['--json', '--skip-git-repo-check', '-C', cwd, ...sandboxFlags(sandboxPolicy)];
  if (model) flags.push('-m', model);
  return ['exec', ...flags, prompt];
}

class CodexExecBackend {
  constructor({ bin = 'codex', onRaw = null } = {}) {
    this.id = 'codex-cli';
    this.label = 'Codex CLI';
    this.bin = bin;
    this.onRaw = onRaw;          // (line, ev) - the provider's own acknowledgment, for proofs
    this.resolved = resolveCodex(bin);
  }
  capabilities() { return { toolCalls: true, reasoning: 'summary', images: false, steer: 'nextProviderTurn', approvals: false }; }
  async listModels() { return ['gpt-5.5', 'gpt-5.4-mini']; }

  // One `codex exec` process. Resolves with the state it accumulated.
  runOnce(session, state, prompt) {
    const args = buildArgs({
      prompt, cwd: session.cwd, sandboxPolicy: session.settings.sandboxPolicy,
      model: session.model, sessionId: state.sessionId
    });
    return new Promise((resolve) => {
      const child = spawn(this.resolved.bin, [...this.resolved.prefix, ...args], {
        cwd: session.cwd, env: process.env,
        // Codex reads a piped stdin as extra prompt input and waits on it, so give it none.
        stdio: ['ignore', 'pipe', 'pipe']
      });
      session.child = child;
      state.spawned.push({ pid: child.pid, args });
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (this.onRaw) { try { this.onRaw(line, ev, session); } catch {} }
          for (const e of translate(ev, state)) session.emit(e.method, e);
        }
      });
      // stderr carries the failures that never reach the JSONL stream (bad flag, missing
      // auth, killed sandbox). Swallowing it turned every one of those into a silent pass.
      child.stderr.on('data', (d) => { state.stderr = (state.stderr + d.toString()).slice(-STDERR_KEEP); });
      child.on('close', (code) => { state.exitCode = code; resolve(); });
      child.on('error', (err) => { state.error = String(err); state.exitCode = -1; resolve(); });
    });
  }

  async run(session) {
    const prompt = session.input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
    const state = {
      cwd: session.cwd, started: new Set(), outputSeen: new Map(), usage: null, error: null,
      stderr: '', exitCode: null, spawned: [], sessionId: session.thread.codexSessionId || null
    };
    session.providerSpawns = state.spawned;   // live, so an interrupt can be checked mid-turn
    await this.runOnce(session, state, prompt);

    // Steers that arrived while Codex was working: deliver them for real, on the same
    // Codex session, rather than reporting a delivery the provider never saw.
    for (let i = 0; i < MAX_STEER_FOLLOWUPS && session.steerQueue.length && !session.cancelled && !state.error; i++) {
      const text = session.steerQueue.splice(0)
        .map((s) => s.input.filter((x) => x.type === 'text').map((x) => x.text).join('\n'))
        .filter(Boolean).join('\n');
      if (!text) break;
      if (!state.sessionId) break;  // nothing to resume onto; the steer stays in the log
      state.started = new Set(); state.outputSeen = new Map();
      await this.runOnce(session, state, text);
    }

    session.child = null;
    if (state.sessionId) session.thread.codexSessionId = state.sessionId;
    if (state.usage) { session.usage.input += state.usage.input; session.usage.output += state.usage.output; }
    session.providerSessionId = state.sessionId;
    session.providerSpawns = state.spawned;
    if (state.error) throw new Error(state.error);
    // A non-zero exit with no error event means Codex rejected the invocation itself.
    if (!session.cancelled && state.exitCode) {
      throw new Error('codex exec exited ' + state.exitCode + (state.stderr ? ': ' + state.stderr.trim().split('\n').slice(-3).join(' ') : ''));
    }
  }
}

// The only Codex configuration with evidence behind it on every supported platform.
//
// Measured on win32 with CLI 0.153.4: under `--sandbox workspace-write` the patch tool
// refuses to write outside the project, but a shell command does not - PowerShell wrote a
// file one directory above the workspace and exited 0. Under `--sandbox read-only` the same
// write is refused by the operating system. So read-only is confined and workspace-write is
// not, and a wrapper that could be talked into the second one would undo the point of the
// first. Session settings are ignored here on purpose.
//
// See docs/proofs/codex-confinement.md for the reproduction.
class ConfinedCodexExecBackend extends CodexExecBackend {
  constructor(options = {}) {
    super(options);
    this.id = 'codex-cli';
    this.label = 'Codex CLI (read-only)';
    this.confinedTo = 'read-only';
  }
  capabilities() {
    return { ...super.capabilities(), writes: false, sandbox: this.confinedTo, approvals: false };
  }
  runOnce(session, state, prompt) {
    // A fresh view of the session with the sandbox pinned. Mutating the caller's settings
    // would leave the rest of the host believing it had asked for something it had not.
    const confined = Object.create(session);
    confined.settings = { ...(session.settings || {}), sandboxPolicy: this.confinedTo };
    const result = super.runOnce(confined, state, prompt);
    // The child is spawned against the derived view, so hand the real session its handle
    // back or an interrupt would have nothing to kill.
    if (confined.child) session.child = confined.child;
    return result;
  }
}

module.exports = { CodexExecBackend, ConfinedCodexExecBackend, translate, available, sandboxFlags, buildArgs, MAX_STEER_FOLLOWUPS };
