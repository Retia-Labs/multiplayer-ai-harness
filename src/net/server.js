/**
 * The session protocol, server side.
 *
 * One HTTP + SSE surface over an event log. It is deliberately the ONLY way
 * anything writes to a session, because the single hardest problem in this
 * whole product is agreeing what order things happened in. Give two processes
 * an append-only file and they will interleave; give them one writer that
 * assigns sequence numbers and the ordering question disappears.
 *
 * The same server runs in two places:
 *
 *   - inside the local runner, bound to 127.0.0.1, so a person's own run
 *     outlives the window that started it;
 *   - inside the relay, bound publicly, so other people can join.
 *
 * Because both speak this protocol, the desktop client has one implementation
 * and genuinely cannot tell whether it is talking to its own runner or to a
 * room with five people in it. That is what stops "multiplayer" from being a
 * second, divergent code path that only gets tested on demo day.
 *
 * Zero dependencies: node:http, and that is all.
 */
const http = require('http');
const { URL } = require('url');
const kernel = require('../main/kernel');

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // A client that streams forever must not be able to exhaust the server's
      // memory just by never sending the end of its request.
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Constant-time-ish comparison for the room token.
 *
 * Not because this is a high-value secret, but because comparing with === on a
 * short token over a LAN is the kind of thing that is free to get right and
 * embarrassing to have to explain later.
 */
function tokenMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @param {object} opts
 * @param {EventLog} opts.log            where events are stored
 * @param {string=} opts.token           required bearer token, or null for none
 * @param {function=} opts.onEvents      called with (sessionId, written[]) after an append
 * @param {function=} opts.authorize     (sessionId, req) => bool, for the relay's room rules
 * @param {function=} opts.describe      (sessionId) => extra metadata for /state
 */
function createSessionServer(opts) {
  const {
    log,
    token = null,
    onEvents = null,
    authorize = null,
    describe = null,
    // Extra endpoints the host wants on the same surface, keyed "METHOD leaf".
    // The runner uses this for sharing, which is a thing only a runner can do -
    // rather than baking it into a server that the relay also runs.
    routes = {}
  } = opts;

  /** sessionId -> Set<res>, the SSE subscribers watching that session. */
  const streams = new Map();
  /** Everyone currently in a session, and when we last heard from them. */
  const members = new Map(); // sessionId -> Map<name, {name, since, lastSeen, viewing}>

  function subscribers(id) {
    let set = streams.get(id);
    if (!set) {
      set = new Set();
      streams.set(id, set);
    }
    return set;
  }

  function roster(id) {
    let m = members.get(id);
    if (!m) {
      m = new Map();
      members.set(id, m);
    }
    return m;
  }

  /** Push to everyone watching. A dead socket is dropped, never thrown on. */
  function broadcast(id, type, data) {
    const payload = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const res of subscribers(id)) {
      try {
        res.write(payload);
      } catch {
        subscribers(id).delete(res);
      }
    }
  }

  /**
   * The one write path. Everything - the agent, the editor, a person answering
   * a gate from their phone - arrives here and leaves with a sequence number.
   */
  function append(sessionId, incoming) {
    const batch = (Array.isArray(incoming) ? incoming : [incoming]).filter(
      (e) => e && typeof e.kind === 'string' && typeof e.actor === 'string'
    );
    if (!batch.length) return [];
    const written = log.append(sessionId, batch);
    if (written.length) {
      broadcast(sessionId, 'events', written);
      if (onEvents) {
        try {
          onEvents(sessionId, written);
        } catch (err) {
          console.error('[server] onEvents', err);
        }
      }
    }
    return written;
  }

  function touchMember(sessionId, name, viewing) {
    if (!name) return;
    const m = roster(sessionId);
    const now = Date.now();
    const prev = m.get(name);
    m.set(name, {
      name,
      since: prev ? prev.since : now,
      lastSeen: now,
      viewing: viewing === undefined ? (prev ? prev.viewing : null) : viewing
    });
  }

  function presentIn(sessionId) {
    const m = roster(sessionId);
    const cutoff = Date.now() - 45000;
    const out = [];
    for (const [name, info] of m) {
      if (info.lastSeen < cutoff) m.delete(name);
      else out.push(info);
    }
    return out.sort((a, b) => a.since - b.since);
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'Bad URL' });
    }

    // A desktop client is not a browser, but the relay may one day be opened
    // from one, and a watch link is the whole point of the relay.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname === '/health') {
      return send(res, 200, { ok: true, sessions: log.list().length });
    }

    if (token) {
      const auth = req.headers.authorization || '';
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token') || '';
      if (!tokenMatches(given, token)) return send(res, 401, { error: 'Bad or missing token' });
    }

    const m = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,64})(\/[a-z]+)?$/);
    if (!m) return send(res, 404, { error: 'No such endpoint' });
    const sessionId = m[1];
    const leaf = (m[2] || '').slice(1);

    if (authorize && !authorize(sessionId, req)) {
      return send(res, 403, { error: 'Not a member of this session' });
    }

    try {
      const custom = routes[req.method + ' ' + leaf];
      if (custom) {
        return await custom({ sessionId, req, res, url, send, readBody, append });
      }

      /* ---- read the log ---- */
      if (req.method === 'GET' && leaf === 'events') {
        const since = Number(url.searchParams.get('since') || 0) || 0;
        const events = log.read(sessionId).filter((e) => e.seq > since);
        return send(res, 200, { events, lastSeq: log.lastSeq(sessionId) });
      }

      /* ---- the reduced state, for a client that does not want to replay ---- */
      if (req.method === 'GET' && leaf === 'state') {
        const state = kernel.reduce(sessionId, log.read(sessionId));
        return send(res, 200, {
          state,
          present: presentIn(sessionId),
          meta: describe ? describe(sessionId) : null
        });
      }

      /* ---- chain integrity, which anyone may check ---- */
      if (req.method === 'GET' && leaf === 'verify') {
        return send(res, 200, log.verify(sessionId));
      }

      /* ---- live: replay what they missed, then stay open ---- */
      if (req.method === 'GET' && leaf === 'stream') {
        const since = Number(url.searchParams.get('since') || 0) || 0;
        const who = url.searchParams.get('as') || null;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no'
        });
        // Backfill first. A watcher who joins late has missed everything, and
        // a stream that only carries the future is useless to them.
        const missed = log.read(sessionId).filter((e) => e.seq > since);
        if (missed.length) res.write('event: events\ndata: ' + JSON.stringify(missed) + '\n\n');
        res.write('event: hello\ndata: ' + JSON.stringify({ lastSeq: log.lastSeq(sessionId) }) + '\n\n');

        subscribers(sessionId).add(res);
        touchMember(sessionId, who);
        broadcast(sessionId, 'presence', presentIn(sessionId));

        // Proxies and phones drop a silent connection. A comment line every
        // 20s keeps it open and costs nothing.
        const beat = setInterval(() => {
          try {
            res.write(': keep-alive\n\n');
            touchMember(sessionId, who);
          } catch {
            clearInterval(beat);
          }
        }, 20000);

        req.on('close', () => {
          clearInterval(beat);
          subscribers(sessionId).delete(res);
          if (who) roster(sessionId).delete(who);
          broadcast(sessionId, 'presence', presentIn(sessionId));
        });
        return;
      }

      /* ---- submit ---- */
      if (req.method === 'POST' && (leaf === 'events' || leaf === '')) {
        const body = await readBody(req);
        const written = append(sessionId, body.events || body);
        return send(res, 200, { written, lastSeq: log.lastSeq(sessionId) });
      }

      /* ---- who is here, and where they are looking ---- */
      if (req.method === 'POST' && leaf === 'presence') {
        const body = await readBody(req);
        touchMember(sessionId, body.name, body.viewing ?? undefined);
        const present = presentIn(sessionId);
        broadcast(sessionId, 'presence', present);
        return send(res, 200, { present });
      }

      return send(res, 404, { error: 'No such endpoint' });
    } catch (err) {
      return send(res, 400, { error: String((err && err.message) || err) });
    }
  });

  // Without this a half-open socket can hold the process open forever, which
  // for a detached runner means a machine slowly filling with zombie runs.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  return {
    server,
    append,
    broadcast,
    presentIn,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      for (const set of streams.values()) {
        for (const res of set) {
          try {
            res.end();
          } catch {
            /* already gone */
          }
        }
        set.clear();
      }
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createSessionServer, tokenMatches };
