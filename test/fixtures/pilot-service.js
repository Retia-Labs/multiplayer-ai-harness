'use strict';
const crypto = require('node:crypto');
const { Hub } = require('../../packages/hub/server');
const { Endpoint } = require('../../packages/e2ee/endpoint');
const { EnrollmentTransport, announcement } = require('../../packages/e2ee/enrollment.mjs');
const { HubKeyTransport } = require('../../packages/e2ee/hub-key-transport.mjs');
const { newId } = require('../../packages/e2ee/task-log.mjs');
const { matrixUser } = require('../../packages/protocol/encrypted-task.mjs');

async function fixture(t, { dbFile } = {}) {
  const hub = new Hub({ dbFile }), endpoints = [];
  t.after(async () => { endpoints.forEach(endpoint => endpoint.close()); await hub.close(); });
  const address = await hub.listen(), url = 'http://127.0.0.1:' + address.port;
  const owner = hub.store.createAccount('Owner'), peer = hub.store.createAccount('Peer'), stranger = hub.store.createAccount('Stranger');
  const team = hub.store.createTeam('Private team', owner.id);
  hub.store.redeemInvitation(hub.store.createInvitation(team.id, owner.id, peer.id).code, peer.id);
  async function client(user, device) {
    const endpoint = await Endpoint.create({ user: matrixUser(user.id), device, transport: new HubKeyTransport({ url, token: user.token, device }) });
    endpoints.push(endpoint); return new EnrollmentTransport({ url, token: user.token, endpoint });
  }
  const alice = await client(owner, 'ALICE'), bob = await client(peer, 'BOB');
  await alice.bootstrap(team.id, announcement(alice.endpoint));
  await bob.pinAuthority(team.id, alice.endpoint.identity());
  await bob.announce(team.id, announcement(bob.endpoint));
  await alice.confirm(team.id, 'ALICE', { userId: peer.id, ...announcement(bob.endpoint) });
  const project = newId('ep'), otherProject = newId('ep');
  await alice.ownProject(team.id, project); await alice.ownProject(team.id, otherProject);
  await alice.grant(team.id, project, peer.id);
  const runtimeId = 'host_test', runtimeToken = crypto.randomBytes(24).toString('hex');
  hub.store.pairRuntime(runtimeId, team.id, owner.id, runtimeToken);
  hub.store.upsertRuntime(team.id, { id: runtimeId, taskProtocol: 'encrypted-v1' });
  const create = (projectId = project) => {
    const value = { version: 1, id: newId('et'), teamId: team.id, runtimeId, projectId,
      request: { type: 'm.room.encrypted', sender: matrixUser(owner.id), content: {
        algorithm: 'm.olm.v1.curve25519-aes-sha2', sender_key: 'A'.repeat(43), ciphertext: { ['B'.repeat(43)]: { type: 0, body: 'c2VhbGVk' } } } } };
    return hub.encryptedTasks.create(value, owner).task;
  };
  const task = create(), other = create(otherProject);
  function append(target) {
    const record = { version: 1, id: newId('ev'), seq: 1, envelope: { type: 'm.room.encrypted', sender: matrixUser(runtimeId), room_id: '!' + target.id + ':plexus.local',
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'c2VhbGVk', sender_key: 'A'.repeat(43), session_id: 'B'.repeat(43), device_id: 'HOST' } } };
    hub.encryptedTasks.append(target, record); return record;
  }
  append(task); append(other);
  const request = async (user, route, body, method) => {
    const response = await fetch(url + route, { method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { authorization: 'Bearer ' + user.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  return { hub, url, owner, peer, stranger, team, alice, bob, project, task, other, create, append, request, runtimeId, runtimeToken };
}

module.exports = { fixture };
