'use strict';
// Provider adapters — the BYOP contract. Every adapter exposes the same narrow
// interface; the agent loop above it only ever sees normalized deltas:
//   { type: 'text', text }
//   { type: 'reasoning', text }
//   { type: 'tool_call', id, name, arguments }   (complete, after stream ends)
//   { type: 'usage', input, output }
// Adapters absorb wire-format differences (OpenAI vs Anthropic tool calls,
// reasoning/effort params, usage accounting).

const DEFAULT_MODELS = {
  openai: ['gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1'],
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  ollama: ['qwen2.5-coder:7b', 'llama3.1:8b', 'deepseek-coder-v2'],
  demo: ['demo-agent']
};

async function readSse(res, onData) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') continue;
      try { onData(JSON.parse(data)); } catch {}
    }
  }
}

// ---------- OpenAI (chat completions; also OpenRouter / any OpenAI-compatible server) ----------
class OpenAIProvider {
  constructor({ apiKey, baseUrl = 'https://api.openai.com/v1', id = 'openai', label = 'OpenAI' } = {}) {
    this.id = id; this.label = label; this.apiKey = apiKey; this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  capabilities(model) {
    return { toolCalls: true, reasoning: /^(gpt-5|o[0-9])/.test(model) ? 'summary' : 'none', images: true };
  }
  async listModels() {
    try {
      const res = await fetch(this.baseUrl + '/models', { headers: this.headers() });
      if (!res.ok) throw new Error(res.status);
      const j = await res.json();
      const ids = (j.data || []).map((m) => m.id).filter((id) => /gpt|o[0-9]|codex|claude|qwen|llama|deepseek|coder/i.test(id));
      return ids.length ? ids.sort() : DEFAULT_MODELS[this.id] || [];
    } catch { return DEFAULT_MODELS[this.id] || DEFAULT_MODELS.openai; }
  }
  headers() {
    const h = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = 'Bearer ' + this.apiKey;
    return h;
  }
  async *stream({ model, system, messages, tools, effort, signal }) {
    const body = {
      model, stream: true, stream_options: { include_usage: true },
      messages: [{ role: 'system', content: system }, ...messages.map(toOpenAIMessage)]
    };
    if (tools && tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (effort && /^(gpt-5|o[0-9])/.test(model)) body.reasoning_effort = effort === 'xhigh' ? 'high' : effort;
    const res = await fetch(this.baseUrl + '/chat/completions', { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`${this.label} API error ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const calls = [];
    const deltas = [];
    let usage = null;
    await readSse(res, (json) => {
      const d = json.choices?.[0]?.delta;
      if (d) {
        if (d.content) deltas.push({ type: 'text', text: d.content });
        if (d.reasoning_content) deltas.push({ type: 'reasoning', text: d.reasoning_content });
        for (const tc of d.tool_calls || []) {
          const i = tc.index || 0;
          calls[i] = calls[i] || { id: tc.id || 'call_' + i, name: '', arguments: '' };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
        }
      }
      if (json.usage) usage = { input: json.usage.prompt_tokens || 0, output: json.usage.completion_tokens || 0 };
    });
    // Streaming SSE inside an async generator: yield what we buffered in arrival order.
    for (const d of deltas) yield d;
    for (const c of calls.filter(Boolean)) yield { type: 'tool_call', ...c };
    if (usage) yield { type: 'usage', ...usage };
  }
}

function toOpenAIMessage(m) {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls) {
    return { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) };
  }
  if (m.role === 'user' && m.images && m.images.length) {
    return { role: 'user', content: [{ type: 'text', text: m.content }, ...m.images.map((u) => ({ type: 'image_url', image_url: { url: u } }))] };
  }
  return { role: m.role, content: m.content };
}

// ---------- Anthropic (Messages API) ----------
class AnthropicProvider {
  constructor({ apiKey, baseUrl = 'https://api.anthropic.com' } = {}) {
    this.id = 'anthropic'; this.label = 'Anthropic'; this.apiKey = apiKey; this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  capabilities() { return { toolCalls: true, reasoning: 'summary', images: true }; }
  async listModels() {
    try {
      const res = await fetch(this.baseUrl + '/v1/models', { headers: this.headers() });
      if (!res.ok) throw new Error(res.status);
      const j = await res.json();
      const ids = (j.data || []).map((m) => m.id);
      return ids.length ? ids : DEFAULT_MODELS.anthropic;
    } catch { return DEFAULT_MODELS.anthropic; }
  }
  headers() {
    return { 'content-type': 'application/json', 'x-api-key': this.apiKey || '', 'anthropic-version': '2023-06-01' };
  }
  async *stream({ model, system, messages, tools, effort, signal }) {
    const body = { model, system, max_tokens: 8192, stream: true, messages: toAnthropicMessages(messages) };
    if (tools && tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (effort && effort !== 'low') body.thinking = { type: 'enabled', budget_tokens: effort === 'medium' ? 2048 : 8192 };
    const res = await fetch(this.baseUrl + '/v1/messages', { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const blocks = {}; // index -> {type, id, name, json, text}
    const deltas = [];
    let usage = { input: 0, output: 0 };
    await readSse(res, (ev) => {
      if (ev.type === 'content_block_start') blocks[ev.index] = { ...ev.content_block, json: '' };
      else if (ev.type === 'content_block_delta') {
        const d = ev.delta;
        if (d.type === 'text_delta') deltas.push({ type: 'text', text: d.text });
        else if (d.type === 'thinking_delta') deltas.push({ type: 'reasoning', text: d.thinking });
        else if (d.type === 'input_json_delta' && blocks[ev.index]) blocks[ev.index].json += d.partial_json;
      } else if (ev.type === 'message_start' && ev.message?.usage) usage.input += ev.message.usage.input_tokens || 0;
      else if (ev.type === 'message_delta' && ev.usage) usage.output += ev.usage.output_tokens || 0;
    });
    for (const d of deltas) yield d;
    for (const b of Object.values(blocks)) if (b.type === 'tool_use') yield { type: 'tool_call', id: b.id, name: b.name, arguments: b.json || '{}' };
    yield { type: 'usage', ...usage };
  }
}

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const content = m.images && m.images.length
        ? [{ type: 'text', text: m.content }, ...m.images.map((u) => {
            const mm = u.match(/^data:(image\/\w+);base64,(.*)$/);
            return mm ? { type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } } : { type: 'text', text: '[image]' };
          })]
        : m.content;
      out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls || []) {
        let input = {}; try { input = JSON.parse(c.arguments || '{}'); } catch {}
        content.push({ type: 'tool_use', id: c.id, name: c.name, input });
      }
      out.push({ role: 'assistant', content: content.length ? content : 'â€‹' });
    } else if (m.role === 'tool') {
      const last = out[out.length - 1];
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

// ---------- Ollama / local OpenAI-compatible (vLLM, LM Studio…) ----------
class OllamaProvider extends OpenAIProvider {
  constructor({ baseUrl = 'http://127.0.0.1:11434/v1' } = {}) {
    super({ apiKey: 'ollama', baseUrl, id: 'ollama', label: 'Ollama' });
  }
  capabilities() { return { toolCalls: true, reasoning: 'none', images: false }; }
  async listModels() {
    try {
      const res = await fetch(this.baseUrl.replace(/\/v1$/, '') + '/api/tags');
      if (!res.ok) throw new Error(res.status);
      const j = await res.json();
      return (j.models || []).map((m) => m.name);
    } catch { return DEFAULT_MODELS.ollama; }
  }
}

function createProvider(spec) {
  switch (spec.id) {
    case 'openai': return new OpenAIProvider({ apiKey: spec.apiKey, baseUrl: spec.baseUrl || 'https://api.openai.com/v1' });
    case 'openrouter': return new OpenAIProvider({ apiKey: spec.apiKey, baseUrl: spec.baseUrl || 'https://openrouter.ai/api/v1', id: 'openrouter', label: 'OpenRouter' });
    case 'anthropic': return new AnthropicProvider({ apiKey: spec.apiKey, baseUrl: spec.baseUrl });
    case 'ollama': return new OllamaProvider({ baseUrl: spec.baseUrl });
    default: throw new Error('unknown provider: ' + spec.id);
  }
}

module.exports = { OpenAIProvider, AnthropicProvider, OllamaProvider, createProvider, DEFAULT_MODELS };
