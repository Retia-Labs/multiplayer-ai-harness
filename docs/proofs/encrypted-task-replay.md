# Durable encrypted task replay (issue #6)

Implementation for [issue #6](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/6),
built on #3's Matrix SDK endpoint and #5's authenticated team/host pairing.
The native dependency on #3's qualified review remains open. This document records
implementation evidence, not an independent cryptographic audit.

## Scope and entry points

The real hub now provides `/api/encrypted-tasks` and
`/api/encrypted-tasks/:id/events`, backed by separate durable SQLite tables.
A verified endpoint encrypts an objective to a pinned execution-host device with Olm.
A paired host validates the authenticated creator, task routing and its own local
opaque-project-to-workspace mapping. It then produces a versioned Megolm event log.
Only that paired runtime credential can append. Team members may retrieve ciphertext;
membership is not cryptographic enrollment.

The host opts into `encryptedTasksOnly: true` (or CLI `--encrypted-tasks-only` /
`runtime.json` configuration). Its fleet descriptor exposes `taskProtocol: encrypted-v1`
and no local project names or paths. Legacy command dispatch and legacy thread re-upload
are disabled for that host. The relay requires this advertised mode for new encrypted
tasks. Keep opaque project/workspace mappings local to the host adapter; the fixture's
canary scan includes the actual authorized workspace path, not just example tool paths.

`packages/e2ee/task-log.mjs` is shared Node/browser code for creation, transport,
ordered replay, endpoint projections and writer retry. `packages/runtime/encrypted-task.js`
supplies a provider-independent host boundary, SQLite outbox/checkpoint storage, and
deterministic fixture events. Later provider slices can replace fixture production
while retaining the transport/replay contract. Fixture execution never invokes an
inference provider or authorizes arbitrary tools.

The acceptance browser is a test fixture, not a new production screen. Existing
`thr_` prototype tasks still use their explicitly separate legacy protocol. New
`et_` tasks never enter those tables, command caches, server content projections,
search or file-overlap logic. Legacy commands, upserts, appends, subscriptions and
HTTP history reject their identifiers instead of falling back to plaintext.
The production composer/provider integration is the later real-task slice (#7).

## Wire metadata and encrypted content

| Cleartext at relay | Reason |
| --- | --- |
| Protocol version and random task/project/event IDs | Routing, format negotiation and idempotency; never names or paths |
| Team, creator account and paired runtime IDs | Account authorization and immutable ownership |
| Olm/Megolm algorithm, public sender/device/session identifiers, recipient key and SDK message ID | Established protocol envelope/key routing |
| Sequence numbers, request/response sizes, request timing and replay cursors | Ordering, pagination and delivery |
| Account/team/pairing data already maintained by #5 | Administrative authorization; not task decryption keys |

Titles, objectives, messages, plans, tool names/arguments/results, diffs, file paths and
detailed activity live inside encrypted payloads. Task creation requests are encrypted
too. Random IDs carry no file paths or human labels. The task routes never log request
bodies and return fixed error codes rather than reflecting bad input or crypto errors.
The relay caps uploads at 1 MiB and event pages at 100 records.

An encrypted event repeats its complete task routing tuple, event ID and sequence,
and includes the SHA-256 digest of the previous canonical wire record. This is
application ordering/integrity framing authenticated by the SDK's Megolm encryption,
not an application cryptographic primitive. Readers check the confirmed writer's
user/device/fingerprints and SDK provenance. Account cross-signing warnings can be
resolved by the explicit device pin; unknown, mismatched or unauthenticated imported
session provenance cannot. Recovery/imported-history authentication remains subject
to the #3/#8 review and enrollment contracts.

## Replay and retry behavior

A new reader starts at sequence zero and rebuilds every field from paginated history.
A reader already holding accepted events fetches only the suffix and keeps its state.
Concurrent reconnects serialize. Identical duplicate records are ignored; changed
records at an accepted sequence, reused event IDs, gaps, changed routing, unknown
versions, broken chain links, unverified senders and ciphertext failures are errors.

The reader exposes an error status/code and retains previously accepted history.
The fixture renders that status and preserves the last rendered task. A subsequent
valid reconnect can recover. Pagination uses a fixed head for one replay, so newly
appended events belong to a subsequent catch-up.

The writer requires a stable event ID and explicit durable load/save callbacks. Its
SQLite outbox stores the exact encrypted pending record before upload; after lost
acknowledgment or writer-state restart it resends those same bytes. Unique event IDs
and contiguous sequence enforcement make append transactional and idempotent.
The outbox stores encrypted records and sequence/digest checkpoints, not task text.

A persisted/previously observed checkpoint detects rollback below known history.
A fresh device with no trusted checkpoint cannot prove that an adversarial relay
has not withheld an unseen suffix; `caught-up` means through the advertised head,
not a freshness guarantee from an offline host. Missing interior events are detected.
The runtime crypto store remains memory-only as in #3; the restart proof reopens
durable writer state while preserving the enrolled crypto endpoint. Full host key
recovery and provider execution resumption are not simulated.

## Reproduce

Use Node 24 or newer and `npm ci`. Install a browser with
`node node_modules/playwright-core/cli.js install chromium` (add `--with-deps` on Linux),
or set `CHROMIUM_PATH` to a local Chromium-family executable.

- `npm run test:encrypted-task:node`: real hub/runtime pairing, all fixture content,
  replay/pagination, duplicate delivery, durable retry, adversarial records,
  authorization, relay restart, revocation and canary scans.
- `npm run test:encrypted-task:browser`: persistent encrypted IndexedDB enrollment,
  page restart while the host writes, full reconstruction, visible rollback error,
  preservation/recovery of the rendered history and relay canary scans.
- `npm run test:encrypted-task`: both; also part of `npm test`.
- `.github/workflows/encrypted-task.yml`: Node 24 on Linux and Windows with real
  Chromium and existing protocol/unit/team regression tests.

Results are generated under `.artifacts/encrypted-task/`; CI uploads only JSON
pass/fail reports. The local screenshot is a fixture containing synthetic canaries,
not a production screenshot baseline. No production UI/design contract is changed.

## Remaining gates

Qualified review of #3 and this additional authenticated log framing is still needed.
The hosted browser trusts delivered application code; authorized endpoints and the
selected inference provider see plaintext when used. This change does not claim
production-wide E2EE, global live-host freshness, signed installers, key recovery
across a full runtime restart or exactly-once external side effects.
