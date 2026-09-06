# Threat model: encrypted endpoint experiment

Scope: isolated `packages/e2ee/` experiment for [issue #3](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/3)
and [ADR 0003](../adr/0003-end-to-end-encrypted-collaboration-content.md).
The production hub still processes cleartext. This is not a completed security audit;
qualified review is pending.

## Assets and trust boundaries

Protected from the experiment relay/operator/database/log reader: task text, selected
history, control payloads, device private keys, store unlock keys and recovery secrets.
The operator can withhold, replay, reorder or replace traffic and directory entries.
It sees endpoint/account IDs, public keys, recipients, opaque project/backup IDs,
algorithm/session IDs, sizes, timing and sequence numbers. Never use customer text,
project names or file paths as routing identifiers.

Trusted: confirmed endpoints, the host's locally pinned membership authority, customer
recovery material, endpoint OS/browser, SDK and code delivery. Relay login credentials
authorize routing/backup access, not endpoint trust. The test provisions accounts directly;
production account recovery is outside scope.

Browser scripts come from the relay origin. A malicious publisher or XSS can steal keys
or decrypt while unlocked; encrypted storage does not defeat same-origin code. Desktop
loads bundled assets through a custom secure origin, but still trusts publisher/update
delivery. CI packages are unsigned/unnotarized test artifacts, not release evidence.

The execution host reads tasks/files. The selected inference provider receives the
prompts, tool output and content the agent sends under that provider's terms. Collaboration
encryption does not hide that content from the provider or a compromised endpoint.
Customer-facing descriptions must state these boundaries.

## Attacks, controls and limits

| Attack/failure | Experiment behavior | Remaining limit |
| --- | --- | --- |
| Valid replacement key under an existing device ID | Match both fingerprints from trusted confirmation | Confirmation channel and initial owner pin must be authentic; production verification UI is not supplied |
| Extra device seeks project keys | Exact verified endpoint list and session rotation | All production senders must use the policy wrapper |
| Modified/plaintext control or forged actor | Require verified SDK decrypted event and bind sender user/device/key to grant and membership | Recovered group history cannot authorize controls |
| Replayed, expired, wrong-turn or stale-epoch approval | Validate context; transactionally persist grant/request consumption | Host disk rollback/deletion is outside scope; lost authority requires safe re-enrollment |
| Crash after approval | Consumption commits before approval returns | Crash before execution can lose action; exactly-once execution needs a durable runtime outbox |
| Disconnected host during removal | Refuse controls until fresh owner snapshot; owner waits for encrypted acknowledgment | Withholding on apparently live connections needs freshness policy; all affected hosts/senders must acknowledge |
| Old membership snapshot replay/rollback | Random reconnect challenge, persisted monotonic epoch, superseded-challenge refusal | Compromised pinned owner remains authoritative; succession/quorum outside scope |
| Removed device receives later ciphertext | Rotate and share only to remaining endpoints | Old keys/plaintext remain; application rotation is not MLS post-compromise security |
| Stolen/modified recovery backup | SDK authenticated export with customer-only random secret; scope enforcement | Losing all recovery methods loses history; no operator override |
| Recovery material used on later same-session messages | Exported session keys can decrypt those messages; the test explicitly demonstrates this | Recovery scope is per project/session, not per backup timestamp; rotate and exclude the device to block subsequent sessions |
| Backup rollback/deletion | Cannot expand history or restore identity/grants | Can hide recent history; backup freshness/availability not proved |
| Stolen/corrupt local store | Encrypted IndexedDB, OS-wrapped desktop key, fail-closed unlock | Same-account malware, OS compromise or malicious browser code can decrypt |
| Relay memory/database/log scan | Endpoint-only plaintext; scan directory, mailboxes, logs, SQLite/WAL for canaries | Metadata remains; scans are not exhaustive information-flow analysis |

## Storage and failure contract

Desktop uses bundled Electron/WASM, a sandboxed isolated renderer and main-frame-only
`safeStorage` IPC. No plaintext fallback is allowed. Unavailable protection, corrupt
existing key files, wrong unlock keys or unsupported SDK data fail rather than silently
creating a trusted replacement. Browser unlock material is supplied in memory; site-data
loss creates a clean untrusted device.

Node crypto storage is memory-only. The complete proof reopens durable host grant and
membership state while retaining the runtime crypto process. It does not prove persistent
Node crypto identity across full restart. Customer history exports exclude host authority
and current identity/trust/delegation records.

Control protocol: `plexus.control.v1`, accepting verified decrypted events only. Algorithm
and SDK versions accompany each result. Network errors/timeouts do not count as key
delivery or completed revocation. The loopback HTTP relay caps requests at 1 MiB and
provides no production tenancy, rate-limit or durable-delivery guarantees. Non-loopback
deployment requires TLS even with encrypted content.

## Production consequences and review

Server collision detection over file paths, cleartext thread titles and content search
need redesign before production E2EE. No production route/UI now promises encryption.
This is a protocol experiment, not a migration of those features.

A named qualified reviewer must assess SDK use/authenticated attribution, key recipient
selection, confirmation channels, recovery scope/freshness, lost-host state and identity
succession, every-sender rotation, offline/live freshness, MLS tradeoffs, browser/OS key
custody, package signing/update trust, and customer boundary wording.

Record reviewer, reviewed commit, date, findings and disposition in
[the verification record](e2ee-verification.md). Automated checks do not constitute that
review or establish production security.
