'use strict';
// Backend that delegates a turn to the Claude Code CLI (`claude -p --output-format stream-json`)
// on the runtime owner's own subscription, translating its stream-json events into harness
// protocol events. Requires the `claude` binary on PATH and a logged-in Claude Code.
const { spawn, execFileSync } = require('child_process');
const { Events, ItemTypes, ItemStatus } = require('../protocol');

function available(bin = 'claude') {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
}

function permissionFlags(sandboxPolicy) {
  if (sandboxPolicy === 'read-only') return ['--permission-mode', 'plan'];
  if (sandboxPolicy === 'danger-full-access') return ['--dangerously-skip-permissions'];
  return ['--permission-mode', 'acceptEdits'];
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Map one stream-json line into harness events. `state` carries tool_use ids → items.
function translate(ev, state) {
  const out = [];
  if (ev.type === 'system' && ev.subtype === 'init') { state.sessionId = ev.session_id; return out; }
  if (ev.type === 'assistant' && ev.message) {
    for (const block of ev.message.content || []) {
      if (block.type === 'text' && block.text) {
        const item = { id: 'cc_' + (state.n++), type: ItemTypes.AGENT_MESSAGE, text: block.text };
        out.push({ method: Events.ITEM_STARTED, item }, { method: Events.ITEM_COMPLETED, item });
      } else if (block.type === 'thinking' && block.thinking) {
        const item = { id: 'cc_' + (state.n++), type: ItemTypes.REASONING, text: block.thinking };
        out.push({ method: Events.ITEM_STARTED, item }, { method: Events.ITEM_COMPLETED, item });
      } else if (block.type === 'tool_use') {
        const input = block.input || {};
        if (block.name === 'Bash') {
          const item = { id: 'cc_' + block.id, type: ItemTypes.COMMAND_EXECUTION, command: input.command || '', cwd: state.cwd, executor: 'claude-code', status: ItemStatus.IN_PROGRESS, aggregatedOutput: '' };
          state.tools.set(block.id, item);
          out.push({ method: Events.ITEM_STARTED, item });
        } else if (EDIT_TOOLS.has(block.name)) {
          const path = input.file_path || input.notebook_path || '?';
          const item = { id: 'cc_' + block.id, type: ItemTypes.FILE_CHANGE, status: ItemStatus.IN_PROGRESS, changes: [{ path: path.startsWith(state.cwd + '/') ? path.slice(state.cwd.length + 1) : path, kind: block.name === 'Write' ? 'add' : 'update', additions: 0, deletions: 0, lines: [] }] };
          state.tools.set(block.id, item);
          out.push({ method: Events.ITEM_STARTED, item });
        } else if (block.name === 'TodoWrite') {
          out.push({ method: Events.TURN_PLAN_UPDATED, plan: (input.todos || []).map((t) => ({ step: t.content, status: t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'inProgress' : 'pending' })) });
        } else {
          // Read/Grep/Glob/WebFetch/etc. → show as a lightweight command-style card.
          const summary = block.name + ' ' + (input.file_path || input.pattern || input.query || input.url || '');
          const item = { id: 'cc_' + block.id, type: ItemTypes.COMMAND_EXECUTION, command: summary.trim(), cwd: state.cwd, executor: 'claude-code', status: ItemStatus.IN_PROGRESS, aggregatedOutput: '' };
          state.tools.set(block.id, item);
          out.push({ method: Events.ITEM_STARTED, item });
        }
      }
    }
    return out;
  }
  if (ev.type === 'user' && ev.message) {
    for (const block of ev.message.content || []) {
      if (block.type !== 'tool_result') continue;
      const item = state.tools.get(block.tool_use_id);
      if (!item) continue;
      const text = Array.isArray(block.content) ? block.content.map((c) => c.text || '').join('\n') : (block.content || '');
      if (item.type === ItemTypes.COMMAND_EXECUTION) {
        item.aggregatedOutput = String(text).slice(0, 20000);
        item.status = block.is_error ? ItemStatus.FAILED : ItemStatus.COMPLETED;
        item.exitCode = block.is_error ? 1 : 0;
      } else item.status = block.is_error ? ItemStatus.FAILED : ItemStatus.COMPLETED;
      state.tools.delete(block.tool_use_id);
      out.push({ method: Events.ITEM_COMPLETED, item });
    }
    return out;
  }
  if (ev.type === 'result') {
    if (ev.usage) state.usage = { input: (ev.usage.input_tokens || 0) + (ev.usage.cache_read_input_tokens || 0), output: ev.usage.output_tokens || 0 };
    if (ev.session_id) state.sessionId = ev.session_id;
    if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) state.error = ev.result || ev.subtype || 'claude failed';
    return out;
  }
  return out;
}

class ClaudeCodeBackend {
  constructor({ bin = 'claude' } = {}) { this.id = 'claude-code'; this.label = 'Claude Code CLI'; this.bin = bin; }
  capabilities() { return { toolCalls: true, reasoning: 'summary', images: false }; }
  async listModels() { return ['default', 'sonnet', 'opus', 'haiku']; }

  async run(session) {
    const prompt = session.input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
    const state = { cwd: session.cwd, tools: new Map(), n: 0, usage: null, error: null, sessionId: session.thread.claudeSessionId || null };
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...permissionFlags(session.settings.sandboxPolicy)];
    if (session.model && session.model !== 'default') args.push('--model', session.model);
    if (state.sessionId) args.push('--resume', state.sessionId);
    const awareness = session.teamAwareness();
    if (awareness) args.push('--append-system-prompt', awareness);
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
    if (state.sessionId) session.thread.claudeSessionId = state.sessionId;
    if (state.usage) { session.usage.input += state.usage.input; session.usage.output += state.usage.output; }
    if (state.error) throw new Error(state.error);
  }
}

module.exports = { ClaudeCodeBackend, translate, available, permissionFlags };
