// Account-level cross-signing recovery stays inside the endpoint. Callers receive only
// encrypted kits, public provenance and narrowly scoped signatures, never SDK seeds.
import { canonical } from '../protocol/encrypted-task.mjs';
import { replayMembership, sameIdentity, verifySignature } from './membership.mjs';
import { validateRecoveryDescriptor, recoveryDescriptorHash, ownerRecoverySigningBody } from './owner-recovery.mjs';

const FORMAT = 'plexus.owner-recovery-kit.v1';
const MAX_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const clone = value => structuredClone(value);
const bytes64 = bytes => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 32768) out += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(out);
};
const decode64 = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) fail('owner_recovery_material_rejected');
  try { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
  catch { fail('owner_recovery_material_rejected'); }
};
const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(v => v.toString(16).padStart(2, '0')).join('');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function createOwnerRecoveryKey() {
  return bytes64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function context(expected) {
  if (!expected || typeof expected.owner !== 'string' || !/^@[^:]+:plexus\.local$/.test(expected.owner) ||
      typeof expected.teamId !== 'string' || !expected.teamId || typeof expected.service !== 'string') fail('owner_recovery_context_required');
  let origin;
  try { origin = new URL(expected.service); } catch { fail('owner_recovery_context_required'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== expected.service) fail('owner_recovery_context_required');
  return { service: expected.service, teamId: expected.teamId, owner: expected.owner };
}
async function wrappingKey(recoveryKey, salt, expected) {
  const raw = decode64(recoveryKey);
  if (raw.length !== 32) fail('owner_recovery_key_invalid');
  const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt,
    info: encoder.encode(canonical({ format: FORMAT, ...context(expected) })) }, material,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(payload, recoveryKey, expected) {
  const plaintext = encoder.encode(JSON.stringify(payload));
  if (plaintext.length > MAX_BYTES) fail('owner_recovery_kit_too_large');
  const salt = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await wrappingKey(recoveryKey, salt, expected);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(FORMAT) }, key, plaintext);
  return JSON.stringify({ format: FORMAT, salt: bytes64(salt), iv: bytes64(iv), ciphertext: bytes64(new Uint8Array(ciphertext)) });
}
async function unseal(ciphertext, recoveryKey, expected) {
  context(expected);
  if (typeof ciphertext !== 'string' || ciphertext.length > MAX_BYTES * 2) fail('owner_recovery_material_rejected');
  try {
    const value = JSON.parse(ciphertext);
    if (!exact(value, ['format', 'salt', 'iv', 'ciphertext']) || value.format !== FORMAT) fail('owner_recovery_material_rejected');
    const salt = decode64(value.salt), iv = decode64(value.iv);
    if (salt.length !== 32 || iv.length !== 12) fail('owner_recovery_material_rejected');
    const key = await wrappingKey(recoveryKey, salt, expected);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(FORMAT) }, key, decode64(value.ciphertext));
    if (plaintext.byteLength > MAX_BYTES) fail('owner_recovery_material_rejected');
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch { fail('owner_recovery_material_rejected'); }
}
async function authenticatedHead(descriptor, log, expected) {
  context(expected);
  validateRecoveryDescriptor(descriptor, expected);
  const head = await replayMembership(log, { teamId: expected.teamId, authority: descriptor.genesis,
    service: expected.service, checkpoint: expected.checkpoint });
  if (!sameIdentity(head.owner, descriptor.genesis) || !head.recoveryDescriptor ||
      await recoveryDescriptorHash(head.recoveryDescriptor) !== await recoveryDescriptorHash(descriptor)) fail('owner_recovery_descriptor_inactive');
  return head;
}
function strippedBundle(value) {
  if (!exact(value, ['master_key', 'self_signing_key', 'user_signing_key']) ||
      Object.values(value).some(seed => decode64(seed).length !== 32)) fail('owner_recovery_material_rejected');
  return { cross_signing: value, backup: null };
}

// The public marker is separate from the SDK store. It is written before creating a
// persistent staging identity, so a restart cannot accidentally sync that identity via
// ordinary Endpoint.create. It contains no recovery key, seed or history content.
async function lifecycle(storeName, write, expected) {
  if (!storeName) return null;
  if (!globalThis.indexedDB) fail('owner_recovery_storage_unavailable');
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('plexus-owner-recovery-lifecycle', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('endpoints');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('blocked'));
    });
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('endpoints', write === undefined ? 'readonly' : 'readwrite');
      const request = tx.objectStore('endpoints').get(storeName);
      let result;
      request.onsuccess = () => {
        result = request.result;
        if (write !== undefined) {
          if (canonical(result || null) !== canonical(expected || null)) {
            reject(Object.assign(new Error('owner_recovery_store_changed'), { code: 'owner_recovery_store_changed' })); tx.abort(); return;
          }
          tx.objectStore('endpoints').put(write, storeName);
        }
      };
      tx.oncomplete = () => resolve(result || null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (error) { if (error.code === 'owner_recovery_store_changed') throw error; fail('owner_recovery_storage_unavailable'); }
  finally { db?.close(); }
}
async function lifecycleKey(storeName, storeKey) {
  if (!storeKey || Uint8Array.from(storeKey).length !== 32) fail('owner_recovery_store_mismatch');
  const material = await crypto.subtle.importKey('raw', Uint8Array.from(storeKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('plexus.owner-recovery.lifecycle.v1'),
    info: encoder.encode(storeName) }, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
}
async function readLifecycle(storeName, storeKey) {
  const held = await lifecycle(storeName);
  if (!held) return null;
  if (!exact(held, ['marker', 'signature']) || !await crypto.subtle.verify('HMAC', await lifecycleKey(storeName, storeKey),
    decode64(held.signature), encoder.encode(canonical(held.marker)))) fail('owner_recovery_store_mismatch');
  return held.marker;
}
async function saveLifecycle(storeName, storeKey, marker) {
  if (!storeName) return;
  const key = await lifecycleKey(storeName, storeKey), prior = await lifecycle(storeName);
  if (prior) {
    if (!exact(prior, ['marker', 'signature']) || !await crypto.subtle.verify('HMAC', key, decode64(prior.signature),
      encoder.encode(canonical(prior.marker)))) fail('owner_recovery_store_mismatch');
    if (prior.marker.user !== marker.user || prior.marker.device !== marker.device || prior.marker.descriptorHash !== marker.descriptorHash ||
        (prior.marker.identity && !sameIdentity(prior.marker.identity, marker.identity))) fail('owner_recovery_store_mismatch');
    if (prior.marker.checkpoint.seq > marker.checkpoint.seq || (prior.marker.checkpoint.seq === marker.checkpoint.seq &&
      prior.marker.checkpoint.hash !== marker.checkpoint.hash)) fail('membership_rollback');
  }
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(canonical(marker)));
  // Compare-and-write in the same transaction also prevents two reopened instances
  // from overwriting a later observed floor while WebCrypto was awaiting verification.
  await lifecycle(storeName, { marker, signature: bytes64(new Uint8Array(signature)) }, prior);
}
export async function assertPublishedStore(opts) {
  if (!opts.storeName || !globalThis.indexedDB) return;
  const marker = await readLifecycle(opts.storeName, opts.storeKey);
  if (!marker) {
    if (opts.storeName.startsWith('plexus-owner-recovery-')) fail('owner_recovery_inactive');
    return null;
  }
  if (marker.state !== 'published') fail('owner_recovery_inactive');
  if (marker.user !== opts.user || marker.device !== opts.device) fail('owner_recovery_store_mismatch');
  return marker;
}

export function createOwnerRecoveryKitAPI({ sdk, openInactive, publishCrossSigning }) {
  const staged = new WeakMap(), ceremonies = new WeakMap();
  const ceremony = (endpoint, work) => {
    const pending = (ceremonies.get(endpoint) || Promise.resolve()).then(work);
    ceremonies.set(endpoint, pending.catch(() => {}));
    return pending;
  };
  const assertActive = endpoint => {
    const state = staged.get(endpoint);
    if (state && state.state !== 'published') fail('owner_recovery_inactive');
  };
  async function publicMaster(endpoint) {
    const own = await endpoint.machine.getIdentity(new sdk.UserId(endpoint.user));
    const values = own ? Object.values(JSON.parse(own.masterKey).keys || {}) : [];
    if (values.length !== 1 || decode64(values[0]).length !== 32) fail('owner_recovery_identity_unavailable');
    return values[0];
  }
  async function signature(endpoint, message, masterKey) {
    const signatures = await endpoint.machine.sign(canonical(message));
    const value = signatures.getSignature(new sdk.UserId(endpoint.user), new sdk.DeviceKeyId('ed25519:' + masterKey));
    if (!value) fail('owner_recovery_identity_unavailable');
    return value.toBase64();
  }
  async function drill(endpoint) {
    const state = staged.get(endpoint);
    if (!state) fail('owner_recovery_stage_required');
    const challenge = { type: 'plexus.owner-recovery.drill.v1', descriptorHash: await recoveryDescriptorHash(state.descriptor),
      candidate: endpoint.identity(), nonce: randomId() };
    if (!await verifySignature({ ed25519: state.descriptor.masterKey }, challenge,
      await signature(endpoint, challenge, state.descriptor.masterKey))) fail('owner_recovery_master_mismatch');
    return { verified: true, masterKey: state.descriptor.masterKey, identity: endpoint.identity(), historySessions: state.history.length };
  }
  function status(endpoint) {
    const state = staged.get(endpoint);
    if (!state) fail('owner_recovery_stage_required');
    return clone({ state: state.state, storeName: state.storeName, identity: endpoint.identity(), descriptor: state.descriptor,
      log: state.log, checkpoint: state.checkpoint, history: state.history,
      taskIds: [...new Set(state.history.map(entry => /^!(et_[a-f0-9]{32}):plexus\.local$/.exec(entry.roomId)?.[1]).filter(Boolean))] });
  }
  async function stage(options, resume = false) {
    const { ciphertext, recoveryKey, expected } = options;
    const payload = await unseal(ciphertext, recoveryKey, expected);
    if (!exact(payload, ['version', 'descriptor', 'log', 'checkpoint', 'crossSigning', 'history']) || payload.version !== 1 ||
        !(payload.history === null || typeof payload.history === 'string')) fail('owner_recovery_material_rejected');
    const kitHead = await authenticatedHead(payload.descriptor, payload.log, { ...expected, checkpoint: undefined });
    if (canonical(payload.checkpoint) !== canonical({ seq: kitHead.seq, hash: kitHead.hash })) fail('owner_recovery_checkpoint_mismatch');
    const currentLog = options.log || payload.log;
    await authenticatedHead(payload.descriptor, currentLog, { ...expected, checkpoint: payload.checkpoint });
    let head = await authenticatedHead(payload.descriptor, currentLog, expected);
    const bundle = strippedBundle(payload.crossSigning);
    let storeName = null, device = 'RECOVERY' + randomId().toUpperCase(), marker;
    const descriptorHash = await recoveryDescriptorHash(payload.descriptor);
    if (resume) {
      if (typeof options.storeName !== 'string' || !/^plexus-owner-recovery-[a-f0-9]{32}$/.test(options.storeName)) fail('owner_recovery_stage_required');
      storeName = options.storeName; marker = await readLifecycle(storeName, options.storeKey);
      if (!marker || !['staged', 'published'].includes(marker.state) || marker.user !== expected.owner || marker.descriptorHash !== descriptorHash ||
          !/^RECOVERY[A-F0-9]{32}$/.test(marker.device)) fail('owner_recovery_store_mismatch');
      head = await authenticatedHead(payload.descriptor, currentLog, { ...expected, checkpoint: marker.checkpoint });
      device = marker.device;
    } else {
      if (options.storeName || options.device || options.user) fail('owner_recovery_clean_store_required');
      if (options.persistent) {
        if (!options.storeKey) fail('encrypted_store_key_required');
        storeName = 'plexus-owner-recovery-' + randomId();
        marker = { version: 1, state: 'staged', user: expected.owner, device, descriptorHash, identity: null,
          checkpoint: { seq: head.seq, hash: head.hash } };
        await saveLifecycle(storeName, options.storeKey, marker);
      }
    }
    // All account/service/team/genesis/descriptor/floor checks precede SDK import.
    const endpoint = await openInactive({ user: expected.owner, device, storeName, storeKey: options.storeKey });
    try {
      staged.set(endpoint, { state: 'staged', storeName, storeKey: options.storeKey ? Uint8Array.from(options.storeKey) : null,
        descriptor: clone(payload.descriptor), log: clone(currentLog), checkpoint: { seq: head.seq, hash: head.hash }, history: [] });
      const existing = await endpoint.machine.crossSigningStatus();
      if (resume && marker.identity && !sameIdentity(marker.identity, endpoint.identity())) fail('owner_recovery_store_mismatch');
      if (existing.hasMaster || existing.hasSelfSigning || existing.hasUserSigning) {
        if (!resume || await publicMaster(endpoint) !== payload.descriptor.masterKey) fail('owner_recovery_clean_store_required');
      } else await endpoint.machine.importSecretsBundle(sdk.SecretsBundle.from_json(bundle));
      if (await publicMaster(endpoint) !== payload.descriptor.masterKey) fail('owner_recovery_master_mismatch');
      await drill(endpoint);
      if (payload.history) {
        const imported = await endpoint.importRecoveryHistory(payload.history, recoveryKey);
        staged.get(endpoint).history = imported.history;
      }
      await saveStage(endpoint);
      return endpoint;
    } catch (error) { endpoint.close(); throw error; }
  }
  async function drillKit(options) {
    const endpoint = await stage({ ciphertext: options.ciphertext, recoveryKey: options.recoveryKey, expected: options.expected });
    try { return await drill(endpoint); } finally { endpoint.close(); }
  }
  async function provision(endpoint, { descriptor, log, expected, historyRooms = [], recoveryKey }) {
    assertActive(endpoint);
    if (endpoint.user !== expected?.owner) fail('owner_recovery_account_mismatch');
    const head = await authenticatedHead(descriptor, log, expected);
    if (!head.endpoints.some(entry => sameIdentity(entry, endpoint.identity()) && entry.state === 'verified')) fail('owner_recovery_owner_unverified');
    if (await publicMaster(endpoint) !== descriptor.masterKey) fail('owner_recovery_master_mismatch');
    if (!Array.isArray(historyRooms) || historyRooms.some(room => !/^!et_[a-f0-9]{32}:plexus\.local$/.test(room))) fail('recovery_scope_mismatch');
    const bundle = (await endpoint.machine.exportSecretsBundle()).to_json();
    strippedBundle(bundle.cross_signing);
    const history = historyRooms.length ? await endpoint.exportRecoveryHistory(historyRooms, recoveryKey) : null;
    const checkpoint = { seq: head.seq, hash: head.hash };
    const ciphertext = await seal({ version: 1, descriptor, log, checkpoint, crossSigning: bundle.cross_signing, history }, recoveryKey, expected);
    const result = await drillKit({ ciphertext, recoveryKey, expected });
    return { ciphertext, descriptor: clone(descriptor), checkpoint, drill: result };
  }
  async function saveStage(endpoint) {
    const state = staged.get(endpoint);
    await saveLifecycle(state.storeName, state.storeKey, { version: 1, state: state.state, user: endpoint.user, device: endpoint.device,
      descriptorHash: await recoveryDescriptorHash(state.descriptor), identity: endpoint.identity(), checkpoint: state.checkpoint });
  }
  async function latest(endpoint, log) {
    const state = staged.get(endpoint);
    if (!state) fail('owner_recovery_stage_required');
    if (!Array.isArray(log)) fail('owner_recovery_current_log_required');
    const head = await replayMembership(log, { teamId: state.descriptor.teamId, authority: state.descriptor.genesis,
      service: state.descriptor.service, checkpoint: state.checkpoint });
    // Observing an authenticated later revocation also advances the floor. A retry
    // cannot forget that observation and publish using an older, still-active snapshot.
    state.checkpoint = { seq: head.seq, hash: head.hash }; state.log = clone(log);
    await saveStage(endpoint);
    if (!head.recoveryDescriptor || await recoveryDescriptorHash(head.recoveryDescriptor) !== await recoveryDescriptorHash(state.descriptor)) {
      fail('owner_recovery_descriptor_inactive');
    }
    return { state, head };
  }
  async function publish(endpoint, { transport, log } = {}) {
    const { state } = await latest(endpoint, log);
    if (state.state === 'published') return status(endpoint);
    if (!transport || typeof transport.send !== 'function') fail('owner_recovery_transport_required');
    await publishCrossSigning(endpoint, false, transport);
    if (await publicMaster(endpoint) !== state.descriptor.masterKey) fail('owner_recovery_master_mismatch');
    state.state = 'published';
    try { await saveStage(endpoint); }
    catch (error) { state.state = 'staged'; throw error; }
    return status(endpoint);
  }
  async function signRecovery(endpoint, body, { log } = {}) {
    const { state, head } = await latest(endpoint, log);
    if (state.state !== 'published') fail('owner_recovery_inactive');
    const wrapped = ownerRecoverySigningBody(body);
    if (body.teamId !== state.descriptor.teamId || body.seq !== head.seq + 1 || body.previous !== head.hash ||
        body.payload.generation !== state.descriptor.generation || body.payload.descriptorHash !== await recoveryDescriptorHash(state.descriptor) ||
        !sameIdentity(body.signer, endpoint.identity()) || !sameIdentity(body.payload.candidate, endpoint.identity())) fail('owner_recovery_claim_mismatch');
    return { signature: await endpoint.sign(canonical(body)), masterSignature: await signature(endpoint, wrapped, state.descriptor.masterKey) };
  }
  async function identity(endpoint, { replaceAuthority = false } = {}) {
    assertActive(endpoint);
    if (typeof replaceAuthority !== 'boolean') fail('owner_recovery_rotation_confirmation_required');
    await publishCrossSigning(endpoint, replaceAuthority);
    const available = await endpoint.machine.crossSigningStatus();
    if (!available.hasMaster || !available.hasSelfSigning || !available.hasUserSigning) fail('owner_recovery_identity_unavailable');
    return { masterKey: await publicMaster(endpoint), replacedAuthority: replaceAuthority };
  }
  return { assertActive, stage, drillKit, drill, status, provision, identity,
    publish: (endpoint, options) => ceremony(endpoint, () => publish(endpoint, options)),
    signRecovery: (endpoint, body, options) => ceremony(endpoint, () => signRecovery(endpoint, body, options)) };
}
