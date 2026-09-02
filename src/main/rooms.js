/**
 * Joining someone else's run.
 *
 * A joined session is a thread like any other, except that this machine is not
 * the one doing the work. Events arrive from the room and are adopted into the
 * local log verbatim - same sequence numbers, same hashes - so the joiner holds
 * a genuine copy of the record rather than a rendering of it, and can verify
 * the chain themselves.
 *
 * Anything the joiner wants the run to do goes out as an intent. It is a
 * request, not a write: the host's runner decides what actually enters the log
 * and gives it its sequence number. That asymmetry is the whole safety story -
 * five people can take part in a run without any of them being able to rewrite
 * what happened.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000, 30000];

class RoomLink {
  /**
   * @param {object} opts
   * @param {string} opts.relay      base URL of the relay
   * @param {string} opts.code       room code
   * @param {string} opts.threadId   the local thread this room feeds
   * @param {EventLog} opts.log
   * @param {string} opts.as         display name
   * @param {function} opts.onEvents (threadId, adopted[])
   * @param {function} opts.onPresence (threadId, roster[])
   * @param {function} opts.onClosed (threadId, reason)
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.relay = opts.relay.replace(/\/$/, '');
    this.lastSeq = opts.log.lastSeq(opts.threadId);
    this.closed = false;
    this.attempt = 0;
    this.present = [];
  }

  get roomUrl() {
    return this.relay + '/r/' + this.code;
  }

  async info() {
    const res = await fetch(this.roomUrl);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not read the room');
    return body;
  }

  /** Ask the run to do something. Always a request, never a write. */
  async intent(kind, payload) {
    const res = await fetch(this.roomUrl + '/intents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, actor: 'human:' + this.as, payload: payload || {} })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) throw new Error(body.error || 'The room refused that');
    return body;
  }

  presence(viewing) {
    return fetch(this.roomUrl + '/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: this.as, viewing: viewing ?? null })
    }).catch(() => null);
  }

  _adopt(events) {
    if (!events || !events.length) return;
    const adopted = this.log.adopt(this.threadId, events);
    for (const e of events) if (e.seq > this.lastSeq) this.lastSeq = e.seq;
    if (adopted.length && this.onEvents) this.onEvents(this.threadId, adopted);
  }

  connect() {
    if (this.closed) return this;
    const url = new URL(
      this.roomUrl + '/stream?since=' + this.lastSeq + '&as=' + encodeURIComponent(this.as || 'guest')
    );
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.request(url, { method: 'GET', headers: { accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return this._retry();
      }
      this.attempt = 0;
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          this._frame(frame);
        }
      });
      res.on('end', () => this._retry());
      res.on('error', () => this._retry());
    });
    req.on('error', () => this._retry());
    req.end();
    this.req = req;
    return this;
  }

  _frame(frame) {
    let type = 'message';
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue;
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
    if (type === 'events') this._adopt(payload);
    else if (type === 'presence') {
      this.present = payload;
      if (this.onPresence) this.onPresence(this.threadId, payload);
    } else if (type === 'closed') {
      if (this.onClosed) this.onClosed(this.threadId, payload.reason || 'closed');
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

/** All the rooms this desktop has joined. */
class RoomBook {
  constructor(opts) {
    this.opts = opts;
    this.links = new Map(); // threadId -> RoomLink
  }

  get(threadId) {
    const l = this.links.get(threadId);
    return l && !l.closed ? l : null;
  }

  has(threadId) {
    return !!this.get(threadId);
  }

  async join({ relay, code, threadId }) {
    const existing = this.get(threadId);
    if (existing) return existing;
    const link = new RoomLink({
      relay,
      code: code.toUpperCase(),
      threadId,
      log: this.opts.log,
      as: this.opts.me(),
      onEvents: this.opts.onEvents,
      onPresence: this.opts.onPresence,
      onClosed: this.opts.onClosed
    });
    // Fail before creating anything if the code is wrong: a thread that will
    // never receive anything is worse than an error message.
    const info = await link.info();
    link.connect();
    this.links.set(threadId, link);
    return Object.assign(link, { roomInfo: info });
  }

  leave(threadId) {
    const l = this.links.get(threadId);
    if (l) l.close();
    this.links.delete(threadId);
  }

  closeAll() {
    for (const l of this.links.values()) l.close();
    this.links.clear();
  }
}

module.exports = { RoomLink, RoomBook };
