/**
 * The Claude backend.
 *
 * Kept in its own file rather than inside agent.js because agent.js speaks the
 * OpenAI chat-completions wire format and mixing two SDKs into one function is
 * how both end up half-wrong. The harness is meant to be bring-your-own; this
 * is the first provider that is properly its own thing.
 *
 * It drives a manual streaming loop rather than the SDK's tool runner. The
 * runner is beta and, more importantly, this loop has to do three things the
 * runner does not expose: block on a human approving a command, merge steering
 * that arrives mid-turn, and emit the app's own event shapes as it goes so the
 * UI and the session log see exactly what they saw with the other provider.
 */
const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default || AnthropicSDK;

/** The model to use when the user has not chosen one. */
const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Claude takes tools as a flat list with an input_schema, where OpenAI nests
 * them under `function` with `parameters`. Same three tools either way, so the
 * translation lives here rather than duplicating the definitions.
 */
function toolsFor(session) {
  return session.toolDefs().map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }));
}

/**
 * Rebuild the conversation in Claude's shape.
 *
 * Tool results must be their own user message containing only tool_result
 * blocks, and every tool_use has to be answered - a dropped result makes the
 * next request invalid rather than merely lossy.
 */
function historyFor(session, userText, images) {
  const messages = [];
  for (const item of session.thread.messages || []) {
    if (item.type !== 'message') continue;
    if (item.role === 'user') {
      const content = [{ type: 'text', text: item.text || '' }];
      for (const url of item.images || []) {
        const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(url);
        if (m) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: m[1], data: m[2] }
          });
        }
      }
      messages.push({ role: 'user', content });
    } else if (item.role === 'assistant' && item.text) {
      messages.push({ role: 'assistant', content: item.text });
    }
  }

  const now = [{ type: 'text', text: userText }];
  for (const url of images || []) {
    const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(url);
    if (m) now.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  messages.push({ role: 'user', content: now });
  return messages;
}

/**
 * Effort, not a token budget.
 *
 * The app's picker still says low/medium/high/xhigh because that is what it
 * meant for the other provider too; on Claude these map straight onto
 * output_config.effort, and thinking is left adaptive so the model decides how
 * much of it a given step is worth.
 */
function effortFor(session) {
  const e = String(session.effort || 'medium').toLowerCase();
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(e) ? e : 'medium';
}

async function runAnthropic(session, userText, images) {
  const settings = session.settings || {};
  const client = new Anthropic({
    apiKey: settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY,
    ...(settings.anthropicBaseUrl ? { baseURL: settings.anthropicBaseUrl } : {})
  });

  const model = settings.anthropicModel || DEFAULT_MODEL;
  const tools = toolsFor(session);
  const messages = historyFor(session, userText, images);

  for (let turn = 0; turn < 32 && !session.cancelled; turn++) {
    // Steering that arrived while the previous step ran. Merged as its own
    // user turn so the transcript says when it was said, rather than being
    // silently glued onto the original request.
    const steers = session.steerQueue.splice(0);
    for (const s of steers) {
      messages.push({ role: 'user', content: [{ type: 'text', text: s }] });
    }

    let msgItem = null;
    let thinkItem = null;

    const stream = client.messages.stream({
      model,
      max_tokens: 64000,
      system: session.systemPrompt(),
      // Adaptive lets the model decide when a step is worth thinking about.
      // `summarized` because the whole product is about showing people what
      // the agent is doing - the default omits the text entirely, which here
      // would read as a long unexplained pause.
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: effortFor(session) },
      tools,
      messages
    });

    stream.on('thinking', (delta) => {
      if (session.cancelled) return;
      if (!thinkItem) {
        thinkItem = { id: 'think_' + Date.now(), role: 'assistant', type: 'reasoning', text: '', ts: Date.now() };
        session.emit({ kind: 'item-start', item: thinkItem });
      }
      thinkItem.text += delta;
      session.emit({ kind: 'item-delta', id: thinkItem.id, delta });
    });

    stream.on('text', (delta) => {
      if (session.cancelled) return;
      if (!msgItem) {
        msgItem = { id: 'msg_' + Date.now(), role: 'assistant', type: 'message', text: '', ts: Date.now() };
        session.emit({ kind: 'item-start', item: msgItem });
      }
      msgItem.text += delta;
      session.emit({ kind: 'item-delta', id: msgItem.id, delta });
    });

    let message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      if (session.cancelled) return;
      throw err;
    }
    if (session.cancelled) return;

    if (thinkItem) session.emit({ kind: 'item-done', item: thinkItem });
    if (msgItem) session.emit({ kind: 'item-done', item: msgItem });

    if (message.usage) {
      session.usage.input += message.usage.input_tokens || 0;
      session.usage.output += message.usage.output_tokens || 0;
    }

    // A safety classifier declined. This is a 200 with a stop_reason, not an
    // exception, so it has to be checked before reading content or the turn
    // ends silently with nothing shown.
    if (message.stop_reason === 'refusal') {
      const why = (message.stop_details && message.stop_details.explanation) || 'The model declined this request.';
      session.emit({
        kind: 'item-done',
        item: { id: 'msg_' + Date.now(), role: 'assistant', type: 'message', text: why, ts: Date.now() }
      });
      return;
    }

    if (message.stop_reason === 'end_turn') return;

    // A server-side tool ran out of iterations. Echo the turn back and continue
    // rather than treating it as the end.
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }

    const calls = message.content.filter((b) => b.type === 'tool_use');
    if (!calls.length) return;

    // The assistant turn goes back verbatim, thinking blocks included: on the
    // same model they must be replayed unchanged.
    messages.push({ role: 'assistant', content: message.content });

    const results = [];
    for (const call of calls) {
      if (session.cancelled) return;
      // Inputs are parsed JSON from the SDK. Never string-match on them - the
      // escaping is not stable across models.
      const args = call.input || {};
      let text;

      if (call.name === 'shell') {
        // execCommand returns the item itself, and has already emitted the
        // approval prompt and streamed the output before it resolves.
        const item = args.command
          ? await session.execCommand(String(args.command))
          : { status: 'failed', output: 'Missing command', exitCode: -1 };
        text = JSON.stringify({
          exit_code: item.exitCode,
          status: item.status,
          output: (item.output || '').slice(0, 20000)
        });
      } else if (call.name === 'write_file') {
        const { result } = args.path != null && args.content != null
          ? await session.writeFile(String(args.path), String(args.content))
          : { result: 'Missing path/content' };
        text = result;
      } else if (call.name === 'update_plan') {
        text = Array.isArray(args.plan)
          ? session.updatePlan(args.plan, args.explanation)
          : 'Missing plan array';
      } else {
        text = 'Unknown tool: ' + call.name;
      }

      results.push({ type: 'tool_result', tool_use_id: call.id, content: text });
    }

    // Every result in one user message. Splitting them across messages quietly
    // teaches the model to stop making parallel calls.
    messages.push({ role: 'user', content: results });
  }
}

module.exports = { runAnthropic, DEFAULT_MODEL };
