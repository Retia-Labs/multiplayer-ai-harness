/**
 * The runner: the process that actually owns a run.
 *
 * Before this existed, a run was an object inside the Electron main process.
 * Quitting the app destroyed it mid-flight, and there was no address anyone
 * else could point at, so "watch my agent work" was not a thing that could be
 * built - there was nothing to watch.
 *
 * Now the run lives here, in its own detached process, and the window is
 * merely one of its readers. Everything the run does becomes an event in the
 * log; everything anyone wants the run to do arrives as an event in the log.
 * The runner is the single writer for its session, which is what makes the
 * ordering trustworthy.
 *
 * Started as:
 *   node runner.js --session <id> --workdir <dir> --logdir <dir> \
 *                  --settings <file> --port <n> --token <t>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { EventLog } = require('../main/log');
const { Recorder } = require('../main/recorder');
const kernel = require('../main/kernel');
const { AgentSession } = require('../main/agent');
const { createSessionServer } = require('../net/server');

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SESSION = arg('session');
const WORKDIR = arg('workdir', process.cwd());
const LOGDIR = arg('logdir');
const SETTINGS_FILE = arg('settings');
const PORT = Number(arg('port', '0')) || 0;
const TOKEN = arg('token', null);
const HOST = arg('host', '127.0.0.1');

if (!SESSION || !LOGDIR) {
  console.error('runner: --session and --logdir are required');
  process.exit(2);
}

const log = new EventLog(LOGDIR);

function settings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Where a runner announces itself.
 *
 * The desktop needs to find runs it did not start - after a restart, or after
 * a crash - and a pid file is the oldest, most boring way to do that. It is
 * written before the server is announced ready and removed on clean exit; a
 * stale one is detected by checking whether the pid is actually alive.
 */
const pidFile = path.join(LOGDIR, SESSION + '.runner.json');

function announce(extra) {
  const info = {
    sessionId: SESSION,
    pid: process.pid,
    workDir: WORKDIR,
    host: HOST,
    startedAt: new Date().toISOString(),
    ...extra
  };
  fs.writeFileSync(pidFile, JSON.stringify(info, null, 2));
  return info;
}

function unannounce() {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    /* already gone */
  }
}

/* ------------------------------------------------------------------ *
 * State the runner keeps about its own run
 * ------------------------------------------------------------------ */

let session = null;      // the live AgentSession, when a turn is running
let recorder = null;
let cursor = 0;          // how far through the log we have reacted
let stopping = false;
const answeredGates = new Set();
const appliedDirectives = new Set();

let share = null; // the room, once this run is shared

/**
 * What people in a room are allowed to ask a run to do.
 *
 * An intent arrives from the relay as a request, and is re-issued here as an
 * append this runner owns and sequences. Anything not on this list is dropped:
 * the room is a way to take part in a run, not a way to write arbitrary rows
 * into somebody else's record.
 */
const ALLOWED_INTENTS = new Set([
  'note.posted',       // chat
  'directive.sent',    // steering
  'gate.resolved',     // approvals, from anywhere
  'turn.started',      // asking for something new
  'presence.seen',
  'run.paused',
  'run.resumed',
  'run.handed_off',
  'step.claimed',
  'step.released'
]);

const api = createSessionServer({
  log,
  token: TOKEN,
  onEvents: (_id, written) => {
    react(written);
    if (share) share.flush();
  },
  describe: () => ({
    pid: process.pid,
    workDir: WORKDIR,
    running: !!(session && session.running),
    agent: 'quorum',
    shared: share ? { code: share.code, relay: share.relay } : null
  }),
  routes: {
    /* Open a room for this run and start mirroring into it. */
    'POST share': async ({ req, res, send: reply, readBody: read }) => {
      const body = await read(req);
      if (share) {
        return reply(res, 200, { code: share.code, joinUrl: share.relay + '/r/' + share.code, already: true });
      }
      const { Share } = require('./share');
      share = new Share({
        relay: body.relay,
        sessionId: SESSION,
        title: body.title || '',
        readEvents: (since) => log.read(SESSION).filter((e) => e.seq > since),
        onIntent: (intent) => {
          if (!ALLOWED_INTENTS.has(intent.kind)) return;
          api.append(SESSION, {
            kind: intent.kind,
            actor: intent.actor,
            payload: intent.payload || {},
            // The relay's intent id makes a redelivered intent harmless: it
            // becomes the same event, not a second one.
            clientId: 'relay-' + share.code + '-' + intent.id
          });
        }
      });
      try {
        const opened = await share.open();
        api.append(SESSION, {
          kind: 'note.posted',
          actor: 'system',
          payload: { text: 'Run shared. Anyone with code ' + opened.code + ' can join.' }
        });
        return reply(res, 200, opened);
      } catch (err) {
        share = null;
        return reply(res, 502, { error: String((err && err.message) || err) });
      }
    },

    /* Stop sharing. The run continues; the room simply closes. */
    'POST unshare': async ({ res, send: reply }) => {
      if (!share) return reply(res, 200, { ok: true, wasShared: false });
      const code = share.code;
      await share.close();
      share = null;
      api.append(SESSION, {
        kind: 'note.posted',
        actor: 'system',
        payload: { text: 'Room ' + code + ' closed. The run continues.' }
      });
      return reply(res, 200, { ok: true, wasShared: true });
    }
  }
});

/**
 * React to events other people wrote.
 *
 * This is the whole inbound half of multiplayer. A directive typed by someone
 * on another machine, and a gate answered from a phone, arrive here as exactly
 * the same kind of thing: a row in the log the runner had not seen yet.
 */
function react(written) {
  for (const e of written) {
    if (e.seq <= cursor) continue;
    cursor = e.seq;

    if (e.kind === 'directive.sent' && !appliedDirectives.has(e.payload.id)) {
      appliedDirectives.add(e.payload.id);
      if (session && session.running) {
        session.enqueueSteer(e.payload.text || '');
        api.append(SESSION, {
          kind: 'directive.applied',
          actor: 'agent:quorum',
          payload: { id: e.payload.id }
        });
      }
      continue;
    }

    if (e.kind === 'gate.resolved' && !answeredGates.has(e.payload.id)) {
      answeredGates.add(e.payload.id);
      // The reducer decides whether this answer counts (who may answer, first
      // answer wins). Asking it rather than reimplementing the rule here is
      // what keeps every client's idea of the gate identical to the runner's.
      const state = kernel.reduce(SESSION, log.read(SESSION));
      const gate = state.gates.find((g) => g.id === e.payload.id);
      if (gate && gate.resolvedAt && gate.callId && session) {
        session.resolveApproval(gate.callId, gate.approved);
      }
      continue;
    }

    if (e.kind === 'turn.started' && e.actor.startsWith('human:') && !e.payload.local) {
      // Someone in the room asked for something. If nothing is running, this
      // runner is the one that has to do it.
      if (!session || !session.running) startTurn(e.payload.text || '', e.payload.turnId);
      continue;
    }

    if (e.kind === 'run.finished' && e.actor === 'system') stop('asked to stop');
  }
}

/* ------------------------------------------------------------------ *
 * Running a turn
 * ------------------------------------------------------------------ */

function startTurn(text, turnId) {
  const s = settings();
  const thread = {
    id: SESSION,
    workDir: WORKDIR,
    projectDir: WORKDIR,
    messages: historyFromLog()
  };

  recorder = recorder || new Recorder({
    log,
    sessionId: SESSION,
    agentName: 'quorum',
    humanName: s.displayName || os.userInfo().username || 'me'
  });
  recorder.turnId = turnId || recorder.turnId;

  session = new AgentSession({
    thread,
    settings: s,
    model: s.model,
    mode: s.mode || 'agent',
    effort: s.effort || 'medium',
    emit: (event) => {
      // Two channels, deliberately.
      //
      // Durable: completed items become events in the log. That is the record,
      // and it is what a person who joins in ten minutes will replay.
      //
      // Ephemeral: the raw emission - including the token-by-token deltas -
      // is broadcast to whoever is connected right now and never stored.
      // Writing forty events per sentence would triple the log for something
      // nobody reads back, but throwing the deltas away entirely would mean
      // only the person who started the run gets to watch it type, which is
      // precisely the single-player behaviour this whole thing exists to end.
      try {
        recorder.record(event);
      } catch (err) {
        console.error('[runner] record', err);
      }
      try {
        api.broadcast(SESSION, 'live', event);
      } catch (err) {
        console.error('[runner] broadcast', err);
      }
      if (event.kind === 'turn-done' || event.kind === 'turn-error') {
        session = null;
      }
    }
  });

  session.run(text, []).catch((err) => {
    api.append(SESSION, {
      kind: 'note.posted',
      actor: 'system',
      payload: { text: 'Run failed: ' + String((err && err.message) || err) }
    });
    session = null;
  });
}

/**
 * Rebuild the model's conversation history from the log.
 *
 * The runner may have been started fresh against a session that already has a
 * history - after a restart, or when taking over a run someone else began - so
 * the history has to come from the record rather than from memory it does not
 * have.
 */
function historyFromLog() {
  const state = kernel.reduce(SESSION, log.read(SESSION));
  const out = [];
  for (const turn of state.turns) {
    if (turn.text) out.push({ role: 'user', type: 'message', text: turn.text, ts: Date.parse(turn.startedAt) || Date.now() });
    for (const msg of turn.messages) {
      out.push({ role: 'assistant', type: 'message', text: msg.text, ts: Date.parse(msg.ts) || Date.now() });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

function stop(reason) {
  if (stopping) return;
  stopping = true;
  try {
    if (session) session.cancel();
  } catch {
    /* nothing to cancel */
  }
  api.append(SESSION, {
    kind: 'note.posted',
    actor: 'system',
    payload: { text: 'Runner stopped: ' + reason }
  });
  unannounce();
  const bye = share ? share.close().catch(() => {}) : Promise.resolve();
  bye.then(() => api.close()).then(() => process.exit(0));
  // If a socket refuses to close, do not hang around forever pretending to be
  // a live run that nobody can talk to.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => stop('interrupted'));
process.on('SIGTERM', () => stop('terminated'));
process.on('uncaughtException', (err) => {
  console.error('[runner] uncaught', err);
  try {
    api.append(SESSION, {
      kind: 'note.posted',
      actor: 'system',
      payload: { text: 'Runner crashed: ' + String(err && err.message) }
    });
  } catch {
    /* the log may be the thing that failed */
  }
  stop('crashed');
});

(async () => {
  const address = await api.listen(PORT, HOST);
  cursor = log.lastSeq(SESSION);
  const info = announce({ port: address.port, token: TOKEN, base: 'http://' + HOST + ':' + address.port });

  // Announced on stdout as one line of JSON so a parent process can read it
  // without guessing which port the OS handed us.
  process.stdout.write(JSON.stringify({ ready: true, ...info }) + '\n');

  api.append(SESSION, {
    kind: 'note.posted',
    actor: 'system',
    payload: { text: 'Runner online (pid ' + process.pid + ') on port ' + address.port + '.' }
  });
})().catch((err) => {
  console.error('[runner] failed to start', err);
  process.exit(1);
});
