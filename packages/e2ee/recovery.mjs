// Getting your history back on a device that has never seen it.
//
// The primitives were already here - exportHistory encrypts the room keys for a set of tasks
// to a key the customer holds, importHistory takes them back. What was missing is everything
// around them: somewhere for the blob to live that the operator cannot read, a way to fail
// when the material is wrong, and a truthful account of what comes back.
//
// The last of those is the part worth being careful about. Recovery restores **history**. It
// does not restore who you are to anybody else, it does not restore permission to do
// anything, and it cannot restore a provider account. Saying "recovered" without saying which
// of those happened is how somebody ends up believing a restored laptop is a trusted one.

export class RecoveryError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new RecoveryError(code); };

// Long enough that guessing is not a strategy, and checked before anything is attempted so a
// typo fails on the spot rather than as a decryption error three calls later.
export const MIN_RECOVERY_KEY = 32;

export class RecoveryTransport {
  constructor({ url, token }) { this.url = url; this.token = token; }
  async request(op, value = {}) {
    const response = await fetch(this.url + '/api/e2ee/recovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token },
      body: JSON.stringify({ op, ...value }),
      signal: AbortSignal.timeout(20000)
    });
    let body;
    try { body = await response.json(); } catch { fail('recovery_service_unavailable'); }
    if (!response.ok) fail(typeof body.error === 'string' ? body.error : 'recovery_request_refused');
    return body;
  }
  put(scope, ciphertext, version = '1', taskIds) { return this.request('put', { scope, ciphertext, version, ...(taskIds ? { taskIds } : {}) }); }
  get(scope) { return this.request('get', { scope }); }
  list() { return this.request('list'); }
}

/**
 * Back up the history of some tasks, encrypted to material only the customer holds.
 *
 * The relay never sees the key. What it stores is what `exportHistory` produced, which is
 * Matrix's authenticated encrypted room-key export format - opaque, and scoped to exactly the
 * rooms named here rather than to everything this endpoint happens to know.
 */
export async function backupHistory(endpoint, transport, { scope, taskIds, recoveryKey, roomFor }) {
  if (typeof recoveryKey !== 'string' || recoveryKey.length < MIN_RECOVERY_KEY) fail('recovery_key_too_weak');
  if (!Array.isArray(taskIds) || !taskIds.length) fail('recovery_scope_required');
  const rooms = taskIds.map(roomFor);
  const ciphertext = await endpoint.exportRecoveryHistory(rooms, recoveryKey);
  await transport.put(scope, ciphertext, '1', taskIds);
  return { scope, tasks: taskIds.length, bytes: ciphertext.length };
}

/**
 * Restore on a clean endpoint, and say precisely what that did and did not do.
 *
 * The return value is deliberately shaped like a statement somebody has to read rather than a
 * boolean somebody can ignore: what came back, and the three things that did not.
 */
export async function restoreHistory(endpoint, transport, { scope, taskIds, recoveryKey, roomFor }) {
  if (typeof recoveryKey !== 'string' || recoveryKey.length < MIN_RECOVERY_KEY) fail('recovery_key_too_weak');
  if (taskIds !== undefined && (!Array.isArray(taskIds) || !taskIds.length)) fail('recovery_scope_required');
  const held = await transport.get(scope);
  const rooms = taskIds ? taskIds.map(roomFor) : null;
  let imported;
  try {
    imported = await endpoint.importRecoveryHistory(held.ciphertext, recoveryKey, rooms);
  } catch (error) {
    // Wrong key and wrong scope are different mistakes with different fixes, and the second
    // one is not a failure of the material - it is asking for history this backup never held.
    if (String(error && error.message) === 'recovery_scope_mismatch') fail('recovery_scope_mismatch');
    fail('recovery_material_rejected');
  }
  const restoredTaskIds = taskIds || [...new Set(imported.history.map(entry => {
    const match = /^!(et_[a-f0-9]{32}):plexus\.local$/.exec(entry.roomId);
    if (!match) fail('recovery_scope_mismatch');
    return match[1];
  }))];
  return {
    restored: { tasks: restoredTaskIds.length, taskIds: restoredTaskIds, sessions: imported.sessions, imported: imported.imported,
      history: Object.fromEntries(restoredTaskIds.map(taskId => {
        const entries = imported.history.filter(entry => entry.roomId === roomFor(taskId));
        return [taskId, { writer: entries[0].writer, sessions: entries.map(entry => entry.sessionId) }];
      })) },
    // Stated every time, because the failure mode here is somebody assuming otherwise.
    notRestored: {
      endpointTrust: 'This device is new to everyone else. It has to announce itself and be confirmed again before any teammate will accept anything from it.',
      approvalAuthority: 'Approval rights are not in a backup. A grant that had expired or been used is still expired or used.',
      providerCredentials: 'Provider accounts live on the execution host and are never part of history. Restoring does not sign you in to one.'
    }
  };
}

/**
 * The onboarding exercise: make somebody prove they actually stored the key.
 *
 * A recovery key that was displayed once and never written down is not recovery, and the only
 * moment anybody will ever check is now - the alternative is discovering it on the day the
 * laptop is gone. This compares what they typed against what they were given, without
 * revealing which part is wrong.
 */
export function confirmRecoveryDrill(issuedKey, typed) {
  if (typeof issuedKey !== 'string' || typeof typed !== 'string') fail('recovery_drill_incomplete');
  const clean = (value) => value.replace(/\s+/g, '');
  if (clean(typed).length === 0) fail('recovery_drill_incomplete');
  if (clean(typed) !== clean(issuedKey)) fail('recovery_drill_mismatch');
  return { confirmed: true };
}

/**
 * Replacing the key, which is also how a lost-but-not-yet-abused key is dealt with.
 *
 * The old blob is overwritten, so a copy of the previous key stops being useful for anything
 * stored afterwards. It does not reach back in time: anybody who already downloaded the old
 * ciphertext and holds the old key can still open that copy, and pretending otherwise would
 * be the kind of promise this file exists to avoid making.
 */
export async function rotateRecovery(endpoint, transport, { scope, taskIds, roomFor }) {
  const issued = await endpoint.enableRecovery();
  return {
    recoveryKey: issued.recoveryKey,
    replaced: false,
    caveat: 'The previous backup is overwritten. Anybody who already downloaded it and holds the old key can still open that copy.'
  };
}

export async function completeRecoveryRotation(endpoint, transport, { scope, taskIds, roomFor, recoveryKey, typed }) {
  confirmRecoveryDrill(recoveryKey, typed);
  const backed = await backupHistory(endpoint, transport, { scope, taskIds, recoveryKey, roomFor });
  return { ...backed, replaced: true };
}

// What the product is allowed to promise, in one place, so no screen invents a better story.
export const RECOVERY_LIMITS = {
  everythingLost: 'If every trusted endpoint is gone and the recovery key is gone, the history cannot be recovered. Nobody can recover it - not the operator, not us. There is no second path, by design: a copy the operator could open would be a copy an intruder could open.',
  siteDataCleared: 'Clearing site data in a browser destroys that endpoint\'s identity and its stored keys. The account survives; the device does not, and comes back as a new one that has to be confirmed again.',
  storageLocked: 'If the operating system keychain is locked or unavailable, the endpoint cannot open its store and will report itself as having no durable identity rather than silently starting a new one.',
  operatorView: 'The operator can see that a backup exists, when it was stored and how large it is. Not what is in it.'
};
