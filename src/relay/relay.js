/**
 * The relay: how someone on another machine joins your run.
 *
 * The hard constraint is that a runner sits on a laptop behind NAT, so nothing
 * on the internet can dial into it. The usual answer is a tunnel over a
 * WebSocket; the answer here is simpler and needs no dependency at all.
 *
 *   - The runner MIRRORS its events outward: it POSTs each batch to the room.
 *   - The runner LONG-POLLS the room for intents: things people in the room
 *     want the run to do (steer it, answer a gate, ask for something new).
 *
 * Both are outbound connections from the laptop, so this works from a coffee
 * shop without configuring anything.
 *
 * Critically the relay never assigns sequence numbers. It stores what the
 * runner gives it and hands intents back. The runner remains the single writer
 * for its own session, which is what keeps ordering trustworthy no matter how
 * many people are in the room - the relay is a postbox, not an authority.
 */
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

/** Room codes people read aloud. No vowels, so no accidental words. */
const ALPHABET = '23456789BCDFGHJKLMNPQRSTVWXZ';

function roomCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out.slice(0, 4) + '-' + out.slice(4);
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
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

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

class Room {
  constructor({ code, sessionId, title, hostKey, ttlMs }) {
    this.code = code;
    this.sessionId = sessionId;
    this.title = title || '';
    /** Proves a caller is the runner, not merely someone who knows the code. */
    this.hostKey = hostKey;
    this.events = [];
    this.intents = [];
    this.nextIntentId = 1;
    this.subscribers = new Set();
    /** Runners waiting on the long poll, to be released when an intent lands. */
    this.waiters = new Set();
    this.members = new Map();
    this.createdAt = Date.now();
    this.touchedAt = Date.now();
    this.ttlMs = ttlMs;
    this.live = false;
  }

  get expired() {
    return Date.now() - this.touchedAt > this.ttlMs;
  }

  touch() {
    this.touchedAt = Date.now();
  }

  /**
   * Store mirrored events, ignoring any the room already has.
   *
   * The runner re-sends on reconnect without knowing what arrived, so this has
   * to be idempotent by sequence number or a flaky connection would duplicate
   * the room's copy of the run.
   */
  mirror(events) {
    const have = new Set(this.events.map((e) => e.seq));
    const fresh = events.filter((e) => e && typeof e.seq === 'number' && !have.has(e.seq));
    if (!fresh.length) return [];
    this.events.push(...fresh);
    this.events.sort((a, b) => a.seq - b.seq);
    this.broadcast('events', fresh);
    return fresh;
  }

  addIntent(intent) {
    const stored = { id: this.nextIntentId++, at: Date.now(), ...intent };
    this.intents.push(stored);
    // Intents are short-lived: once the runner has taken them they are history,
    // and the log is where history belongs.
    if (this.intents.length > 500) this.intents.splice(0, this.intents.length - 500);
    for (const release of this.waiters) release();
    this.waiters.clear();
    return stored;
  }

  intentsSince(id) {
    return this.intents.filter((i) => i.id > id);
  }

  broadcast(type, data) {
    const frame = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const res of this.subscribers) {
      try {
        res.write(frame);
      } catch {
        this.subscribers.delete(res);
      }
    }
  }

  roster() {
    const cutoff = Date.now() - 45000;
    const out = [];
    for (const [name, info] of this.members) {
      if (info.lastSeen < cutoff) this.members.delete(name);
      else out.push(info);
    }
    return out.sort((a, b) => a.since - b.since);
  }

  saw(name, viewing) {
    if (!name) return;
    const prev = this.members.get(name);
    const now = Date.now();
    this.members.set(name, {
      name,
      since: prev ? prev.since : now,
      lastSeen: now,
      viewing: viewing === undefined ? (prev ? prev.viewing : null) : viewing
    });
  }
}

/**
 * @param {object} opts
 * @param {number=} opts.ttlMs        how long an untouched room survives
 * @param {number=} opts.maxRooms     back-pressure for a public deployment
 * @param {number=} opts.pollMs       how long a runner's long poll hangs open
 */
function createRelay(opts = {}) {
  const ttlMs = opts.ttlMs ?? 12 * 60 * 60 * 1000;
  const maxRooms = opts.maxRooms ?? 500;
  const pollMs = opts.pollMs ?? 25000;

  const rooms = new Map(); // code -> Room

  function sweep() {
    for (const [code, room] of rooms) {
      if (room.expired) {
        room.broadcast('closed', { reason: 'expired' });
        for (const res of room.subscribers) {
          try {
            res.end();
          } catch {
            /* already gone */
          }
        }
        rooms.delete(code);
      }
    }
  }
  const sweeper = setInterval(sweep, 60000);
  if (sweeper.unref) sweeper.unref();

  function hostAuthorized(room, req, url) {
    const auth = req.headers['x-host-key'] || url.searchParams.get('hostKey') || '';
    return timingSafeEqual(auth, room.hostKey);
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'Bad URL' });
    }

    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, x-host-key');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname === '/health') {
      return send(res, 200, { ok: true, rooms: rooms.size });
    }

    /* ---- open a room ---- */
    if (req.method === 'POST' && url.pathname === '/rooms') {
      if (rooms.size >= maxRooms) {
        sweep();
        if (rooms.size >= maxRooms) return send(res, 503, { error: 'Relay is full' });
      }
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return send(res, 400, { error: String(err.message) });
      }
      if (!body.sessionId) return send(res, 400, { error: 'sessionId is required' });

      const code = roomCode();
      const hostKey = crypto.randomBytes(24).toString('base64url');
      const room = new Room({ code, sessionId: body.sessionId, title: body.title, hostKey, ttlMs });
      room.live = true;
      rooms.set(code, room);
      return send(res, 200, { code, hostKey, sessionId: room.sessionId, joinPath: '/r/' + code });
    }

    const m = url.pathname.match(/^\/r\/([A-Z0-9-]{4,16})(\/[a-z]+)?$/i);
    if (!m) return send(res, 404, { error: 'No such endpoint' });
    const room = rooms.get(m[1].toUpperCase());
    if (!room) return send(res, 404, { error: 'No such room. It may have expired.' });
    const leaf = (m[2] || '').slice(1);
    room.touch();

    try {
      /* ---- what the room knows ---- */
      if (req.method === 'GET' && leaf === '') {
        return send(res, 200, {
          code: room.code,
          sessionId: room.sessionId,
          title: room.title,
          live: room.live,
          lastSeq: room.events.length ? room.events[room.events.length - 1].seq : 0,
          present: room.roster()
        });
      }

      if (req.method === 'GET' && leaf === 'events') {
        const since = Number(url.searchParams.get('since') || 0) || 0;
        return send(res, 200, { events: room.events.filter((e) => e.seq > since) });
      }

      /* ---- everyone in the room watches this ---- */
      if (req.method === 'GET' && leaf === 'stream') {
        const since = Number(url.searchParams.get('since') || 0) || 0;
        const who = url.searchParams.get('as') || null;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no'
        });
        const missed = room.events.filter((e) => e.seq > since);
        if (missed.length) res.write('event: events\ndata: ' + JSON.stringify(missed) + '\n\n');
        res.write('event: hello\ndata: ' + JSON.stringify({ code: room.code, live: room.live }) + '\n\n');

        room.subscribers.add(res);
        room.saw(who);
        room.broadcast('presence', room.roster());

        const beat = setInterval(() => {
          try {
            res.write(': keep-alive\n\n');
            room.saw(who);
            room.touch();
          } catch {
            clearInterval(beat);
          }
        }, 20000);
        req.on('close', () => {
          clearInterval(beat);
          room.subscribers.delete(res);
          if (who) room.members.delete(who);
          room.broadcast('presence', room.roster());
        });
        return;
      }

      /* ---- a member asks the run to do something ---- */
      if (req.method === 'POST' && leaf === 'intents') {
        const body = await readBody(req);
        const list = Array.isArray(body.intents) ? body.intents : [body];
        const stored = [];
        for (const i of list) {
          if (!i || typeof i.kind !== 'string' || typeof i.actor !== 'string') continue;
          stored.push(room.addIntent({ kind: i.kind, actor: i.actor, payload: i.payload || {} }));
        }
        if (!room.live) {
          // Accepted, but say so: a room whose runner has gone offline will
          // deliver these when it comes back, and pretending otherwise would
          // leave someone waiting on an agent that cannot hear them.
          return send(res, 202, { accepted: stored, warning: 'The run is offline; this is queued.' });
        }
        return send(res, 200, { accepted: stored });
      }

      if (req.method === 'POST' && leaf === 'presence') {
        const body = await readBody(req);
        room.saw(body.name, body.viewing ?? undefined);
        room.broadcast('presence', room.roster());
        return send(res, 200, { present: room.roster() });
      }

      /* ---- host only, below ---- */

      /* the runner mirrors its events outward */
      if (req.method === 'POST' && leaf === 'mirror') {
        if (!hostAuthorized(room, req, url)) return send(res, 403, { error: 'Not the host' });
        const body = await readBody(req);
        const fresh = room.mirror(Array.isArray(body.events) ? body.events : []);
        room.live = true;
        return send(res, 200, { stored: fresh.length, lastSeq: room.events.length ? room.events[room.events.length - 1].seq : 0 });
      }

      /* the runner long-polls for things people asked for */
      if (req.method === 'GET' && leaf === 'inbox') {
        if (!hostAuthorized(room, req, url)) return send(res, 403, { error: 'Not the host' });
        const since = Number(url.searchParams.get('since') || 0) || 0;
        room.live = true;

        const ready = room.intentsSince(since);
        if (ready.length) return send(res, 200, { intents: ready });

        // Nothing yet. Hold the connection rather than making the runner poll
        // in a loop: an idle room should cost one open socket, not a request
        // every second forever.
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          room.waiters.delete(finish);
          send(res, 200, { intents: room.intentsSince(since) });
        };
        const timer = setTimeout(finish, pollMs);
        room.waiters.add(finish);
        req.on('close', () => {
          settled = true;
          clearTimeout(timer);
          room.waiters.delete(finish);
        });
        return;
      }

      if (req.method === 'POST' && leaf === 'close') {
        if (!hostAuthorized(room, req, url)) return send(res, 403, { error: 'Not the host' });
        room.live = false;
        room.broadcast('closed', { reason: 'host ended the room' });
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'No such endpoint' });
    } catch (err) {
      return send(res, 400, { error: String((err && err.message) || err) });
    }
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  // The runner's long poll legitimately holds a request open, so the default
  // request timeout would kill it on schedule.
  server.requestTimeout = 0;

  return {
    server,
    rooms,
    roomCode,
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
      clearInterval(sweeper);
      for (const room of rooms.values()) {
        for (const res of room.subscribers) {
          try {
            res.end();
          } catch {
            /* already gone */
          }
        }
        for (const release of room.waiters) release();
      }
      rooms.clear();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createRelay, roomCode };
