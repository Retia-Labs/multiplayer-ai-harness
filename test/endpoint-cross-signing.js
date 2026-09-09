'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { KeyDirectory, KeyTransport } = require('../packages/e2ee/key-transport');

test('bootstrapping publishes the signature that binds this device to its account identity', async (t) => {
  const user = '@cross_signing:plexus.local';
  const transport = new KeyTransport(new KeyDirectory());
  const endpoint = await Endpoint.create({ user, device: 'ORIGINAL', transport });
  t.after(() => endpoint.close());
  await endpoint.bootstrapCrossSigning();
  await endpoint.track([user]);
  const device = await endpoint.getDevice(user, 'ORIGINAL');
  assert.equal(device.isCrossSignedByOwner(), true);
});

test('repeating setup preserves the account identity and previously signed devices', async (t) => {
  const user = '@repeat_setup:plexus.local';
  const directory = new KeyDirectory();
  const transport = new KeyTransport(directory);
  const first = await Endpoint.create({ user, device: 'FIRST', transport });
  const second = await Endpoint.create({ user, device: 'SECOND', transport });
  t.after(() => { first.close(); second.close(); });
  await first.bootstrapCrossSigning();
  await first.track([user]);
  await first.verifyEndpoint(user, 'SECOND');
  assert.equal(await first.isEndpointVerified(user, 'SECOND'), true);
  const originalKeys = JSON.parse(directory.query()).master_keys[user].keys;

  await first.bootstrapCrossSigning();
  await first.track([user]);
  assert.deepEqual(JSON.parse(directory.query()).master_keys[user].keys, originalKeys);
  assert.equal(await first.isEndpointVerified(user, 'SECOND'), true);
});
