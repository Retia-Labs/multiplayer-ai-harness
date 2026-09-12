'use strict';
// Dedicated provider state, never an authorized project. Configuration and account bytes
// are not forwarded to task events. Unexpected managed sources block this narrow mode.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { failure } = require('./codex-rpc');
const SUPPORTED_CODEX_VERSION = '0.153.4';
const SUPPORTED_CODEX_MODEL = 'gpt-5.5';
const BLOCKED_FEATURES = ['plugins', 'apps', 'enable_mcp_apps', 'recommended_plugins', 'hooks',
  'memories', 'memory_tool', 'browser_use', 'computer_use', 'image_generation',
  'standalone_web_search', 'code_mode', 'code_mode_host', 'js_repl', 'multi_agent',
  'multi_agent_v2', 'tool_search', 'tool_suggest', 'skill_search', 'shell_tool', 'goals'];
const PROFILE_CONFIG = Object.freeze({
  model_provider: 'openai', web_search: 'disabled', project_doc_max_bytes: 0,
  cli_auth_credentials_store: 'file', forced_login_method: 'chatgpt',
  features: { ...Object.fromEntries(BLOCKED_FEATURES.map(name => [name, false])), skip_host_skill_discovery: true },
  skills: { include_instructions: false, bundled: { enabled: false } },
  orchestrator: { mcp: { enabled: false }, skills: { enabled: false } },
  apps: { _default: { enabled: false } },
  tools: { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } }
});
function tomlLines(value, prefix = '') {
  return Object.entries(value).flatMap(([key, item]) => {
    const name = prefix ? prefix + '.' + key : key;
    return item && typeof item === 'object' ? tomlLines(item, name) : [name + ' = ' + JSON.stringify(item)];
  });
}
const PROFILE_TOML = tomlLines(PROFILE_CONFIG).join('\n') + '\n';
function validateAuthMode(value = 'chatgpt') {
  if (!['chatgpt', 'apikey'].includes(value)) throw failure('codex_host_tools_auth_mode_unsupported');
  return value;
}
function profileConfig(authMode) {
  return { ...PROFILE_CONFIG, forced_login_method: validateAuthMode(authMode) === 'apikey' ? 'api' : 'chatgpt' };
}
// Local binding only: these claims are continuity hints, not authentication proof.
// The provider's account/read result independently checks the selected login mode.
function loginIdentity(authFile, authMode) {
  let auth;
  try {
    if (fs.statSync(authFile).size > 128 * 1024) throw new Error();
    auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  } catch { throw failure('codex_host_tools_login_required'); }
  const nonempty = value => typeof value === 'string' && value.length > 0;
  const detected = auth?.auth_mode || (nonempty(auth?.OPENAI_API_KEY) ? 'apikey' : auth?.tokens ? 'chatgpt' : null);
  if (detected !== authMode) throw failure('codex_host_tools_account_mode_mismatch');
  if (authMode === 'apikey') {
    if (!nonempty(auth.OPENAI_API_KEY)) throw failure('codex_host_tools_login_required');
    return auth.OPENAI_API_KEY;
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString('utf8')); }
  catch { throw failure('codex_host_tools_account_identity_unverified'); }
  const providerClaims = claims?.['https://api.openai.com/auth'];
  const account = auth.tokens.account_id || providerClaims?.chatgpt_account_id;
  const user = providerClaims?.chatgpt_user_id || providerClaims?.user_id || claims?.sub;
  if (!nonempty(account) || !nonempty(user) || !nonempty(auth.tokens.access_token) || !nonempty(auth.tokens.refresh_token)) {
    throw failure('codex_host_tools_account_identity_unverified');
  }
  return JSON.stringify([account, user]);
}
function privateDirectory(directory) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw failure('codex_host_tools_profile_invalid');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if ((fs.statSync(directory).mode & 0o077) !== 0) throw failure('codex_host_tools_profile_permissions');
  return fs.realpathSync(directory);
}
function bindingKey(profileRoot) {
  const file = path.join(profileRoot, '.account-binding-key');
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw failure('codex_host_tools_profile_invalid'); }
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size !== 32) throw failure('codex_host_tools_profile_invalid');
  return fs.readFileSync(file);
}
function accountBinding(profile) {
  return crypto.createHmac('sha256', bindingKey(profile.profileRoot))
    .update(JSON.stringify(['plexus.codex.account-binding.v1', profile.authMode, profile.authFile,
      loginIdentity(profile.authFile, profile.authMode)])).digest('hex');
}
function verifyHostAccount(profile) {
  try {
    const target = path.join(profile.profileDir, 'auth.json');
    if (!fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== profile.authFile ||
        accountBinding(profile) !== profile.accountBinding) throw new Error();
  } catch { throw failure('codex_host_tools_account_changed'); }
}
const canonical = value => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
function same(a, b) { return canonical(a) === canonical(b); }
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function isolatedEnvironment(profileDir) {
  const environment = { CODEX_HOME: profileDir, RUST_LOG: 'error' };
  // Preserve OS/runtime inputs, not arbitrary provider/tool environment overrides.
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}
function prepareHostProfile({ profileDir, authFile, authMode, workspace, resolved, versionProbe }) {
  authMode = validateAuthMode(authMode);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw failure('codex_host_tools_platform_unproven');
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir) || typeof authFile !== 'string' || !path.isAbsolute(authFile)) throw failure('codex_host_tools_profile_required');
  let version;
  try { version = (versionProbe || (() => execFileSync(resolved.bin, [...resolved.prefix, '--version'],
    { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })))().trim(); }
  catch { throw failure('codex_unavailable'); }
  if (version !== 'codex-cli ' + SUPPORTED_CODEX_VERSION) throw failure('codex_host_tools_version_unsupported');
  const profileRoot = privateDirectory(profileDir), project = fs.realpathSync(workspace);
  if (within(project, profileRoot) || within(profileRoot, project)) throw failure('codex_host_tools_profile_in_workspace');
  for (const name of ['AGENTS.md', 'AGENTS.override.md', 'instructions.md']) {
    if (fs.existsSync(path.join(profileRoot, name))) throw failure('codex_host_tools_ambient_instructions');
  }
  // Keep earlier ChatGPT-only profiles intact. Unbound old thread handles cannot resume
  // in a new account profile; they require an explicit fresh task/recovery choice.
  const legacyConfig = path.join(profileRoot, 'config.toml');
  if (fs.existsSync(legacyConfig) && (fs.lstatSync(legacyConfig).isSymbolicLink() || fs.readFileSync(legacyConfig, 'utf8') !== PROFILE_TOML)) throw failure('codex_host_tools_profile_changed');
  let original;
  try { original = fs.realpathSync(authFile); if (!fs.statSync(original).isFile()) throw new Error(); }
  catch { throw failure('codex_host_tools_login_required'); }
  if (within(project, original) || within(profileRoot, original)) throw failure('codex_host_tools_auth_location_invalid');
  const profile = { profileRoot, authMode, authFile: original };
  profile.accountBinding = accountBinding(profile);
  const modeDir = privateDirectory(path.join(profileRoot, authMode));
  const canonicalDir = privateDirectory(path.join(modeDir, profile.accountBinding));
  for (const directory of [modeDir, canonicalDir]) for (const name of ['AGENTS.md', 'AGENTS.override.md', 'instructions.md']) {
    if (fs.existsSync(path.join(directory, name))) throw failure('codex_host_tools_ambient_instructions');
  }
  const configText = tomlLines(profileConfig(authMode)).join('\n') + '\n';
  const configPath = path.join(canonicalDir, 'config.toml');
  if (fs.existsSync(configPath)) {
    if (fs.lstatSync(configPath).isSymbolicLink() || fs.readFileSync(configPath, 'utf8') !== configText) throw failure('codex_host_tools_profile_changed');
  } else fs.writeFileSync(configPath, configText, { mode: 0o600, flag: 'wx' });
  const target = path.join(canonicalDir, 'auth.json');
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== original) throw failure('codex_host_tools_auth_changed');
  } else fs.symlinkSync(original, target);
  return { ...profile, profileDir: canonicalDir, environment: isolatedEnvironment(canonicalDir), version: SUPPORTED_CODEX_VERSION };
}
function verifyProfileConfiguration(result, { profileDir, authMode, effort = 'medium' }) {
  if (!result || !Array.isArray(result.layers) || !result.config) throw failure('codex_host_tools_config_unverified');
  let owned = 0;
  for (const layer of result.layers) {
    if (layer.disabledReason) continue;
    const config = layer.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw failure('codex_host_tools_config_unverified');
    if (!Object.keys(config).length) continue;
    if (layer.name?.type === 'user' && layer.name.file === path.join(profileDir, 'config.toml') && !layer.name.profile && same(config, profileConfig(authMode))) owned++;
    else if (layer.name?.type === 'sessionFlags' && same(config, { model_reasoning_effort: effort })) continue;
    else throw failure('codex_host_tools_ambient_config');
  }
  if (owned !== 1 || result.config.model_provider !== 'openai' || result.config.web_search !== 'disabled') throw failure('codex_host_tools_config_unverified');
}
module.exports = { SUPPORTED_CODEX_VERSION, SUPPORTED_CODEX_MODEL, BLOCKED_FEATURES, PROFILE_CONFIG, PROFILE_TOML,
  validateAuthMode, profileConfig, isolatedEnvironment, prepareHostProfile, verifyProfileConfiguration, verifyHostAccount };
