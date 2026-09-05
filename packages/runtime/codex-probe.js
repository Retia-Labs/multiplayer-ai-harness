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
const { execFileSync } = require('child_process');

// The CLI this adapter has actually been proved against. `probe()` reports drift rather
// than failing: a newer CLI usually works, but the event vocabulary is not contractual.
const TESTED = { version: '0.142.1', events: 'codex exec --json (thread/turn/item JSONL)' };

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
  if (bin !== 'codex' && fs.existsSync(bin)) return { ok: true, kind: 'explicit', bin, prefix: [], path: bin };
  const hits = lookupPaths(bin);
  if (!hits.length) return { ok: false, kind: 'missing', reason: bin + ' is not on PATH', path: null };
  const native = hits.find((p) => (process.platform === 'win32' ? /\.exe$/i.test(p) : !/\.(cmd|ps1)$/i.test(p)));
  if (native) return { ok: true, kind: 'native', bin: native, prefix: [], path: native };
  const vendored = vendoredBinary(hits);
  if (vendored) return { ok: true, kind: 'vendored', bin: vendored, prefix: [], path: vendored };
  const shim = hits.find((p) => /\.cmd$/i.test(p)) || hits[0];
  return { ok: true, kind: 'cmd-shim', bin: process.env.COMSPEC || 'cmd.exe', prefix: ['/d', '/s', '/c', shim], path: shim };
}

function runCodex(resolved, args, { timeout = 20000 } = {}) {
  return execFileSync(resolved.bin, [...resolved.prefix, ...args], {
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

// Who the provider bills. `codex login status` is the supported question; auth.json is an
// implementation detail we read only to name the mode when the CLI answers ambiguously.
function authStatus(resolved) {
  const r = tryRunCodex(resolved, ['login', 'status']);
  const text = (r.out || '').trim();
  let mode = 'unknown';
  if (/not logged in/i.test(text)) mode = 'none';
  else if (/chatgpt/i.test(text)) mode = 'chatgpt';
  else if (/api key/i.test(text)) mode = 'apikey';
  else if (!r.ok) mode = 'none';
  if (mode === 'unknown') {
    try { mode = JSON.parse(fs.readFileSync(path.join(codexHome(), 'auth.json'), 'utf8')).auth_mode || 'unknown'; } catch {}
  }
  return {
    mode,
    statusLine: text.split(/\r?\n/)[0] || null,
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
    // Present in older builds, dropped from `exec --help` in 0.142.x with a runtime
    // deprecation warning. The adapter must not depend on it.
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
  const blockers = [];

  for (const [flag, why] of Object.entries(REQUIRED_FLAGS)) {
    if (!capabilities.flags[flag]) {
      blockers.push({
        id: 'missing-flag:' + flag,
        detail: 'codex exec ' + flag + " is not in this build's help (needed to " + why + ').',
        alternative: 'Pin Codex ' + TESTED.version + ', which supports it.'
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
    alternative: 'Drive Codex through `codex app-server`, whose protocol carries CommandExecutionRequestApproval / FileChangeRequestApproval / ApplyPatchApproval with accept | acceptForSession | decline | cancel decisions (experimental in 0.142.x). Until then run --sandbox read-only so nothing escapes without the harness.'
  });

  return {
    resolved: { kind: resolved.kind, path: resolved.path, bin: resolved.bin, prefix: resolved.prefix },
    version: found,
    tested: TESTED,
    versionMatchesTested: found === TESTED.version,
    platform: { os: process.platform, arch: process.arch, node: process.version, release: os.release() },
    auth, models, capabilities, blockers
  };
}

module.exports = {
  resolveCodex, probe, authStatus, entitledModels, execCapabilities, version,
  runCodex, tryRunCodex, codexHome, TESTED, REQUIRED_FLAGS
};
