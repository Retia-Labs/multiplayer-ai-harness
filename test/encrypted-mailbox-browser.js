'use strict';
// Public browser client with the real SDK and relay. Faults affect transport visibility
// or one import attempt; successful decryption and host verification are never replaced.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EncryptedTaskTransport, EncryptedTaskReader, EncryptedTaskWriter, routing, newId } = require('../packages/e2ee/task-log.mjs');
const { HISTORY_TYPE, CONTROL_TYPE } = require('../packages/e2ee/task-control.mjs');
const { matrixUser, roomFor } = require('../packages/protocol/encrypted-task.mjs');
const root = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-mailbox-'));
let hub, browser; const hosts = [], errors = [];
(async () => {
  hub = new Hub({ dbFile: path.join(temp, 'hub.sqlite'), staticDir: path.join(root, 'apps/web'), log: () => {} });
  const address = await hub.listen(), url = 'http://127.0.0.1:' + address.port;
  const owner = hub.store.createAccount('Mailbox fixture'), team = hub.store.createTeam('Mailbox retry', owner.id);
  for (const name of ['A', 'B']) {
    const runtimeId = 'rt_mailbox_' + name, token = 'runtime-mailbox-' + name;
    hub.store.pairRuntime(runtimeId, team.id, owner.id, token);
    hub.store.upsertRuntime(team.id, { id: runtimeId, taskProtocol: 'encrypted-v1' });
    const endpoint = await Endpoint.create({ user: matrixUser(runtimeId), device: 'HOST' + name,
      transport: new HubKeyTransport({ url, token, runtimeId, device: 'HOST' + name }) });
    await endpoint.confirmEndpoint(endpoint.identity(), { confirmed: true });
    hosts.push({ runtimeId, endpoint, transport: new EncryptedTaskTransport({ url, token, runtimeId }) });
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
  const makeClient = async context => {
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    // A minimal consumer of the shipped public client avoids unrelated background inbox
    // polling. Every client operation below is the same API used by the shared renderer.
    await page.route(url + '/', route => route.fulfill({ contentType: 'text/html', body: '<script src="/encrypted.js"></script>' }));
    await page.goto(url); await page.waitForFunction(() => window.PlexusEncrypted);
    await page.evaluate(async config => { window.client = new PlexusEncrypted.EncryptedClient(config); await client.open(); },
      { token: owner.token, userId: owner.id, teamId: team.id });
    return page;
  };
  const creatorContext = await browser.newContext(), readerContext = await browser.newContext();
  const creator = await makeClient(creatorContext); let reader = await makeClient(readerContext);
  await creator.evaluate(() => client.announce());
  await creator.evaluate(identity => client.confirmHost('rt_mailbox_B', identity), hosts[1].endpoint.identity());
  await reader.evaluate(identity => client.confirmHost('rt_mailbox_A', identity), hosts[0].endpoint.identity());
  const readerIdentity = await reader.evaluate(() => client.endpoint.identity());
  await hosts[1].endpoint.confirmEndpoint(readerIdentity, { confirmed: true });
  const projectId = newId('ep');
  const task = await creator.evaluate(projectId => client.createTask('rt_mailbox_B', projectId,
    { title: 'Mailbox history canary', objective: 'Retry the authenticated history' }), projectId);
  const endpoint = hosts[1].endpoint;
  await endpoint.shareTaskKey(roomFor(task.id), [endpoint.user]);
  const writer = new EncryptedTaskWriter({ reader: new EncryptedTaskReader({ endpoint, task, writer: endpoint.identity() }),
    transport: hosts[1].transport, load: () => ({}), save: () => {} });
  await writer.append({ type: 'task.created', payload: { title: 'Mailbox history canary', objective: 'Retry the authenticated history' } }, newId('ev'));
  const transferKey = 'MAILBOX_TRANSFER_SECRET_' + newId('canary');
  const deliver = async () => {
    const rooms = [roomFor(task.id)], blob = await endpoint.exportHistory(rooms, transferKey);
    const inner = await endpoint.sealControl(readerIdentity.user, readerIdentity.device, { type: 'plexus.project.history.v1',
      teamId: team.id, projectId, rooms, transferKey });
    const history = { blob, rooms, envelope: inner };
    const envelope = await endpoint.sealControl(readerIdentity.user, readerIdentity.device, { type: HISTORY_TYPE, task: routing(task), history });
    await endpoint.transport.deliverToDevice(readerIdentity.user, readerIdentity.device, envelope);
    return envelope;
  };
  await deliver();
  const pending = await reader.evaluate(() => client.receiveKeys()); assert.ok(pending.pending > 0);
  await reader.close(); reader = await makeClient(readerContext);
  await reader.evaluate(identity => client.confirmHost('rt_mailbox_B', identity), endpoint.identity());
  let result = await reader.evaluate(task => client.catchUp(task), task);
  assert.equal(result.error, undefined, 'late host confirmation after another host drained the mailbox must still admit history');
  assert.equal(result.snapshot.title, 'Mailbox history canary');
  console.log('PASS unknown host history stays sealed through another host drain and browser reload, then authenticates after exact confirmation');
  await endpoint.shareVerifiedTaskKey(roomFor(task.id), [endpoint.identity()], { rotate: true });
  await writer.append({ type: 'message.added', payload: { id: 'later-message', text: 'Fresh session after interrupted import' } }, newId('ev'));
  await deliver();
  await reader.route('**/api/encrypted-tasks?*', async route => {
    const response = await route.fetch(); await route.fulfill({ response, json: { tasks: [] } });
  });
  assert.equal((await reader.evaluate(() => client.receiveKeys())).pending, 1);
  const sealed = await reader.evaluate(() => ({ key: client.storageKey('plexus.mailbox.retry.', client.device),
    raw: localStorage.getItem(client.storageKey('plexus.mailbox.retry.', client.device)), all: JSON.stringify(localStorage) }));
  assert.equal(sealed.all.includes(transferKey), false, 'transfer key never persists in plaintext');
  assert.equal(sealed.raw.includes('project.history'), false);
  await reader.close(); reader = await makeClient(readerContext);
  // Simulate one local SDK import outage after BOTH one-shot Olm layers were decoded.
  // The subsequent successful import remains the real SDK method.
  await reader.evaluate(() => {
    const importHistory = client.endpoint.importHistory.bind(client.endpoint);
    client.endpoint.importHistory = async (...args) => {
      client.endpoint.importHistory = importHistory;
      throw new Error('synthetic_import_unavailable');
    };
  });
  assert.equal((await reader.evaluate(() => client.receiveKeys())).pending, 1);
  await reader.close(); reader = await makeClient(readerContext);
  assert.equal((await reader.evaluate(() => client.receiveKeys())).pending, 0);
  result = await reader.evaluate(task => client.catchUp(task), task);
  assert.equal(result.error, undefined); assert.equal(result.snapshot.messages.at(-1).text, 'Fresh session after interrupted import');
  console.log('PASS authenticated inner handoff survives missing task, transient import failure and two browser reloads without replaying consumed Olm');

  await reader.evaluate(({ key, raw }) => {
    const record = JSON.parse(raw); record.ciphertext = (record.ciphertext[0] === 'A' ? 'B' : 'A') + record.ciphertext.slice(1);
    localStorage.setItem(key, JSON.stringify(record));
  }, sealed);
  let refusal = await reader.evaluate(async () => { try { await client.receiveKeys(); return null; } catch (error) { return error.code; } });
  assert.equal(refusal, 'mailbox_journal_rejected');
  await reader.evaluate(({ key, raw }) => localStorage.setItem(key, raw), sealed);
  refusal = await reader.evaluate(async config => {
    const other = new PlexusEncrypted.EncryptedClient({ token: client.token, userId: client.userId, teamId: 'tm_different_context' });
    await other.open(); localStorage.setItem(other.storageKey('plexus.mailbox.retry.', other.device), config.raw);
    try { await other.receiveKeys(); return null; } catch (error) { return error.code; } finally { other.close(); }
  }, sealed);
  assert.equal(refusal, 'mailbox_journal_rejected');
  console.log('PASS tampered ciphertext and a journal copied to another team are refused before mailbox consumption');
  await reader.close(); reader = await makeClient(readerContext);
  await endpoint.shareVerifiedTaskKey(roomFor(task.id), [endpoint.identity()], { rotate: true });
  await writer.append({ type: 'message.added', payload: { id: 'storage-message', text: 'Still recoverable after storage refusal' } }, newId('ev'));
  await deliver();
  refusal = await reader.evaluate(async () => {
    const saved = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('plexus.mailbox.retry.')) throw new DOMException('Synthetic quota refusal', 'QuotaExceededError');
      return saved.call(this, key, value);
    };
    try { await client.receiveKeys(); return null; } catch (error) { return error.code; } finally { Storage.prototype.setItem = saved; }
  });
  assert.equal(refusal, 'mailbox_storage_unavailable');
  await reader.close(); reader = await makeClient(readerContext);
  result = await reader.evaluate(task => client.catchUp(task), task);
  assert.equal(result.error, undefined); assert.equal(result.snapshot.messages.at(-1).text, 'Still recoverable after storage refusal');
  assert.equal(await reader.evaluate(key => JSON.stringify(localStorage).includes(key), transferKey), false);
  console.log('PASS journal storage refusal precedes consumption; fresh-session history still imports after storage access and reload');

  await endpoint.confirmEndpoint(await creator.evaluate(() => client.endpoint.identity()), { confirmed: true });
  const first = await creator.evaluate(task => client.requestHistory(task), task);
  assert.equal(first.state, 'requested');
  assert.equal((await creator.evaluate(task => client.requestHistory(task), task)).state, 'throttled');
  const renewed = await creator.evaluate(async task => {
    const now = Date.now; Date.now = () => now() + 16000;
    try { return await client.requestHistory(task); } finally { Date.now = now; }
  }, task);
  assert.equal(renewed.state, 'requested'); assert.notEqual(renewed.commandId, first.commandId);
  const controls = (await endpoint.open(await endpoint.transport.drain())).filter(event => event.content?.type === CONTROL_TYPE && event.content.action === 'task.history');
  assert.equal(controls.length, 2);
  for (const control of controls) {
    assert.equal(control.decrypted, true); assert.equal(control.verified, true); assert.equal(control.sender, matrixUser(owner.id));
    assert.deepEqual(control.content.payload, {}); assert.equal(control.content.task.id, task.id);
  }
  console.log('PASS public read-only history requests are authenticated, task-bound, throttled, and renewed with distinct command IDs');
  const consumed = await deliver(); await reader.evaluate(() => client.receiveKeys());
  await endpoint.transport.deliverToDevice(readerIdentity.user, readerIdentity.device, consumed);
  assert.equal((await reader.evaluate(() => client.receiveKeys())).pending, 0, 'explicitly undecryptable consumed ciphertext leaves the raw retry queue');
  await reader.close(); reader = await makeClient(readerContext);
  await endpoint.transport.deliverToDevice(readerIdentity.user, readerIdentity.device, consumed);
  assert.equal((await reader.evaluate(() => client.receiveKeys())).pending, 0, 'the same packet cannot re-enter the queue after reload');
  result = await reader.evaluate(task => client.catchUp(task), task);
  assert.equal(result.error, undefined); assert.equal(result.snapshot.messages.at(-1).text, 'Still recoverable after storage refusal');
  assert.equal(await reader.evaluate(() => client.mailboxError), 'mailbox_envelope_unreadable');
  console.log('PASS consumed ciphertext refusal survives reload without an endless SDK retry queue or loss of verified task history');
  assert.deepEqual(errors, []);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); for (const host of hosts) host.endpoint.close(); await hub?.close(); fs.rmSync(temp, { recursive: true, force: true });
});
