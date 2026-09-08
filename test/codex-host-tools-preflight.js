'use strict';
// Supported native binary against the production adapter's readiness boundary. No account
// credentials or model turns: the sole credential is a deliberately synthetic API key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HostToolsCodexAppServerBackend } = require('../packages/runtime/codex-app-server');
const bin = process.env.PLEXUS_CODEX_INVENTORY_BIN;
test('production API host profile preflight validates the native account without a model turn',
  { skip: !bin || process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 30000 }, async t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-native-preflight-'));
    const workspace = path.join(base, 'workspace'), authFile = path.join(base, 'synthetic-auth.json');
    fs.mkdirSync(workspace); fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'apikey',
      OPENAI_API_KEY: 'synthetic-api-fixture-not-a-real-key' }), { mode: 0o600 });
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const methods = [];
    const provider = new HostToolsCodexAppServerBackend({ bin, profileDir: path.join(base, 'profile'), authFile, authMode: 'apikey',
      spawnProcess: (command, args, options) => {
        assert.equal(options.env.OPENAI_API_KEY, undefined);
        const child = spawn(command, args, options), write = child.stdin.write.bind(child.stdin);
        child.stdin.write = (chunk, ...rest) => { const message = JSON.parse(String(chunk)); methods.push(message.method); return write(chunk, ...rest); };
        return child;
      } });
    const result = await provider.checkHost({ workspace, settings: { effort: 'medium' } });
    assert.equal(result.ready, true); assert.equal(result.version, '0.153.4');
    assert.equal(result.authMode, 'apikey');
    assert.ok(methods.includes('account/read'));
    assert.equal(methods.some(method => method?.startsWith('account/login')), false);
    assert.equal(methods.includes('turn/start'), false);
    assert.ok(methods.includes('configRequirements/read'));
    assert.ok(methods.includes('thread/start'));
  });
