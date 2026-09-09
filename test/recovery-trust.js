'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('@matrix-org/matrix-sdk-crypto-wasm');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { KeyDirectory, KeyTransport } = require('../packages/e2ee/key-transport');
const { EncryptedTaskReader, newId } = require('../packages/e2ee/task-log.mjs');
const { roomFor } = require('../packages/protocol/encrypted-task.mjs');
const { backupHistory, restoreHistory, rotateRecovery, completeRecoveryRotation } = require('../packages/e2ee/recovery.mjs');

test('customer recovery restores verified reader history without manually granting imported-key trust', async () => {
  const directory = new KeyDirectory();
  const transport = new KeyTransport(directory);
  const opened = [];
  const create = async (user, device) => { const ep = await Endpoint.create({ user, device, transport }); opened.push(ep); return ep; };
  try {
    const host = await create('@rt_host:plexus.local', 'HOST');
    const original = await create('@u_alex:plexus.local', 'ORIGINAL');
    await host.confirmEndpoint(original.identity(), { confirmed: true });
    await original.confirmEndpoint(host.identity(), { confirmed: true });
    const task = { version: 1, id: newId('et'), teamId: 'team_1', runtimeId: 'rt_host', projectId: newId('ep'), creatorUserId: 'u_alex' };
    const room = roomFor(task.id);
    await host.shareVerifiedTaskKey(room, [original.identity()]);
    await original.open(directory.drain(original.user, original.device));
    const id = newId('ev');
    const envelope = await host.encryptTask(room, 'plexus.task.event.v1', {
      version: 1, task, seq: 1, eventId: id, previous: null,
      event: { type: 'task.created', payload: { title: 'Saved task', objective: 'History that must survive device loss' } }
    });
    const record = { version: 1, id, seq: 1, envelope };
    const originalReader = new EncryptedTaskReader({ endpoint: original, task, writer: host.identity() });
    await originalReader.accept(record);
    let held;
    const recovery = { put: async (scope, ciphertext) => { held = { scope, ciphertext }; }, get: async () => held };
    const key = 'a'.repeat(64);
    await backupHistory(original, recovery, { scope: 'team_1', taskIds: [task.id], recoveryKey: key, roomFor });
    const replacement = await create('@u_alex:plexus.local', 'REPLACEMENT');
    const restored = await restoreHistory(replacement, recovery, { scope: 'team_1', taskIds: [task.id], recoveryKey: key, roomFor });
    assert.equal(restored.restored.history[task.id].writer.ed25519, host.identity().ed25519);
    const reader = new EncryptedTaskReader({ endpoint: replacement, task, writer: host.identity() });
    await reader.accept(record);
    assert.equal(reader.state.objective, originalReader.state.objective);
    assert.equal(await host.isEndpointVerified(replacement.user, replacement.device), false);

    const prior = held.ciphertext;
    const pending = await rotateRecovery(replacement, recovery, { scope: 'team_1', taskIds: [task.id], roomFor });
    assert.equal(pending.replaced, false);
    assert.equal(held.ciphertext, prior, 'issuing a replacement key must not destroy the working backup');
    await assert.rejects(() => completeRecoveryRotation(replacement, recovery, {
      scope: 'team_1', taskIds: [task.id], roomFor, recoveryKey: pending.recoveryKey, typed: 'wrong'
    }), /recovery_drill_mismatch/);
    assert.equal(held.ciphertext, prior);
    await completeRecoveryRotation(replacement, recovery, {
      scope: 'team_1', taskIds: [task.id], roomFor, recoveryKey: pending.recoveryKey, typed: pending.recoveryKey
    });
    assert.notEqual(held.ciphertext, prior);

    // A raw Matrix import has attacker-controlled claimed sender fields. Possessing it
    // does not make it eligible for a trusted customer backup.
    const attacker = await create('@u_attacker:plexus.local', 'ATTACKER');
    await attacker.shareTaskKey(room, [attacker.user]);
    const fake = JSON.parse(await attacker.machine.exportRoomKeys(() => true)).map(entry => ({
      ...entry, sender_key: host.identity().curve25519, sender_claimed_keys: { ed25519: host.identity().ed25519 }
    }));
    const contaminated = await create('@u_alex:plexus.local', 'CONTAMINATED');
    await contaminated.importHistory(sdk.OlmMachine.encryptExportedRoomKeys(JSON.stringify(fake), key, 10000), key, [room]);
    await assert.rejects(() => backupHistory(contaminated, recovery, {
      scope: 'team_1', taskIds: [task.id], recoveryKey: key, roomFor
    }), /recovery_verified_history_required/);
  } finally { for (const endpoint of opened) endpoint.close(); }
});
