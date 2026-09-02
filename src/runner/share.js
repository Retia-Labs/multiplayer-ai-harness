/**
 * Sharing a run: the runner's half of the relay conversation.
 *
 * Two loops, both outbound, so a laptop behind NAT needs no configuration:
 *
 *   mirror  - push new events to the room as they are produced
 *   inbox   - long-poll the room for intents and apply them locally
 *
 * An intent is not an event. Someone in the room saying "stop" is a request;
 * what lands in the log is whatever the runner decided to do about it, with a
 * sequence number the runner assigned. Keeping those two things distinct is
 * what lets five people talk to one run without any of them being able to
 * corrupt its history.
 */

const MIRROR_IDLE_MS = 400;
const RETRY_MS = [500, 1000, 2000, 5000, 10000, 20000];

class Share {
  /**
   * @param {object} opts
   * @param {string} opts.relay      base URL of the relay
   * @param {string} opts.sessionId
   * @param {string=} opts.title
   * @param {function} opts.readEvents  (since) => events[]  to mirror
   * @param {function} opts.onIntent    (intent) => void     to act on
   */
  constructor(opts) {
    this.relay = opts.relay.replace(/\/$/, '');
    this.sessionId = opts.sessionId;
    this.title = opts.title || '';
    this.readEvents = opts.readEvents;
    this.onIntent = opts.onIntent;

    this.code = null;
    this.hostKey = null;
    this.mirroredSeq = 0;
    this.intentCursor = 0;
    this.closed = false;
    this.attempt = 0;
    this.pending = false;
  }

  get joined() {
    return !!this.code;
  }

  async open() {
    const res = await fetch(this.relay + '/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: this.sessionId, title: this.title })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not open a room: ' + res.status);
    this.code = body.code;
    this.hostKey = body.hostKey;
    this.mirroredSeq = 0;
    this._pollInbox();
    await this.flush();
    return { code: this.code, joinUrl: this.relay + '/r/' + this.code };
  }

  _headers() {
    return { 'content-type': 'application/json', 'x-host-key': this.hostKey };
  }

  /**
   * Send everything the room has not got.
   *
   * Coalesced: a burst of events during a turn becomes one request rather than
   * forty, and because mirroring is idempotent by sequence number a resend
   * after a failure is always safe.
   */
  flush() {
    if (this.closed || !this.code) return Promise.resolve();
    if (this.pending) return Promise.resolve();
    this.pending = true;
    return new Promise((resolve) => {
      setTimeout(async () => {
        this.pending = false;
        if (this.closed || !this.code) return resolve();
        const events = this.readEvents(this.mirroredSeq);
        if (!events.length) return resolve();
        try {
          const res = await fetch(this.relay + '/r/' + this.code + '/mirror', {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify({ events })
          });
          if (res.ok) {
            const body = await res.json().catch(() => ({}));
            // Trust the room's own account of what it has rather than assuming
            // the whole batch landed.
            this.mirroredSeq = Math.max(this.mirroredSeq, body.lastSeq || 0);
            this.attempt = 0;
          } else {
            this._backoff(() => this.flush());
          }
        } catch {
          this._backoff(() => this.flush());
        }
        resolve();
      }, MIRROR_IDLE_MS);
    });
  }

  _backoff(fn) {
    if (this.closed) return;
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt += 1;
    const t = setTimeout(fn, delay);
    if (t.unref) t.unref();
  }

  /**
   * Hold a request open until the room has something for us.
   *
   * A relay that answers immediately with nothing would turn an idle room into
   * a request per second per run, forever. The long poll makes an idle room
   * cost one socket.
   */
  async _pollInbox() {
    while (!this.closed && this.code) {
      try {
        const res = await fetch(
          this.relay + '/r/' + this.code + '/inbox?since=' + this.intentCursor,
          { headers: { 'x-host-key': this.hostKey } }
        );
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        const body = await res.json().catch(() => ({ intents: [] }));
        for (const intent of body.intents || []) {
          this.intentCursor = Math.max(this.intentCursor, intent.id);
          try {
            this.onIntent(intent);
          } catch (err) {
            console.error('[share] intent', err);
          }
        }
      } catch {
        // The relay is unreachable. Keep trying: the run carries on locally in
        // the meantime, and the room catches up when the network does.
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async close() {
    this.closed = true;
    if (!this.code) return;
    try {
      await fetch(this.relay + '/r/' + this.code + '/close', {
        method: 'POST',
        headers: this._headers()
      });
    } catch {
      /* the room expires on its own if we cannot say goodbye */
    }
  }
}

module.exports = { Share };
