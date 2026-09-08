'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { KeyDirectory, KeyTransport } = require('../packages/e2ee/key-transport');
const { initialMembership, replayMembership, signMembership } = require('../packages/e2ee/membership.mjs');

async function ownerFixture(t) {
  const directory = new KeyDirectory(), transport = new KeyTransport(directory);
  const original = await Endpoint.create({ user: '@kit_owner:plexus.local', device: 'ORIGINAL', transport });
  t.after(() => original.close());
  const expected = { service: 'https://relay.example.test', teamId: 'tm_owner_kit', owner: original.user, genesis: original.identity() };
  const bootstrap = await signMembership(original, initialMembership(expected.teamId), 'bootstrap', { endpoint: original.identity() });
  const first = await replayMembership([bootstrap], { teamId: expected.teamId, authority: expected.genesis });
  const { masterKey } = await original.ownerRecoveryIdentity();
  const descriptor = { version: 1, purpose: 'owner-endpoint-recovery-with-host-local-activation', ...expected, generation: 1, masterKey };
  const configure = await signMembership(original, first, 'recovery.configure', { descriptor });
  const log = [bootstrap, configure];
  return { original, directory, transport, expected, descriptor, log };
}

test('customer kit restores a new owner identity after the original closes, with no publication before explicit publish', async t => {
  const f = await ownerFixture(t);
  const recoveryKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
  await f.original.enableRecovery('excluded-room-backup');
  const kit = await f.original.provisionOwnerRecoveryKit({ ...f, recoveryKey, historyRooms: [] });
  assert.equal(kit.drill.verified, true);
  assert.equal(kit.ciphertext.includes('cross_signing'), false);
  const oldIdentity = f.original.identity(); f.original.close();
  const before = f.directory.query();
  const staged = await Endpoint.stageOwnerRecovery({ ciphertext: kit.ciphertext, recoveryKey, expected: f.expected });
  t.after(() => staged.close());
  const status = staged.ownerRecoveryStatus();
  assert.equal(status.state, 'staged');
  assert.notEqual(status.identity.device, oldIdentity.device);
  assert.notEqual(status.identity.ed25519, oldIdentity.ed25519);
  assert.equal(status.descriptor.masterKey, f.descriptor.masterKey);
  assert.equal((await staged.drillOwnerRecovery()).verified, true);
  assert.equal(await staged.recoveryKeyOnThisEndpoint(), null, 'SDK room-backup key is excluded');
  await assert.rejects(() => staged.sync(), /owner_recovery_inactive/);
  await assert.rejects(() => staged.track([f.expected.owner]), /owner_recovery_inactive/);
  assert.equal(f.directory.query(), before, 'staging and a real SDK drill do not publish anything');
  await staged.publishOwnerRecovery({ transport: f.transport, log: f.log });
  assert.equal(staged.ownerRecoveryStatus().state, 'published');
  await staged.track([staged.user]);
  const published = await staged.getDevice(staged.user, staged.device);
  assert.equal(published.isCrossSignedByOwner(), true);
  const head = await replayMembership(f.log, { teamId: f.expected.teamId, authority: f.expected.genesis, service: f.expected.service });
  const { digest } = require('../packages/protocol/encrypted-task.mjs');
  const body = { version: 1, teamId: head.teamId, seq: head.seq + 1, previous: head.hash,
    signer: staged.identity(), action: 'owner.recover', payload: { descriptorHash: await digest(f.descriptor), generation: 1,
      epoch: '1'.repeat(32), candidate: staged.identity() } };
  const signed = { ...body, ...await staged.signOwnerRecovery(body, { log: f.log }) };
  const recovered = await replayMembership([...f.log, signed], { teamId: head.teamId, authority: f.expected.genesis, service: f.expected.service });
  assert.equal(recovered.endpoints.find(entry => entry.device === staged.device).state, 'verified');
  assert.equal(recovered.owner.device, 'ORIGINAL', 'public genesis is immutable');
  assert.equal(recovered.recoveryEpoch, '1'.repeat(32));
});

test('wrong customer material, context, genesis and applied floor are refused without changing the active endpoint', async t => {
  const f = await ownerFixture(t), { createOwnerRecoveryKey } = require('../packages/e2ee/owner-recovery-kit.mjs');
  const recoveryKey = createOwnerRecoveryKey();
  const kit = await f.original.provisionOwnerRecoveryKit({ ...f, recoveryKey });
  const before = f.original.identity(), directory = f.directory.query();
  for (const options of [
    { recoveryKey: createOwnerRecoveryKey() },
    { expected: { ...f.expected, owner: '@different_owner:plexus.local' } },
    { expected: { ...f.expected, teamId: 'tm_other' } },
    { expected: { ...f.expected, service: 'https://other.example.test' } },
    { expected: { ...f.expected, genesis: { ...before, device: 'REPLACED_GENESIS' } } },
    { expected: { ...f.expected, checkpoint: { seq: 3, hash: 'a'.repeat(64) } } },
    { device: 'ORIGINAL' },
    { storeName: 'existing-active-store' }
  ]) {
    await assert.rejects(() => Endpoint.stageOwnerRecovery({ ciphertext: kit.ciphertext, recoveryKey, expected: f.expected, ...options }));
    assert.deepEqual(f.original.identity(), before);
    assert.equal(f.directory.query(), directory);
  }
  const tampered = JSON.parse(kit.ciphertext); tampered.ciphertext = (tampered.ciphertext[0] === 'A' ? 'B' : 'A') + tampered.ciphertext.slice(1);
  await assert.rejects(() => Endpoint.stageOwnerRecovery({ ciphertext: JSON.stringify(tampered), recoveryKey, expected: f.expected }), /owner_recovery_material_rejected/);
});

test('revoked descriptors cannot publish or sign, and recovered masters cannot sign arbitrary task or membership authority', async t => {
  const f = await ownerFixture(t), { createOwnerRecoveryKey } = require('../packages/e2ee/owner-recovery-kit.mjs');
  const recoveryKey = createOwnerRecoveryKey(), kit = await f.original.provisionOwnerRecoveryKit({ ...f, recoveryKey });
  const staged = await Endpoint.stageOwnerRecovery({ ciphertext: kit.ciphertext, recoveryKey, expected: f.expected });
  t.after(() => staged.close());
  const head = await replayMembership(f.log, { teamId: f.expected.teamId, authority: f.expected.genesis });
  const { digest } = require('../packages/protocol/encrypted-task.mjs');
  const revoked = await signMembership(f.original, head, 'recovery.revoke', { descriptorHash: await digest(f.descriptor), generation: 1 });
  const directory = f.directory.query();
  await assert.rejects(() => staged.publishOwnerRecovery({ transport: f.transport, log: [...f.log, revoked] }), /owner_recovery_descriptor_inactive/);
  assert.equal(f.directory.query(), directory);
  await assert.rejects(() => staged.publishOwnerRecovery({ transport: f.transport, log: f.log }), /membership_rollback/);
  const signing = await Endpoint.stageOwnerRecovery({ ciphertext: kit.ciphertext, recoveryKey, expected: f.expected });
  t.after(() => signing.close());
  await signing.publishOwnerRecovery({ transport: f.transport, log: f.log });
  for (const body of [
    { type: 'plexus.membership.current.v1', teamId: head.teamId, challenge: 'arbitrary' },
    { version: 1, teamId: head.teamId, seq: 3, previous: head.hash, signer: staged.identity(), action: 'grant', payload: {} }
  ]) await assert.rejects(() => signing.signOwnerRecovery(body, { log: f.log }), /owner_recovery_claim_invalid/);
  const body = { version: 1, teamId: head.teamId, seq: 3, previous: head.hash, signer: staged.identity(), action: 'owner.recover',
    payload: { descriptorHash: await digest(f.descriptor), generation: 1, epoch: '2'.repeat(32), candidate: staged.identity() } };
  await assert.rejects(() => staged.signOwnerRecovery(body, { log: [...f.log, revoked] }), /owner_recovery_descriptor_inactive/);
  await assert.rejects(() => signing.signOwnerRecovery({ ...body, previous: 'f'.repeat(64) }, { log: f.log }), /owner_recovery_claim_mismatch/);
});

test('a clean inactive kit restores only selected verified task history, without a surviving original or host endpoint', async t => {
  const f = await ownerFixture(t), { createOwnerRecoveryKey } = require('../packages/e2ee/owner-recovery-kit.mjs');
  const { EncryptedTaskReader, newId } = require('../packages/e2ee/task-log.mjs');
  const { roomFor } = require('../packages/protocol/encrypted-task.mjs');
  const host = await Endpoint.create({ user: '@rt_kit_host:plexus.local', device: 'HOST', transport: f.transport });
  t.after(() => host.close());
  await host.confirmEndpoint(f.original.identity(), { confirmed: true });
  await f.original.confirmEndpoint(host.identity(), { confirmed: true });
  const writer = host.identity(), tasks = [];
  for (const title of ['Selected verified history', 'Excluded task history']) {
    const task = { version: 1, id: newId('et'), teamId: f.expected.teamId, runtimeId: 'rt_kit_host', projectId: newId('ep'), creatorUserId: 'kit_owner' };
    await host.shareVerifiedTaskKey(roomFor(task.id), [f.original.identity()]);
    await f.original.open(f.directory.drain(f.original.user, f.original.device));
    const id = newId('ev'), envelope = await host.encryptTask(roomFor(task.id), 'plexus.task.event.v1', {
      version: 1, task, seq: 1, eventId: id, previous: null, event: { type: 'task.created', payload: { title, objective: title } }
    });
    const record = { version: 1, id, seq: 1, envelope };
    const reader = new EncryptedTaskReader({ endpoint: f.original, task, writer }); await reader.accept(record);
    tasks.push({ task, record });
  }
  const recoveryKey = createOwnerRecoveryKey(), kit = await f.original.provisionOwnerRecoveryKit({ ...f, recoveryKey, historyRooms: [roomFor(tasks[0].task.id)] });
  assert.equal(kit.drill.historySessions, 1);
  f.original.close(); host.close();
  const restored = await Endpoint.stageOwnerRecovery({ ciphertext: kit.ciphertext, recoveryKey, expected: f.expected });
  t.after(() => restored.close());
  assert.deepEqual(restored.ownerRecoveryStatus().taskIds, [tasks[0].task.id]);
  const selected = new EncryptedTaskReader({ endpoint: restored, task: tasks[0].task, writer });
  await selected.accept(tasks[0].record);
  assert.equal(selected.snapshot().title, 'Selected verified history');
  const excluded = new EncryptedTaskReader({ endpoint: restored, task: tasks[1].task, writer });
  await assert.rejects(() => excluded.accept(tasks[1].record), /task_integrity_failed/);
  assert.equal(restored.ownerRecoveryStatus().state, 'staged', 'reading authenticated history cannot publish/admit the endpoint');
});

test('authority replacement creates a fresh SDK master while ordinary setup retains it, and retires the old kit', async t => {
  const f = await ownerFixture(t), { createOwnerRecoveryKey } = require('../packages/e2ee/owner-recovery-kit.mjs');
  const firstKey = createOwnerRecoveryKey(), first = await f.original.provisionOwnerRecoveryKit({ ...f, recoveryKey: firstKey });
  assert.equal((await f.original.ownerRecoveryIdentity()).masterKey, f.descriptor.masterKey);
  const replacement = await f.original.ownerRecoveryIdentity({ replaceAuthority: true });
  assert.notEqual(replacement.masterKey, f.descriptor.masterKey);
  const descriptor = { ...f.descriptor, generation: 2, masterKey: replacement.masterKey };
  const head = await replayMembership(f.log, { teamId: f.expected.teamId, authority: f.expected.genesis });
  const configure = await signMembership(f.original, head, 'recovery.configure', { descriptor }), log = [...f.log, configure];
  const recoveryKey = createOwnerRecoveryKey(), next = await f.original.provisionOwnerRecoveryKit({ descriptor, log, expected: f.expected, recoveryKey });
  assert.equal(next.drill.verified, true);
  f.original.close();
  const retired = await Endpoint.stageOwnerRecovery({ ciphertext: first.ciphertext, recoveryKey: firstKey, expected: f.expected });
  t.after(() => retired.close());
  await assert.rejects(() => retired.publishOwnerRecovery({ transport: f.transport, log }), /owner_recovery_descriptor_inactive/);
  const current = await Endpoint.stageOwnerRecovery({ ciphertext: next.ciphertext, recoveryKey, expected: f.expected });
  t.after(() => current.close());
  assert.equal((await current.drillOwnerRecovery()).masterKey, replacement.masterKey);
  await current.publishOwnerRecovery({ transport: f.transport, log });
  assert.equal(current.ownerRecoveryStatus().state, 'published');
});

test('overlapping old-log and revocation checks cannot roll a staged endpoint back to the retired descriptor', async t => {
  const f = await ownerFixture(t), { createOwnerRecoveryKey } = require('../packages/e2ee/owner-recovery-kit.mjs');
  const { digest } = require('../packages/protocol/encrypted-task.mjs');
  const recoveryKey = createOwnerRecoveryKey(), kit = await f.original.provisionOwnerRecoveryKit({ ...f, recoveryKey });
  const endpoint = await Endpoint.stageOwnerRecovery({ ciphertext: kit.ciphertext, recoveryKey, expected: f.expected });
  t.after(() => endpoint.close());
  await endpoint.publishOwnerRecovery({ transport: f.transport, log: f.log });
  const head = await replayMembership(f.log, { teamId: f.expected.teamId, authority: f.expected.genesis });
  const revoked = await signMembership(f.original, head, 'recovery.revoke', { descriptorHash: await digest(f.descriptor), generation: 1 });
  let release, entered;
  const pause = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const verify = crypto.subtle.verify.bind(crypto.subtle); let delayed = false;
  t.mock.method(crypto.subtle, 'verify', async (...args) => {
    if (!delayed && args[0] === 'Ed25519') { delayed = true; entered(); await pause; }
    return verify(...args);
  });
  const oldCheck = endpoint.publishOwnerRecovery({ transport: f.transport, log: f.log });
  await started;
  const revokedCheck = endpoint.publishOwnerRecovery({ transport: f.transport, log: [...f.log, revoked] });
  // Under the broken race, the later request completes before the older verification.
  // A serialized ceremony instead releases at this bounded simulated crypto deadline.
  const releaseOnRevocation = revokedCheck.catch(() => {}).finally(release);
  const timeout = setTimeout(release, 50);
  try {
    const results = await Promise.allSettled([oldCheck, revokedCheck]);
    assert.equal(results[1].status, 'rejected');
    assert.equal(endpoint.ownerRecoveryStatus().checkpoint.seq, 3);
    await assert.rejects(() => endpoint.publishOwnerRecovery({ transport: f.transport, log: f.log }), /membership_rollback/);
  } finally { clearTimeout(timeout); release(); await releaseOnRevocation; t.mock.restoreAll(); }
});
