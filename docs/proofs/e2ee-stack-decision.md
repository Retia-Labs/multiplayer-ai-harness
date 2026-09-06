# Encrypted endpoint experiment and library decision

Implementation evidence for [issue #3](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/3).
This is a bounded desktop/runtime/browser experiment. It does not encrypt the current
production hub, and it has not received independent qualified security review.

## Decision

Use `@matrix-org/matrix-sdk-crypto-wasm` 18.8.0 (lockfile version) for this experiment:
Olm `m.olm.v1.curve25519-aes-sha2` for authenticated endpoint controls and group-key
delivery, Megolm `m.megolm.v1.aes-sha2` for project content, and the SDK's authenticated
Megolm session export for customer recovery. Cryptographic primitives, encrypted storage
and recovery encryption come from the SDK. The adapter adds transport, explicit endpoint
trust, membership and grant policy.

The same endpoint module runs through the Node SDK entry point on the execution host and
the browser WASM entry point in Chromium and a bundled Electron renderer. This avoids a
second crypto implementation or a Rust/WASM build pipeline. Adoption elsewhere does not
audit our adapter. MLS remains a review option for atomic membership epochs and
post-compromise security; this experiment makes no MLS-equivalent guarantee.

SDK contracts: [OlmMachine](https://matrix-org.github.io/matrix-sdk-crypto-wasm/classes/OlmMachine.html)
and [StoreHandle](https://matrix-org.github.io/matrix-sdk-crypto-wasm/classes/StoreHandle.html).
Installed 18.8.0 declarations, the lockfile and executable tests govern this result.

## Enrollment, content and control

`confirmEndpoint` requires explicit confirmation of both fingerprints obtained through
an already trusted channel. A relay entry alone grants no trust. Verified SDK sender
user/device/key are bound to host membership, delegated approver, epoch, thread, request,
turn and expiry. Consumed grant IDs and resolved request IDs commit to host-local SQLite
before approval returns. This proves durable single-use authorization, not exactly-once
command execution.

`shareVerifiedTaskKey` accepts an explicit list of confirmed project endpoints, rotates
the old group session and filters deliveries to that list. Another verified device of
the same account receives no key unless included. Removed endpoints cannot decrypt later
ciphertext but retain old history. Low-level spike APIs remain for primitive tests;
production callers must not substitute them for the policy-enforcing entry points.

## Recovery and storage

A customer retains a random 32-byte recovery secret. The SDK encrypts an export of selected
project session keys with it (500,000 KDF rounds). Only the encrypted export is uploaded.
A clean browser with a new identity recovers selected history using customer material
alone. Wrong keys, modified backups and unexpected project scopes fail closed. Recovery
does not restore identity, trust, delegation, host state or consumed grants. The older
backup-key import probe is not the history recovery proof.

Browser IndexedDB uses `StoreHandle.openWithKey` with a customer-held 32-byte unlock key
supplied in memory, never persisted by the proof in localStorage. Desktop IndexedDB uses a
random key wrapped by Electron `safeStorage` (Windows DPAPI/macOS Keychain). Its custom
secure origin serves bundled code/WASM; key IPC accepts only that window's main frame.
Unavailable OS protection and corrupt wrapped keys fail closed.

The runtime SDK store is explicitly memory-only; its grant/membership SQLite state is
durable. A full runtime restart must enroll a new crypto identity, not silently reuse
trust for newly generated keys. The control-ledger restart test retains the runtime
crypto process and does not claim persistent Node crypto storage.

## Offline removal

Disconnected or newly started control hosts refuse controls. Reconciliation uses a random
host challenge and an encrypted snapshot from the pinned owner. The host rejects stale
challenges/epoch rollback, persists membership and emits an authenticated encrypted
acknowledgment. Removal stays pending until the owner receives the matching host,
challenge and epoch. Failure or withholding never becomes timer-based success.

A relay withholding updates on an apparently live connection cannot make a host learn
them instantly. Production needs a freshness/availability policy and acknowledgment from
every affected host and key sender before claiming globally completed removal.

## Reproduce and evidence

- `npm ci`, then `node node_modules/playwright-core/cli.js install chromium`.
- `npm run test:e2ee`: legacy primitive matrix plus complete source experiment.
- `npm run test:e2ee:platform`: build an unpacked Windows/macOS Electron app for the
  current architecture and run the complete experiment with `app.isPackaged === true`.
- `npm run test:e2ee:spike`: original primitive interoperability smoke test.
- `.github/workflows/e2ee-experiment.yml`: packaged Windows/macOS checks and uploaded
  machine-readable evidence. Local results: `.artifacts/e2ee-complete/`.
  `CHROMIUM_PATH` may select a locally installed Chromium-family browser.

Complete checks cover fingerprint verification, valid substituted directory keys,
encrypted-store restart, tampered/plaintext/forged controls, stale turns, durable replay
rejection, HTTP/SQLite relay traffic, exact project recipients, offline reconciliation,
encrypted acknowledgment, forward exclusion, clean scoped recovery, wrong/tampered
recovery material, and corrupt storage. Relay memory, SQLite/WAL and content-free logs
are scanned for task/key canaries. These are regression checks, not exhaustive leak proofs.

The tracked `e2ee-acceptance-result.json` is historical primitive evidence. New runs write
artifacts instead of overwriting it. See [verification](e2ee-verification.md) and
[threat model](e2ee-threat-model.md).

## Qualified review gate

The implementation and automated evidence can be completed independently. Issue #3's
reviewed decision remains pending until a named qualified reviewer records disposition
of SDK use, trust establishment, recovery scope, revocation/freshness and failure cases.
Do not call automated tests independent review, close the issue on that basis, or
advertise production E2EE.
