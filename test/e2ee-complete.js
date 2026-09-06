'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { chromium, _electron: electron } = require('playwright-core');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { ExperimentRelay } = require('../packages/e2ee/experiment-relay');
const { HttpKeyTransport } = require('../packages/e2ee/http-transport.mjs');
const { EncryptedHostControl, MembershipReceipt } = require('../packages/e2ee/host-control');
const { issueGrant } = require('../packages/e2ee/authorization');
const { KeyDirectory, KeyTransport } = require('../packages/e2ee/key-transport');
const root = path.join(__dirname, '..');
const results = [];
const ok = (name) => { results.push({ name, status: 'pass' }); console.log('PASS ' + name); };
const rejects = async (fn, pattern) => assert.rejects(fn, pattern);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-e2ee-complete-'));
const room = '!shared-project:plexus.local', privateRoom = '!other-project:plexus.local';
const secret = 'TASK-CANARY-' + randomBytes(18).toString('hex');
const recoveryKey = randomBytes(32).toString('base64url');
const user = (name) => '@' + name + ':plexus.local';
let relay, browser, desktop, host, control;
const endpoints = [];
const configs = {};
const transport = (name, device) => relay.enroll(user(name), device);

async function browserEndpoint(config, profile = 'browser') {
  browser = await chromium.launchPersistentContext(path.join(temp, profile), {
    executablePath: process.env.CHROMIUM_PATH || undefined, headless: true
  });
  const page = browser.pages()[0];
  await page.goto(relay.url);
  await page.waitForFunction(() => globalThis.e2eeProof);
  const identity = await page.evaluate((options) => e2eeProof.create(options), config);
  return pageDriver(page, identity);
}
function pageDriver(page, identity) {
  return {
    identity,
    call: (method, ...args) => page.evaluate(([name, values]) => e2eeProof.call(name, ...values), [method, args]),
    transport: (method, ...args) => page.evaluate(([name, values]) => e2eeProof.transport(name, ...values), [method, args])
  };
}
async function desktopEndpoint(config) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ cwd: root,
    executablePath: process.env.E2EE_DESKTOP_EXECUTABLE || undefined,
    args: [...(process.env.E2EE_DESKTOP_EXECUTABLE ? [] : ['packages/e2ee/desktop-proof-main.js']),
      '--user-data-dir=' + path.join(temp, 'desktop'), '--no-sandbox'], env
  });
  const page = await desktop.firstWindow();
  await page.waitForFunction(() => globalThis.e2eeProof);
  const identity = await page.evaluate((options) => e2eeProof.create(options), config);
  return pageDriver(page, identity);
}
async function stopBrowser(driver) { await driver.call('close'); await browser.close(); browser = null; }
async function stopDesktop(driver) { await driver.call('close'); await desktop.close(); desktop = null; }

(async () => {
  relay = new ExperimentRelay(path.join(temp, 'relay.sqlite')); await relay.listen();
  configs.alice = { user: user('alice'), device: 'BROWSER', storeName: 'alice-store',
    storeKey: [...randomBytes(32)], transport: transport('alice', 'BROWSER') };
  configs.owner = { user: user('owner'), device: 'DESKTOP', storeName: 'owner-store',
    desktopStore: true, transport: transport('owner', 'DESKTOP') };
  let alice = await browserEndpoint(configs.alice);
  let owner = await desktopEndpoint(configs.owner);
  host = await Endpoint.create({ user: user('host'), device: 'RUNTIME', transport: new HttpKeyTransport(transport('host', 'RUNTIME')) });
  endpoints.push(host);
  const ids = [alice.identity, owner.identity, host.identity()];
  const users = ids.map((id) => id.user);
  await alice.call('track', users); await owner.call('track', users); await host.track(users);
  await rejects(() => alice.call('sealControl', host.user, host.device, { test: true }), /endpoint_unverified/);
  await rejects(() => host.confirmEndpoint(owner.identity), /endpoint_confirmation_required/);
  await rejects(() => host.confirmEndpoint({ ...owner.identity, ed25519: 'substituted' }, { confirmed: true }), /endpoint_key_mismatch/);
  for (const id of ids) {
    await alice.call('confirmEndpoint', id, { confirmed: true });
    await owner.call('confirmEndpoint', id, { confirmed: true });
    await host.confirmEndpoint(id, { confirmed: true });
  }
  ok('browser, desktop and runtime require explicit matching fingerprint confirmation');

  const originalAlice = alice.identity, originalOwner = owner.identity;
  await stopBrowser(alice); alice = await browserEndpoint(configs.alice);
  assert.deepEqual(alice.identity, originalAlice);
  assert.equal(await alice.call('isEndpointVerified', owner.identity.user, owner.identity.device), true);
  await stopDesktop(owner); owner = await desktopEndpoint(configs.owner);
  assert.deepEqual(owner.identity, originalOwner);
  assert.equal(await owner.call('isEndpointVerified', alice.identity.user, alice.identity.device), true);
  const protection = await desktop.evaluate(({ safeStorage, app }) => ({ available: safeStorage.isEncryptionAvailable(),
    packaged: app.isPackaged, platform: process.platform, electron: process.versions.electron, node: process.versions.node }));
  assert.equal(protection.available, true);
  if (process.env.E2EE_DESKTOP_EXECUTABLE) assert.equal(protection.packaged, true);
  const wrappedKey = fs.readFileSync(path.join(temp, 'desktop', 'crypto-store-key'));
  assert.ok(wrappedKey.length > 32);
  ok('encrypted IndexedDB identities and verified peers survive browser and OS-protected desktop restarts');

  // A valid, newly generated key substituted under the exact expected user/device
  // must fail a fresh verifier, rather than merely being absent from its cache.
  const rogueDir = new KeyDirectory();
  const rogue = await Endpoint.create({ user: owner.identity.user, device: owner.identity.device, transport: new KeyTransport(rogueDir) });
  endpoints.push(rogue);
  const originalKeys = relay.directory.deviceKeys.get(owner.identity.user).get(owner.identity.device);
  relay.directory.deviceKeys.get(owner.identity.user).set(owner.identity.device, rogueDir.deviceKeys.get(owner.identity.user).get(owner.identity.device));
  const verifier = await Endpoint.create({ user: user('verifier'), device: 'VERIFY', transport: new HttpKeyTransport(transport('verifier', 'VERIFY')) });
  endpoints.push(verifier);
  await rejects(() => verifier.confirmEndpoint(owner.identity, { confirmed: true }), /endpoint_key_mismatch/);
  relay.directory.deviceKeys.get(owner.identity.user).set(owner.identity.device, originalKeys);
  ok('a malicious directory substituting a valid key for the exact endpoint identity is refused');

  const ledgerFile = path.join(temp, 'host.sqlite');
  const openHost = () => new EncryptedHostControl({ endpoint: host, owner: owner.identity, file: ledgerFile });
  control = openHost();
  let snapshot, revocation;
  async function reconcile(epoch, members, approvers) {
    const challenge = control.beginReconcile();
    revocation = new MembershipReceipt({ host: host.identity(), epoch, challenge });
    const ownerReceiver = { openControl: (events) => owner.call('openControl', events) };
    const wrongAck = await host.sealControl(owner.identity.user, owner.identity.device,
      { kind: 'membership.applied', epoch, challenge: 'stale-challenge' });
    await rejects(() => revocation.accept(ownerReceiver, wrongAck), /membership_receipt_mismatch/);
    assert.equal(revocation.status, 'pending-host-acknowledgment');
    snapshot = await owner.call('sealControl', host.user, host.device, { kind: 'membership', challenge, epoch, members, approvers });
    const ack = await control.applyMembership(snapshot);
    assert.equal(revocation.status, 'pending-host-acknowledgment');
    const receipt = await revocation.accept(ownerReceiver, ack);
    assert.equal(revocation.status, 'applied');
    assert.equal(receipt.content.epoch, epoch); assert.equal(receipt.content.challenge, challenge);
    assert.equal(receipt.senderDevice, host.device);
    return receipt;
  }
  const approver = alice.identity.user + '/' + alice.identity.device;
  await reconcile(1, ids, [approver]);
  const pending = { requestId: 'request-1', threadId: room, turnId: 'turn-1',
    approverUser: alice.identity.user, approverDevice: alice.identity.device };
  const grant = { ...issueGrant({ ...pending, decision: 'accept' }), membershipEpoch: 1 };
  const sealGrant = (value) => alice.call('sealControl', host.user, host.device, value);
  const forged = await sealGrant({ ...grant, approverUser: owner.identity.user });
  assert.equal((await control.resolve(forged, pending)).reason, 'grant_from_an_unexpected_endpoint');
  await rejects(() => host.openControl([{ type: 'plexus.control.v1', sender: alice.identity.user, content: grant }]), /control_not_authenticated/);
  const tampered = await sealGrant(grant);
  const key = Object.keys(tampered.content.ciphertext)[0];
  tampered.content.ciphertext[key].body = tampered.content.ciphertext[key].body.slice(0, -8) + 'AAAAAAAA';
  await rejects(() => control.resolve(tampered, pending), /control_not_authenticated/);
  assert.equal((await control.resolve(await sealGrant(grant), { ...pending, turnId: 'new-turn' })).reason, 'grant_for_a_superseded_turn');
  assert.equal((await control.resolve(await sealGrant(grant), pending)).ok, true);
  assert.equal((await control.resolve(await sealGrant(grant), pending)).reason, 'grant_already_consumed');
  const oldSnapshot = snapshot;
  control.close(); control = openHost();
  assert.equal((await control.resolve(await sealGrant(grant), pending)).reason, 'membership_reconciliation_required');
  control.beginReconcile();
  await rejects(() => control.applyMembership(oldSnapshot));
  await reconcile(1, ids, [approver]);
  assert.equal((await control.resolve(await sealGrant(grant), pending)).reason, 'grant_already_consumed');
  const originalOpenControl = host.openControl.bind(host);
  host.openControl = async (...args) => { const result = await originalOpenControl(...args); control.disconnect(); return result; };
  assert.equal((await control.resolve(await sealGrant(grant), pending)).reason, 'membership_reconciliation_required');
  host.openControl = originalOpenControl;
  const raceChallenge = control.beginReconcile();
  const raceSnapshot = await owner.call('sealControl', host.user, host.device,
    { kind: 'membership', challenge: raceChallenge, epoch: 1, members: ids, approvers: [approver] });
  const originalConfirm = host.confirmEndpoint.bind(host);
  host.confirmEndpoint = async (...args) => { const result = await originalConfirm(...args); control.disconnect(); return result; };
  await rejects(() => control.applyMembership(raceSnapshot), /membership_challenge_superseded/);
  host.confirmEndpoint = originalConfirm;
  assert.equal(control.reconciled, false);
  await reconcile(1, ids, [approver]);
  ok('authenticated sender, tamper, plaintext, stale-turn and replay checks survive execution-host restart');

  const extra = await Endpoint.create({ user: owner.identity.user, device: 'OTHER-PROJECT',
    transport: new HttpKeyTransport(relay.enroll(owner.identity.user, 'OTHER-PROJECT')) });
  endpoints.push(extra);
  await owner.call('confirmEndpoint', extra.identity(), { confirmed: true });
  for (const scope of [room, privateRoom]) {
    await owner.call('shareVerifiedTaskKey', scope, ids);
    await alice.call('open', await alice.transport('drain'));
    await host.open(await host.transport.drain());
  }
  const history = await owner.call('encryptTask', room, 'plexus.task', { text: secret });
  const privateHistory = await owner.call('encryptTask', privateRoom, 'plexus.task', { text: secret + '-private' });
  await owner.transport('putTask', room, history); await owner.transport('putTask', privateRoom, privateHistory);
  await extra.open(await extra.transport.drain());
  await rejects(() => extra.decryptTask(room, history));
  assert.equal((await alice.call('decryptTask', room, history)).content.text, secret);
  const backup = await alice.call('exportHistory', [room], recoveryKey);
  await alice.transport('backup', 'customer-history', backup);
  ok('real HTTP relay and sqlite hold encrypted tasks/backups; verified devices outside the explicit project membership receive no task key');

  // A removed device keeps old plaintext but cannot obtain the newly rotated session,
  // even if the relay deliberately gives it all subsequent ciphertext.
  control.disconnect();
  revocation = new MembershipReceipt({ host: host.identity(), epoch: 2, challenge: null });
  assert.equal((await control.resolve(await sealGrant(grant), pending)).reason, 'membership_reconciliation_required');
  relay.directory.revoke(alice.identity.user, alice.identity.device);
  await owner.call('shareVerifiedTaskKey', room, [owner.identity, host.identity()]);
  await host.open(await host.transport.drain());
  const future = await owner.call('encryptTask', room, 'plexus.task', { text: 'post-removal-' + secret });
  assert.equal((await host.decryptTask(room, future)).content.text, 'post-removal-' + secret);
  await rejects(() => alice.call('decryptTask', room, future));
  assert.equal((await alice.call('decryptTask', room, history)).content.text, secret);
  assert.equal(revocation.status, 'pending-host-acknowledgment');
  await reconcile(2, [owner.identity, host.identity()], []);
  assert.equal(revocation.status, 'applied');
  const rollbackChallenge = control.beginReconcile();
  const rollback = await owner.call('sealControl', host.user, host.device,
    { kind: 'membership', challenge: rollbackChallenge, epoch: 1, members: ids, approvers: [approver] });
  await rejects(() => control.applyMembership(rollback), /membership_rollback/);
  await reconcile(2, [owner.identity, host.identity()], []);
  const removedEnvelope = await sealGrant({ ...grant, membershipEpoch: 2 });
  const removedResult = await control.resolve(removedEnvelope, pending).catch((error) => ({ ok: false, reason: error.message }));
  assert.equal(removedResult.ok, false);
  assert.ok(['not_delegated_approver', 'control_not_authenticated'].includes(removedResult.reason));
  ok('offline host blocks controls until fresh authenticated membership is applied and acknowledged; rotation excludes removed device');

  await stopBrowser(alice);
  // The customer's new endpoint has a new device identity and an empty profile/store.
  const cleanConfig = { user: user('alice'), device: 'RECOVERED', storeName: 'clean-store',
    storeKey: [...randomBytes(32)], transport: transport('alice', 'RECOVERED') };
  const clean = await browserEndpoint(cleanConfig, 'clean-browser');
  assert.notEqual(clean.identity.ed25519, originalAlice.ed25519);
  const stored = await clean.transport('restore', 'customer-history');
  await rejects(() => clean.call('decryptTask', room, history));
  await rejects(() => clean.call('importHistory', stored.ciphertext, 'wrong-customer-key', [room]));
  const backupLines = stored.ciphertext.split('\n');
  backupLines[1] = (backupLines[1][0] === 'A' ? 'B' : 'A') + backupLines[1].slice(1);
  await rejects(() => clean.call('importHistory', backupLines.join('\n'), recoveryKey, [room]));
  await rejects(() => clean.call('importHistory', stored.ciphertext, recoveryKey, [privateRoom]), /recovery_scope_mismatch/);
  const imported = await clean.call('importHistory', stored.ciphertext, recoveryKey, [room]);
  assert.ok(imported.imported > 0);
  assert.equal((await clean.call('decryptTask', room, history)).content.text, secret);
  await rejects(() => clean.call('decryptTask', privateRoom, privateHistory));
  await rejects(() => clean.call('decryptTask', room, future));
  await rejects(() => clean.call('sealControl', host.user, host.device, grant), /endpoint_unverified/);
  const expired = { ...issueGrant({ ...pending, decision: 'accept', now: 1, ttlMs: 1 }), membershipEpoch: 2 };
  assert.equal(control.ledger.resolve(expired, pending, { decrypted: true }).reason, 'grant_expired');
  assert.equal(control.ledger.resolve(grant, pending, { decrypted: true }).reason, 'grant_already_consumed');
  ok('clean browser restores selected history with customer material alone, not other projects, future keys, identity trust or obsolete grants');

  const scan = relay.evidence();
  for (const canary of [secret, recoveryKey, Buffer.from(configs.alice.storeKey).toString('base64')]) {
    assert.ok(!scan.includes(canary), 'relay memory/logs do not contain customer plaintext or keys');
    for (const suffix of ['', '-wal']) {
      const file = path.join(temp, 'relay.sqlite' + suffix);
      if (fs.existsSync(file)) assert.ok(!fs.readFileSync(file).includes(Buffer.from(canary)));
    }
  }
  await rejects(() => clean.transport('putTask', room, { type: 'plaintext', sender: clean.identity.user, content: { text: secret } }), /relay_400/);
  ok('relay memory, sqlite/WAL and content-free logs pass plaintext/key canary scans; plaintext envelopes are refused');

  await stopBrowser(clean);
  // Wrong browser key cannot unlock persisted endpoint state; site-data loss creates
  // an untrusted endpoint whose only history path is explicit customer recovery.
  browser = await chromium.launchPersistentContext(path.join(temp, 'browser'), { executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const lockedPage = browser.pages()[0]; await lockedPage.goto(relay.url); await lockedPage.waitForFunction(() => globalThis.e2eeProof);
  await rejects(() => lockedPage.evaluate((options) => e2eeProof.create(options), { ...configs.alice, storeKey: [...randomBytes(32)] }));
  ok('wrong browser unlock key fails closed');

  await stopDesktop(owner);
  const keyFile = path.join(temp, 'desktop', 'crypto-store-key');
  fs.writeFileSync(keyFile, 'corrupted wrapped key');
  await rejects(() => desktopEndpoint(configs.owner));
  assert.equal(fs.readFileSync(keyFile, 'utf8'), 'corrupted wrapped key');
  ok('corrupt OS-wrapped desktop key fails closed without replacing the endpoint identity');

  const output = path.join(root, '.artifacts', 'e2ee-complete'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, process.platform + '.json'), JSON.stringify({
    ranAt: new Date().toISOString(), platform: process.platform, protection,
    sdk: require('../node_modules/@matrix-org/matrix-sdk-crypto-wasm/package.json').version,
    results, qualifiedReview: 'required before production security claims; not simulated by this test'
  }, null, 2));
  console.log(`${results.length} complete-experiment checks passed`);
})().catch((error) => { console.error('E2EE COMPLETE FAILED:', error); process.exitCode = 1; }).finally(async () => {
  control?.close();
  for (const endpoint of endpoints) endpoint.close();
  if (browser) await browser.close();
  if (desktop) await desktop.close();
  if (relay) await relay.close();
});
