'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { KeyDirectory, KeyTransport } = require('../packages/e2ee/key-transport');
const { newId } = require('../packages/e2ee/task-log.mjs');
const { sendTaskControl, readTaskControl, sendTaskReceipt, readTaskReceipt } = require('../packages/e2ee/task-control.mjs');

test('encrypted controls retain retry identity and accept receipts only from the exact host', async () => {
  const directory = new KeyDirectory();
  const transport = new KeyTransport(directory);
  const endpoints = [];
  const create = async (user, device) => { const endpoint = await Endpoint.create({ user, device, transport }); endpoints.push(endpoint); return endpoint; };
  try {
    const alice = await create('@u_alice:plexus.local', 'ALICE');
    const host = await create('@rt_host:plexus.local', 'HOST');
    const other = await create('@u_other:plexus.local', 'OTHER');
    for (const endpoint of endpoints) for (const peer of endpoints) {
      if (peer !== endpoint) await endpoint.confirmEndpoint(peer.identity(), { confirmed: true });
    }
    const task = { version: 1, id: newId('et'), teamId: 'team_1', runtimeId: 'rt_host', projectId: newId('ep'), creatorUserId: 'u_alice' };
    const commandId = newId('cmd');
    const payload = { input: [{ type: 'text', text: 'Use the existing key' }], expectedTurnId: 'turn_1' };
    const first = await sendTaskControl(alice, host.identity(), { task, action: 'turn.steer', payload, commandId });
    assert.deepEqual(first, { commandId, state: 'submitted' });
    await sendTaskControl(alice, host.identity(), { task, action: 'turn.steer', payload, commandId });
    const events = await host.open(directory.drain(host.user, host.device));
    const reads = events.map(event => readTaskControl(event, task)).filter(Boolean);
    assert.equal(reads.length, 2);
    assert.equal(reads[0].commandId, reads[1].commandId);
    assert.equal(reads[0].sender, 'u_alice');
    assert.equal(reads[0].payload.expectedTurnId, 'turn_1');
    assert.equal(readTaskControl(events[0], { ...task, id: newId('et') }), null);

    await sendTaskReceipt(host, alice.identity(), { task, commandId, state: 'queued', result: { order: 1, turnId: 'turn_1' } });
    const replies = await alice.open(directory.drain(alice.user, alice.device));
    const receipt = readTaskReceipt(replies.find(event => event.content?.commandId === commandId), task, host.identity());
    assert.equal(receipt.state, 'queued');
    assert.equal(receipt.result.order, 1);
    await sendTaskReceipt(other, alice.identity(), { task, commandId, state: 'delivered' });
    const forged = await alice.open(directory.drain(alice.user, alice.device));
    assert.throws(() => readTaskReceipt(forged.find(event => event.content?.commandId === commandId), task, host.identity()), /task_receipt_unauthenticated/);
    await assert.rejects(() => sendTaskControl(alice, host.identity(), { task, action: 'turn.steer', payload, commandId: 'caller-changed-id' }), /invalid_command_id/);
  } finally { for (const endpoint of endpoints) endpoint.close(); }
});
