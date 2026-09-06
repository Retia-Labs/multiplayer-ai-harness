'use strict';
// Command executors: where an agent's shell commands actually run.
//  - LocalExecutor: bash in the thread's workspace (worktree) on this machine.
//  - CrabboxExecutor: delegates to the `crabbox` CLI (github.com/openclaw/crabbox),
//    which leases a remote runner, syncs the working tree, runs the command there,
//    and streams output back. Crabbox deliberately owns only remote execution and
//    evidence — the harness keeps the agent loop, credentials and decisions.
const { spawn, execFileSync } = require('child_process');

const MAX_OUTPUT = 20000;

function runProcess(bin, args, { cwd, env, onOutput, timeoutMs = 120000, onChild }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', ...(env || {}) } });
    } catch (err) {
      return resolve({ code: -1, out: String(err) });
    }
    if (onChild) onChild(child);
    let out = '';
    const onData = (d) => {
      const s = d.toString();
      if (out.length < MAX_OUTPUT) {
        const delta = s.slice(0, MAX_OUTPUT - out.length);
        out += delta;
        if (onOutput) onOutput(delta);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, out }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: String(err) }); });
  });
}

class LocalExecutor {
  get id() { return 'local'; }
  describe() { return { id: 'local', label: 'Structured workspace tools', shell: false }; }
  async run() {
    return { code: -1, out: 'Arbitrary local shell is unavailable without a proven project-confined sandbox.' };
  }
}

class CrabboxExecutor {
  constructor({ bin = 'crabbox', extraArgs = [] } = {}) {
    this.bin = bin;
    this.extraArgs = extraArgs; // e.g. ['--provider', 'hetzner', '--keep']
  }
  get id() { return 'crabbox'; }
  static available(bin = 'crabbox') {
    try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
  }
  describe() { return { id: 'crabbox', label: 'Crabbox remote runner', available: CrabboxExecutor.available(this.bin) }; }
  run(command, opts) {
    // `crabbox run -- <cmd>` leases (or reuses) a runner, rsyncs the dirty checkout,
    // executes remotely, streams output, releases. Evidence lands in crabbox's run history.
    return runProcess(this.bin, ['run', ...this.extraArgs, '--', 'bash', '-lc', command], { ...opts, timeoutMs: 15 * 60000 });
  }
}

function createExecutor(spec) {
  if (!spec || spec === 'local') return new LocalExecutor();
  if (spec === 'crabbox' || (spec && spec.id === 'crabbox')) return new CrabboxExecutor(typeof spec === 'object' ? spec : {});
  throw new Error('unknown executor: ' + JSON.stringify(spec));
}

module.exports = { LocalExecutor, CrabboxExecutor, createExecutor, runProcess };
