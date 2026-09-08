'use strict';
// Backend that delegates a turn to the real OpenAI Codex CLI (`codex exec --json`)
// and translates its JSONL thread events into harness protocol events. Requires the
// `codex` binary (see codex-probe.js for how it is found) and Codex auth on this
// machine. Approvals cannot be routed - `codex exec` enforces its own sandbox and never
// asks the caller - so the sandbox policy is passed as a flag instead; see
// docs/proofs/codex-shared-control.md for the app-server alternative.
const { spawn } = require('child_process');
const { StringDecoder } = require('node:string_decoder');
const { Events, ItemTypes, ItemStatus } = require('../protocol');
const { resolveCodex, codexConfigArgs } = require('./codex-probe');
const { failure } = require('./codex-rpc');

// A steer that lands after `codex exec` has already been handed the prompt cannot be
// injected into that process, so it is delivered as an immediate resumed turn on the same
// Codex session. Bounded so a chatty thread cannot extend one turn indefinitely.
const MAX_STEER_FOLLOWUPS = 4;
const MAX_FRAME_BYTES = 1024 * 1024;

// Inspect provider diagnostics locally, but only retain fixed codes. Credentials or
// account details in an error must never become task content or shared telemetry.
function diagnosticCode(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  if (/usage.?limit|rate.?limit|quota|sessionBudgetExceeded/i.test(text)) return 'codex_usage_limit';
  if (/not logged in|unauthenticated|authentication|unauthorized|invalid.api.key|401/i.test(text)) return 'codex_auth_required';
  if (/model.*(?:not found|not available|not supported|does not exist)/i.test(text)) return 'codex_model_unavailable';
  if (/unexpected argument|unrecognized (?:option|argument)|unknown (?:option|argument)/i.test(text)) return 'codex_protocol_unsupported';
  return 'codex_request_failed';
}

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
      case 'error': return { ...base, type: ItemTypes.AGENT_MESSAGE, text: diagnosticCode(it.message) };
      default: return null;
    }
  };
  switch (ev.type) {
    case 'thread.started':
      if (typeof ev.thread_id !== 'string' || !ev.thread_id ||
          (state.expectedSessionId && state.expectedSessionId !== ev.thread_id)) state.error = 'codex_protocol_invalid';
      else { state.sessionId = ev.thread_id; state.threadAcknowledged = true; }
      break;
    case 'turn.started':
      if (state.threadAcknowledged && !state.turnAcknowledged) {
        state.turnAcknowledged = true;
        state.onProviderStarted?.();
      }
      break;
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
      state.completed = true;
      if (ev.usage) state.usage = { input: ev.usage.input_tokens || 0, output: ev.usage.output_tokens || 0 };
      break;
    case 'turn.failed': case 'error':
      state.error = diagnosticCode(ev.error || ev.message);
      break;
  }
  return out;
}

function mapStatus(s) {
  return { in_progress: ItemStatus.IN_PROGRESS, completed: ItemStatus.COMPLETED, failed: ItemStatus.FAILED, declined: ItemStatus.DECLINED }[s] || ItemStatus.FAILED;
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
  constructor({ bin = 'codex', onRaw = null, spawnProcess = spawn } = {}) {
    this.id = 'codex-cli';
    this.label = 'Codex CLI';
    this.bin = bin;
    this.onRaw = onRaw;          // (line, ev) - the provider's own acknowledgment, for proofs
    this.spawnProcess = spawnProcess;
    this.resolved = resolveCodex(bin);
  }
  capabilities() { return { toolCalls: true, reasoning: 'summary', images: false, steer: 'nextProviderTurn', approvals: false }; }
  async listModels() { return ['gpt-5.5', 'gpt-5.4-mini']; }

  // One `codex exec` process. Resolves with the state it accumulated.
  runOnce(session, state, prompt) {
    if (session.cancelled) return Promise.resolve();
    state.completed = false; state.threadAcknowledged = false; state.turnAcknowledged = false;
    state.expectedSessionId = state.sessionId;
    state.exitCode = null;
    const args = buildArgs({
      prompt, cwd: session.cwd, sandboxPolicy: session.settings.sandboxPolicy,
      model: session.model, sessionId: state.sessionId
    });
    return new Promise((resolve) => {
      let child;
      try { child = this.spawnProcess(this.resolved.bin, [...this.resolved.prefix, ...codexConfigArgs(session.settings), ...args], {
        cwd: session.cwd, env: process.env,
        // Codex reads a piped stdin as extra prompt input and waits on it, so give it none.
        stdio: ['ignore', 'pipe', 'pipe']
      }); } catch { state.error = 'codex_unavailable'; resolve(); return; }
      session.child = child;
      state.spawned.push({ pid: child.pid, args });
      let buf = '', ended = false;
      const decoder = new StringDecoder('utf8');
      const finish = (code) => {
        if (ended) return;
        ended = true;
        if (buf.trim()) consume(buf);
        buf = '';
        state.exitCode = code;
        resolve();
      };
      const invalid = (code) => {
        state.error = code; buf = '';
        try { child.kill(); } catch {}
        finish(-1);
      };
      const consume = (line) => {
        if (!line.trim() || state.error) return;
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return invalid('codex_frame_too_large');
        let ev; try { ev = JSON.parse(line); } catch { return invalid('codex_protocol_invalid'); }
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return invalid('codex_protocol_invalid');
        if (this.onRaw) { try { this.onRaw(line, ev, session); } catch {} }
        try { for (const e of translate(ev, state)) session.emit(e.method, e); }
        catch { invalid('codex_protocol_invalid'); }
      };
      child.stdout.on('data', (d) => {
        if (ended) return;
        buf += decoder.write(d);
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) consume(line);
        if (Buffer.byteLength(buf) > MAX_FRAME_BYTES) invalid('codex_frame_too_large');
      });
      // stderr carries the failures that never reach the JSONL stream (bad flag, missing
      // auth, killed sandbox). Swallowing it turned every one of those into a silent pass.
      child.stderr.on('data', (d) => {
        const code = diagnosticCode(d.toString());
        if (code !== 'codex_request_failed') state.diagnostic = code;
      });
      child.on('close', (code) => { buf += decoder.end(); finish(code); });
      child.on('error', () => invalid('codex_unavailable'));
      child.stdout.on('error', () => invalid('codex_disconnected'));
      child.stderr.on('error', () => invalid('codex_disconnected'));
    });
  }

  async run(session) {
    if (session.cancelled) return { proposals: [] };
    if (!this.resolved.ok) throw failure('codex_unavailable');
    const prompt = session.input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
    const state = {
      cwd: session.cwd, started: new Set(), outputSeen: new Map(), usage: null, error: null,
      diagnostic: null, exitCode: null, spawned: [], proposals: [], sessionId: session.thread.codexSessionId || null
    };
    session.providerSpawns = state.spawned;   // live, so an interrupt can be checked mid-turn
    await this.runOnce(session, state, prompt);
    const verifyCompletion = () => {
      if (session.cancelled) return;
      if (state.error) throw failure(state.error);
      if (state.exitCode !== 0) throw failure(state.diagnostic || 'codex_request_failed');
      if (!state.completed || !state.threadAcknowledged) throw failure('codex_completion_missing');
    };
    verifyCompletion();

    // Steers that arrived while Codex was working: deliver them for real, on the same
    // Codex session, rather than reporting a delivery the provider never saw.
    for (let i = 0; i < MAX_STEER_FOLLOWUPS && session.steerQueue.length && !session.cancelled && !state.error; i++) {
      if (!state.sessionId) break;
      const steers = session.steerQueue.splice(0);
      const text = steers
        .map((s) => s.input.filter((x) => x.type === 'text').map((x) => x.text).join('\n'))
        .filter(Boolean).join('\n');
      if (!text) break;
      state.started = new Set(); state.outputSeen = new Map();
      state.onProviderStarted = () => {
        for (const steer of steers) session.emit(Events.TURN_STEER_DELIVERED, {
          steerSeq: steer.seq, by: steer.by, delivery: 'nextProviderTurn'
        });
      };
      await this.runOnce(session, state, text);
      verifyCompletion();
    }

    session.child = null;
    if (state.sessionId) session.thread.codexSessionId = state.sessionId;
    if (state.usage) { session.usage.input += state.usage.input; session.usage.output += state.usage.output; }
    session.providerSessionId = state.sessionId;
    session.providerSpawns = state.spawned;
    return state;
  }
}

// How a confined provider still changes files.
//
// The block below is the whole point, so it is stated once and then relied on: Codex is run
// read-only, which is the only mode whose project confinement was measured, and it never gets
// a writable shell. It proposes the contents it thinks each file should have, and the host
// applies those through the same workspace writer every other tool goes through - project
// confined, symlink-refusing, policy-checked, and approval-gated when the write is anything
// but ordinary.
//
// So the writes are the host's, made under rules the host enforces, rather than a provider's
// made under rules nobody could verify. That is a stronger position than trusting
// `--sandbox workspace-write` would have been, not a weaker one, and it is why this can
// produce file changes without reopening the hole the confinement evidence found.
const EDIT_FENCE = /```plexus-edits\s*\n([\s\S]*?)```/g;
const MAX_EDITS = 20;
const MAX_EDIT_BYTES = 256 * 1024;

const EDIT_PROTOCOL = [
  '',
  'You are running with a read-only view of this project and cannot write to it.',
  'When you have decided what a file should contain, output its complete new contents in a',
  'fenced block tagged plexus-edits, one JSON object per line, paths relative to the project',
  'root:',
  '',
  '```plexus-edits',
  '{"path": "notes/README.md", "contents": "the entire new file, not a patch"}',
  '```',
  '',
  'Do not attempt to run a command that writes. Emit the block instead; the host applies it.'
].join('\n');

// Every proposal in the agent's own words, parsed and bounded. A malformed line is dropped
// rather than guessed at: a half-understood edit applied to somebody's file is worse than no
// edit, and the turn still reports what it did and did not do.
function parseProposedEdits(text) {
  const edits = [];
  const rejected = [];
  for (const match of String(text || '').matchAll(EDIT_FENCE)) {
    for (const line of match[1].split('\n')) {
      if (!line.trim()) continue;
      if (edits.length >= MAX_EDITS) { rejected.push({ reason: 'too_many_edits' }); break; }
      let value;
      try { value = JSON.parse(line); } catch { rejected.push({ reason: 'unparsable_edit' }); continue; }
      if (!value || typeof value.path !== 'string' || typeof value.contents !== 'string') {
        rejected.push({ reason: 'incomplete_edit' }); continue;
      }
      if (Buffer.byteLength(value.contents) > MAX_EDIT_BYTES) { rejected.push({ reason: 'edit_too_large', path: value.path }); continue; }
      edits.push({ path: value.path, contents: value.contents });
    }
  }
  return { edits, rejected };
}

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
    this.label = 'Codex CLI (read-only, host-applied edits)';
    this.confinedTo = 'read-only';
  }
  capabilities() {
    return {
      ...super.capabilities(),
      // The provider cannot write; the task can. Reporting a single boolean would make one
      // of those two true statements into a lie, so both are named.
      writes: true,
      providerWrites: false,
      writesVia: 'host-applied-edits',
      sandbox: this.confinedTo,
      approvals: false
    };
  }
  runOnce(session, state, prompt) {
    // A fresh view of the session with the sandbox pinned. Mutating the caller's settings
    // would leave the rest of the host believing it had asked for something it had not.
    const confined = Object.create(session);
    confined.settings = { ...(session.settings || {}), sandboxPolicy: this.confinedTo };
    // Everything the agent says, kept so the proposal can be read out of it afterwards.
    confined.emit = (method, payload) => {
      if (method === Events.ITEM_COMPLETED && payload && payload.item &&
          payload.item.type === ItemTypes.AGENT_MESSAGE) {
        state.proposals.push(payload.item.text || '');
      }
      return session.emit(method, payload);
    };
    const result = super.runOnce(confined, state, prompt);
    // The child is spawned against the derived view, so hand the real session its handle
    // back or an interrupt would have nothing to kill.
    if (confined.child) session.child = confined.child;
    return result;
  }

  // Apply what the agent proposed, through the host's own writer. Each edit takes the same
  // path a demo-agent write takes: workspace boundary, then policy, then approval if the
  // policy asks for one. Nothing here can write outside the project, whatever was proposed.
  async applyProposedEdits(session, text) {
    const { edits, rejected } = parseProposedEdits(text);
    const applied = [];
    for (const edit of edits) {
      const { item, result } = await session.writeFile(edit.path, edit.contents);
      applied.push({ path: edit.path, status: item.status, result });
      if (session.cancelled) break;
    }
    return { applied, rejected };
  }

  async run(session) {
    // The protocol is appended rather than replacing the objective: the agent is being asked
    // to do its own work and then say what it changed, not to do something different.
    const original = session.input;
    let state;
    session.input = [...original, { type: 'text', text: EDIT_PROTOCOL }];
    try {
      state = await super.run(session);
    } finally {
      session.input = original;
    }
    // Applied after the provider has finished, and never for a turn somebody interrupted:
    // an interrupt that still wrote the files would make cancelling meaningless.
    if (session.cancelled) return { applied: [], rejected: [] };
    const outcome = await this.applyProposedEdits(session, state.proposals.join('\n'));
    session.appliedEdits = outcome;
    return outcome;
  }
}

module.exports = {
  CodexExecBackend, ConfinedCodexExecBackend, translate, available, sandboxFlags, buildArgs,
  parseProposedEdits, EDIT_PROTOCOL, MAX_STEER_FOLLOWUPS
};
