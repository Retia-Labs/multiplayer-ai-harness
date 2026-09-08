'use strict';
// Exercise the official binary against a loopback-only synthetic Responses server.
// No real credentials, model requests, global config writes, or model sampling.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn, execFileSync } = require('node:child_process');
const { CodexRpc } = require('../packages/runtime/codex-rpc');

const binary = process.env.PLEXUS_CODEX_INVENTORY_BIN;
const blockedFeatures = ['plugins', 'apps', 'enable_mcp_apps', 'recommended_plugins', 'hooks',
  'memories', 'memory_tool', 'browser_use', 'computer_use', 'image_generation',
  'standalone_web_search', 'code_mode', 'code_mode_host', 'js_repl', 'multi_agent',
  'multi_agent_v2', 'tool_search', 'tool_suggest', 'skill_search', 'shell_tool', 'goals'];

function candidateConfig(port) {
  return `model = "gpt-5.4-mini"
model_provider = "fixture"
web_search = "disabled"
project_doc_max_bytes = 0
cli_auth_credentials_store = "file"
[model_providers.fixture]
name = "Local synthetic inventory fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[features]
${blockedFeatures.map(name => `${name} = false`).join('\n')}
skip_host_skill_discovery = true
[skills]
include_instructions = false
[skills.bundled]
enabled = false
[orchestrator.mcp]
enabled = false
[orchestrator.skills]
enabled = false
[apps._default]
enabled = false
[tools.update_plan]
enabled = false
[tools.experimental_request_user_input]
enabled = false
`;
}

test('Codex 0.153.4 no-environment exposes only host tools with isolated sources',
  { skip: !binary, timeout: 45000 }, async (t) => {
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(version, 'codex-cli 0.153.4');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'plexus-codex-inventory-'));
  const profile = path.join(base, 'profile');
  await fs.mkdir(profile, { mode: 0o700 });
  const canary = 'PLEXUS_AMBIENT_INSTRUCTION_MUST_NOT_LOAD_84741';
  await fs.writeFile(path.join(base, 'AGENTS.md'), canary);
  await fs.mkdir(path.join(profile, 'skills', 'canary'), { recursive: true });
  await fs.writeFile(path.join(profile, 'skills', 'canary', 'SKILL.md'),
    `---\nname: canary\ndescription: ${canary}\n---\n${canary}\n`);

  const captured = [];
  let received;
  const firstRequest = new Promise(resolve => { received = resolve; });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
    if (req.headers['content-encoding'] === 'zstd') body = zlib.zstdDecompressSync(body);
    let parsed;
    try { parsed = JSON.parse(body.toString()); } catch { parsed = { raw: body.toString() }; }
    captured.push({ url: req.url, body: parsed });
    received();
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Synthetic fixture stops after inventory capture' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const config = candidateConfig(server.address().port);
  await fs.writeFile(path.join(profile, 'config.toml'), config, { mode: 0o600 });
  const child = spawn(binary, ['-c', 'model_reasoning_effort="medium"', 'app-server'], {
    cwd: profile,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      CODEX_HOME: profile, RUST_LOG: 'error' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const notifications = [];
  const rpc = new CodexRpc(child, { timeoutMs: 15000,
    onNotification: message => notifications.push(message), onRequest: message => rpc.refuse(message.id) });
  t.after(async () => {
    rpc.close();
    const ended = new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', resolve);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
    await ended;
    clearTimeout(timer);
    await fs.rm(base, { recursive: true, force: true });
  });
  await rpc.call('initialize', { clientInfo: { name: 'plexus_inventory_fixture', version: '0.1.0' },
    capabilities: { experimentalApi: true } });
  rpc.notify('initialized');
  const read = await rpc.call('config/read', { includeLayers: true, cwd: profile });
  const requirements = await rpc.call('configRequirements/read', {});
  assert.deepEqual(requirements, { requirements: null }, 'managed requirements need a separate compatibility proof');
  const configFile = await fs.realpath(path.join(profile, 'config.toml'));
  for (const layer of read.layers) {
    if (layer.name.type === 'user' && layer.name.file === configFile) continue;
    if (layer.name.type === 'sessionFlags') {
      assert.deepEqual(layer.config, { model_reasoning_effort: 'medium' });
    } else assert.equal(Object.keys(layer.config).length, 0, 'ambient configuration must be rejected before a turn');
  }
  const mcp = await rpc.call('mcpServerStatus/list', {});
  assert.deepEqual(mcp, { data: [], nextCursor: null });
  const names = ['plexus_read_file', 'plexus_list_files', 'plexus_write_file', 'plexus_remove_path'];
  const dynamicTools = names.map(name => ({ name, description: 'Host-authorized fixture operation',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }));
  // A zero project-document limit is not a global-instruction suppression switch.
  // The production preflight must reject this response before any turn starts.
  await fs.writeFile(path.join(profile, 'AGENTS.md'), canary);
  const contaminated = await rpc.call('thread/start', { cwd: profile, environments: [], dynamicTools,
    model: 'gpt-5.4-mini', modelProvider: 'fixture', approvalPolicy: 'never', sandbox: 'read-only' });
  assert.equal(contaminated.instructionSources.length, 1);
  assert.equal(captured.length, 0);
  await fs.rm(path.join(profile, 'AGENTS.md'));
  const started = await rpc.call('thread/start', { cwd: profile, environments: [], dynamicTools,
    model: 'gpt-5.4-mini', modelProvider: 'fixture', approvalPolicy: 'never', sandbox: 'read-only',
    developerInstructions: 'Only the explicitly provided Plexus host tools are authorized.' });
  assert.deepEqual(started.instructionSources, []);
  await rpc.call('turn/start', { threadId: started.thread.id, environments: [],
    input: [{ type: 'text', text: 'Synthetic inventory capture only.', text_elements: [] }] });
  await Promise.race([firstRequest, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`No loopback model request: ${stderr.slice(-1000)}`)), 15000);
    timer.unref();
  })]);
  const request = captured.find(entry => entry.url.endsWith('/responses'));
  assert.ok(request, 'a synthetic Responses request must be captured');
  const tools = request.body.tools.map(tool => tool.name || tool.type).sort();
  const evidence = { version, toolNames: tools, instructionSources: started.instructionSources,
    ambientCanaryPresent: JSON.stringify(request.body).includes(canary),
    configLayers: read.layers, config: read.config, requirements, mcp, threadStart: started,
    notifications: notifications.map(message => message.method), stderrPresent: !!stderr };
  if (process.env.PLEXUS_CODEX_INVENTORY_REPORT) {
    await fs.writeFile(process.env.PLEXUS_CODEX_INVENTORY_REPORT, JSON.stringify(evidence, null, 2));
  }
  assert.deepEqual(tools, [...names].sort());
  assert.equal(evidence.ambientCanaryPresent, false);
});

test('Codex configuration can be inspected before configured MCP starts',
  { skip: !binary, timeout: 20000 }, async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'plexus-codex-mcp-preflight-'));
  const marker = path.join(base, 'mcp-started');
  const script = path.join(base, 'mcp-canary.cjs');
  await fs.writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`);
  await fs.writeFile(path.join(base, 'config.toml'), candidateConfig(1) +
    `\n[mcp_servers.unexpected]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(script)}]\n`);
  const child = spawn(binary, ['app-server'], { cwd: base,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CODEX_HOME: base, RUST_LOG: 'error' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = new CodexRpc(child, { timeoutMs: 10000 });
  try {
    await rpc.call('initialize', { clientInfo: { name: 'plexus_inventory_fixture', version: '0.1.0' },
      capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    const read = await rpc.call('config/read', { includeLayers: true, cwd: base });
    assert.ok(read.layers.some(layer => layer.config?.mcp_servers?.unexpected));
    // Config inspection is where the production adapter rejects this source.
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  } finally {
    rpc.close();
    const ended = new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', resolve);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
    await ended;
    clearTimeout(timer);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    await fs.rm(base, { recursive: true, force: true });
  }
});

module.exports = { candidateConfig };
