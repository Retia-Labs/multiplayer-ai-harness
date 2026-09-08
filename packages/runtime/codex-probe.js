'use strict';
// Where the Codex CLI actually is, what this build of it can do, and who pays for it.
//
// Split out from codex-exec.js because the acceptance proof for issue #2 has to record
// these facts even when no turn runs, and because *finding* the binary is the part that
// differs per platform: `which` does not exist on a stock Windows box, Node refuses to
// spawn a `.cmd` shim directly (EINVAL, since the argument-injection fix) and cannot see
// npm's extensionless sh shim at all (ENOENT). Resolving npm's real vendored executable
// avoids both, and running the shim under cmd.exe is the fallback.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// The CLI builds this adapter has actually been proved against, oldest first. `probe()`
// reports drift rather than failing: a newer CLI usually works, but the event vocabulary is
// not contractual, so anything outside this list is unproven rather than unsupported.
const TESTED = {
  versions: ['0.142.1', '0.153.4'],
  get newest() { return this.versions[this.versions.length - 1]; },
  events: 'codex exec --json (thread/turn/item JSONL)'
};

// `codex exec` flags this adapter depends on, and why.
const REQUIRED_FLAGS = {
  '--json': 'stream thread/turn/item events as JSONL',
  '--skip-git-repo-check': 'run in a workspace that is not a git repo',
  '--cd': 'pin the agent working root to the thread workspace',
  '--sandbox': 'set the execution-host sandbox policy'
};

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function lookupPaths(bin) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    return execFileSync(finder, [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

// npm installs the real Codex binary as an optional platform package and puts only a shim
// on PATH. Spawning that binary directly keeps us off cmd.exe and its quoting rules.
function vendoredBinary(shimPaths) {
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const shim of shimPaths) {
    const root = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex');
    for (const pkg of safeReaddir(path.join(root, 'node_modules', '@openai'))) {
      const vendor = path.join(root, 'node_modules', '@openai', pkg, 'vendor');
      for (const triple of safeReaddir(vendor)) {
        const cand = path.join(vendor, triple, 'bin', exe);
        if (fs.existsSync(cand)) return cand;
      }
    }
  }
  return null;
}

// -> { ok, bin, prefix, kind, path }; the command to run is [bin, ...prefix, ...args].
function resolveCodex(bin = process.env.CODEX_BIN || 'codex') {
  if (bin !== 'codex' && fs.existsSync(bin)) return { ok: true, kind: 'explicit', bin, prefix: [], path: bin, hits: [bin] };
  const hits = lookupPaths(bin);
  if (!hits.length) return { ok: false, kind: 'missing', reason: bin + ' is not on PATH', path: null, hits: [] };
  const native = hits.find((p) => (process.platform === 'win32' ? /\.exe$/i.test(p) : !/\.(cmd|ps1)$/i.test(p)));
  if (native) return { ok: true, kind: 'native', bin: native, prefix: [], path: native, hits };
  const vendored = vendoredBinary(hits);
  if (vendored) return { ok: true, kind: 'vendored', bin: vendored, prefix: [], path: vendored, hits };
  const shim = hits.find((p) => /\.cmd$/i.test(p)) || hits[0];
  return { ok: true, kind: 'cmd-shim', bin: process.env.COMSPEC || 'cmd.exe', prefix: ['/d', '/s', '/c', shim], path: shim, hits };
}

// A machine can carry several global npm prefixes (nvm switches, an old install left on
// PATH). PATH order then decides which Codex runs, and an upgrade can appear to do nothing
// because the newer binary is shadowed by an older one earlier on PATH.
function shadowedInstalls(resolved) {
  const seen = [];
  for (const hit of resolved.hits || []) {
    const dir = path.dirname(hit);
    const cand = vendoredBinary([hit]) || (/\.exe$/i.test(hit) ? hit : null);
    if (!cand || seen.some((s) => s.binary === cand)) continue;
    const v = version({ bin: cand, prefix: [] });
    seen.push({ prefix: dir, binary: cand, version: v });
  }
  const versions = [...new Set(seen.map((s) => s.version).filter(Boolean))];
  return { installs: seen, conflicting: versions.length > 1, versions };
}

// Runtime-owned reasoning settings must not inherit an incompatible value saved by
// another CLI/app version. This command-local override never edits provider config.
function codexConfigArgs(settings = {}) {
  const effort = settings.effort || 'medium';
  if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('codex_effort_unsupported');
  return ['-c', 'model_reasoning_effort=' + JSON.stringify(effort)];
}

function runCodex(resolved, args, { timeout = 20000 } = {}) {
  return execFileSync(resolved.bin, [...resolved.prefix, ...codexConfigArgs(), ...args], {
    encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe']
  });
}

function tryRunCodex(resolved, args, opts) {
  try { return { ok: true, out: runCodex(resolved, args, opts) }; }
  catch (err) {
    const out = String((err && ((err.stdout || '') + (err.stderr || ''))) || '');
    return { ok: false, out, error: String((err && err.message) || err) };
  }
}

function version(resolved) {
  const r = tryRunCodex(resolved, ['--version']);
  const m = r.ok && r.out.match(/([0-9]+\.[0-9]+\.[0-9]+)/);
  return m ? m[1] : null;
}

// Who the provider bills. Ask the supported CLI status command and never inspect credentials.
function authStatus(resolved, { invoke = spawnSync } = {}) {
  const result = invoke(resolved.bin, [...resolved.prefix, ...codexConfigArgs(), 'login', 'status'], {
    encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe']
  });
  // Successful login status is written to stderr by some supported CLI builds.
  const r = { ok: result.status === 0 };
  const text = ((result.stdout || '') + (result.stderr || '')).trim();
  let mode = 'unknown';
  if (/not logged in/i.test(text)) mode = 'none';
  else if (/chatgpt/i.test(text)) mode = 'chatgpt';
  else if (/api key/i.test(text)) mode = 'apikey';
  else if (/loading configuration|unknown variant|invalid.*config|failed to parse/i.test(text)) mode = 'config_error';
  else if (!r.ok) mode = 'unavailable';
  return {
    mode,
    statusLine: { none: 'Codex is not logged in.', chatgpt: 'Logged in with ChatGPT.',
      apikey: 'Logged in with an API key.', config_error: 'Codex could not load its local configuration.',
      unavailable: 'Codex account status is unavailable.', unknown: 'Codex did not identify the account mode.' }[mode],
    codexHome: codexHome(),
    // The env var is a separate authority from the stored login: record both, claim neither.
    openaiApiKeyInEnv: !!process.env.OPENAI_API_KEY
  };
}

// Models the signed-in account was actually offered, as cached by the CLI. Empty is not
// "no entitlement" - it means the cache is absent or in a shape this build did not write.
function entitledModels() {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(codexHome(), 'models_cache.json'), 'utf8'));
    const list = cache.models || cache.data || [];
    return {
      models: list.map((m) => m.id || m.slug || m.name).filter(Boolean),
      cachedForClient: cache.client_version || null,
      fetchedAt: cache.fetched_at || null
    };
  } catch { return { models: [], cachedForClient: null, fetchedAt: null }; }
}

function execCapabilities(resolved) {
  const help = tryRunCodex(resolved, ['exec', '--help']).out || '';
  const resumeHelp = tryRunCodex(resolved, ['exec', 'resume', '--help']).out || '';
  const has = (flag) => help.includes(flag);
  return {
    flags: Object.fromEntries(Object.keys(REQUIRED_FLAGS).map((f) => [f, has(f)])),
    resume: /\bresume\b/.test(help),
    // Resume takes a smaller option set than a fresh exec; passing --cd or --sandbox to it
    // is a parse error, so the adapter must fall back to the child's cwd and the policy
    // recorded on the session.
    resumeAccepts: { cd: resumeHelp.includes('--cd'), sandbox: resumeHelp.includes('--sandbox'), model: resumeHelp.includes('--model'), json: resumeHelp.includes('--json') },
    ephemeral: has('--ephemeral'),
    outputLastMessage: has('--output-last-message'),
    // Present in older builds, dropped from `exec --help` with a runtime deprecation
    // warning. The adapter must not depend on it.
    fullAuto: has('--full-auto'),
    // `codex exec` applies its own sandbox and never asks the caller: approval requests
    // exist only on the app-server protocol.
    routableApprovals: false,
    helpAvailable: help.length > 0
  };
}

function probe({ bin } = {}) {
  const resolved = resolveCodex(bin);
  if (!resolved.ok) {
    return {
      resolved: { kind: resolved.kind, path: null }, version: null, tested: TESTED,
      platform: { os: process.platform, arch: process.arch, node: process.version, release: os.release() },
      auth: null, models: null, capabilities: null,
      blockers: [{
        id: 'codex-not-found',
        detail: resolved.reason,
        alternative: 'Install the CLI (npm i -g @openai/codex) or point CODEX_BIN at the executable.'
      }]
    };
  }
  const found = version(resolved);
  const auth = authStatus(resolved);
  const models = entitledModels();
  const capabilities = execCapabilities(resolved);
  const shadowing = shadowedInstalls(resolved);
  const blockers = [];

  if (shadowing.conflicting) {
    const newest = shadowing.installs.slice().sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }))[0];
    blockers.push({
      id: 'shadowed-install',
      detail: 'PATH carries ' + shadowing.versions.join(' and ') + ' of the Codex CLI from different npm prefixes; the first one wins, so `codex update` can appear to do nothing.',
      alternative: 'Remove the stale prefix from PATH, or set CODEX_BIN=' + (newest ? newest.binary : '<newest codex binary>') + ' so the runtime pins the intended build.'
    });
  }

  for (const [flag, why] of Object.entries(REQUIRED_FLAGS)) {
    if (!capabilities.flags[flag]) {
      blockers.push({
        id: 'missing-flag:' + flag,
        detail: 'codex exec ' + flag + " is not in this build's help (needed to " + why + ').',
        alternative: 'Pin Codex ' + TESTED.newest + ', which supports it.'
      });
    }
  }
  if (auth.mode === 'none') {
    blockers.push({
      id: 'not-authenticated',
      detail: 'The Codex CLI on this execution host is not logged in.',
      alternative: 'Run `codex login` for subscription auth, or `printenv OPENAI_API_KEY | codex login --with-api-key` for API auth.'
    });
  }
  if (['config_error', 'unavailable', 'unknown'].includes(auth.mode)) blockers.push({
    id: 'account-status-' + auth.mode,
    detail: auth.statusLine,
    alternative: 'Check `codex login status` on the execution host and use a compatible CLI/configuration. This is not proof that the account is signed out.'
  });
  if (models.cachedForClient && found && models.cachedForClient !== found) {
    blockers.push({
      id: 'model-cache-drift',
      detail: "The account's model list was cached for Codex " + models.cachedForClient + ', but this host runs ' + found + '; the service rejects models this build cannot describe.',
      alternative: 'Upgrade the CLI to ' + models.cachedForClient + ', or pin a model this build can run with --model.'
    });
  }
  blockers.push({
    id: 'exec-approvals-not-routable',
    detail: '`codex exec` enforces its own sandbox and never emits an approval request, so a teammate cannot approve a command Codex itself runs.',
    alternative: 'Use a separately proven app-server configuration with host-mediated tools. Read-only prevents provider writes but does not confine provider reads to the project.'
  });

  return {
    resolved: { kind: resolved.kind, path: resolved.path, bin: resolved.bin, prefix: resolved.prefix },
    version: found,
    tested: TESTED,
    versionMatchesTested: TESTED.versions.includes(found),
    platform: { os: process.platform, arch: process.arch, node: process.version, release: os.release() },
    auth, models, capabilities, shadowing, blockers
  };
}

module.exports = {
  resolveCodex, probe, shadowedInstalls, authStatus, entitledModels, execCapabilities, version,
  runCodex, tryRunCodex, codexHome, codexConfigArgs, TESTED, REQUIRED_FLAGS
};
