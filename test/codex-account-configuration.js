'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Runtime, parseArgs, localCodexOptIn } = require('../packages/runtime');
const { TurnSession } = require('../packages/runtime/session');

test('legacy runtime configuration requires fresh local consent before any provider process or model work', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-legacy-consent-'));
  const runtime = new Runtime({ dataDir: base, codexHostTools: {
    bin: process.execPath, authFile: path.join(base, 'unused-local-auth.json') } });
  t.after(async () => { await runtime.stop(); fs.rmSync(base, { recursive: true, force: true }); });
  const descriptor = runtime.providerList().find(provider => provider.id === 'codex-cli');
  assert.equal(descriptor.configured, false);
  assert.match(descriptor.reason, /local.*setup|reauthoriz/i);
  const provider = runtime.provider('codex-cli'); let spawns = 0;
  provider.spawnProcess = () => { spawns++; throw new Error('must not spawn'); };
  const session = new TurnSession({ thread: { id: 'legacy-task', cwd: base }, provider,
    input: [{ type: 'text', text: 'synthetic task' }], settings: {}, by: { userId: 'owner' }, emit() {} });
  const result = await session.run();
  assert.equal(result.error.message, 'codex_host_tools_account_reauthorization_required');
  assert.equal(spawns, 0);
});

test('local runtime configuration preserves explicit API mode and defaults old configuration to ChatGPT', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-api-config-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const [input, expected] of [[undefined, 'chatgpt'], ['apikey', 'apikey']]) {
    const runtime = new Runtime({ dataDir: path.join(base, expected), codexHostTools: {
      bin: process.execPath, authFile: path.join(base, 'synthetic-auth.json'), ...(input ? { authMode: input } : {}) } });
    t.after(() => runtime.stop());
    assert.equal(runtime.provider('codex-cli').authMode, expected);
    assert.equal(runtime.codexHostTools.authMode, expected);
  }
  assert.throws(() => new Runtime({ dataDir: path.join(base, 'invalid'), codexHostTools: {
    bin: process.execPath, authFile: path.join(base, 'synthetic-auth.json'), authMode: 'api' } }), /codex_host_tools_auth_mode_unsupported/);
});
test('CLI opt-in validates detected local account mode and refuses explicit mismatches', () => {
  const resolved = { ok: true, path: process.execPath }, authFile = path.resolve('synthetic-auth.json');
  const args = parseArgs(['--codex-host-tools', '--codex-auth-mode', 'apikey']);
  assert.equal(args.codexAuthMode, 'apikey');
  assert.equal(localCodexOptIn({ resolved, authFile, detectedMode: 'apikey', authMode: args.codexAuthMode }).authMode, 'apikey');
  assert.equal(localCodexOptIn({ resolved, authFile, detectedMode: 'chatgpt' }).authMode, 'chatgpt');
  assert.throws(() => localCodexOptIn({ resolved, authFile, detectedMode: 'chatgpt', authMode: 'apikey' }), /codex_host_tools_account_mode_mismatch/);
  assert.throws(() => localCodexOptIn({ resolved, authFile, detectedMode: 'none' }), /codex_host_tools_auth_mode_unsupported/);
  assert.throws(() => parseArgs(['--codex-host-tools', '--codex-auth-mode', 'api']), /codex_host_tools_auth_mode_unsupported/);
  assert.throws(() => parseArgs(['--codex-auth-mode', 'apikey']), /codex_host_tools_opt_in_required/);
});
