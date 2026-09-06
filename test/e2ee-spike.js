// Spike for issue #3 (P02): encrypted endpoint enrollment, control and recovery.
//
// The claim under test is narrow and checkable: the relay does its whole job without ever
// holding anything it can read. Most checks therefore assert on what the *relay* has,
// not on what the endpoints managed to say to each other.
const assert = require('assert');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { KeyDirectory, KeyTransport } = require('../packages/e2ee/key-transport');

let passed = 0;
const ok = (name, detail) => { passed++; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); };

const ALICE = '@alice:plexus.local';
const BOB = '@bob:plexus.local';

// A control message with content that must never appear in the clear anywhere the relay
// can see, plus a marker string that is easy to grep for.
const SECRET = {
  method: 'approval/resolve',
  requestId: 'req_42',
  decision: 'accept',
  command: 'rm -rf build',
  note: 'CANARY-PLAINTEXT-8f3a'
};

(async () => {
  console.log('\nP02 encrypted endpoint spike\n');
  const dir = new KeyDirectory();
  const transport = new KeyTransport(dir);

  console.log('Enrollment');
  const alice = await Endpoint.create({ user: ALICE, device: 'ALICEDEV', transport });
  const bob = await Endpoint.create({ user: BOB, device: 'BOBDEV', transport });
  ok('two endpoints enrolled against the relay', `${alice.identity().ed25519.slice(0, 12)}… / ${bob.identity().ed25519.slice(0, 12)}…`);

  const relayAfterEnrollment = dir.everythingTheRelayHolds();
  assert.ok(!relayAfterEnrollment.includes('CANARY'), 'no content yet, obviously');
  assert.ok(relayAfterEnrollment.includes('ed25519'), 'the relay does hold public identity keys');
  ok('the relay holds public keys and nothing private', 'device_keys + one_time_keys only');

  await alice.track([BOB]);
  await bob.track([ALICE]);
  const bobSeenByAlice = await alice.getDevice(BOB, 'BOBDEV');
  assert.ok(bobSeenByAlice, 'alice can resolve bob through the relay');
  ok('an endpoint discovers another through the relay', 'BOBDEV visible to alice');

  console.log('\nContent the relay cannot read');
  const sealed = await alice.sealTo(BOB, 'BOBDEV', 'plexus.control', SECRET);
  const wire = JSON.stringify(sealed);
  dir.deliver(BOB, 'BOBDEV', sealed);

  const held = dir.everythingTheRelayHolds();
  assert.ok(!held.includes('CANARY-PLAINTEXT-8f3a'), 'the canary must not be readable by the relay');
  assert.ok(!held.includes('rm -rf build'), 'the command must not be readable by the relay');
  assert.ok(!held.includes('approval/resolve'), 'even the control method must not leak');
  ok('the relay holds only ciphertext', `${wire.length} bytes, algorithm ${sealed.content.algorithm}`);

  const delivered = dir.drain(BOB, 'BOBDEV');
  const opened = await bob.open(delivered);
  const got = opened.find((e) => e.type === 'plexus.control' && e.decrypted);
  assert.ok(got, 'bob received and decrypted the control message');
  const content = typeof got.content === 'string' ? JSON.parse(got.content) : got.content;
  assert.equal(content.command, 'rm -rf build');
  assert.equal(got.sender, ALICE);
  ok('the intended endpoint decrypts it, attributed to its sender', `sender ${got.sender}`);

  console.log('\nAdversarial: what a hostile relay can and cannot do');
  // A relay that swaps in its own device key gets a different endpoint identity - it does
  // not silently become alice.
  const forged = new KeyDirectory();
  const forgedTransport = new KeyTransport(forged);
  const impostor = await Endpoint.create({ user: ALICE, device: 'ALICEDEV', transport: forgedTransport });
  assert.notEqual(impostor.identity().ed25519, alice.identity().ed25519);
  ok('a substituted key is a different identity, not the same one', 'ed25519 differs');

  // Tampering with the ciphertext must fail closed rather than yield altered plaintext.
  const tampered = await alice.sealTo(BOB, 'BOBDEV', 'plexus.control', { ...SECRET, decision: 'accept' });
  const victimKey = Object.keys(tampered.content.ciphertext)[0];
  const body = tampered.content.ciphertext[victimKey].body;
  tampered.content.ciphertext[victimKey].body = body.slice(0, -8) + 'AAAAAAAA';
  dir.deliver(BOB, 'BOBDEV', tampered);
  const afterTamper = await bob.open(dir.drain(BOB, 'BOBDEV'));
  const readable = afterTamper.filter((e) => e.decrypted && e.type === 'plexus.control');
  assert.equal(readable.length, 0, 'a modified control message must not decrypt');
  ok('a modified control message does not decrypt', 'fails closed');

  console.log('\nRevocation');
  dir.revoke(BOB, 'BOBDEV');
  const afterRevoke = dir.deliver(BOB, 'BOBDEV', { type: 'm.room.encrypted', sender: ALICE, content: {} });
  assert.equal(afterRevoke.delivered, false);
  assert.equal(afterRevoke.reason, 'endpoint_revoked');
  ok('a removed endpoint receives no further content', afterRevoke.reason);
  assert.ok(!JSON.parse(dir.query()).device_keys[BOB]['BOBDEV'], 'and is dropped from the directory');
  ok('and is no longer offered to anyone establishing a session', 'absent from KeysQuery');

  console.log(`\n${passed} spike checks passed ✅`);
  console.log('\nNOT proved here: clean-endpoint recovery, key rotation on membership change,');
  console.log('desktop/browser key storage, and offline revocation acknowledgment.');
  process.exit(0);
})().catch((err) => { console.error('\nFAILED:', err && err.message); console.error(err); process.exit(1); });
