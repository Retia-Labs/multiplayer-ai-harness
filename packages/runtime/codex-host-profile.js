'use strict';
// Dedicated provider state, never an authorized project. Configuration and account bytes
// are not forwarded to task events. Unexpected managed sources block this narrow mode.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { failure } = require('./codex-rpc');
const SUPPORTED_CODEX_VERSION = '0.153.4';
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
function prepareHostProfile({ profileDir, authFile, workspace, resolved, versionProbe }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw failure('codex_host_tools_platform_unproven');
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir) || typeof authFile !== 'string' || !path.isAbsolute(authFile)) throw failure('codex_host_tools_profile_required');
  let version;
  try { version = (versionProbe || (() => execFileSync(resolved.bin, [...resolved.prefix, '--version'],
    { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })))().trim(); }
  catch { throw failure('codex_unavailable'); }
  if (version !== 'codex-cli ' + SUPPORTED_CODEX_VERSION) throw failure('codex_host_tools_version_unsupported');
  if (fs.existsSync(profileDir) && fs.lstatSync(profileDir).isSymbolicLink()) throw failure('codex_host_tools_profile_invalid');
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const canonicalDir = fs.realpathSync(profileDir), project = fs.realpathSync(workspace);
  if (within(project, canonicalDir) || within(canonicalDir, project)) throw failure('codex_host_tools_profile_in_workspace');
  if ((fs.statSync(canonicalDir).mode & 0o077) !== 0) throw failure('codex_host_tools_profile_permissions');
  for (const name of ['AGENTS.md', 'AGENTS.override.md', 'instructions.md']) {
    if (fs.existsSync(path.join(canonicalDir, name))) throw failure('codex_host_tools_ambient_instructions');
  }
  const configPath = path.join(canonicalDir, 'config.toml');
  if (fs.existsSync(configPath)) {
    if (fs.lstatSync(configPath).isSymbolicLink() || fs.readFileSync(configPath, 'utf8') !== PROFILE_TOML) throw failure('codex_host_tools_profile_changed');
  } else fs.writeFileSync(configPath, PROFILE_TOML, { mode: 0o600, flag: 'wx' });
  let original;
  try { original = fs.realpathSync(authFile); if (!fs.statSync(original).isFile()) throw new Error(); }
  catch { throw failure('codex_host_tools_login_required'); }
  if (within(project, original) || within(canonicalDir, original)) throw failure('codex_host_tools_auth_location_invalid');
  const target = path.join(canonicalDir, 'auth.json');
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== original) throw failure('codex_host_tools_auth_changed');
  } else fs.symlinkSync(original, target);
  return { profileDir: canonicalDir, environment: isolatedEnvironment(canonicalDir), version: SUPPORTED_CODEX_VERSION };
}
function verifyProfileConfiguration(result, { profileDir, effort = 'medium' }) {
  if (!result || !Array.isArray(result.layers) || !result.config) throw failure('codex_host_tools_config_unverified');
  let owned = 0;
  for (const layer of result.layers) {
    if (layer.disabledReason) continue;
    const config = layer.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw failure('codex_host_tools_config_unverified');
    if (!Object.keys(config).length) continue;
    if (layer.name?.type === 'user' && layer.name.file === path.join(profileDir, 'config.toml') && !layer.name.profile && same(config, PROFILE_CONFIG)) owned++;
    else if (layer.name?.type === 'sessionFlags' && same(config, { model_reasoning_effort: effort })) continue;
    else throw failure('codex_host_tools_ambient_config');
  }
  if (owned !== 1 || result.config.model_provider !== 'openai' || result.config.web_search !== 'disabled') throw failure('codex_host_tools_config_unverified');
}
module.exports = { SUPPORTED_CODEX_VERSION, BLOCKED_FEATURES, PROFILE_CONFIG, PROFILE_TOML,
  isolatedEnvironment, prepareHostProfile, verifyProfileConfiguration };
