'use strict';
import { assertPublishedStore, createOwnerRecoveryKitAPI } from './owner-recovery-kit.mjs';
// One cryptographic endpoint - a desktop app, a browser profile, or an execution host.
//
// Spike for issue #3. This is a thin seam over @matrix-org/matrix-sdk-crypto-wasm: the
// crypto is entirely theirs (Olm/Megolm via vodozemac, Apache-2.0, the stack Element
// ships), and what lives here is only the transport binding, because that library is
// shaped around Matrix's client-server endpoints and this product has its own hub.
//
// Nothing in this file implements a cryptographic primitive, and nothing in it should.
export function createEndpointAPI(sdk) {

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
const bytes64 = bytes => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(binary);
};
const from64 = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
const recoveryContext = new TextEncoder().encode('plexus.verified-history.v1');
async function recoveryEnvelopeKey(recoveryKey, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(recoveryKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: recoveryContext }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

class Endpoint {
  constructor({ user, device, transport, recoveredHistory = [], log = () => {} }) {
    this.user = user;           // '@alice:plexus.local'
    this.device = device;       // 'ALICEDEV'
    this.transport = transport; // the hub binding; see KeyTransport below
    this.log = log;
    this.machine = null;
    this.verifiedHistory = new Map();
    // Application-local durable trust metadata. Only authenticated recovery imports may
    // populate it; callers must never fill it from a relay response or a raw key export.
    this.recoveredHistory = new Map(recoveredHistory.map(entry => [entry.roomId + '/' + entry.sessionId, entry]));
  }

  // `storeName` gives a persistent store, which this library backs with IndexedDB - so it
  // works in a browser or an Electron renderer and NOT in Node, where it throws. Omitting
  // it yields a memory store whose keys die with the process. See the threat model.
  static async create(opts) {
    const marker = await assertPublishedStore(opts);
    const ep = await openInactive(opts);
    try {
      if (marker?.identity && !['user', 'device', 'curve25519', 'ed25519'].every(key => marker.identity[key] === ep.identity()[key])) {
        throw Object.assign(new Error('owner_recovery_store_mismatch'), { code: 'owner_recovery_store_mismatch' });
      }
      await ep.sync(); return ep;
    }
    catch (error) { ep.close(); throw error; }
  }

  static async storageSupport() {
    await init();
    try {
      await sdk.StoreHandle.open('plexus-probe', 'probe');
      return { persistent: true, backend: 'indexeddb' };
    } catch (e) {
      return { persistent: false, backend: 'memory', reason: String(e.message || e) };
    }
  }

  // Publish our public keys and pick up everyone else's. The hub only ever handles public
  // material here; the private half never leaves this process.
  async sync() {
    ownerRecovery.assertActive(this);
    return syncRequests(this);
  }

  // `updateTrackedUsers` only marks users as interesting; the key query is issued lazily
  // off a sync we do not have. `queryKeysForUsers` forces it, which is what makes another
  // endpoint visible right now rather than eventually.
  async track(users) {
    ownerRecovery.assertActive(this);
    await this.machine.updateTrackedUsers(users.map(userId));
    const req = this.machine.queryKeysForUsers(users.map(userId));
    if (req) {
      const response = await this.transport.send('KeysQuery', { user: this.user, device: this.device, body: req.body, id: req.id });
      await this.machine.markRequestAsSent(req.id, sdk.RequestType.KeysQuery, response);
    }
    await this.sync();
  }

  async getDevice(user, device, timeoutSecs = 5) {
    return this.machine.getDevice(userId(user), deviceId(device), timeoutSecs);
  }

  // The endpoints a user or an execution host has published, as identities a person can
  // compare against a fingerprint shown on the machine itself. The relay supplies these, so
  // nothing here is trusted by being listed: confirmEndpoint() is still the act that makes
  // one readable, and this only gives a client something to put in front of a human.
  async peerEndpoints(user) {
    await this.track([user]);
    const held = await this.machine.getUserDevices(userId(user), 5);
    return held.devices()
      .map((device) => ({
        user,
        device: device.deviceId.toString(),
        curve25519: device.curve25519Key ? device.curve25519Key.toBase64() : null,
        ed25519: device.ed25519Key ? device.ed25519Key.toBase64() : null,
        verified: device.isVerified()
      }))
      .filter((endpoint) => endpoint.curve25519 && endpoint.ed25519);
  }

  // Establish sessions with any of `users`' devices we have not talked to yet.
  async ensureSessions(users) {
    ownerRecovery.assertActive(this);
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
  async sealTo(user, device, type, payload, { verified = false } = {}) {
    await this.ensureSessions([user]);
    const target = await this.getDevice(user, device);
    if (!target) throw new Error('unknown endpoint ' + user + '/' + device);
    const ciphertext = await target.encryptToDeviceEvent(type, payload,
      verified ? sdk.CollectStrategy.onlyTrustedDevices() : undefined);
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
    ownerRecovery.assertActive(this);
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
        content: raw && raw.content,
        verified: decrypted && e.encryptionInfo.isSenderVerified(),
        senderDevice: decrypted ? e.encryptionInfo.senderDevice?.toString() : null,
        senderKey: decrypted ? e.encryptionInfo.senderCurve25519Key : null
      });
    }
    return out;
  }

  // ---- shared task sessions, and rotating them on membership change ----
  //
  // A to-device message is sealed for one device, which is fine for control but wrong for
  // a task several people watch. A group session is shared once with the current members
  // and used for everything after - which is also what makes removal meaningful, because
  // the session can be thrown away and the next one shared with fewer people.

  // Hand the current group session to everyone who should be able to read what follows.
  async shareTaskKey(roomId, users, { members } = {}) {
    ownerRecovery.assertActive(this);
    // The group key itself travels sealed to each device, so the Olm sessions have to
    // exist before it can be handed out at all.
    await this.ensureSessions(users);
    const settings = new sdk.EncryptionSettings();
    if (members) settings.sharingStrategy = sdk.CollectStrategy.onlyTrustedDevices();
    const reqs = await this.machine.shareRoomKey(new sdk.RoomId(roomId), users.map(userId), settings);
    let delivered = 0;
    for (const req of reqs || []) {
      const body = JSON.parse(req.body);
      for (const [user, devices] of Object.entries(body.messages || {})) {
        for (const [device, content] of Object.entries(devices)) {
          if (members && !members.some((member) => member.user === user && member.device === device)) continue;
          const r = await this.transport.deliverToDevice(user, device, { type: req.eventType || 'm.room.encrypted', sender: this.user, content });
          if (r && r.delivered) delivered++;
        }
      }
      try { await this.machine.markRequestAsSent(req.id, sdk.RequestType.ToDevice, '{}'); } catch {}
    }
    return { requests: (reqs || []).length, delivered };
  }

  // The complete experiment uses an exact, already-confirmed endpoint set. SDK user
  // discovery alone must never enroll another device into a project's key recipients.
  // Rotate on every membership share, including re-adding a previously excluded device.
  // `rotate` is the difference between adding someone and removing someone. Sharing the
  // session as it stands lets a new reader open what was already written with it, which is
  // what joining a task in progress means. Rotating first denies exactly that, which is what
  // removing someone means. Defaulting to rotation keeps the safer act the unmarked one.
  async shareVerifiedTaskKey(roomId, members, { rotate = true } = {}) {
    if (!Array.isArray(members) || members.length === 0) throw new Error('task_members_required');
    for (const member of members) {
      const target = await this.getDevice(member.user, member.device);
      if (!target?.isVerified() || target.curve25519Key?.toBase64() !== member.curve25519 ||
          target.ed25519Key?.toBase64() !== member.ed25519) throw new Error('endpoint_unverified');
    }
    if (rotate) await this.rotateTaskKey(roomId);
    return this.shareTaskKey(roomId, [...new Set(members.map((member) => member.user))], { members });
  }

  async encryptTask(roomId, type, content) {
    const ciphertext = await this.machine.encryptRoomEvent(new sdk.RoomId(roomId), type, JSON.stringify(content));
    return { type: 'm.room.encrypted', sender: this.user, room_id: roomId, content: JSON.parse(ciphertext) };
  }

  async decryptTask(roomId, event) {
    const wire = JSON.stringify({
      type: 'm.room.encrypted',
      sender: event.sender,
      event_id: event.event_id || ('$' + Math.random().toString(36).slice(2)),
      origin_server_ts: event.origin_server_ts || Date.now(),
      room_id: roomId,
      content: event.content
    });
    const decrypted = await this.machine.decryptRoomEvent(
      wire, new sdk.RoomId(roomId), new sdk.DecryptionSettings(sdk.TrustRequirement.Untrusted)
    );
    return JSON.parse(decrypted.event);
  }

  // Task replay trusts an explicitly confirmed device, not merely a relay's sender
  // field or an imported session's claimed keys. Cross-signing an entire account is
  // not required for the device-fingerprint enrollment used by this adapter.
  // `admittedSessions` is the enrollment contract #6 left open, made explicit.
  //
  // A session that arrived as an import cannot prove its own provenance - the SDK says
  // AuthenticityNotGuaranteed and it is right to, because an export is exactly what an
  // attacker would also hand you. Refusing every import outright was #6's position, and it
  // makes joining a project late impossible: megolm exports a session key at its *current*
  // ratchet index, so being admitted to a running session buys the next event and never a
  // past one.
  //
  // So the trust is moved to where it can actually be checked: the reader accepts an
  // unauthenticated session only if that exact session id came out of a handoff it opened
  // itself, sealed by an endpoint whose fingerprint it had already confirmed. Every other
  // import stays refused, and every other check here still applies to the event.
  async decryptVerifiedTask(roomId, event, expected, { admittedSessions } = {}) {
    if (!expected || event?.type !== 'm.room.encrypted' || event.room_id !== roomId) throw new Error('task_integrity_failed');
    const decrypted = await this.machine.decryptRoomEvent(JSON.stringify(event), new sdk.RoomId(roomId),
      new sdk.DecryptionSettings(sdk.TrustRequirement.Untrusted));
    const shield = decrypted.shieldState(true);
    const historyKey = roomId + '/' + event.content?.session_id;
    const recovered = this.recoveredHistory.get(historyKey);
    const recoveredWriter = recovered && ['user', 'device', 'curve25519', 'ed25519']
      .every(key => recovered.writer[key] === expected[key]);
    const admitted = shield.code === sdk.ShieldStateCode.AuthenticityNotGuaranteed &&
      (recoveredWriter || (!!admittedSessions && admittedSessions.has(event.content?.session_id)));
    const allowedShield = shield.color === sdk.ShieldColor.None || admitted ||
      shield.code === sdk.ShieldStateCode.UnverifiedIdentity || shield.code === sdk.ShieldStateCode.UnsignedDevice;
    // An exported session carries the writer's keys but not its device id - the format has
    // no field for one - so an admitted session cannot be checked against a device name.
    // The curve25519/ed25519 pair still identifies that exact device's keys, and the device
    // must still be one this endpoint has confirmed, so the identity check survives; only
    // the name it is spelled with is unavailable. Every non-admitted session is unchanged.
    const deviceAttributed = admitted || decrypted.senderDevice?.toString() === expected.device;
    if (!allowedShield || !deviceAttributed || decrypted.sender.toString() !== expected.user ||
        decrypted.senderCurve25519Key !== expected.curve25519 ||
        decrypted.senderClaimedEd25519Key !== expected.ed25519 ||
        (!recoveredWriter && !await this.isEndpointVerified(expected.user, expected.device))) {
      throw new Error('task_sender_unverified');
    }
    this.verifiedHistory.set(historyKey, { roomId, sessionId: event.content.session_id, writer: { ...expected } });
    return JSON.parse(decrypted.event);
  }

  // Throw the current group session away. The next share creates a new one, so anyone left
  // out of that share cannot read anything sent afterwards - which is the difference
  // between a relay declining to deliver and a device actually being unable to read.
  async rotateTaskKey(roomId) {
    return this.machine.invalidateGroupSession(new sdk.RoomId(roomId));
  }

  // ---- endpoint identity and verification ----

  // Establish or republish this account's cross-signing identity. Repeating setup must
  // retain the existing root and signatures; a reset needs a separate rotation ceremony.
  // The keys it publishes are public; the private halves stay in this machine's store.
  async bootstrapCrossSigning() {
    ownerRecovery.assertActive(this);
    return publishCrossSigning(this, false);
  }

  // An already-trusted endpoint vouching for another one. This is the step that stops a
  // relay-supplied key from being accepted just because the relay served it.
  async verifyEndpoint(user, device) {
    ownerRecovery.assertActive(this);
    const target = await this.getDevice(user, device);
    if (!target) throw new Error('unknown endpoint ' + user + '/' + device);
    const req = await target.verify();
    if (req) {
      await this.transport.send('SignatureUpload', { user: this.user, device: this.device, body: req.body, id: req.id });
    }
    // The signature only counts once we have read it back off the directory: trust comes
    // from the published signature, not from having sent one.
    await this.track([user]);
    return true;
  }

  async isEndpointVerified(user, device) {
    const target = await this.getDevice(user, device);
    return !!(target && target.isVerified());
  }

  // Owner authority recovery creates a different inactive store. The ordinary create
  // path cannot reopen it until the explicit publication ceremony has completed.
  static stageOwnerRecovery(options) { return ownerRecovery.stage(options); }
  static resumeOwnerRecovery(options) { return ownerRecovery.stage(options, true); }
  static drillOwnerRecoveryKit(options) { return ownerRecovery.drillKit(options); }
  ownerRecoveryIdentity(options) { return ownerRecovery.identity(this, options); }
  provisionOwnerRecoveryKit(options) { return ownerRecovery.provision(this, options); }
  ownerRecoveryStatus() { return ownerRecovery.status(this); }
  drillOwnerRecovery() { return ownerRecovery.drill(this); }
  publishOwnerRecovery(options) { return ownerRecovery.publish(this, options); }
  signOwnerRecovery(body, options) { return ownerRecovery.signRecovery(this, body, options); }

  // ---- customer-held recovery ----

  // The customer holds this key. The relay stores only material encrypted to it, so a
  // clean endpoint can be restored without the operator holding any secret.
  async enableRecovery(version = '1') {
    const key = sdk.BackupDecryptionKey.createRandomKey();
    await this.machine.enableBackupV1(key.megolmV1PublicKey.publicKeyBase64, version);
    await this.machine.saveBackupDecryptionKey(key, version);
    return { recoveryKey: key.toBase64(), version };
  }

  async recoveryKeyOnThisEndpoint() {
    const keys = await this.machine.getBackupKeys();
    return keys && keys.decryptionKeyBase64 ? keys.decryptionKeyBase64 : null;
  }

  // Restore on a clean endpoint using only the customer's key.
  async restoreRecovery(recoveryKeyBase64, version = '1') {
    const key = sdk.BackupDecryptionKey.fromBase64(recoveryKeyBase64);
    await this.machine.saveBackupDecryptionKey(key, version);
    const keys = await this.machine.getBackupKeys();
    return !!(keys && keys.decryptionKeyBase64);
  }

  // Confirmation material must arrive through an already trusted channel (e.g. compare
  // the fingerprint on the existing device). A server account or key query is not trust.
  async confirmEndpoint(expected, { confirmed = false } = {}) {
    if (!confirmed) throw new Error('endpoint_confirmation_required');
    await this.track([expected.user]);
    const target = await this.getDevice(expected.user, expected.device);
    if (!target || target.curve25519Key?.toBase64() !== expected.curve25519 ||
        target.ed25519Key?.toBase64() !== expected.ed25519) throw new Error('endpoint_key_mismatch');
    await target.setLocalTrust(sdk.LocalTrust.Verified);
    return true;
  }

  async sign(message) {
    ownerRecovery.assertActive(this);
    if (typeof message !== 'string') throw new Error('invalid_signed_message');
    const signatures = await this.machine.sign(message);
    const signature = signatures.getSignature(userId(this.user), new sdk.DeviceKeyId('ed25519:' + this.device));
    if (!signature) throw new Error('device_signature_unavailable');
    return signature.toBase64();
  }

  async sealControl(user, device, payload) {
    if (!await this.isEndpointVerified(user, device)) throw new Error('endpoint_unverified');
    return this.sealTo(user, device, 'plexus.control.v1', payload, { verified: true });
  }

  async openControl(envelopes) {
    const events = await this.open(envelopes);
    if (events.length !== 1 || !events[0].decrypted || !events[0].verified ||
        events[0].type !== 'plexus.control.v1' || !events[0].senderDevice) {
      throw new Error('control_not_authenticated');
    }
    return events[0];
  }

  // Matrix's authenticated encrypted room-key export format supplies the crypto.
  // Only the explicitly selected opaque rooms are backed up. Approval authority and
  // device identity are deliberately not part of history restoration.
  async exportHistory(roomIds, recoveryKey) {
    if (!Array.isArray(roomIds) || !roomIds.length || typeof recoveryKey !== 'string' || recoveryKey.length < 32) {
      throw new Error('recovery_scope_and_key_required');
    }
    const allowed = new Set(roomIds);
    const keys = await this.machine.exportRoomKeys((session) => allowed.has(session.roomId.toString()));
    if (!JSON.parse(keys).length) throw new Error('recovery_history_empty');
    return sdk.OlmMachine.encryptExportedRoomKeys(keys, recoveryKey, 500000);
  }

  async importHistory(encrypted, recoveryKey, roomIds) {
    const exported = sdk.OlmMachine.decryptExportedRoomKeys(encrypted, recoveryKey);
    const keys = JSON.parse(exported);
    const allowed = new Set(roomIds);
    if (!keys.length || keys.some((key) => !allowed.has(key.room_id))) throw new Error('recovery_scope_mismatch');
    const imported = await this.machine.importExportedRoomKeys(exported, () => {});
    // The session ids are returned because the caller has to be able to say later which
    // sessions this particular handoff brought in. See decryptVerifiedTask.
    return { imported: Number(imported.importedCount), total: keys.length, sessions: keys.map((key) => key.session_id) };
  }

  // Unlike a bare room-key export, a customer backup carries the host fingerprints whose
  // events this endpoint actually verified. Imported key metadata is not provenance.
  async exportRecoveryHistory(roomIds, recoveryKey) {
    const allowed = new Set(roomIds);
    const history = [...this.verifiedHistory.values(), ...this.recoveredHistory.values()]
      .filter(entry => allowed.has(entry.roomId));
    const unique = new Map(history.map(entry => [entry.roomId + '/' + entry.sessionId, entry]));
    if (roomIds.some(room => !history.some(entry => entry.roomId === room))) throw new Error('recovery_verified_history_required');
    const exported = JSON.parse(await this.machine.exportRoomKeys(session => allowed.has(session.roomId.toString())));
    const keys = exported.filter(key => {
      const entry = unique.get(key.room_id + '/' + key.session_id);
      return entry && key.sender_key === entry.writer.curve25519 && key.sender_claimed_keys?.ed25519 === entry.writer.ed25519;
    });
    if (!keys.length || roomIds.some(room => !keys.some(key => key.room_id === room))) throw new Error('recovery_verified_history_required');
    const present = new Set(keys.map(key => key.room_id + '/' + key.session_id));
    const manifest = [...unique].filter(([key]) => present.has(key)).map(([, entry]) => entry);
    const exportedKeys = sdk.OlmMachine.encryptExportedRoomKeys(JSON.stringify(keys), recoveryKey, 500000);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await recoveryEnvelopeKey(recoveryKey, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify({ history: manifest, exportedKeys }));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: recoveryContext }, key, plaintext);
    return JSON.stringify({ format: 'plexus.verified-history.v1', salt: bytes64(salt), iv: bytes64(iv), ciphertext: bytes64(new Uint8Array(encrypted)) });
  }

  async importRecoveryHistory(encrypted, recoveryKey, roomIds) {
    const envelope = JSON.parse(encrypted);
    if (envelope?.format !== 'plexus.verified-history.v1') throw new Error('recovery_verified_history_required');
    const salt = from64(envelope.salt), iv = from64(envelope.iv);
    if (salt.length !== 32 || iv.length !== 12) throw new Error('recovery_material_rejected');
    const key = await recoveryEnvelopeKey(recoveryKey, salt);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: recoveryContext }, key, from64(envelope.ciphertext));
    const decoded = JSON.parse(new TextDecoder().decode(plaintext));
    decoded.keys = JSON.parse(sdk.OlmMachine.decryptExportedRoomKeys(decoded.exportedKeys, recoveryKey));
    if (!Array.isArray(decoded.history) || !Array.isArray(decoded.keys)) {
      throw new Error('recovery_verified_history_required');
    }
    const history = decoded.history;
    roomIds = roomIds || [...new Set(history.map(entry => entry.roomId))];
    const allowed = new Set(roomIds);
    if (!history.length || history.some(entry => !allowed.has(entry.roomId)) ||
        roomIds.some(room => !history.some(entry => entry.roomId === room))) throw new Error('recovery_scope_mismatch');
    const manifest = new Map();
    for (const entry of history) {
      if (typeof entry.sessionId !== 'string' || !entry.writer ||
          !['user', 'device', 'curve25519', 'ed25519'].every(key => typeof entry.writer[key] === 'string' && entry.writer[key])) {
        throw new Error('recovery_material_rejected');
      }
      manifest.set(entry.roomId + '/' + entry.sessionId, entry);
    }
    if (!decoded.keys.length || decoded.keys.some(key => {
      const entry = manifest.get(key.room_id + '/' + key.session_id);
      return !entry || key.sender_key !== entry.writer.curve25519 || key.sender_claimed_keys?.ed25519 !== entry.writer.ed25519;
    })) throw new Error('recovery_material_rejected');
    const imported = await this.machine.importExportedRoomKeys(JSON.stringify(decoded.keys), () => {});
    for (const [key, entry] of manifest) this.recoveredHistory.set(key, structuredClone(entry));
    return { imported: Number(imported.importedCount), total: decoded.keys.length,
      sessions: decoded.keys.map(key => key.session_id), history: structuredClone(history) };
  }

  close() { this.machine?.close(); this.machine = null; }

  identity() {
    const keys = this.machine.identityKeys;
    return { user: this.user, device: this.device, curve25519: keys.curve25519.toBase64(), ed25519: keys.ed25519.toBase64() };
  }
}

// Internal construction deliberately makes no outgoing SDK request. Only normal
// creation and explicit validated recovery publication may call the transport helpers.
async function openInactive(opts) {
  await init();
  const endpoint = new Endpoint(opts);
  if (opts.storeName) {
    if (!opts.storeKey && !opts.storePassphrase) throw new Error('encrypted_store_key_required');
    const handle = opts.storeKey
      ? await sdk.StoreHandle.openWithKey(opts.storeName, Uint8Array.from(opts.storeKey))
      : await sdk.StoreHandle.open(opts.storeName, opts.storePassphrase);
    endpoint.machine = await sdk.OlmMachine.initFromStore(userId(endpoint.user), deviceId(endpoint.device), handle);
  } else endpoint.machine = await sdk.OlmMachine.initialize(userId(endpoint.user), deviceId(endpoint.device));
  // initFromStore may return the identity already in the database. Caller labels
  // cannot rename it, including when resuming an inactive recovery store.
  if (endpoint.machine.userId.toString() !== opts.user || endpoint.machine.deviceId.toString() !== opts.device) {
    endpoint.close();
    throw Object.assign(new Error('owner_recovery_store_mismatch'), { code: 'owner_recovery_store_mismatch' });
  }
  return endpoint;
}
async function syncRequests(endpoint) {
  for (const req of await endpoint.machine.outgoingRequests()) {
    const type = REQUEST_TYPES[req.constructor.name];
    if (!type) { endpoint.log('unhandled request ' + req.constructor.name); continue; }
    const response = await endpoint.transport.send(type, { user: endpoint.user, device: endpoint.device, body: req.body, id: req.id });
    await endpoint.machine.markRequestAsSent(req.id, sdk.RequestType[type], response);
  }
}
async function publishCrossSigning(endpoint, replaceAuthority, transport = endpoint.transport) {
  endpoint.transport = transport;
  const reqs = await endpoint.machine.bootstrapCrossSigning(replaceAuthority);
  for (const req of [reqs.uploadKeysRequest, reqs.uploadSigningKeysRequest, reqs.uploadSignaturesRequest]) {
    if (!req) continue;
    const kind = req.constructor.name;
    const type = REQUEST_TYPES[kind] || (kind.includes('SigningKeys') ? 'SigningKeysUpload' : null);
    if (!type) continue;
    await transport.send(type, { user: endpoint.user, device: endpoint.device, body: req.body, id: req.id });
    if (sdk.RequestType[type] !== undefined && req.id) {
      try { await endpoint.machine.markRequestAsSent(req.id, sdk.RequestType[type], '{}'); } catch {}
    }
  }
  await syncRequests(endpoint);
  return endpoint.machine.crossSigningStatus();
}
const ownerRecovery = createOwnerRecoveryKitAPI({ sdk, openInactive, publishCrossSigning });

return { Endpoint, REQUEST_TYPES, init, sdk };
}
