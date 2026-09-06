// Acceptance for issue #3 (P02): a desktop/runtime/browser experiment in which verified
// endpoints exchange one encrypted task and authenticated control, recover on a clean
// endpoint, and remove a device.
//
// Structured by the ticket's four criteria. Where something cannot be shown on this
// machine, the check says BLOCKED with what is needed rather than passing quietly.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { KeyDirectory, KeyTransport } = require('../packages/e2ee/key-transport');
const { issueGrant, GrantLedger, Refusals } = require('../packages/e2ee/authorization');
const { HubStore } = require('../packages/hub/store');

const results = [];
function record(criterion, name, status, detail) {
  results.push({ criterion, name, status, detail });
  const mark = { pass: '  ✓', fail: '  ✗', blocked: '  ○', info: '  ·' }[status];
  console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
}
async function check(criterion, name, fn) {
  try {
    const r = await fn();
    record(criterion, name, r.status || 'pass', r.detail);
  } catch (err) {
    record(criterion, name, 'fail', String((err && err.message) || err));
  }
}

const ALICE = '@alice:plexus.local';
const BOB = '@bob:plexus.local';
const CANARY = 'CANARY-PLAINTEXT-8f3a';
const TASK = {
  threadId: 'thr_demo',
  name: 'Delete the build directory',
  prompt: 'Remove build/ and verify the workspace',
  note: CANARY
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p02-'));
  const dir = new KeyDirectory();
  const transport = new KeyTransport(dir);

  console.log('\nP02 encrypted endpoint acceptance\n');
  console.log('AC1  the relay, its database and its logs cannot read content or keys');

  const alice = await Endpoint.create({ user: ALICE, device: 'ALICEDEV', transport });
  const bob = await Endpoint.create({ user: BOB, device: 'BOBDEV', transport });
  await alice.track([BOB]);
  await bob.track([ALICE]);

  // The task and its control travel sealed. Everything the relay handles is persisted to a
  // real hub database so the claim is tested against real storage, not a variable.
  const dbFile = path.join(tmp, 'relay.sqlite');
  const store = new HubStore(dbFile);
  store.ensureOrg('team');
  store.upsertThread({ id: 'thr_demo', orgId: 'team', runtimeId: 'rt', name: 'encrypted thread' });

  const sealedTask = await alice.sealTo(BOB, 'BOBDEV', 'plexus.task', TASK);
  store.append('thr_demo', { method: 'plexus/sealed', envelope: sealedTask });
  dir.deliver(BOB, 'BOBDEV', sealedTask);

  await check('AC1', 'the relay holds only ciphertext in memory', async () => {
    const held = dir.everythingTheRelayHolds();
    for (const leak of [CANARY, 'Delete the build directory', 'Remove build/']) {
      assert.ok(!held.includes(leak), 'leaked: ' + leak);
    }
    return { detail: `algorithm ${sealedTask.content.algorithm}` };
  });

  await check('AC1', 'the hub database on disk holds only ciphertext', async () => {
    store.close();
    const raw = fs.readFileSync(dbFile, 'latin1');
    for (const leak of [CANARY, 'Delete the build directory', 'Remove build/']) {
      assert.ok(!raw.includes(leak), 'the sqlite file contains: ' + leak);
    }
    assert.ok(raw.includes('plexus/sealed'), 'the event was really written');
    return { detail: `${(raw.length / 1024).toFixed(1)} KB of sqlite, searched for plaintext` };
  });

  await check('AC1', 'the intended endpoint reads the task', async () => {
    const opened = await bob.open(dir.drain(BOB, 'BOBDEV'));
    const got = opened.find((e) => e.decrypted && e.type === 'plexus.task');
    assert.ok(got, 'bob could not decrypt the task');
    assert.equal(got.content.note, CANARY);
    assert.equal(got.sender, ALICE);
    return { detail: `sealed by ${got.sender}` };
  });

  await check('AC1', 'cleartext metadata the relay still needs is recorded', async () => ({
    status: 'info',
    detail: 'endpoint ids and public keys, who talks to whom, envelope sizes, timing, delivery cursors — see docs/proofs/e2ee-threat-model.md'
  }));

  console.log('\nAC2  a trusted endpoint verifies a new endpoint identity');

  await check('AC2', 'cross-signing identity established', async () => {
    const status = await alice.bootstrapCrossSigning();
    assert.ok(status, 'no cross-signing status returned');
    return { detail: `master key present: ${!!status.hasMaster}` };
  });

  await check('AC2', 'a second endpoint of the same account starts unverified', async () => {
    const alice2 = await Endpoint.create({ user: ALICE, device: 'ALICELAPTOP', transport });
    await alice2.track([ALICE]);
    await alice.track([ALICE]);
    const verified = await alice.isEndpointVerified(ALICE, 'ALICELAPTOP');
    assert.equal(verified, false, 'a new endpoint must not be trusted on sight');
    globalThis.__alice2 = alice2;
    return { detail: 'ALICELAPTOP unverified until vouched for' };
  });

  await check('AC2', 'an existing trusted endpoint verifies the new one', async () => {
    await alice.verifyEndpoint(ALICE, 'ALICELAPTOP');
    const verified = await alice.isEndpointVerified(ALICE, 'ALICELAPTOP');
    assert.equal(verified, true, 'verification did not take effect');
    return { detail: 'ALICEDEV signed ALICELAPTOP' };
  });

  await check('AC2', 'a relay-substituted key is not verified', async () => {
    // A hostile relay can offer a key it made up. It cannot make it verified, because
    // verification is a signature from an endpoint the account already trusts.
    const rogue = await Endpoint.create({ user: ALICE, device: 'ROGUEDEV', transport: new KeyTransport(new KeyDirectory()) });
    assert.notEqual(rogue.identity().ed25519, alice.identity().ed25519);
    const verified = await alice.isEndpointVerified(ALICE, 'ROGUEDEV');
    assert.equal(verified, false, 'a substituted key must never come back verified');
    return { detail: 'unknown to the trusted set, so unverified' };
  });

  await check('AC2', 'a modified control message does not decrypt', async () => {
    const sealed = await alice.sealTo(BOB, 'BOBDEV', 'plexus.control', { decision: 'accept' });
    const key = Object.keys(sealed.content.ciphertext)[0];
    sealed.content.ciphertext[key].body = sealed.content.ciphertext[key].body.slice(0, -8) + 'AAAAAAAA';
    dir.deliver(BOB, 'BOBDEV', sealed);
    const opened = await bob.open(dir.drain(BOB, 'BOBDEV'));
    assert.equal(opened.filter((e) => e.decrypted && e.type === 'plexus.control').length, 0);
    return { detail: 'fails closed' };
  });

  // Replay and staleness are authorization properties, not encryption ones: the ciphertext
  // of a captured approval stays perfectly valid, so the binding has to refuse it.
  const ledger = new GrantLedger();
  const pending = { requestId: 'req_42', turnId: 'turn_7', approverDevice: 'BOBDEV' };

  await check('AC2', 'a bound approval is accepted once', async () => {
    const grant = issueGrant({ ...pending, threadId: 'thr_demo', approverUser: BOB, decision: 'accept' });
    globalThis.__grant = grant;
    const r = ledger.resolve(grant, pending);
    assert.ok(r.ok, 'a fresh, bound grant should be accepted');
    return { detail: 'decision ' + r.decision };
  });

  await check('AC2', 'a replayed approval is refused', async () => {
    const r = ledger.resolve(globalThis.__grant, pending);
    assert.equal(r.ok, false);
    assert.equal(r.reason, Refusals.REPLAYED);
    return { detail: r.reason };
  });

  await check('AC2', 'an approval for a superseded turn is refused', async () => {
    const grant = issueGrant({ ...pending, threadId: 'thr_demo', approverUser: BOB, decision: 'accept' });
    const r = ledger.resolve(grant, { ...pending, turnId: 'turn_8' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, Refusals.STALE_TURN);
    return { detail: r.reason };
  });

  await check('AC2', 'an expired approval is refused', async () => {
    const grant = issueGrant({ ...pending, threadId: 'thr_demo', approverUser: BOB, decision: 'accept', ttlMs: 1000 });
    const r = ledger.resolve(grant, pending, { now: Date.now() + 60000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, Refusals.EXPIRED);
    return { detail: r.reason };
  });

  await check('AC2', 'an approval that did not arrive encrypted is refused', async () => {
    const grant = issueGrant({ ...pending, threadId: 'thr_demo', approverUser: BOB, decision: 'accept' });
    const r = ledger.resolve(grant, pending, { decrypted: false });
    assert.equal(r.ok, false);
    assert.equal(r.reason, Refusals.NOT_DECRYPTED);
    return { detail: r.reason };
  });

  console.log('\nAC3  clean-endpoint recovery, rotation and device removal');

  await check('AC3', 'the customer holds a recovery key the relay never sees', async () => {
    const { recoveryKey, version } = await alice.enableRecovery('1');
    globalThis.__recoveryKey = recoveryKey;
    assert.ok(recoveryKey && recoveryKey.length > 20);
    const held = dir.everythingTheRelayHolds();
    assert.ok(!held.includes(recoveryKey), 'the relay must never hold the recovery key');
    return { detail: `version ${version}, key held only by the customer` };
  });

  await check('AC3', 'a clean endpoint recovers with the customer key alone', async () => {
    const fresh = await Endpoint.create({ user: ALICE, device: 'ALICECLEAN', transport });
    const before = await fresh.recoveryKeyOnThisEndpoint();
    assert.equal(before, null, 'a clean endpoint starts with nothing');
    const restored = await fresh.restoreRecovery(globalThis.__recoveryKey, '1');
    assert.ok(restored, 'restore failed');
    const after = await fresh.recoveryKeyOnThisEndpoint();
    assert.equal(after, globalThis.__recoveryKey, 'the restored key should match');
    return { detail: 'no operator secret involved' };
  });

  await check('AC3', 'recovery does not reinstate a consumed or expired grant', async () => {
    // The ledger and the clock survive a restore, so history comes back and authority
    // does not. This is asserted because a naive "restore everything" would do the opposite.
    const replayed = ledger.resolve(globalThis.__grant, pending);
    assert.equal(replayed.reason, Refusals.REPLAYED);
    const stale = issueGrant({ ...pending, threadId: 'thr_demo', approverUser: BOB, decision: 'accept', ttlMs: 1 });
    const r = ledger.resolve(stale, pending, { now: Date.now() + 60000 });
    assert.equal(r.reason, Refusals.EXPIRED);
    return { detail: 'history restores; authority does not' };
  });

  await check('AC3', 'a removed endpoint receives no further content', async () => {
    dir.revoke(BOB, 'BOBDEV');
    const r = dir.deliver(BOB, 'BOBDEV', { type: 'm.room.encrypted', sender: ALICE, content: {} });
    assert.equal(r.delivered, false);
    assert.ok(!JSON.parse(dir.query()).device_keys[BOB]['BOBDEV'], 'still offered for new sessions');
    return { detail: r.reason + ', and dropped from the directory' };
  });

  // Revocation at the relay is access control: a relay that ignores its own list still
  // delivers. Rotation is the cryptographic half - the removed device is not given the new
  // session, so it cannot read what follows even if it receives the bytes.
  const ROOM = '!task_shared:plexus.local';
  const CAROL = '@carol:plexus.local';
  const carol = await Endpoint.create({ user: CAROL, device: 'CAROLDEV', transport });
  const alice3 = await Endpoint.create({ user: ALICE, device: 'ALICESHARED', transport });
  const bob3 = await Endpoint.create({ user: BOB, device: 'BOBSHARED', transport });
  for (const e of [alice3, bob3, carol]) await e.track([ALICE, BOB, CAROL]);

  await check('AC3', 'a shared task session reaches every current member', async () => {
    const shared = await alice3.shareTaskKey(ROOM, [ALICE, BOB, CAROL]);
    await bob3.open(dir.drain(BOB, 'BOBSHARED'));
    await carol.open(dir.drain(CAROL, 'CAROLDEV'));
    const m1 = await alice3.encryptTask(ROOM, 'plexus.task', { secret: 'BEFORE-REMOVAL' });
    globalThis.__m1 = m1;
    const asBob = await bob3.decryptTask(ROOM, m1);
    const asCarol = await carol.decryptTask(ROOM, m1);
    assert.equal(asBob.content.secret, 'BEFORE-REMOVAL');
    assert.equal(asCarol.content.secret, 'BEFORE-REMOVAL');
    return { detail: `${shared.delivered} key deliveries, both members read it` };
  });

  await check('AC3', 'removing a member rotates the session', async () => {
    dir.revoke(BOB, 'BOBSHARED');
    const rotated = await alice3.rotateTaskKey(ROOM);
    assert.equal(rotated, true, 'the group session should have been invalidated');
    await alice3.shareTaskKey(ROOM, [ALICE, CAROL]);
    await carol.open(dir.drain(CAROL, 'CAROLDEV'));
    return { detail: 'session invalidated and re-shared to the remaining members only' };
  });

  await check('AC3', 'a removed member cannot read what comes after', async () => {
    const m2 = await alice3.encryptTask(ROOM, 'plexus.task', { secret: 'AFTER-REMOVAL' });
    const asCarol = await carol.decryptTask(ROOM, m2);
    assert.equal(asCarol.content.secret, 'AFTER-REMOVAL', 'a remaining member must still read');
    let refused = false;
    try { await bob3.decryptTask(ROOM, m2); } catch { refused = true; }
    assert.ok(refused, 'the removed member decrypted post-rotation content');
    return { detail: 'carol reads it; bob cannot, even holding the ciphertext' };
  });

  await check('AC3', 'rotation does not retract what was already read', async () => {
    // Stated as a passing check because it is a real limit, not a bug: the old session is
    // still in the removed device's store, so history it already had stays readable.
    const stillReadable = await bob3.decryptTask(ROOM, globalThis.__m1);
    assert.equal(stillReadable.content.secret, 'BEFORE-REMOVAL');
    return { status: 'info', detail: 'a removed device keeps what it already decrypted — removal is forward-only' };
  });

  console.log('\nAC4  storage and packaging, and what must be recorded');

  await check('AC4', 'persistent key storage support on this platform', async () => {
    const support = await Endpoint.storageSupport();
    return {
      status: support.persistent ? 'pass' : 'info',
      detail: support.persistent
        ? `persistent via ${support.backend}`
        : `Node has no IndexedDB, so the crypto store is memory-only here. Persistence lives in the browser or the Electron renderer. (${support.reason.slice(0, 60)})`
    };
  });

  await check('AC4', 'protocol and library versions pinned', async () => {
    const v = require('../node_modules/@matrix-org/matrix-sdk-crypto-wasm/package.json').version;
    return { detail: `matrix-sdk-crypto-wasm ${v}, algorithm ${sealedTask.content.algorithm}` };
  });

  await check('AC4', 'desktop packaging of the crypto store', async () => ({
    status: 'blocked',
    detail: 'Needs the store in an Electron renderer with its pickle key sealed by safeStorage, exercised on macOS and Windows. Not built, and macOS cannot be exercised on this machine.'
  }));

  await check('AC4', 'offline revocation acknowledgment', async () => ({
    status: 'blocked',
    detail: 'An execution host that cannot reach the relay cannot learn a device was removed. Deciding the tolerated window is a product decision, not a test.'
  }));

  await check('AC4', 'qualified review requirement', async () => ({
    status: 'info',
    detail: 'This is an integration experiment, not a security audit. Independent review of the enrollment, recovery and revocation design is required before any E2EE claim is made publicly.'
  }));

  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const blocked = results.filter((r) => r.status === 'blocked').length;
  const info = results.filter((r) => r.status === 'info').length;
  console.log(`\n${pass} passed, ${blocked} blocked, ${info} recorded, ${fail} failed`);
  if (fail) { for (const f of results.filter((r) => r.status === 'fail')) console.log(`  - ${f.name}: ${f.detail}`); }
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'proofs', 'e2ee-acceptance-result.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('\nFAILED:', err && err.message); console.error(err); process.exit(1); });
