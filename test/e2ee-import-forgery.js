'use strict';
// Adversarial check on the imported-session contract added for issue #8.
//
// #6 refused every imported session because an export proves nothing about where it came
// from. #8 narrowed that refusal: an import is readable when its session ids arrived through
// a handoff the receiving endpoint opened itself, sealed by a fingerprint it had confirmed.
//
// This asks the obvious follow-up question. The seal proves *who handed it over*. It does not
// prove *who wrote the sessions inside it*, and an exported megolm session carries its sender
// keys as claimed metadata that the exporter chooses. So: can a teammate the joiner has
// confirmed - not the execution host - hand over a session that claims to be the host's, and
// have fabricated events accepted as the host's writes?
//
// The relay is untrusted in this threat model, so serving the fabricated record is assumed,
// and modelled here by handing it straight to the reader.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sdk = require('@matrix-org/matrix-sdk-crypto-wasm');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { KeyDirectory, KeyTransport } = require('../packages/e2ee/key-transport');
const { EncryptedTaskReader, newId } = require('../packages/e2ee/task-log.mjs');
const { roomFor, matrixUser, VERSION } = require('../packages/protocol/encrypted-task.mjs');
const { acceptProjectAccess } = require('../packages/e2ee/enrollment.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-forgery-'));
const findings = [];

(async () => {
  const directory = new KeyDirectory();
  const keys = new KeyTransport(directory);
  const hostId = 'rt_' + '0'.repeat(16);
  const aliceId = 'u_alice';
  const bobId = 'u_bob';
  const host = await Endpoint.create({ user: matrixUser(hostId), device: 'HOST', transport: keys });
  const alice = await Endpoint.create({ user: matrixUser(aliceId), device: 'ALICEDEV', transport: keys });
  const bob = await Endpoint.create({ user: matrixUser(bobId), device: 'BOBDEV', transport: keys });

  // Bob has confirmed both, exactly as the enrolment flow requires: the host because it is
  // the writer, and Alice because she is the teammate who let him in.
  for (const peer of [host, alice]) await bob.confirmEndpoint(peer.identity(), { confirmed: true });
  for (const peer of [bob, alice]) await host.confirmEndpoint(peer.identity(), { confirmed: true });
  for (const peer of [bob, host]) await alice.confirmEndpoint(peer.identity(), { confirmed: true });

  const taskId = newId('et');
  const room = roomFor(taskId);
  const task = { version: VERSION, id: taskId, teamId: 'team_1', runtimeId: hostId, projectId: newId('ep'), creatorUserId: aliceId };

  // Alice builds a megolm session of her own for this task's room, then rewrites the export
  // so it claims the host's identity keys. Nothing stops her: the fields are hers to write.
  // A megolm session only exists once it has been shared, so she shares one with herself.
  await alice.shareTaskKey(room, [matrixUser(aliceId)]);
  await alice.encryptTask(room, 'plexus.task.event.v1', { warmup: true });
  const raw = JSON.parse(await alice.machine.exportRoomKeys((session) => session.roomId.toString() === room));
  assert.ok(raw.length >= 1, 'alice holds a session for the room');
  const hostKeys = host.identity();
  const forged = raw.map((session) => ({
    ...session,
    sender_key: hostKeys.curve25519,
    sender_claimed_keys: { ed25519: hostKeys.ed25519 }
  }));
  const transferKey = 'f'.repeat(64);
  const blob = sdk.OlmMachine.encryptExportedRoomKeys(JSON.stringify(forged), transferKey, 10000);

  // She seals it to Bob as a project-history handoff. This is a real seal from a device Bob
  // has genuinely confirmed - no impersonation is needed anywhere in this step.
  const envelope = await alice.sealControl(matrixUser(bobId), 'BOBDEV', {
    type: 'plexus.project.history.v1', teamId: task.teamId, projectId: task.projectId, rooms: [room], transferKey
  });
  let accepted = { sessions: [] };
  let handoffRefused = null;
  try {
    accepted = await acceptProjectAccess(bob, { history: { blob, envelope, rooms: [room] } }, { writer: hostKeys });
  } catch (error) { handoffRefused = error.code || String(error.message || error); }

  // Alice now writes an event the host never wrote, under the session she just gave away.
  const fabricated = { type: 'task.created', payload: { title: 'Ship it', objective: 'Approved by the team.' } };
  const envelope2 = await alice.encryptTask(room, 'plexus.task.event.v1', {
    version: VERSION, task, seq: 1, eventId: 'ev_' + 'a'.repeat(32), previous: null, event: fabricated
  });
  const record = { version: VERSION, id: 'ev_' + 'a'.repeat(32), seq: 1, envelope: { ...envelope2, sender: matrixUser(hostId) } };

  // Bob reads it as the host's writing, because that is what the session claims.
  const reader = new EncryptedTaskReader({
    endpoint: bob, task, writer: hostKeys, admittedSessions: accepted.sessions
  });
  let accepted2 = null;
  try { await reader.accept(record); accepted2 = reader.state.title; } catch (error) { accepted2 = { refused: error.code || String(error.message || error) }; }

  const forgeryAccepted = !handoffRefused && accepted2 === 'Ship it';
  findings.push({
    id: 'IMPORT-FORGERY',
    question: 'Can a confirmed teammate hand over a session claiming the execution host, and have fabricated events read as the host\'s?',
    result: forgeryAccepted ? 'ACCEPTED - the forgery was read as host-written'
      : 'refused at the handoff: ' + (handoffRefused || JSON.stringify(accepted2))
  });
  console.log((forgeryAccepted ? 'FINDING  ' : 'refused  ') + findings[0].question);
  console.log('         ' + findings[0].result);

  fs.mkdirSync(path.join(__dirname, '..', '.artifacts', 'e2ee-review'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', '.artifacts', 'e2ee-review', 'import-forgery.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), findings }, null, 2) + '\n');

  // This file is a regression test for the fix: once the handoff is bound to the writer, the
  // forgery must be refused, and a non-zero exit means it was not.
  process.exit(forgeryAccepted ? 1 : 0);
})().catch((error) => { console.error('ATTACK HARNESS FAILED\n', error); process.exit(2); });
