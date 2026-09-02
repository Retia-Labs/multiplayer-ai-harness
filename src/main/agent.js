const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_TOOL_OUTPUT = 20000;
const MAX_TURNS = 32;

// Commands that Agent mode may run without asking (read-only inspection).
const SAFE_PREFIXES = [
  'ls', 'cat ', 'head ', 'tail ', 'wc ', 'pwd', 'echo ', 'find ', 'grep ', 'rg ',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git ls-files',
  'which ', 'file ', 'du ', 'stat ', 'tree', 'sed -n', 'awk ',
  'node --version', 'npm --version', 'python --version', 'python3 --version'
];

function isSafeCommand(cmd) {
  const c = cmd.trim();
  if (/[;&|>]|\$\(|`/.test(c)) return false; // no chaining/redirection auto-approved
  return SAFE_PREFIXES.some((p) => c === p.trim() || c.startsWith(p));
}

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

// Simple LCS-based line diff for edit cards (capped for big files).
function lineDiff(oldText, newText, cap = 4000) {
  const a = (oldText || '').split('\n');
  const b = (newText || '').split('\n');
  if (a.length * b.length > cap * cap) {
    return { lines: [{ kind: 'hunk', text: `File rewritten (${a.length} → ${b.length} lines)` }], additions: b.length, deletions: a.length };
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let additions = 0, deletions = 0, i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { lines.push({ kind: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ kind: 'del', text: a[i++] }); deletions++; }
    else { lines.push({ kind: 'add', text: b[j++] }); additions++; }
  }
  while (i < n) { lines.push({ kind: 'del', text: a[i++] }); deletions++; }
  while (j < m) { lines.push({ kind: 'add', text: b[j++] }); additions++; }
  // Collapse long runs of context to keep cards compact.
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > 6) {
      out.push(run[0], run[1], { kind: 'hunk', text: `… ${run.length - 4} unchanged lines …` }, run[run.length - 2], run[run.length - 1]);
    } else out.push(...run);
    run = [];
  };
  for (const l of lines) {
    if (l.kind === 'ctx') run.push(l);
    else { flush(); out.push(l); }
  }
  flush();
  return { lines: out.slice(0, 600), additions, deletions };
}

class AgentSession {
  constructor({ thread, settings, model, mode, effort, emit }) {
    this.thread = thread;
    this.settings = settings;
    this.model = model || settings.model;
    this.mode = mode || settings.mode;
    this.effort = effort || settings.effort || 'medium';
    this.emit = emit;
    this.running = false;
    this.cancelled = false;
    this.pendingApprovals = new Map(); // callId -> resolve(bool)
    this.steerQueue = [];
    this.usage = { input: 0, output: 0 };
    this.planItem = null;
    this.child = null;
  }

  get workDir() {
    return this.thread.workDir || this.thread.projectDir || process.cwd();
  }

  cancel() {
    this.cancelled = true;
    for (const resolve of this.pendingApprovals.values()) resolve(false);
    this.pendingApprovals.clear();
    if (this.child) {
      try { this.child.kill('SIGKILL'); } catch {}
    }
  }

  enqueueSteer(text) {
    this.steerQueue.push(text);
  }

  resolveApproval(callId, approved) {
    const resolve = this.pendingApprovals.get(callId);
    if (resolve) {
      this.pendingApprovals.delete(callId);
      resolve(!!approved);
    }
  }

  async run(userText, images) {
    this.running = true;
    this.emit({ kind: 'turn-start' });
    try {
      if (this.settings.openaiApiKey) {
        await this.runOpenAI(userText, images);
      } else {
        await this.runDemo(userText);
      }
      this.finishPlan();
      this.emit({
        kind: this.cancelled ? 'turn-error' : 'turn-done',
        error: this.cancelled ? 'Cancelled' : undefined,
        usage: this.usage.input + this.usage.output > 0 ? this.usage : undefined
      });
    } catch (err) {
      this.finishPlan();
      this.emit({ kind: 'turn-error', error: String(err && err.message ? err.message : err) });
    } finally {
      this.running = false;
    }
  }

  // ---------- shared helpers ----------

  async streamAssistantText(text, chunkSize = 24, delayMs = 10) {
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

  async streamReasoning(text, delayMs = 14) {
    const id = uid('rsn');
    const item = { id, role: 'assistant', type: 'reasoning', text: '', ts: Date.now() };
    this.emit({ kind: 'item-start', item });
    for (let i = 0; i < text.length; i += 18) {
      if (this.cancelled) break;
      const delta = text.slice(i, i + 18);
      item.text += delta;
      this.emit({ kind: 'item-delta', id, delta });
      await new Promise((r) => setTimeout(r, delayMs));
    }
    this.emit({ kind: 'item-done', item });
    return item;
  }

  updatePlan(steps, explanation) {
    // steps: [{step, status: 'pending'|'in_progress'|'completed'}]
    if (!this.planItem) {
      this.planItem = { id: uid('plan'), role: 'assistant', type: 'plan', steps: [], explanation: '', ts: Date.now() };
      this.emit({ kind: 'item-start', item: this.planItem });
    }
    this.planItem.steps = steps;
    if (explanation) this.planItem.explanation = explanation;
    this.emit({ kind: 'item-update', item: this.planItem });
    return 'Plan updated.';
  }

  finishPlan() {
    if (this.planItem) {
      this.emit({ kind: 'item-done', item: this.planItem });
      this.planItem = null;
    }
  }

  async requestApproval(id, kind, detail) {
    this.emit({ kind: 'approval-request', callId: id, action: kind, command: detail });
    return await new Promise((resolve) => this.pendingApprovals.set(id, resolve));
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
    if (!approved) approved = await this.requestApproval(id, 'command', command);
    if (!approved) {
      item.status = 'denied';
      item.output = this.cancelled ? 'Cancelled.' : 'Denied by user.';
      this.emit({ kind: 'item-done', item });
      return item;
    }

    this.emit({ kind: 'item-start', item });
    const result = await new Promise((resolve) => {
      const child = spawn('/bin/bash', ['-c', command], {
        cwd: this.workDir,
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

  async writeFile(relPath, content) {
    const id = uid('edit');
    const abs = path.resolve(this.workDir, relPath);
    const inside = abs === this.workDir || abs.startsWith(this.workDir + path.sep);
    const item = {
      id, role: 'assistant', type: 'edit', path: relPath,
      status: 'running', created: false, additions: 0, deletions: 0, lines: [], ts: Date.now()
    };

    if (this.mode === 'read-only') {
      item.status = 'denied';
      this.emit({ kind: 'item-done', item });
      return { item, result: 'Denied: Read Only mode. Cannot write files.' };
    }
    if (!inside) {
      const ok = this.mode === 'full-access' || await this.requestApproval(id, 'write', `write file outside workspace: ${abs}`);
      if (!ok) {
        item.status = 'denied';
        this.emit({ kind: 'item-done', item });
        return { item, result: 'Denied by user.' };
      }
    }

    let oldText = null;
    try { oldText = fs.readFileSync(abs, 'utf8'); } catch {}
    item.created = oldText === null;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    } catch (e) {
      item.status = 'failed';
      this.emit({ kind: 'item-done', item });
      return { item, result: 'Write failed: ' + String(e) };
    }
    const d = lineDiff(oldText || '', content);
    item.additions = item.created ? content.split('\n').length : d.additions;
    item.deletions = item.created ? 0 : d.deletions;
    item.lines = item.created
      ? content.split('\n').slice(0, 400).map((t) => ({ kind: 'add', text: t }))
      : d.lines;
    item.status = 'done';
    this.emit({ kind: 'item-done', item });
    return { item, result: `Wrote ${relPath} (${item.created ? 'created' : 'updated'}, +${item.additions} −${item.deletions}).` };
  }

  buildHistory(userText, images) {
    const msgs = [];
    for (const it of this.thread.items || []) {
      if (it.type === 'message' && it.role === 'user') {
        if (it.images && it.images.length) {
          msgs.push({
            role: 'user',
            content: [
              { type: 'text', text: it.text || '' },
              ...it.images.map((u) => ({ type: 'image_url', image_url: { url: u } }))
            ]
          });
        } else msgs.push({ role: 'user', content: it.text });
      } else if (it.type === 'message' && it.role === 'assistant') {
        msgs.push({ role: 'assistant', content: it.text });
      } else if (it.type === 'command') {
        msgs.push({ role: 'assistant', content: `[ran command: ${it.command}]\n${(it.output || '').slice(0, 2000)}` });
      } else if (it.type === 'edit') {
        msgs.push({ role: 'assistant', content: `[edited file: ${it.path} (+${it.additions} −${it.deletions})]` });
      }
    }
    const last = msgs[msgs.length - 1];
    const lastText = last && (typeof last.content === 'string' ? last.content : (last.content.find((c) => c.type === 'text') || {}).text);
    if (!last || last.role !== 'user' || lastText !== userText) {
      if (images && images.length) {
        msgs.push({
          role: 'user',
          content: [{ type: 'text', text: userText }, ...images.map((u) => ({ type: 'image_url', image_url: { url: u } }))]
        });
      } else msgs.push({ role: 'user', content: userText });
    }
    return msgs;
  }

  systemPrompt() {
    const dir = this.workDir;
    const modeDesc = {
      'read-only': 'Read Only: you may only run safe read-only inspection commands; you cannot write files.',
      'agent': 'Agent: you may run commands and edit files in the workspace; risky commands require user approval.',
      'full-access': 'Full Access: commands and edits run without approval.'
    }[this.mode];
    return [
      'You are Quorum, a coding agent running inside a desktop app. You help the user work on the project in their workspace.',
      `Workspace directory: ${dir}`,
      this.thread.worktree ? `You are in an isolated git worktree on branch ${this.thread.branch}. Changes here do not touch the main checkout.` : '',
      `Access mode — ${modeDesc}`,
      'Tools: `shell` runs bash in the workspace; `write_file` creates or replaces a file; `update_plan` shows the user a live step checklist — use it at the start of multi-step tasks and keep statuses current.',
      'Prefer small, verifiable steps. Verify your work with shell commands when practical.',
      'When you are done, summarize what you did concisely in Markdown.'
    ].filter(Boolean).join('\n');
  }

  toolDefs() {
    if (this.mode === 'read-only') {
      return [{
        type: 'function',
        function: {
          name: 'shell',
          description: 'Run a read-only bash command in the workspace directory.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command']
          }
        }
      }];
    }
    return [
      {
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
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Create or completely replace a file in the workspace with the given content.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path relative to the workspace root' },
              content: { type: 'string', description: 'Full new file content' }
            },
            required: ['path', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'update_plan',
          description: 'Show or update a step-by-step plan checklist in the UI. Call again to mark steps in_progress/completed.',
          parameters: {
            type: 'object',
            properties: {
              explanation: { type: 'string' },
              plan: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    step: { type: 'string' },
                    status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
                  },
                  required: ['step', 'status']
                }
              }
            },
            required: ['plan']
          }
        }
      }
    ];
  }

  // ---------- OpenAI backend ----------

  async runOpenAI(userText, images) {
    const base = (this.settings.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const messages = [{ role: 'system', content: this.systemPrompt() }, ...this.buildHistory(userText, images)];
    const tools = this.toolDefs();

    for (let turn = 0; turn < MAX_TURNS && !this.cancelled; turn++) {
      // Inject any steering messages the user sent mid-run.
      while (this.steerQueue.length) {
        messages.push({ role: 'user', content: this.steerQueue.shift() });
      }

      const body = {
        model: this.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        tools
      };
      if (/^(gpt-5|o[0-9])/.test(this.model)) body.reasoning_effort = this.effort === 'xhigh' ? 'high' : this.effort;

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
        if (!text && !this.cancelled) {
          this.emit({ kind: 'item-done', item: { id: uid('msg'), role: 'assistant', type: 'message', text: '(empty response)', ts: Date.now() } });
        }
        if (this.steerQueue.length === 0) return;
        continue; // user steered after the model finished — go another round
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
        let args = {};
        try { args = JSON.parse(tc.arguments || '{}'); } catch {}
        let resultStr;
        if (tc.name === 'shell') {
          const item = args.command
            ? await this.execCommand(args.command)
            : { status: 'failed', output: 'Missing command', exitCode: -1 };
          resultStr = JSON.stringify({
            exit_code: item.exitCode, status: item.status,
            output: (item.output || '').slice(0, MAX_TOOL_OUTPUT)
          });
        } else if (tc.name === 'write_file') {
          const { result } = (args.path != null && args.content != null)
            ? await this.writeFile(String(args.path), String(args.content))
            : { result: 'Missing path/content' };
          resultStr = result;
        } else if (tc.name === 'update_plan') {
          resultStr = Array.isArray(args.plan)
            ? this.updatePlan(args.plan, args.explanation)
            : 'Missing plan array';
        } else {
          resultStr = 'Unknown tool: ' + tc.name;
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
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
          if (json.usage) {
            this.usage.input += json.usage.prompt_tokens || 0;
            this.usage.output += json.usage.completion_tokens || 0;
          }
        } catch {}
      }
    }
    if (msgItem) this.emit({ kind: 'item-done', item: msgItem });
    return { text, toolCalls: toolCalls.filter(Boolean) };
  }

  // ---------- Demo backend (no API key) ----------

  async runDemo(userText) {
    const dir = this.thread.projectDir || this.thread.workDir;
    const lower = userText.toLowerCase();
    const demoNote = '\n\n_Demo mode — add an OpenAI API key in **Settings** to connect the real model._';

    if (!dir) {
      await this.streamAssistantText(
        'No project is open yet. Pick a project from the composer (or **Open project** in the sidebar), ' +
        'and add an OpenAI API key in **Settings** to connect the real model.' + demoNote
      );
      return;
    }

    // Scenario: create/write something — exercises plan + reasoning + write_file + shell.
    const createMatch = lower.match(/\b(create|write|add|make|build|generate)\b/);
    if (createMatch && !/\bdiff|changes\b/.test(lower)) {
      await this.streamReasoning('Considering the request — I should lay out a short plan, create the file in the workspace, then verify it exists before summarizing.');
      this.updatePlan([
        { step: 'Inspect the workspace', status: 'in_progress' },
        { step: 'Create the requested file', status: 'pending' },
        { step: 'Verify the result', status: 'pending' }
      ], 'Small three-step plan for this change.');
      await this.execCommand('ls -la');
      this.updatePlan([
        { step: 'Inspect the workspace', status: 'completed' },
        { step: 'Create the requested file', status: 'in_progress' },
        { step: 'Verify the result', status: 'pending' }
      ]);
      const fname = (userText.match(/([\w./-]+\.(?:md|txt|js|ts|py|json|html|css|sh))/i) || [])[1] || 'NOTES.md';
      const { item } = await this.writeFile(fname, [
        '# Created by Quorum (demo mode)',
        '',
        'You asked:',
        '> ' + userText,
        '',
        'This file was written through the same `write_file` tool pipeline the real model uses —',
        'approvals, diff cards and the Changes panel all behave identically.',
        ''
      ].join('\n'));
      this.updatePlan([
        { step: 'Inspect the workspace', status: 'completed' },
        { step: 'Create the requested file', status: 'completed' },
        { step: 'Verify the result', status: 'in_progress' }
      ]);
      await this.execCommand(`ls -la ${fname.includes('/') ? fname.split('/')[0] : fname}`);
      this.updatePlan([
        { step: 'Inspect the workspace', status: 'completed' },
        { step: 'Create the requested file', status: 'completed' },
        { step: 'Verify the result', status: 'completed' }
      ]);
      await this.streamAssistantText(
        `Done — I created **${fname}** (${item.status === 'done' ? '+' + item.additions + ' lines' : item.status}). ` +
        'Open the **Changes** panel to review, revert or commit it.' + demoNote
      );
      return;
    }

    if (/\b(what|show|list|look|explore|files|structure|around|repo)\b/.test(lower)) {
      await this.streamReasoning('The user wants an overview — a quick listing plus git status should cover it.');
      await this.streamAssistantText('I\'ll take a look at the workspace first.');
      const ls = await this.execCommand('ls -la');
      const gs = await this.execCommand('git status --short --branch');
      const fileCount = (ls.output || '').split('\n').filter(Boolean).length - 1;
      await this.streamAssistantText(
        `The workspace \`${path.basename(dir)}\` has about **${Math.max(fileCount, 0)} entries** at the top level` +
        (gs.exitCode === 0 ? ', and it\'s a git repository (status shown above).' : '.') + demoNote
      );
      return;
    }

    if (/\b(diff|changes|changed)\b/.test(lower)) {
      await this.execCommand('git diff --stat');
      await this.streamAssistantText(
        'Those are the current working-tree changes. Open the **Changes** panel (top right) to review per-file diffs, revert files, copy a patch, or commit.' + demoNote
      );
      return;
    }

    await this.streamAssistantText(
      `I\'m running in **demo mode** because no OpenAI API key is configured, so I can\'t truly work on:\n\n> ${userText}\n\n` +
      'Things you can try offline:\n' +
      '- “**Create** a NOTES.md summarizing this repo” — plan, file edit and verification cards\n' +
      '- “**Explore** the repo” — real read-only commands\n' +
      '- “Show the **diff**” — working-tree changes\n\n' +
      'Everything else — threads, worktrees, approvals, the Changes panel, automations — is fully live. ' +
      'To unlock the real agent, open **Settings** (gear, bottom left) and paste an OpenAI API key.'
    );
    if (this.steerQueue.length) {
      const extra = this.steerQueue.splice(0).join('; ');
      await this.streamAssistantText(`Noted your follow-up: _${extra}_ — in live mode I\'d fold that into the current run.`);
    }
  }
}

module.exports = { AgentSession, isSafeCommand, lineDiff };
