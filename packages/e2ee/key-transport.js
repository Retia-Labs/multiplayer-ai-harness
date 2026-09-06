'use strict';
// The hub's side of endpoint enrollment: a directory of public keys and a queue of sealed
// envelopes. Deliberately dumb, because that is the claim being tested - the relay should
// be able to do its whole job without ever holding anything it could read.
//
// This is an in-process implementation used by the spike. Wiring it to the real hub's
// WebSocket is the next step, not this one.

class KeyDirectory {
  constructor() {
    this.deviceKeys = new Map();   // user -> device -> public device keys
    this.oneTimeKeys = new Map();  // user -> device -> { keyId: key }
    this.mailboxes = new Map();    // user/device -> [envelope]
    this.revoked = new Set();      // user/device that may no longer receive
    this.audit = [];               // everything the relay handled, for inspection
  }

  _dev(map, user) {
    if (!map.has(user)) map.set(user, new Map());
    return map.get(user);
  }

  upload(user, device, body) {
    const j = JSON.parse(body);
    if (j.device_keys) this._dev(this.deviceKeys, user).set(device, j.device_keys);
    if (j.one_time_keys) {
      const pool = this._dev(this.oneTimeKeys, user).get(device) || {};
      this._dev(this.oneTimeKeys, user).set(device, { ...pool, ...j.one_time_keys });
    }
    const counts = {};
    for (const k of Object.keys(j.one_time_keys || {})) {
      const alg = k.split(':')[0];
      counts[alg] = (counts[alg] || 0) + 1;
    }
    return JSON.stringify({ one_time_key_counts: counts });
  }

  query() {
    const device_keys = {};
    for (const [user, devices] of this.deviceKeys) {
      device_keys[user] = {};
      for (const [device, keys] of devices) {
        if (this.revoked.has(user + '/' + device)) continue;
        device_keys[user][device] = keys;
      }
    }
    return JSON.stringify({ device_keys, failures: {} });
  }

  claim(body) {
    const want = JSON.parse(body).one_time_keys || {};
    const one_time_keys = {};
    for (const [user, devices] of Object.entries(want)) {
      one_time_keys[user] = {};
      for (const device of Object.keys(devices)) {
        if (this.revoked.has(user + '/' + device)) continue;
        const pool = (this._dev(this.oneTimeKeys, user).get(device)) || {};
        const [keyId, key] = Object.entries(pool)[0] || [];
        if (keyId) { one_time_keys[user][device] = { [keyId]: key }; delete pool[keyId]; }
      }
    }
    return JSON.stringify({ one_time_keys, failures: {} });
  }

  deliver(user, device, envelope) {
    if (this.revoked.has(user + '/' + device)) return { delivered: false, reason: 'endpoint_revoked' };
    const box = user + '/' + device;
    if (!this.mailboxes.has(box)) this.mailboxes.set(box, []);
    this.mailboxes.get(box).push(envelope);
    return { delivered: true };
  }

  drain(user, device) {
    const box = user + '/' + device;
    const out = this.mailboxes.get(box) || [];
    this.mailboxes.set(box, []);
    return out;
  }

  // Removing a device stops it receiving anything further. It cannot un-know what it
  // already held - that limit is real and is stated in the threat model rather than
  // papered over here.
  revoke(user, device) {
    this.revoked.add(user + '/' + device);
    this._dev(this.oneTimeKeys, user).delete(device);
    this.mailboxes.delete(user + '/' + device);
  }

  // Everything the relay ever saw, so a test can assert on it directly.
  everythingTheRelayHolds() {
    return JSON.stringify({
      deviceKeys: [...this.deviceKeys].map(([u, d]) => [u, [...d]]),
      oneTimeKeys: [...this.oneTimeKeys].map(([u, d]) => [u, [...d]]),
      mailboxes: [...this.mailboxes],
      audit: this.audit
    });
  }
}

// Binds one endpoint to the directory above.
class KeyTransport {
  constructor(directory) { this.directory = directory; }
  async send(type, { user, device, body }) {
    this.directory.audit.push({ type, user, device, at: Date.now() });
    if (type === 'KeysUpload') return this.directory.upload(user, device, body);
    if (type === 'KeysQuery') return this.directory.query();
    if (type === 'KeysClaim') return this.directory.claim(body);
    return '{}';
  }
}

module.exports = { KeyDirectory, KeyTransport };
