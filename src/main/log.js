/**
 * Append-only, hash-chained event log.
 *
 * This replaces rewriting threads.json wholesale. A single-writer JSON blob is
 * fine while one local process owns the truth; it stops being fine the moment a
 * second person is watching the same run, because there is no ordering, no way
 * to say "you are behind by three", and a crash mid-write loses the file.
 *
 * The chain algorithm here is deliberately identical to Quorum's server-side
 * one (src/lib/session.ts). Events written on this desktop and events written
 * by the server are the same records, so a session can be replayed on either
 * side and verify() gives the same answer.
 *
 * Storage is one JSONL file per session. Appends are a single write to the end
 * of the file, which is atomic enough at these sizes: a torn final line is
 * detectable (JSON.parse fails) and is discarded on load, costing at most the
 * last event rather than the whole log.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const digest = (v) => crypto.createHash('sha256').update(v).digest('hex');

/**
 * Each event commits to the one before it, so editing or dropping any earlier
 * event breaks every hash after it. The chain commits to the payload's DIGEST
 * rather than its text, which is what lets a secret an agent printed be
 * removed later without forging a break in the chain.
 */
function eventHash(prevHash, e) {
  return digest([prevHash, e.seq, e.sessionId, e.kind, e.actor, e.ts, e.payloadHash].join(' '));
}

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

class EventLog {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.cache = new Map(); // sessionId -> { events, byClientId }
  }

  _file(sessionId) {
    return path.join(this.dir, sessionId + '.jsonl');
  }

  /** Load a session's events, discarding a torn trailing line from a crash. */
  read(sessionId) {
    const hit = this.cache.get(sessionId);
    if (hit) return hit.events;
    const events = [];
    const byClientId = new Set();
    let raw = '';
    try {
      raw = fs.readFileSync(this._file(sessionId), 'utf8');
    } catch {
      raw = '';
    }
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        // Only the final line can legitimately be torn. Anything else means the
        // file is damaged in a way we should not silently paper over.
        if (lines.slice(i + 1).some((l) => l.trim())) {
          throw new Error('Corrupt event log ' + sessionId + ' at line ' + (i + 1));
        }
        break;
      }
      events.push(ev);
      if (ev.clientId) byClientId.add(ev.clientId);
    }
    this.cache.set(sessionId, { events, byClientId });
    return events;
  }

  lastSeq(sessionId) {
    const events = this.read(sessionId);
    return events.length ? events[events.length - 1].seq : 0;
  }

  /**
   * The only write path. Accepts one event or a batch.
   *
   * `clientId` makes an append idempotent. A sender that timed out does not
   * know whether its write landed, so it resends; without this the reconnect
   * meant to repair the record duplicates it instead. That is rare while the
   * agent is online and posts once, and routine the moment work is queued
   * offline and replayed - which is exactly what this desktop app does.
   */
  append(sessionId, input) {
    const batch = Array.isArray(input) ? input : [input];
    if (!batch.length) return [];

    const events = this.read(sessionId);
    const entry = this.cache.get(sessionId);
    let seq = events.length ? events[events.length - 1].seq : 0;
    let prevHash = events.length ? events[events.length - 1].hash : '';

    const written = [];
    for (const e of batch) {
      if (e.clientId && entry.byClientId.has(e.clientId)) continue;
      const ts = new Date().toISOString();
      const payload = e.payload || {};
      const payloadHash = digest(JSON.stringify(payload));
      const thisSeq = ++seq;
      const hash = eventHash(prevHash, {
        seq: thisSeq,
        sessionId,
        kind: e.kind,
        actor: e.actor,
        ts,
        payloadHash
      });
      const ev = {
        id: uid('ev'),
        clientId: e.clientId || null,
        sessionId,
        seq: thisSeq,
        kind: e.kind,
        actor: e.actor,
        ts,
        payload,
        payloadHash,
        prevHash,
        hash
      };
      written.push(ev);
      events.push(ev);
      if (ev.clientId) entry.byClientId.add(ev.clientId);
      prevHash = hash;
    }

    if (written.length) {
      fs.appendFileSync(
        this._file(sessionId),
        written.map((e) => JSON.stringify(e)).join('\n') + '\n'
      );
    }
    return written;
  }

  /**
   * Adopt events produced elsewhere (the server, or another client) without
   * rewriting their sequence numbers or hashes. Used on sync: whatever the
   * server has that we do not, we take verbatim, because its ordering is the
   * one both sides already agreed on.
   */
  adopt(sessionId, remote) {
    const events = this.read(sessionId);
    const entry = this.cache.get(sessionId);
    const have = new Set(events.map((e) => e.seq));
    const fresh = remote.filter((e) => !have.has(e.seq));
    if (!fresh.length) return [];
    for (const e of fresh) {
      events.push(e);
      if (e.clientId) entry.byClientId.add(e.clientId);
    }
    events.sort((a, b) => a.seq - b.seq);
    // A full rewrite is correct here: adopting can interleave remote events
    // before local ones, and the file must match the order we replay in.
    this._rewrite(sessionId, events);
    return fresh;
  }

  _rewrite(sessionId, events) {
    const tmp = this._file(sessionId) + '.tmp';
    fs.writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.renameSync(tmp, this._file(sessionId));
  }

  /**
   * Walk the chain and report the first break. Returns ok:true when intact.
   *
   * We cannot stop someone with disk access from editing a line. We can make it
   * impossible to do so without leaving a break, which is the difference
   * between "we keep logs" and a record anyone can rely on.
   */
  verify(sessionId) {
    const events = this.read(sessionId);
    let prevHash = '';
    let expectedSeq = 0;
    for (const e of events) {
      expectedSeq += 1;
      if (e.seq !== expectedSeq) return { ok: false, seq: e.seq, reason: 'sequence gap' };
      if (e.prevHash !== prevHash) return { ok: false, seq: e.seq, reason: 'chain break' };
      if (!e.redactedAt && digest(JSON.stringify(e.payload)) !== e.payloadHash) {
        return { ok: false, seq: e.seq, reason: 'payload altered' };
      }
      const recomputed = eventHash(e.prevHash, {
        seq: e.seq,
        sessionId: e.sessionId,
        kind: e.kind,
        actor: e.actor,
        ts: e.ts,
        payloadHash: e.payloadHash
      });
      if (recomputed !== e.hash) return { ok: false, seq: e.seq, reason: 'hash mismatch' };
      prevHash = e.hash;
    }
    return { ok: true, seq: events.length, reason: null };
  }

  /**
   * Remove an event's content without breaking the chain. Because the chain
   * commits to the payload's digest and not its text, the digest stays, the
   * text goes, and the redaction itself is recorded beside it.
   */
  redact(sessionId, seq, by, reason) {
    const events = this.read(sessionId);
    const ev = events.find((e) => e.seq === seq);
    if (!ev) return null;
    ev.payload = {};
    ev.redactedAt = new Date().toISOString();
    ev.redactedBy = by;
    ev.redactedReason = reason || null;
    this._rewrite(sessionId, events);
    return ev;
  }

  list() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.slice(0, -6));
    } catch {
      return [];
    }
  }

  drop(sessionId) {
    this.cache.delete(sessionId);
    try {
      fs.unlinkSync(this._file(sessionId));
    } catch {
      /* already gone */
    }
  }
}

module.exports = { EventLog, digest, eventHash, uid };
