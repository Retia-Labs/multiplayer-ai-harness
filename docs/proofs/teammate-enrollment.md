# Inviting a verified teammate into encrypted project history (issue #8)

Implementation for [issue #8](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/8),
built on [#3](e2ee-verification.md)'s endpoint and [#6](encrypted-task-replay.md)'s task log.
The native dependency on #3's qualified review remains open. This records implementation
evidence, not an independent cryptographic audit.

## Two gates, and why they are separate

Joining a project is two decisions that look like one:

| | Kept by | Decides | On its own it gives you |
| --- | --- | --- | --- |
| **Project grant** | the relay, in `project_grants` | who may fetch this project's ciphertext | bytes nobody can open |
| **Endpoint enrolment** | `endpoint_enrollments`, plus local trust on each endpoint | whose device may be sealed to | nothing to open |

This changes #6. There, *"team members may retrieve ciphertext"*; now retrieval is scoped to
project participants, and a task id copied out of a private link is refused at the relay by a
member of the same team. Creating a task in a project makes its creator that project's owner,
so the creator never locks themselves out of what they just made.

An account and an accepted invitation produce a `pending` row and nothing else. Confirmation
comes from an endpoint already verified in that team, or from the team owner acting as the
team's recovery authority - but only while the owner has no verified endpoint left, which is
the situation that authority exists for. An owner who still holds one confirms from it like
anybody else; otherwise possession of the owner's session would enrol endpoints into the
team's trust, and "login is not trust" would have an exception big enough to walk through.
The announced fingerprints must match, and a confirmation naming other keys is refused rather
than applied. The team's first endpoint is self-confirmed and recorded as `bootstrap` - every
trust graph has a root and this one is named.

Handing over history consults both verdicts. Local trust survives a device being revoked -
an endpoint that confirmed it once has no reason to forget - so the relay's view is checked
as well before anything is sealed, and a revoked endpoint receives nothing further however
trusted it once was. The two layers refuse on their own grounds and either refusal is enough.

Confirmation is device-fingerprint trust, not cross-signing. Signing another account's device
requires user-signing keys and a verified account identity that this adapter does not
establish, which is the same position `decryptVerifiedTask` already takes when it accepts an
explicitly pinned device over an account-level warning.

## How history reaches someone who was not there

Megolm exports a group session's key **at its current ratchet index**. Admitting a new
endpoint to a running session therefore grants the next event and never a past one; there is
no arrangement of the relay that changes this. Existing history has to move as a room-key
export, scoped to that project's rooms, encrypted to a single-use transfer key, with the
transfer key sealed to one confirmed device. `sealControl` refuses to seal for a device this
endpoint has not confirmed, which is what stops a grant from quietly becoming access.

#6 refused every imported session, because an export carries no provenance a reader can check
- it is exactly what an attacker would also hand you - and left the question to this slice.
The contract is now explicit: **an imported session is readable only for the session ids that
came out of a handoff the receiving endpoint opened itself, sealed by the execution host that
wrote the log.** Every other import stays refused, with no plaintext fallback.

The writer specifically, and not merely an endpoint the reader has confirmed. The first
version of this contract accepted a handoff from any confirmed endpoint, and that was wrong:
an exported session states its sender keys as claimed metadata chosen by whoever exported it,
so a confirmed teammate could hand over a session claiming the host's keys and have fabricated
events read as the host's writing. `test/e2ee-import-forgery.js` performs that forgery; it
succeeded, and it is kept as a regression test now that the handoff is bound to the writer.
Only the party whose sessions they are can vouch for them.

One check weakens under that contract and is recorded here rather than buried: an exported
session carries the writer's keys but **not its device id**, so an admitted session cannot be
matched against a device name. The writer's curve25519/ed25519 pair must still match, and the
device must still be one the reader has confirmed, so the identity check survives - only the
name it is spelled with is unavailable. Sender, sequence, digest chain and event-id checks
are unchanged.

The admitted session-id set is durable trust state, like the replay checkpoint. An endpoint
that loses it holds the keys to its own history and refuses to read it until the handoff is
repeated. The browser fixture persists it beside the checkpoint.

## Refusals

Each has its own code, because a suite where every denial says "not found" hides the bugs
this slice is about.

| Code | Raised when |
| --- | --- |
| `not_a_project_participant` | a team member fetches, lists or appends to a project they hold no grant on |
| `confirming_endpoint_unverified` | an unconfirmed endpoint tries to vouch for another |
| `endpoint_key_mismatch` | a confirmation names keys other than the announced ones |
| `endpoint_confirmation_required` | confirming without asserting an out-of-band comparison |
| `endpoint_device_id_reused` | a device id returns with different keys |
| `endpoint_unverified` | sealing or key-sharing aimed at a device this endpoint has not confirmed |
| `project_history_not_from_writer` | a history handoff sealed by anyone but the execution host that wrote the log |
| `project_history_writer_required` | a handoff accepted without naming the writer to check it against |
| `member_endpoint_unverified` | a handoff aimed at a device the relay does not list as verified, including a revoked one |
| `endpoint_revoked` | confirming an endpoint that has been revoked |
| `endpoint_not_announced` | a revoked endpoint trying to announce its way back to pending |
| `team_already_bootstrapped` | a second attempt to self-confirm a team's first endpoint |
| `project_owner_grant_retained` | a participant trying to revoke the project owner's own grant |
| `task_integrity_failed` | ciphertext that cannot be opened, or a session not admitted by a handoff |
| `owning_runtime_required` | a participant tries to append to the log through the relay |
| `granting_endpoint_unverified` | a grant issued from an account with no confirmed endpoint |

## Site-data loss and re-enrolment

A browser profile that loses its IndexedDB has lost the private half of the identity that was
vouched for. The account, its token and the project grant survive that loss untouched, so if
enrolment were a property of the account the rebuilt profile would keep reading. It is a
property of the keys: the rebuilt endpoint announces as `pending`, holds its grant, fetches
ciphertext and cannot open any of it until a human confirms it again.

The rebuilt endpoint must also take a **new device id**. Device keys are immutable in the
crypto layer, so the same id returning with different keys can never be confirmed; the relay
refuses to record such a row rather than storing one no endpoint could ever act on.

## What the relay still sees

Everything #6 lists, plus: device ids and public device keys, who confirmed whom and when,
project grants with their roles and grantors, and the `bootstrap` marker. All of it is
administrative authorization, none of it decrypts anything. Project ids remain random and
carry no names or paths. Enrolment routes cap uploads at 64 KiB, never reflect request
bodies, and return fixed codes.

Participant role and pending endpoint states are exposed through `participation()`, which
names who is granted but cannot yet read - the state that otherwise looks identical to being
fully joined.

## Reproduce

Node 24 or newer and `npm ci`, then `node node_modules/electron/install.js` is *not* needed
here, but a browser is: `node node_modules/playwright-core/cli.js install chromium` (add
`--with-deps` on Linux), or set `CHROMIUM_PATH`.

- `npm run test:import-forgery` - the forgery above, which must be refused.
- `npm run test:teammate-enrollment:node` - 37 checks: pending enrolment, refused
  confirmations, project scoping, the two-gate proof, late-join replay of a running task,
  events after the grant, a second task needing no second grant, grant and endpoint
  revocation, vouching by a verified non-owner, the owner's recovery authority after losing
  every endpoint, site-data loss and re-enrolment, and a canary scan of everything the relay
  serves. Every refusal in the table above has a check.
- `npm run test:teammate-enrollment:browser` - 8 checks in real Chromium with a persistent
  profile: announce, blind read, confirmed late-join replay, restart persistence, profile
  wipe, refused read, re-enrolment, and relay canary scans.
- `npm run test:teammate-enrollment` - both; also part of `npm test`.

Results are written to `.artifacts/teammate-enrollment/`; CI uploads the JSON reports only.

## Remaining gates

The qualified review of #3 and #6's log framing still covers this. Key exchange itself still
runs through the in-process `KeyDirectory`/`ExperimentRelay` spike rather than the real hub's
WebSocket, exactly as in #6 - the enrolment *records* are in the real hub, the key transport
is not. Out-of-band fingerprint comparison is asserted by the caller and cannot be checked by
anything here. There is no production UI: participant state is exposed as data and rendered
only by the fixture, because the joining teammate's view belongs to
[#9](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/9). Removing a participant revokes
the grant, stops further handoffs and rotates on the next admission; what is *not* proven
here is that a removed reader cannot follow a rotation it never received, which is #10/#11's
territory. Nothing revokes knowledge already decrypted, and nothing here claims to.
