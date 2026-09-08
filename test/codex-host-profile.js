'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareHostProfile } = require('../packages/runtime/codex-host-profile');
const supported = process.platform === 'darwin' && process.arch === 'arm64';
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-account-profile-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'workspace'), authFile = path.join(base, 'synthetic-auth.json');
  fs.mkdirSync(workspace);
  const write = auth => fs.writeFileSync(authFile, JSON.stringify(auth), { mode: 0o600 });
  const prepare = authMode => prepareHostProfile({ profileDir: path.join(base, 'profile'), authFile, workspace,
    authMode, resolved: { bin: process.execPath, prefix: [] }, versionProbe: () => 'codex-cli 0.153.4' });
  return { base, authFile, write, prepare };
}
function chatgpt(account = 'account-one', user = 'user-one', refresh = 'fixture-refresh') {
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_user_id: user } };
  return { auth_mode: 'chatgpt', tokens: { account_id: account, id_token: 'e30.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture',
    access_token: 'fixture-access-' + refresh, refresh_token: refresh } };
}
test('explicit API mode uses its own private profile and only a link to the authorized login', { skip: !supported }, t => {
  const f = fixture(t); f.write({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-api-key-one' });
  const api = f.prepare('apikey');
  assert.equal(api.authMode, 'apikey');
  assert.match(fs.readFileSync(path.join(api.profileDir, 'config.toml'), 'utf8'), /forced_login_method = "api"/);
  assert.equal(fs.realpathSync(path.join(api.profileDir, 'auth.json')), fs.realpathSync(f.authFile));
  assert.equal(fs.lstatSync(path.join(api.profileDir, 'auth.json')).isSymbolicLink(), true);
  assert.match(api.accountBinding, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(api).includes('synthetic-api-key-one'), false);
  f.write(chatgpt()); const subscription = f.prepare();
  assert.equal(subscription.authMode, 'chatgpt');
  assert.notEqual(subscription.profileDir, api.profileDir);
  assert.notEqual(subscription.accountBinding, api.accountBinding);
});
test('token refresh preserves identity but API-key and ChatGPT user/account switches isolate history', { skip: !supported }, t => {
  const f = fixture(t); f.write(chatgpt()); const first = f.prepare();
  f.write(chatgpt('account-one', 'user-one', 'fixture-refreshed')); const refreshed = f.prepare();
  assert.equal(refreshed.accountBinding, first.accountBinding);
  assert.equal(refreshed.profileDir, first.profileDir);
  for (const auth of [chatgpt('account-two'), chatgpt('account-one', 'user-two')]) {
    f.write(auth); assert.notEqual(f.prepare().accountBinding, first.accountBinding);
  }
  f.write({ auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-api-one' }); const api = f.prepare('apikey');
  f.write({ auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-api-two' });
  assert.notEqual(f.prepare('apikey').profileDir, api.profileDir);
});
test('unsupported or mismatched modes never silently select a different account', { skip: !supported }, t => {
  const f = fixture(t); f.write({ auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-only' });
  assert.throws(() => f.prepare(), /codex_host_tools_account_mode_mismatch/);
  for (const mode of ['api', 'apiKey', '', null, 'chatgptAuthTokens']) {
    assert.throws(() => f.prepare(mode), /codex_host_tools_auth_mode_unsupported/);
  }
  f.write({}); assert.throws(() => f.prepare('apikey'), /codex_host_tools_account_mode_mismatch/);
  f.write({ auth_mode: 'chatgpt', tokens: {} });
  assert.throws(() => f.prepare(), /codex_host_tools_account_identity_unverified/);
});
