/**
 * The session protocol, client side.
 *
 * Used identically against a local runner on 127.0.0.1 and against a relay
 * hosting a room with other people in it. The client does not know or care
 * which, and that is the point: solo and shared are the same code path, so the
 * multiplayer path is exercised every single time anybody uses the app alone.
 *
 * SSE is hand-rolled over node:http rather than using EventSource, which does
 * not exist in the Node that Electron 33 ships. That is fine - the wire format
 * is four lines of parsing - and it means reconnection behaviour is ours to
 * control rather than the browser's.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

/** Reconnect delays. Backs off, then holds - it never gives up on a room. */
const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000, 30000];

class SessionClient {
  /**
   * @param {object} opts
   * @param {string} opts.base       e.g. http://127.0.0.1:7420
   * @param {string} opts.sessionId
   * @param {string=} opts.token
   * @param {string=} opts.as        display name, for presence
   */
  constructor({ base, sessionId, token = null, as = null }) {
    this.base = base.replace(/\/$/, '');
    this.sessionId = sessionId;
    this.token = token;
    this.as = as;
    this.lastSeq = 0;
    this.closed = false;
    this.req = null;
    this.attempt = 0;
    this.handlers = { events: [], presence: [], status: [] };
  }

  on(type, fn) {
    (this.handlers[type] || (this.handlers[type] = [])).push(fn);
    return this;
  }

  _emit(type, payload) {
    for (const fn of this.handlers[type] || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[client] handler', type, err);
      }
    }
  }

  _headers(extra) {
    const h = { accept: 'application/json', ...extra };
    if (this.token) h.authorization = 'Bearer ' + this.token;
    return h;
  }

  async _json(method, leaf, body) {
    const url = this.base + '/s/' + this.sessionId + (leaf ? '/' + leaf : '');
    const res = await fetch(url, {
      method,
      headers: this._headers(body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error('Server sent something that is not JSON: ' + text.slice(0, 120));
    }
    if (!res.ok) throw new Error(parsed.error || 'Request failed: ' + res.status);
    return parsed;
  }

  /** Submit events. Every one carries a clientId so a retry cannot duplicate it. */
  submit(events) {
    const batch = Array.isArray(events) ? events : [events];
    return this._json('POST', 'events', { events: batch });
  }

  state() {
    return this._json('GET', 'state');
  }

  verify() {
    return this._json('GET', 'verify');
  }

  events(since = 0) {
    return this._json('GET', 'events?since=' + since);
  }

  presence(viewing) {
    return this._json('POST', 'presence', { name: this.as, viewing: viewing ?? null }).catch(
      () => null
    );
  }

  /**
   * Open the live stream, reconnecting for as long as the client is alive.
   *
   * `lastSeq` is tracked across reconnects and sent as `since`, so a dropped
   * connection replays exactly what was missed rather than the whole run - and
   * a laptop that slept for an hour catches up in one response.
   */
  connect() {
    if (this.closed) return this;
    const url = new URL(
      this.base + '/s/' + this.sessionId + '/stream?since=' + this.lastSeq +
        (this.as ? '&as=' + encodeURIComponent(this.as) : '')
    );
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.request(
      url,
      { method: 'GET', headers: this._headers({ accept: 'text/event-stream' }) },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          this._emit('status', { connected: false, error: 'HTTP ' + res.statusCode });
          return this._retry();
        }
        this.attempt = 0;
        this._emit('status', { connected: true });

        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          // SSE frames are separated by a blank line. Anything after the last
          // blank line is a partial frame and stays in the buffer.
          let split;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            this._frame(frame);
          }
        });
        res.on('end', () => {
          this._emit('status', { connected: false });
          this._retry();
        });
        res.on('error', () => {
          this._emit('status', { connected: false });
          this._retry();
        });
      }
    );

    req.on('error', (err) => {
      this._emit('status', { connected: false, error: String(err.message || err) });
      this._retry();
    });
    req.end();
    this.req = req;
    return this;
  }

  _frame(frame) {
    let type = 'message';
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // keep-alive comment
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) return;
    let payload;
    try {
      payload = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    if (type === 'events') {
      for (const e of payload) if (e.seq > this.lastSeq) this.lastSeq = e.seq;
      this._emit('events', payload);
    } else if (type === 'live') {
      // Not durable and not replayed: whoever is connected now sees the agent
      // type, and whoever arrives later reads the finished thought from the log.
      this._emit('live', payload);
    } else if (type === 'presence') {
      this._emit('presence', payload);
    } else if (type === 'hello') {
      if (payload.lastSeq > this.lastSeq) this.lastSeq = payload.lastSeq;
    }
  }

  _retry() {
    if (this.closed) return;
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt += 1;
    this._timer = setTimeout(() => this.connect(), delay);
    if (this._timer.unref) this._timer.unref();
  }

  close() {
    this.closed = true;
    clearTimeout(this._timer);
    if (this.req) {
      try {
        this.req.destroy();
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Wait for a server to answer, so a caller that just spawned a runner does not
 * race its own child to the first request.
 */
async function waitForServer(base, { token = null, timeoutMs = 15000 } = {}) {
  const started = Date.now();
  const headers = token ? { authorization: 'Bearer ' + token } : {};
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(base.replace(/\/$/, '') + '/health', { headers });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

module.exports = { SessionClient, waitForServer };
