'use strict';
// Backend that delegates a turn to the real OpenAI Codex CLI (`codex exec --json`)
// and translates its JSONL thread events into harness protocol events. Requires the
// `codex` binary on PATH and Codex auth on this machine. Approvals cannot be routed
// (codex exec is non-interactive), so the sandbox policy is passed as a flag instead.
const { spawn, execFileSync } = require('child_process');
const { Events, ItemTypes, ItemStatus } = require('../protocol');

function available(bin = 'codex') {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
}

function sandboxFlags(sandboxPolicy) {
  if (sandboxPolicy === 'read-only') return ['--sandbox', 'read-only'];
  if (sandboxPolicy === 'danger-full-access') return ['--dangerously-bypass-approvals-and-sandbox'];
  return ['--full-auto'];
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

class CodexExecBackend {
  constructor({ bin = 'codex' } = {}) { this.id = 'codex-cli'; this.label = 'Codex CLI'; this.bin = bin; }
  capabilities() { return { toolCalls: true, reasoning: 'summary', images: false }; }
  async listModels() { return ['gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5.1-codex-mini']; }

  async run(session) {
    const prompt = session.input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
    const state = { cwd: session.cwd, started: new Set(), outputSeen: new Map(), usage: null, error: null, sessionId: session.thread.codexSessionId || null };
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', session.cwd, ...sandboxFlags(session.settings.sandboxPolicy)];
    if (session.model) args.push('-m', session.model);
    if (state.sessionId) args.splice(1, 0, 'resume', state.sessionId);
    args.push(prompt);
    await new Promise((resolve) => {
      const child = spawn(this.bin, args, { cwd: session.cwd, env: process.env });
      session.child = child;
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          for (const e of translate(ev, state)) session.emit(e.method, e);
        }
      });
      child.stderr.on('data', () => {});
      child.on('close', () => resolve());
      child.on('error', (err) => { state.error = String(err); resolve(); });
    });
    session.child = null;
    if (state.sessionId) session.thread.codexSessionId = state.sessionId;
    if (state.usage) { session.usage.input += state.usage.input; session.usage.output += state.usage.output; }
    if (state.error) throw new Error(state.error);
  }
}

module.exports = { CodexExecBackend, translate, available, sandboxFlags };
