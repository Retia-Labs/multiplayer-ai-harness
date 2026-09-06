'use strict';
// One cryptographic endpoint - a desktop app, a browser profile, or an execution host.
//
// Spike for issue #3. This is a thin seam over @matrix-org/matrix-sdk-crypto-wasm: the
// crypto is entirely theirs (Olm/Megolm via vodozemac, Apache-2.0, the stack Element
// ships), and what lives here is only the transport binding, because that library is
// shaped around Matrix's client-server endpoints and this product has its own hub.
//
// Nothing in this file implements a cryptographic primitive, and nothing in it should.
const sdk = require('@matrix-org/matrix-sdk-crypto-wasm');

// The key-exchange calls the machine can ask us to make. Each maps to one hub route.
const REQUEST_TYPES = {
  KeysUploadRequest: 'KeysUpload',
  KeysQueryRequest: 'KeysQuery',
  KeysClaimRequest: 'KeysClaim',
  ToDeviceRequest: 'ToDevice',
  SignatureUploadRequest: 'SignatureUpload',
  RoomMessageRequest: 'RoomMessage',
  KeysBackupRequest: 'KeysBackup'
};

let ready = null;
function init() {
  if (!ready) ready = sdk.initAsync();
  return ready;
}

// wasm-bindgen takes ownership of these wrappers: one passed into a call is freed and
// cannot be passed into the next. Every use builds a fresh one, deliberately.
const userId = (id) => new sdk.UserId(id);
const deviceId = (id) => new sdk.DeviceId(id);

class Endpoint {
  constructor({ user, device, transport, log = () => {} }) {
    this.user = user;           // '@alice:plexus.local'
    this.device = device;       // 'ALICEDEV'
    this.transport = transport; // the hub binding; see KeyTransport below
    this.log = log;
    this.machine = null;
  }

  static async create(opts) {
    await init();
    const ep = new Endpoint(opts);
    ep.machine = await sdk.OlmMachine.initialize(userId(ep.user), deviceId(ep.device));
    await ep.sync();
    return ep;
  }

  // Publish our public keys and pick up everyone else's. The hub only ever handles public
  // material here; the private half never leaves this process.
  async sync() {
    for (const req of await this.machine.outgoingRequests()) {
      const kind = req.constructor.name;
      const type = REQUEST_TYPES[kind];
      if (!type) { this.log('unhandled request ' + kind); continue; }
      const response = await this.transport.send(type, { user: this.user, device: this.device, body: req.body, id: req.id });
      await this.machine.markRequestAsSent(req.id, sdk.RequestType[type], response);
    }
  }

  async track(users) {
    await this.machine.updateTrackedUsers(users.map(userId));
    await this.sync();
  }

  async getDevice(user, device, timeoutSecs = 5) {
    return this.machine.getDevice(userId(user), deviceId(device), timeoutSecs);
  }

  // Establish sessions with any of `users`' devices we have not talked to yet.
  async ensureSessions(users) {
    const missing = await this.machine.getMissingSessions(users.map(userId));
    if (!missing) return;
    const response = await this.transport.send('KeysClaim', { user: this.user, device: this.device, body: missing.body, id: missing.id });
    await this.machine.markRequestAsSent(missing.id, sdk.RequestType.KeysClaim, response);
  }

  // Encrypt one payload for one device, and return the envelope the hub should carry.
  //
  // The outer type must be `m.room.encrypted`: that is what tells a receiving machine to
  // decrypt rather than to treat the body as plaintext. Getting it wrong does not error -
  // the event simply arrives unencrypted-looking - so the envelope is built here and not
  // left to callers.
  async sealTo(user, device, type, payload) {
    await this.ensureSessions([user]);
    const target = await this.getDevice(user, device);
    if (!target) throw new Error('unknown endpoint ' + user + '/' + device);
    const ciphertext = await target.encryptToDeviceEvent(type, payload);
    return {
      type: 'm.room.encrypted',
      sender: this.user,
      content: typeof ciphertext === 'string' ? JSON.parse(ciphertext) : ciphertext
    };
  }

  // Hand the machine a batch of envelopes the hub delivered to us.
  //
  // Every returned event carries a `type` saying how it arrived. Only `Decrypted` was
  // actually protected in transit; a `PlainText` or `UnableToDecrypt` event must never be
  // treated as authentic, which is why that distinction is surfaced rather than flattened.
  async open(envelopes) {
    const processed = await this.machine.receiveSyncChanges(
      JSON.stringify(envelopes), new sdk.DeviceLists(), new Map(), undefined,
      new sdk.DecryptionSettings(sdk.TrustRequirement.Untrusted)
    );
    const out = [];
    for (const e of processed) {
      const decrypted = e.type === sdk.ProcessedToDeviceEventType.Decrypted;
      let raw = null;
      try { raw = JSON.parse(e.rawEvent); } catch {}
      out.push({
        processedAs: e.type,
        decrypted,
        type: raw && raw.type,
        sender: raw && raw.sender,
        content: raw && raw.content
      });
    }
    return out;
  }

  identity() {
    const keys = this.machine.identityKeys;
    return { user: this.user, device: this.device, curve25519: keys.curve25519.toBase64(), ed25519: keys.ed25519.toBase64() };
  }
}

module.exports = { Endpoint, REQUEST_TYPES, init, sdk };
