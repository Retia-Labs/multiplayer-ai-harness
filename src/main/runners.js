/**
 * The desktop's side of the detached runner.
 *
 * The window no longer owns a run. It starts one if none exists, attaches to
 * whatever is already there, and otherwise behaves like any other client - it
 * submits events and reads events back. That is the change that makes a second
 * person possible: there is nothing special about being the process that
 * happened to press Start.
 *
 * This module keeps the bookkeeping (which runner serves which thread, which
 * client is attached) so main.js stays a thin IPC surface over it.
 */
const path = require('path');
const { spawn } = require('child_process');
const registry = require('../runner/registry');
const { SessionClient } = require('../net/client');

/**
 * Where the runner script really lives.
 *
 * In a packaged app the source sits inside app.asar, which is an archive: a
 * child process cannot execute a path inside it. electron-builder is told to
 * unpack src/runner (and what it requires) alongside, so the real file is at
 * the same path with app.asar.unpacked in place of app.asar. Without this the
 * app works perfectly in development and cannot start a run once installed -
 * which is exactly the class of bug that only shows up for users.
 */
const RUNNER_ENTRY = path
  .join(__dirname, '..', 'runner', 'runner.js')
  .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');

class RunnerPool {
  /**
   * @param {object} opts
   * @param {string} opts.logDir        where session logs and claims live
   * @param {string} opts.settingsFile  the settings the runner should read
   * @param {function} opts.me          () => display name for attribution
   * @param {function} opts.onLive      (threadId, agentEvent) - ephemeral, for the UI
   * @param {function} opts.onEvents    (threadId, events[]) - durable
   * @param {function} opts.onPresence  (threadId, roster[])
   */
  constructor(opts) {
    this.opts = opts;
    this.clients = new Map(); // threadId -> SessionClient
    this.starting = new Map(); // threadId -> Promise, so two callers do not both spawn
  }

  /**
   * The Electron binary cannot run a plain Node script by default: it boots as
   * Electron and ignores the file. ELECTRON_RUN_AS_NODE makes it behave as the
   * Node it already contains, which means a packaged app needs no separate Node
   * installed on the user's machine.
   */
  _spawnArgs(sessionId, workDir, token) {
    const args = [
      RUNNER_ENTRY,
      '--session', sessionId,
      '--logdir', this.opts.logDir,
      '--workdir', workDir,
      '--settings', this.opts.settingsFile,
      '--port', '0'
    ];
    if (token) args.push('--token', token);
    return args;
  }

  /** Start a runner for this session and wait for it to say where it is. */
  _spawn(sessionId, workDir, token) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, this._spawnArgs(sessionId, workDir, token), {
        // Detached is the entire point: the run must not be a child that dies
        // when this window does.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });

      let out = '';
      let err = '';
      const done = (fn, arg) => {
        clearTimeout(timer);
        child.stdout.removeAllListeners('data');
        fn(arg);
      };
      const timer = setTimeout(
        () => done(reject, new Error('Runner did not start in time. ' + err.slice(0, 500))),
        20000
      );

      child.stderr.on('data', (d) => {
        err += d.toString();
      });
      child.stdout.on('data', (d) => {
        out += d.toString();
        for (const line of out.split('\n')) {
          if (!line.trim().startsWith('{')) continue;
          try {
            const info = JSON.parse(line);
            if (!info.ready) continue;
            // Let go of it. From here the runner is nobody's child.
            child.unref();
            return done(resolve, info);
          } catch {
            /* partial line */
          }
        }
      });
      child.on('error', (e) => done(reject, e));
      child.on('exit', (code) => {
        if (code !== 0) done(reject, new Error('Runner exited with ' + code + '. ' + err.slice(0, 500)));
      });
    });
  }

  /**
   * The client for a thread, starting a runner first if nothing is serving it.
   *
   * Attaching to a runner this process did not start is the ordinary case, not
   * an edge case: it happens every time the app is reopened while work is still
   * going on.
   */
  async attach(threadId, workDir) {
    const existing = this.clients.get(threadId);
    if (existing && !existing.closed) return existing;
    if (this.starting.has(threadId)) return this.starting.get(threadId);

    const promise = (async () => {
      let claim = registry.findRunner(this.opts.logDir, threadId);
      if (!claim) claim = await this._spawn(threadId, workDir, null);

      const client = new SessionClient({
        base: claim.base || 'http://127.0.0.1:' + claim.port,
        sessionId: threadId,
        token: claim.token || null,
        as: this.opts.me()
      });
      client.on('live', (ev) => this.opts.onLive && this.opts.onLive(threadId, ev));
      client.on('events', (evs) => this.opts.onEvents && this.opts.onEvents(threadId, evs));
      client.on('presence', (p) => this.opts.onPresence && this.opts.onPresence(threadId, p));
      client.connect();
      this.clients.set(threadId, client);
      return client;
    })();

    this.starting.set(threadId, promise);
    try {
      return await promise;
    } finally {
      this.starting.delete(threadId);
    }
  }

  /** Attached client, or null. Never starts anything. */
  peek(threadId) {
    const c = this.clients.get(threadId);
    return c && !c.closed ? c : null;
  }

  isRunning(threadId) {
    return !!registry.findRunner(this.opts.logDir, threadId);
  }

  /** Sessions with a live runner right now, including ones we never started. */
  live() {
    return registry.listRunners(this.opts.logDir).map((r) => r.sessionId);
  }

  detach(threadId) {
    const c = this.clients.get(threadId);
    if (c) c.close();
    this.clients.delete(threadId);
  }

  /**
   * Stop the run itself, as opposed to merely looking away from it.
   *
   * These are genuinely different actions and the UI should keep them apart:
   * closing a window should detach, and only an explicit "stop this run" should
   * end work that may be halfway through something.
   */
  async stop(threadId) {
    this.detach(threadId);
    return registry.stopRunner(this.opts.logDir, threadId);
  }

  closeAll() {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}

module.exports = { RunnerPool };
