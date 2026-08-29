const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_TOOL_OUTPUT = 20000;
const MAX_TURNS = 24;

// Commands that Agent mode may run without asking (read-only inspection).
const SAFE_PREFIXES = [
  'ls', 'cat ', 'head ', 'tail ', 'wc ', 'pwd', 'echo ', 'find ', 'grep ', 'rg ',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'which ', 'file ',
  'du ', 'stat ', 'tree', 'node --version', 'npm --version', 'python --version'
];

function isSafeCommand(cmd) {
  const c = cmd.trim();
  if (/[;&|>]|\$\(|`/.test(c)) return false; // no chaining/redirection auto-approved
  return SAFE_PREFIXES.some((p) => c === p.trim() || c.startsWith(p));
}

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

class AgentSession {
  constructor({ thread, settings, model, mode, emit }) {
    this.thread = thread;
    this.settings = settings;
    this.model = model || settings.model;
    this.mode = mode || settings.mode;
    this.emit = emit;
    this.running = false;
    this.cancelled = false;
    this.pendingApprovals = new Map(); // callId -> resolve(bool)
    this.child = null;
  }

  cancel() {
    this.cancelled = true;
    for (const resolve of this.pendingApprovals.values()) resolve(false);
    this.pendingApprovals.clear();
    if (this.child) {
      try { this.child.kill('SIGKILL'); } catch {}
    }
  }

  resolveApproval(callId, approved) {
    const resolve = this.pendingApprovals.get(callId);
    if (resolve) {
      this.pendingApprovals.delete(callId);
      resolve(!!approved);
    }
  }

  async run(userText) {
    this.running = true;
    this.emit({ kind: 'turn-start' });
    try {
      if (this.settings.openaiApiKey) {
        await this.runOpenAI(userText);
      } else {
        await this.runDemo(userText);
      }
      this.emit({ kind: this.cancelled ? 'turn-error' : 'turn-done', error: this.cancelled ? 'Cancelled' : undefined });
    } catch (err) {
      this.emit({ kind: 'turn-error', error: String(err && err.message ? err.message : err) });
    } finally {
      this.running = false;
    }
  }

  // ---------- shared helpers ----------

  async streamAssistantText(text, chunkSize = 24, delayMs = 12) {
    const id = uid('msg');
    const item = { id, role: 'assistant', type: 'message', text: '', ts: Date.now() };
    this.emit({ kind: 'item-start', item });
    for (let i = 0; i < text.length; i += chunkSize) {
      if (this.cancelled) break;
      const delta = text.slice(i, i + chunkSize);
      item.text += delta;
      this.emit({ kind: 'item-delta', id, delta });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    this.emit({ kind: 'item-done', item });
    return item;
  }

  async execCommand(command, callId) {
    const id = callId || uid('cmd');
    const item = {
      id, role: 'assistant', type: 'command', command,
      output: '', exitCode: null, status: 'running', ts: Date.now()
    };

    if (this.mode === 'read-only' && !isSafeCommand(command)) {
      item.status = 'denied';
      item.output = 'Denied: thread is in Read Only mode.';
      this.emit({ kind: 'item-done', item });
      return item;
    }

    let approved = this.mode === 'full-access' || isSafeCommand(command);
    if (!approved) {
      this.emit({ kind: 'approval-request', callId: id, command });
      approved = await new Promise((resolve) => this.pendingApprovals.set(id, resolve));
    }
    if (!approved) {
      item.status = 'denied';
      item.output = this.cancelled ? 'Cancelled.' : 'Denied by user.';
      this.emit({ kind: 'item-done', item });
      return item;
    }

    this.emit({ kind: 'item-start', item });
    const result = await new Promise((resolve) => {
      const child = spawn('/bin/bash', ['-c', command], {
        cwd: this.thread.projectDir || process.cwd(),
        env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' }
      });
      this.child = child;
      let out = '';
      const onData = (d) => {
        const s = d.toString();
        if (out.length < MAX_TOOL_OUTPUT) {
          const delta = s.slice(0, MAX_TOOL_OUTPUT - out.length);
          out += delta;
          item.output = out;
          this.emit({ kind: 'item-delta', id, outputDelta: delta });
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 120000);
      child.on('close', (code) => {
        clearTimeout(timer);
        this.child = null;
        resolve({ code: code == null ? -1 : code, out });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        this.child = null;
        resolve({ code: -1, out: String(err) });
      });
    });

    item.exitCode = result.code;
    item.output = result.out;
    item.status = result.code === 0 ? 'done' : 'failed';
    this.emit({ kind: 'item-done', item });
    return item;
  }

  buildHistory(userText) {
    const msgs = [];
    for (const it of this.thread.items || []) {
      if (it.type === 'message' && it.role === 'user') msgs.push({ role: 'user', content: it.text });
      else if (it.type === 'message' && it.role === 'assistant') msgs.push({ role: 'assistant', content: it.text });
      else if (it.type === 'command') {
        msgs.push({ role: 'assistant', content: `[ran command: ${it.command}]\n${(it.output || '').slice(0, 2000)}` });
      }
    }
    if (msgs.length === 0 || msgs[msgs.length - 1].content !== userText) {
      msgs.push({ role: 'user', content: userText });
    }
    return msgs;
  }

  systemPrompt() {
    const dir = this.thread.projectDir || '(no project selected)';
    const modeDesc = {
      'read-only': 'Read Only: you may only run safe read-only inspection commands.',
      'agent': 'Agent: you may run commands; risky ones require user approval.',
      'full-access': 'Full Access: commands run without approval.'
    }[this.mode];
    return [
      'You are Codex, a coding agent running inside a desktop app. You help the user work on the project in their workspace.',
      `Workspace directory: ${dir}`,
      `Access mode — ${modeDesc}`,
      'Use the shell tool to inspect and modify the workspace. Prefer small, verifiable steps.',
      'To edit files, write them with shell commands (heredocs via `cat > file <<EOF`, `sed`, etc.).',
      'When you are done, summarize what you did concisely in Markdown.'
    ].join('\n');
  }

  // ---------- OpenAI backend ----------

  async runOpenAI(userText) {
    const base = (this.settings.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const messages = [{ role: 'system', content: this.systemPrompt() }, ...this.buildHistory(userText)];
    const tools = this.mode === 'read-only' ? undefined : [{
      type: 'function',
      function: {
        name: 'shell',
        description: 'Run a bash command in the workspace directory and return its output.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: 'The bash command to run' } },
          required: ['command']
        }
      }
    }];

    for (let turn = 0; turn < MAX_TURNS && !this.cancelled; turn++) {
      const body = { model: this.model, messages, stream: true };
      if (tools) body.tools = tools;
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + this.settings.openaiApiKey
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`API error ${res.status}: ${errText.slice(0, 500)}`);
      }

      const { text, toolCalls } = await this.consumeOpenAIStream(res);

      if (toolCalls.length === 0) {
        if (!text) this.emit({ kind: 'item-done', item: { id: uid('msg'), role: 'assistant', type: 'message', text: '(empty response)', ts: Date.now() } });
        return;
      }

      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: tc.arguments }
        }))
      });

      for (const tc of toolCalls) {
        if (this.cancelled) return;
        let command = '';
        try { command = JSON.parse(tc.arguments || '{}').command || ''; } catch {}
        const item = command
          ? await this.execCommand(command)
          : { status: 'failed', output: 'Invalid tool arguments', exitCode: -1 };
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            exit_code: item.exitCode,
            status: item.status,
            output: (item.output || '').slice(0, MAX_TOOL_OUTPUT)
          })
        });
      }
    }
  }

  async consumeOpenAIStream(res) {
    let msgItem = null;
    let text = '';
    const toolCalls = []; // {id, name, arguments}
    const decoder = new TextDecoder();
    let buf = '';

    const handleDelta = (delta) => {
      if (delta.content) {
        if (!msgItem) {
          msgItem = { id: uid('msg'), role: 'assistant', type: 'message', text: '', ts: Date.now() };
          this.emit({ kind: 'item-start', item: msgItem });
        }
        msgItem.text += delta.content;
        text += delta.content;
        this.emit({ kind: 'item-delta', id: msgItem.id, delta: delta.content });
      }
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index || 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || uid('call'), name: '', arguments: '' };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
      }
    };

    for await (const chunk of res.body) {
      if (this.cancelled) break;
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (delta) handleDelta(delta);
        } catch {}
      }
    }
    if (msgItem) this.emit({ kind: 'item-done', item: msgItem });
    return { text, toolCalls: toolCalls.filter(Boolean) };
  }

  // ---------- Demo backend (no API key) ----------

  async runDemo(userText) {
    const dir = this.thread.projectDir;
    const lower = userText.toLowerCase();

    if (!dir) {
      await this.streamAssistantText(
        'No project is open yet. Click **Open project** in the sidebar to point me at a folder, ' +
        'and add an OpenAI API key in **Settings** to connect the real model.\n\n' +
        '_Running in demo mode — responses are simulated._'
      );
      return;
    }

    if (/\b(what|show|list|look|explore|files|structure|around|repo)\b/.test(lower)) {
      await this.streamAssistantText('I\'ll take a look at the workspace first.');
      const ls = await this.execCommand('ls -la');
      const gs = await this.execCommand('git status --short --branch');
      const fileCount = (ls.output || '').split('\n').filter(Boolean).length - 1;
      await this.streamAssistantText(
        `The workspace \`${path.basename(dir)}\` has about **${Math.max(fileCount, 0)} entries** at the top level` +
        (gs.exitCode === 0 ? ', and it\'s a git repository (status shown above).' : '.') +
        '\n\n_Running in demo mode — add an OpenAI API key in **Settings** for real agentic coding._'
      );
      return;
    }

    if (/\b(diff|changes|changed)\b/.test(lower)) {
      await this.execCommand('git diff --stat');
      await this.streamAssistantText(
        'Those are the current working-tree changes. You can also open the **Changes** panel (top right) for a full side-by-side view.\n\n' +
        '_Running in demo mode — add an OpenAI API key in **Settings** for real agentic coding._'
      );
      return;
    }

    await this.streamAssistantText(
      `I\'m running in **demo mode** because no OpenAI API key is configured, so I can\'t make real code changes for:\n\n> ${userText}\n\n` +
      'What works right now:\n' +
      '- Ask me to **explore the repo** and I\'ll run real read-only commands\n' +
      '- Ask about the **diff** to see working-tree changes\n' +
      '- The **Changes** panel, threads, models and approval modes are all live\n\n' +
      'To unlock the real agent, open **Settings** (gear, bottom left) and paste an OpenAI API key.'
    );
  }
}

module.exports = { AgentSession, isSafeCommand };
