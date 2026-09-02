/**
 * Tests for the Claude backend.
 *
 * These never reach the network. What is checked is the shaping - the parts
 * that are easy to get quietly wrong and expensive to discover live: that
 * tools are translated into Claude's schema, that a tool_use is always answered
 * in one user message, that a refusal is surfaced instead of ending the turn
 * silently, and that thinking blocks are replayed unchanged.
 *
 * The SDK is stubbed at the module boundary rather than mocked at the HTTP
 * layer, because the contract being verified is "what do we ask the SDK for".
 *
 * Run with: npm run test:anthropic
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SDK_ID = require.resolve('@anthropic-ai/sdk');
const PROVIDER = path.join(__dirname, '..', 'src', 'main', 'providers', 'anthropic.js');

/**
 * Install a fake SDK, load the provider fresh against it, and hand back both
 * the provider and a record of every request it made.
 */
function withFakeSdk(scriptedTurns) {
  const calls = [];
  let turn = 0;

  class FakeStream {
    constructor(params) {
      this.params = params;
      this.handlers = {};
    }
    on(evt, fn) {
      (this.handlers[evt] || (this.handlers[evt] = [])).push(fn);
      return this;
    }
    async finalMessage() {
      const scripted = scriptedTurns[turn++] || { stop_reason: 'end_turn', content: [] };
      for (const delta of scripted.thinking || []) {
        for (const fn of this.handlers.thinking || []) fn(delta);
      }
      for (const delta of scripted.text || []) {
        for (const fn of this.handlers.text || []) fn(delta);
      }
      return {
        stop_reason: scripted.stop_reason,
        stop_details: scripted.stop_details || null,
        content: scripted.content || [],
        usage: scripted.usage || { input_tokens: 10, output_tokens: 5 }
      };
    }
  }

  class FakeAnthropic {
    constructor(opts) {
      this.opts = opts;
      this.messages = {
        stream: (params) => {
          calls.push(params);
          return new FakeStream(params);
        }
      };
    }
  }

  // Swap the module in the cache, load the provider against it, restore.
  const realSdk = require.cache[SDK_ID];
  require.cache[SDK_ID] = new Module(SDK_ID, null);
  require.cache[SDK_ID].filename = SDK_ID;
  require.cache[SDK_ID].loaded = true;
  require.cache[SDK_ID].exports = FakeAnthropic;

  delete require.cache[require.resolve(PROVIDER)];
  const provider = require(PROVIDER);

  const restore = () => {
    if (realSdk) require.cache[SDK_ID] = realSdk;
    else delete require.cache[SDK_ID];
    delete require.cache[require.resolve(PROVIDER)];
  };

  return { provider, calls, restore, clientOpts: () => new FakeAnthropic({}).opts };
}

/** A stand-in for AgentSession with just the surface the provider touches. */
function fakeSession(over = {}) {
  const emitted = [];
  const ran = [];
  return {
    emitted,
    ran,
    cancelled: false,
    steerQueue: [],
    usage: { input: 0, output: 0 },
    effort: 'medium',
    mode: 'agent',
    settings: { anthropicApiKey: 'sk-ant-test' },
    thread: { messages: [] },
    emit: (e) => emitted.push(e),
    systemPrompt: () => 'You are Quorum, a coding agent.',
    toolDefs: () => [
      { type: 'function', function: { name: 'shell', description: 'Run bash.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
      { type: 'function', function: { name: 'write_file', description: 'Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
      { type: 'function', function: { name: 'update_plan', description: 'Plan.', parameters: { type: 'object', properties: { plan: { type: 'array' } }, required: ['plan'] } } }
    ],
    execCommand: async (cmd) => {
      ran.push(cmd);
      return { status: 'done', output: 'ok', exitCode: 0 };
    },
    writeFile: async (p, c) => {
      ran.push('write:' + p);
      return { result: 'Wrote ' + p + ' (' + c.length + ' bytes).' };
    },
    updatePlan: (plan) => {
      ran.push('plan:' + plan.length);
      return 'Plan updated.';
    },
    ...over
  };
}

/* ---------------- request shaping ---------------- */

test('tools are translated into Claude schema, not left in OpenAI shape', async () => {
  const { provider, calls, restore } = withFakeSdk([{ stop_reason: 'end_turn', content: [] }]);
  try {
    await provider.runAnthropic(fakeSession(), 'hello', []);
    const tools = calls[0].tools;
    assert.equal(tools.length, 3);
    assert.deepEqual(tools.map((t) => t.name), ['shell', 'write_file', 'update_plan']);
    assert.ok(tools[0].input_schema, 'input_schema, not parameters');
    assert.equal(tools[0].input_schema.properties.command.type, 'string');
    assert.ok(!('function' in tools[0]), 'nothing nested under function');
  } finally {
    restore();
  }
});

test('the request uses adaptive thinking and effort, never a token budget', async () => {
  const { provider, calls, restore } = withFakeSdk([{ stop_reason: 'end_turn', content: [] }]);
  try {
    await provider.runAnthropic(fakeSession({ effort: 'xhigh' }), 'hello', []);
    const p = calls[0];
    assert.equal(p.thinking.type, 'adaptive');
    assert.equal(p.thinking.display, 'summarized', 'the product exists to show what the agent is doing');
    assert.equal(p.output_config.effort, 'xhigh');
    assert.ok(!('budget_tokens' in p.thinking), 'budget_tokens is rejected on current models');
    assert.equal(p.model, 'claude-opus-5');
    assert.equal(p.system, 'You are Quorum, a coding agent.');
  } finally {
    restore();
  }
});

test('an unknown effort falls back rather than sending something invalid', async () => {
  const { provider, calls, restore } = withFakeSdk([{ stop_reason: 'end_turn', content: [] }]);
  try {
    await provider.runAnthropic(fakeSession({ effort: 'turbo' }), 'hi', []);
    assert.equal(calls[0].output_config.effort, 'medium');
  } finally {
    restore();
  }
});

test('images are sent as base64 blocks alongside the text', async () => {
  const { provider, calls, restore } = withFakeSdk([{ stop_reason: 'end_turn', content: [] }]);
  try {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    await provider.runAnthropic(fakeSession(), 'look at this', [png]);
    const content = calls[0].messages[0].content;
    assert.equal(content[0].type, 'text');
    assert.equal(content[1].type, 'image');
    assert.equal(content[1].source.media_type, 'image/png');
    assert.equal(content[1].source.data, 'iVBORw0KGgo=');
  } finally {
    restore();
  }
});

/* ---------------- the loop ---------------- */

test('a tool call is executed and answered in one user message', async () => {
  const { provider, calls, restore } = withFakeSdk([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'shell', input: { command: 'ls -la' } },
        { type: 'tool_use', id: 'tu_2', name: 'write_file', input: { path: 'a.txt', content: 'hi' } }
      ]
    },
    { stop_reason: 'end_turn', content: [] }
  ]);
  try {
    const s = fakeSession();
    await provider.runAnthropic(s, 'do it', []);

    assert.deepEqual(s.ran, ['ls -la', 'write:a.txt'], 'both tools actually ran');

    const second = calls[1].messages;
    const last = second[second.length - 1];
    assert.equal(last.role, 'user');
    assert.equal(last.content.length, 2, 'both results in ONE message');
    assert.deepEqual(last.content.map((c) => c.tool_use_id), ['tu_1', 'tu_2']);
    assert.ok(last.content.every((c) => c.type === 'tool_result'));
  } finally {
    restore();
  }
});

test('the assistant turn is replayed verbatim, thinking blocks included', async () => {
  const assistant = [
    { type: 'thinking', thinking: 'weighing it up', signature: 'sig-abc' },
    { type: 'tool_use', id: 'tu_1', name: 'shell', input: { command: 'pwd' } }
  ];
  const { provider, calls, restore } = withFakeSdk([
    { stop_reason: 'tool_use', content: assistant },
    { stop_reason: 'end_turn', content: [] }
  ]);
  try {
    await provider.runAnthropic(fakeSession(), 'go', []);
    const replayed = calls[1].messages.find((m) => m.role === 'assistant');
    assert.deepEqual(replayed.content, assistant, 'thinking must go back unchanged on the same model');
  } finally {
    restore();
  }
});

test('a missing argument becomes a tool result, not a crash', async () => {
  const { provider, calls, restore } = withFakeSdk([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'shell', input: {} }] },
    { stop_reason: 'end_turn', content: [] }
  ]);
  try {
    const s = fakeSession();
    await provider.runAnthropic(s, 'go', []);
    assert.equal(s.ran.length, 0, 'nothing was run');
    const result = calls[1].messages.at(-1).content[0];
    assert.equal(result.tool_use_id, 'tu_1', 'the call is still answered');
    assert.match(result.content, /Missing command/);
  } finally {
    restore();
  }
});

test('an unknown tool is still answered', async () => {
  const { provider, calls, restore } = withFakeSdk([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_9', name: 'launch_rocket', input: {} }] },
    { stop_reason: 'end_turn', content: [] }
  ]);
  try {
    await provider.runAnthropic(fakeSession(), 'go', []);
    const result = calls[1].messages.at(-1).content[0];
    assert.match(result.content, /Unknown tool: launch_rocket/);
  } finally {
    restore();
  }
});

test('pause_turn continues the loop instead of ending it', async () => {
  const { provider, calls, restore } = withFakeSdk([
    { stop_reason: 'pause_turn', content: [{ type: 'text', text: 'partway' }] },
    { stop_reason: 'end_turn', content: [] }
  ]);
  try {
    await provider.runAnthropic(fakeSession(), 'go', []);
    assert.equal(calls.length, 2, 'it asked again rather than stopping');
  } finally {
    restore();
  }
});

test('a refusal is shown to the user rather than ending in silence', async () => {
  const { provider, restore } = withFakeSdk([
    {
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'I cannot help with that.' },
      content: []
    }
  ]);
  try {
    const s = fakeSession();
    await provider.runAnthropic(s, 'do something bad', []);
    const shown = s.emitted.filter((e) => e.kind === 'item-done' && e.item.type === 'message');
    assert.equal(shown.length, 1);
    assert.match(shown[0].item.text, /cannot help/);
  } finally {
    restore();
  }
});

/* ---------------- streaming, steering, cancelling ---------------- */

test('thinking and text stream as separate items the UI already knows', async () => {
  const { provider, restore } = withFakeSdk([
    { stop_reason: 'end_turn', thinking: ['Looking ', 'at auth.js'], text: ['Found ', 'it.'], content: [] }
  ]);
  try {
    const s = fakeSession();
    await provider.runAnthropic(s, 'go', []);
    const kinds = s.emitted.map((e) => e.kind + ':' + (e.item ? e.item.type : ''));
    assert.ok(kinds.includes('item-start:reasoning'), 'reasoning item opened');
    assert.ok(kinds.includes('item-start:message'), 'message item opened');
    const reasoning = s.emitted.find((e) => e.kind === 'item-done' && e.item.type === 'reasoning');
    assert.equal(reasoning.item.text, 'Looking at auth.js');
    const msg = s.emitted.find((e) => e.kind === 'item-done' && e.item.type === 'message');
    assert.equal(msg.item.text, 'Found it.');
  } finally {
    restore();
  }
});

test('steering queued mid-run is merged as its own turn', async () => {
  const { provider, calls, restore } = withFakeSdk([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'shell', input: { command: 'ls' } }] },
    { stop_reason: 'end_turn', content: [] }
  ]);
  try {
    const s = fakeSession({
      execCommand: async function () {
        // Someone in the room steers while the command is running.
        this.steerQueue.push('use British spelling');
        return { status: 'done', output: 'ok', exitCode: 0 };
      }
    });
    s.execCommand = s.execCommand.bind(s);
    await provider.runAnthropic(s, 'go', []);

    const steer = calls[1].messages.find(
      (m) => m.role === 'user' && Array.isArray(m.content) &&
        m.content.some((c) => c.type === 'text' && c.text === 'use British spelling')
    );
    assert.ok(steer, 'the directive reached the model as its own user turn');
  } finally {
    restore();
  }
});

test('cancelling stops the loop and emits nothing further', async () => {
  const { provider, calls, restore } = withFakeSdk([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'shell', input: { command: 'ls' } }] },
    { stop_reason: 'end_turn', content: [] }
  ]);
  try {
    const s = fakeSession();
    s.cancelled = true;
    await provider.runAnthropic(s, 'go', []);
    assert.equal(calls.length, 0, 'an already-cancelled run never asks the model');
    assert.equal(s.emitted.length, 0);
  } finally {
    restore();
  }
});

test('usage accumulates across turns so cost is reportable', async () => {
  const { provider, restore } = withFakeSdk([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'shell', input: { command: 'ls' } }], usage: { input_tokens: 100, output_tokens: 20 } },
    { stop_reason: 'end_turn', content: [], usage: { input_tokens: 150, output_tokens: 30 } }
  ]);
  try {
    const s = fakeSession();
    await provider.runAnthropic(s, 'go', []);
    assert.equal(s.usage.input, 250);
    assert.equal(s.usage.output, 50);
  } finally {
    restore();
  }
});

test('read-only mode offers only the tool it should', async () => {
  const { provider, calls, restore } = withFakeSdk([{ stop_reason: 'end_turn', content: [] }]);
  try {
    await provider.runAnthropic(
      fakeSession({
        toolDefs: () => [
          { type: 'function', function: { name: 'shell', description: 'Read-only bash.', parameters: { type: 'object', properties: {}, required: [] } } }
        ]
      }),
      'look around',
      []
    );
    assert.deepEqual(calls[0].tools.map((t) => t.name), ['shell']);
  } finally {
    restore();
  }
});
