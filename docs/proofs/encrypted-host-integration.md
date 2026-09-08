# Authenticated host integration and remaining recovery gates

This records the repair of the production integration gaps found in the September 2026
implementation audit, covering issues [#8](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/8),
[#15](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/15),
[#16](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/16), and
[#17](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/17). It supplements
[ADR 0003](../adr/0003-end-to-end-encrypted-collaboration-content.md),
[ADR 0004](../adr/0004-encrypted-task-event-log.md), and
[ADR 0005](../adr/0005-project-grants-and-confirmed-endpoint-history.md).

The original audit reviewed `1be13d40c60ad50d7b79eadd31360a86be2ba428`. The results below
apply to the subsequent integration working tree; they are not claims that the original
revision passed these added checks. Record the final integration commit with the release
verification record. The independent privacy/control review in the product specification
remains a release gate.

## What the audit reproduced

The old revocation suite passed even when a malicious relay restored a revoked device's
ability to act by returning an older enrollment row. The old recovery suite passed while
the production browser wrapper imported room keys without retaining the session admission
needed to read them. Recreating an encrypted host with the same runtime and durable outbox
produced a different crypto identity and failed to read the prior task. The runtime and
browser tests manually connected several components that the product had not connected.

Those were implementation defects, rather than simply missing screenshots or insufficient
CI coverage. The repair keeps tests at the public enrollment, host, and client boundaries
so a passing helper does not stand in for its missing caller.

## Membership is an authenticated history

`packages/e2ee/membership.mjs` defines a versioned ordered membership log. Each mutation
contains its team, sequence number, previous-record digest, action, complete action payload,
and exact signing device identity. `Endpoint.sign()` uses the Matrix SDK's device Ed25519
key; standard WebCrypto verifies signatures. SHA-256 hashes link the signed records. This
adds application authorization policy around established cryptographic primitives; it does
not introduce a new encryption primitive or claim MLS-equivalent security.

The signed operations currently cover bootstrap, endpoint confirmation, endpoint revocation,
project ownership, project grants, and grant revocation. An account token still routes the
HTTP request, but cannot substitute for the signing endpoint. The signed confirmer device
must equal the named confirmer. The relay verifies the signature and predecessor, applies
the mutation and appends the record in one SQLite transaction. A retry of the identical
signed request is recognized; changing the signed payload invalidates its signature.

The execution host independently replays this log and enforces the same policy. It derives
verified endpoints and project grants from that replay, rather than the relay's unsigned
`endpoints` or `participants` arrays. It durably retains the accepted sequence and digest
in its local state database. A shorter history, a changed accepted prefix, or a signature
from another bootstrap identity cannot restore prior authorization. The browser transport
also supports persistent per-team checkpoints through its configured load/save callbacks.

This is not a claim that the relay can never withhold information. A party cannot detect an
update it has never received solely by reading an apparently valid old prefix. The
reconnect challenge described below addresses control resumption; availability attacks and
withholding of unseen updates remain explicit limits of the protocol.

## The trust root is pinned at the host

The relay does not select the execution host's membership authority. `EncryptedHost`
receives an exact authority identity from the host operator's local configuration. The
initial record must match that identity, including the signing and encryption keys. The
desktop flow must obtain explicit local fingerprint confirmation before persisting this pin.
An account login, a relay enrollment badge, or the first key returned by a directory is not
an acceptable substitute. A host without a configured authority refuses reconciliation.

The participant transport can establish its own bootstrap identity. A different endpoint
must explicitly pin the existing authority through the trusted enrollment flow before using
its membership log to issue mutations. The transport rejects replacing an existing pin
with an unrelated identity.

Existing unsigned enrollment rows do not silently become trusted records. When an owner
establishes the signed bootstrap, other previously verified unsigned rows are returned to
pending and require signed confirmation. Existing projects similarly require an authenticated
ownership/grant history; a relay-side project row alone does not authorize a host. Operators
must plan this migration before enabling the repaired encrypted runtime for existing teams.

## Reconnect requires the live authority

On startup or disconnect the host disables reconciliation-dependent controls and creates a
new random challenge. The locally selected owner device signs a response binding that challenge
to the current membership sequence and digest. The host verifies the signature, challenge,
team and exact accepted log head before enabling controls. Replaying an earlier response
cannot satisfy a newly created challenge. Failure to fetch or validate membership does not
fall back to cached authorization.

`EnrollmentTransport.answerChallenges()` performs the owner-side response. The application
must run this only with an opened trusted endpoint and its persisted membership checkpoint;
it must not make an account-session substitute for the owner signing key.

**Availability tradeoff:** the selected owner endpoint must be online when an execution host
reconnects. Another verified teammate is not automatically a membership authority. After
owner-device loss, a surviving verified teammate may enroll a replacement owner device;
the execution host's operator must then separately appoint that exact device locally, as
described below. History restore alone cannot perform either transition. Recovery without
any surviving verified teammate still needs the customer-material authority path.

A live host learns subsequent authenticated changes as it polls. Until it applies a
revocation, the removed device may retain future-content access on that host's current
session. The UI must continue to show that host as pending.

## Revocation and acknowledgments

Applying a signed removal rotates each affected host's group sessions and excludes revoked
endpoints or revoked project grants. All confirmed devices of remaining participants are
considered; a map containing only one device per account is insufficient. Control receipt
handling checks the sender's current authenticated project grant and device standing even
when that sender's old crypto trust remains in the SDK.

The host records application locally before acknowledging it. Acknowledgments bind the
host identity, team, exact membership sequence/digest, and revoked endpoint, with an
Ed25519 signature and a distinct `plexus.membership.applied.v1` purpose. Failed delivery is
retained for retry. A runtime bearer token alone cannot create a valid host acknowledgment.

The relay returns these signed receipts, but its `appliedBy` and `pendingHosts` fields are
not authority. `verifyRevocationReceipts()` checks receipts against independently confirmed
host fingerprints and the authenticated log before counting application. The application
must retain its known host roster, show missing or unconfirmed hosts as pending, and not
turn a relay omission into a successful removal.

Rotation does not erase already-read plaintext or participant-held history. Endpoint
revocation, project participation, team roles and paid-seat state remain separate concepts.
This work does not establish paid-seat billing behavior.

## Durable host crypto storage

The Node Matrix WASM memory store cannot retain its identity across process exit. The
production host now uses a dedicated bundled Electron renderer for the SDK's supported
IndexedDB store, accessed through `packages/runtime/durable-endpoint.js`. Its synchronous
identity accessor is a cached public identity; all cryptographic operations execute in
the broker's persistent store.

`packages/e2ee/desktop-crypto-broker.js` serves only allowlisted bundled HTML, JavaScript and
WASM from a privileged local origin. The main process handles key transport; the private
renderer does not execute relay-supplied application code. Store-key IPC accepts only the
broker window's main frame. Navigation and new windows are denied. Browser participant and
execution-host keys have separate purposes and storage. The host store's random key is
wrapped by Electron `safeStorage`; unavailable protection, a corrupt wrapped key or locked
storage fails closed instead of minting a replacement identity.

The broker must be registered before Electron readiness. Application and broker privileged
schemes must be registered together, rather than overwriting each other's privileges with
separate registration calls. The runtime connects through its existing child-process IPC.
A Node-only CLI without the supported desktop broker fails with
`durable_crypto_broker_required`; it must not silently substitute an ephemeral production
identity. Tests that explicitly inject an in-memory endpoint document that narrower scope.

The durable restart test uses a fresh Electron process with the same isolated profile and
OS-wrapped store key. It checks identical public identity and successful decryption of the
same prior task. This was executed on macOS; it is not installed-Windows evidence.

### Desktop service isolation

The bundled renderer origin is constant, so it must not use Electron's shared default
session for every configured service. The review reproduced an account bearer token from
service A being sent to service B after changing `HUB_HTTP_URL` under the same desktop
profile. The previous HTTP-origin renderer had separated those browser stores naturally.

`apps/desktop/profile.js` now canonicalizes the selected HTTP/HTTPS service address and
derives a distinct persistent Electron partition and a `hubs/<service-hash>` directory.
Account sessions, browser crypto identity, OS-wrapped endpoint keys, runtime credentials,
host authority pins and runtime state are isolated by that service. `HARNESS_DATA`, when
explicitly provided, selects the data root; the service subdirectory still applies. The
local hub's database remains at the root's `hub.sqlite`. The bundled asset/API handler is
registered on the selected partition rather than the default session.

Equivalent default-port/trailing-slash addresses select the same profile; a different
scheme, host, nondefault port or service path selects a different one. Embedded credentials,
queries and fragments are refused as service addresses. The real Electron regression visits
A, then B, then A again: B never receives A's account or runtime token; keys and identities
differ across services; returning to A restores its exact prior identity and session.

Old unscoped default-session account tokens and root-level runtime credentials are retained
on disk but never silently copied to a newly selected service. This repair does not implement
an automatic legacy-profile migration or claim seamless upgrade access to those credentials.
An explicit, service-confirmed migration/recovery path is required before promising that
existing installations upgrade without signing in, recovering history or re-enrolling.

## Commands and provider state

The host reuses one opened reader/writer per task. Provider events and participant controls
therefore share the same append queue rather than competing with stale writer checkpoints.
Controls have independent command IDs; repeated handovers by one sender no longer collide.
The host persists a command claim before dispatch, returns the prior result for a matching
completed request, and rejects a reused ID with changed content. Typed validation refusals
are retained as refusals. An uncertain dispatch retains its claim and returns unknown on
retry, rather than automatically executing it again.

The runtime-owned execution manager uses durable execution markers, reconciliation and an
explicit recovery-required state. Starting a task after restart must never infer that an
unwitnessed side effect did not happen. Provider resume support and real-provider execution
are separate gates from crypto-store persistence. See the runtime integration tests and
final integration verification record for their coverage.

Startup and polling also belong to a specific pairing generation. Unpairing or stopping
invalidates unfinished crypto startup; an obsolete completion closes its own endpoint and
cannot publish a ready host. A replacement waits until the previous generation releases
the shared crypto store. The loop checks its generation between asynchronous stages and
uses its own execution manager rather than a replacement's manager. Publishing an endpoint
reports `membership_reconciliation_required`; `ready` requires successful authenticated
reconciliation. Shutdown waits for execution, polling and endpoint close; the CLI applies a
1.5-second bound and a second-signal escape instead of exiting immediately after calling the
asynchronous stop method.

## Customer recovery is not authority recovery

The customer recovery path restores the defined encrypted history and authenticated history
provenance. It does not restore provider credentials, expired approval grants, consumed
commands or the private signing key of the prior membership authority. A new endpoint that
successfully reads recovered history still has a different identity and must be enrolled
before it participates in future content or controls.

In particular, customer recovery material that contains history room keys does **not** let
a clean replacement device sign a live challenge as the previous pinned owner. The separate
local appointment below supports a teammate-verified replacement device. Do not
restore obsolete approval rights or silently repin a host from relay/account metadata to
make recovery appear successful.

If every trusted endpoint and every customer-held recovery method are lost, encrypted
history is unrecoverable. There is no operator content-recovery path. Copies already
exported may still be readable by whoever holds their matching key; later rotation cannot
retract them. A successful history backup does not imply that later tasks or later rotated
sessions are continuously backed up.

The desktop recovery scenario exposed a separate client integration defect: restoring an
authenticated host fingerprint did not restore that recipient's SDK device trust. The UI
therefore showed a confirmed host while task creation failed with `endpoint_unverified`.
Before task creation or control delivery, the client now confirms the already-pinned exact
host keys against the SDK's live directory. Different published keys still fail comparison;
the relay cannot select a replacement recipient. This restores recipient trust only, not
membership or action-approval rights. Failed creation also remains visible beside the
Fleet composer instead of only in the hidden task pane and a transient toast.

### Exact recovery scope and the lost-owner constraint

Issue #15 asks to restore the defined project/history and endpoint-trust scope through an
existing trusted endpoint or customer-held recovery material. Its first criterion requires
clean-endpoint recovery; its third requires explicit trust transitions without restoring
approval grants or provider credentials; its fourth requires a supported replacement and
rotation path. The parent specification, `docs/planning/product-spec.md:147`, also says to
restore project/history access and endpoint trust according to the chosen protocol. Neither
text explicitly names an immutable sole-owner freshness signer or promises that a history
backup contains that signer's private key.

The present clean recovery path restores history, leaves the replacement endpoint pending,
and permits a surviving verified teammate to confirm it through the authenticated enrollment
flow. That is a real endpoint-trust transition, rather than an automatic trust grant from a
backup. The added regression exercises these steps after closing the original owner signing
machine. Re-enrollment alone leaves the host unavailable; explicit local appointment then
enables challenges addressed to the replacement. This completes the trusted-teammate branch
of authority replacement, while customer-material-only authority recovery remains unfinished.

**The single-device availability dependency is introduced by the new freshness protection.**
It is not an explicit product requirement. Local appointment now provides an explicit escape
from that dependency when a verified teammate survives. The remaining material-only branch
must be implemented before claiming the entire #15 replacement criterion or #17 reconnect
experience complete. Issue #16's requirement that
recovery cannot roll back current authorization rules out simply disabling this check,
trusting a relay-selected replacement, or repinning from an account login.

The regression also shows why history provenance is insufficient authority evidence. The
backup authenticates the writer/session scope under customer-held material; it contains no
owner-signed recovery delegation and no original device signing secret. Authorized
participants can possess the same room sessions. A proof of reading those sessions therefore
does not prove a right to become the membership authority. Existing backups cannot be made
into such proof retroactively after every relevant signing authority is gone.

### Local appointment of a verified replacement

The implementation following `e7865f2` separates the immutable enrollment genesis from the
host's selected freshness signer. A verified replacement must belong to the original owner
account, with all four identity fields matching the signed membership log. Teammate
verification alone cannot change the host's selection.

The installed app requests a proposal through its own child-process IPC channel. The runtime
replays signed membership above its applied checkpoint and binds the proposal to the exact
candidate, host, team, head, prior checkpoint, selection and process generation. Native
confirmation is single-use and expires after two minutes. Work active or pending at either
validation step refuses appointment. The runtime commits the selection and authorization
checkpoint in one SQLite transaction, invalidates old polling, and the desktop restarts that
same execution host. Cancellation and failed validation do not appoint a device.

Fresh challenges use `plexus.membership.current.v2`, binding the runtime and random local
activation identifier as well as team, nonce and signed head. Only the selected verified
device answers. Existing hosts retain their original v1 protocol until explicitly changed.
Neither protocol lets a relay nominate an authority. Enrollment genesis, provider consent,
credentials and action-approval authority remain separate; recovered devices need independent
approval consent before resolving agent actions.

When a host applies the selected device's signed revocation, it durably disables that
selection and cancels execution before another relay read. Pending starts cannot execute
after cancellation. Rotation covers all durable task IDs, including rooms omitted by a relay
after restart and rooms recorded before their first event. Current members of listed tasks
then receive the new sessions; omitted rooms stay host-only until later admission. Only
after rotation is the application acknowledgment sent. A revoked selection never falls back
to the original signer, and another appointment requires a different verified owner device.

Local checkpoints cannot reveal a removal withheld before that host has ever seen it. The
native confirmation explicitly requires a trusted comparison of membership state; offline
hosts remain pending. This path does not add a global freshness service. The original
bootstrap device could not be revoked at that revision; the follow-up below adds that
operation. Customer-material-only recovery and independent privacy/control review remain
unfinished.

### Original device removal

The follow-up based on `5a27ab1` permits a different, currently verified endpoint of the
original owner account to revoke the original device. The first signed record and its
four-field public identity remain immutable. Original self-removal, pending/foreign
signers and account tokens without the device signature cannot authorize the operation.
The removed device cannot mutate membership, re-enroll itself, or answer a current v1
challenge. Proof publication rechecks the durable signed head after asynchronous
verification so removal committed during verification wins.

An already appointed replacement host continues using its locally selected signer. A
host still implicitly using the original persists an `implicit-genesis` revoked record,
with no fabricated activation identifier, atomically with its authorization checkpoint.
It cancels work and remains paused across SQLite reopening until a separate local
appointment. Both online and disconnected host paths apply the signed removal before
attempting to obtain a proof from that removed device. Each host rotates every locally
known room, including tasks omitted by the relay, before its own authenticated receipt.
One host's receipt does not count for another host.

Failed pin or checkpoint storage also cancels all active work before reporting the disk
error and emits no successful application receipt. The live host retains its highest
authenticated observation in memory as well as checking its durable checkpoint. A relay
cannot make that process forget the observed removal once storage recovers, even when
another owner device honestly signs a fresh nonce against a withheld older view. This
in-memory safeguard does not claim that a failed disk write survived process loss.

Each new turn records its exact locally configured approval device, or no approver.
Removing that device cancels affected live turns and clears their delegated grants;
cancellation receipts preserve the reason. Persistence failure cannot leave later tasks
running or approval promises unresolved. A failed accepted settlement resolves to cancel,
preventing its workspace action. Later ordinary turns can run without restoring approval
authority, provider credentials or old grants. Membership reconciliation rechecks its
generation and floor after waiting for affected turn receipts.

A failed accepted-decision write changes the pending settlement to an explicit host
cancellation before resolving the provider. In-memory state, later successful SQLite
flushes, retry replies and encrypted history all retain that cancellation rather than
silently recording the failed acceptance.

The shared Access UI marks the original device using authenticated genesis. Its guided
removal requires the current exact verified replacement to have an active appointment on
the selected local host. A second host's initial authorization pins the authenticated
original identity, rather than confusing a replacement renderer with a new genesis.
Explicit host selection survives that host's restart; the composer is unavailable while
that selected host is offline. The UI presents independent pending/applied host status
and explains that removal cannot erase previously disclosed history.

Public regressions are `test/genesis-revocation-protocol.js`,
`test/genesis-host-revocation.js`, `test/implicit-authority-state.js`,
`test/approval-authority-removal.js` and `test/genesis-removal-ui-browser.js`.
The host tests use real endpoint cryptography and public hub routes; SQLite reconstruction
retains an SDK store and is not by itself evidence of OS-backed Electron persistence.
Continuous source-Electron evidence and aggregate results are tracked in
[issues-02-17-integration.md](issues-02-17-integration.md).

### Cross-host history delivery and retry

The two-host desktop scenario exposed a consumed-message bug. Reading an already
confirmed host drained another host's history handoff before that second fingerprint
was confirmed. Olm consumed the first decryption; replaying the same sealed message
after confirmation could not recreate its authenticated history transfer. The single-host
late-confirmation fixture had not exercised that ordering.

The client now defers unconfirmed-host envelopes before SDK consumption. Relay-visible
routing may only postpone decoding; the SDK seal and exact customer-confirmed host pin
still authenticate accepted history. Authenticated outer and inner handoffs are retained
in an encrypted local retry journal before import, allowing missing task listings and
temporary import failures to recover after reload. HKDF and AES-GCM bind the journal to
its purpose, service, account, team and exact local endpoint using the existing store key.
Transfer keys and decoded history are not persisted as plaintext. Tampered or foreign
journals fail visibly without replacing trusted state.

SDK storage and the application journal do not form one transaction. A still-authorized
client can recover a lost/consumed handoff by sending a fresh `task.history` request over
the existing encrypted control channel. The host checks current device and project
standing, exports only that task, and addresses a new sealed handoff only to the
authenticated requesting device. It does not call a provider, restart a turn, grant
approval authority or append a fabricated task action. The submission receipt is not
proof of recipient delivery; only successful authenticated replay establishes recovery.
Existing command deduplication applies, while a new request ID asks for new ciphertext.

Client requests are throttled per task. The original integrity error stays visible until
the complete log verifies, so a fresh handoff cannot conceal log tampering. An unavailable
host cannot resend history, and a removed endpoint cannot use this request to recover
access to new content. Public checks live in `test/encrypted-mailbox-browser.js` and
`test/task-history-retry.js`.

### Safe prerequisite for customer-material authority recovery

A future recovery ceremony must establish the recovery authority **before** the original
authority is lost. Evaluate the selected SDK's supported identity/cross-signing recovery
mechanisms first, retaining the specification's established-protocol and independent-review
gates. The required application properties are:

1. The live authority authorizes a separate recovery public credential in authenticated
   membership, bound to the team, purpose, allowed successor scope and credential version.
   The customer retains its corresponding secret; the relay stores only encrypted material.
   A history-room key is not implicitly this credential.
2. Setup drills the actual replacement proof on a clean endpoint before presenting authority
   recovery as configured. The recovery package retains the original trust root and the
   signed authorization needed to verify that proof independently of relay metadata.
3. Recovery explicitly binds the intended replacement fingerprint, authenticated membership
   head, host challenge and recovery-credential version. Hosts apply it monotonically and
   idempotently. The design must address a relay withholding credential revocation or a
   newer authority epoch from an offline host; a nonce by itself does not solve that case.
4. Replacing or revoking recovery material has an explicit host-application state and clear
   stale-material behavior. Restoring identity never reactivates obsolete approval grants,
   consumed commands, uncertain executions or provider credentials.

This is a protocol-design prerequisite, not an implemented or verified ceremony. It requires
coordinated recovery setup, bundle, client, enrollment and host changes. Old history-only
backups remain history-only. When no preauthorized recovery credential and no existing
authority signing endpoint survive, the supported result remains readable recovered history
with unavailable authority, rather than a relay-assisted takeover.

### SDK recovery investigation and bootstrap repair

A synthetic experiment with the installed Matrix SDK 18.8.0 established that
`exportSecretsBundle()` and `importSecretsBundle()` can restore the same master signing
key on a clean device. `OlmMachine.sign()` can then sign a new application challenge with
that master key. The original device key is not restored. The experiment used memory
stores, synthetic identities and an in-process public-key directory; it made no network
requests and used no customer secrets. This is evidence about an SDK primitive, not a
completed product recovery path.

Two trust transitions require application guards before this API could be used in recovery:
the SDK accepts the same secret bundle under a different user, and import can replace an
already verified different master identity. Recovery therefore needs an authenticated
original account/team/root binding and an inactive staging store. SDK identity trust must
not automatically confer Plexus membership, project grants or approval authority.

The SDK wrapper also had two reproducible defects. It requested a reset on every bootstrap,
changing the account root on repeated setup, and used the nonexistent singular
`uploadSignatureRequest`, omitting publication of the device signature. It now reuses the
existing root with `bootstrapCrossSigning(false)` and publishes the SDK's
`uploadSignaturesRequest`. `test/endpoint-cross-signing.js` verifies both the public device
signature and retention of the account root and a previously signed second device. Each
regression failed before its repair and passes afterwards; the existing encryption
acceptance suite also passed 22 checks with six separately recorded limitations.

The recovery investigation does not resolve membership freshness. An old exported seed
still signs new nonces under its old root after another device rotates the root; rewrapping
the backup does not revoke captured seeds. Even without root rotation, a clean restore
with an old membership checkpoint can be shown a valid older prefix by a withholding relay.
Restoring key possession does not recover lost knowledge of later removals. The proposed
authority ceremony must preserve every host's applied checkpoint and explicitly establish
the replacement authority locally when current membership cannot be authenticated. No
automatic authority recovery or weakened reconciliation check was added by this repair.

## Verification record

Executed with bundled Node **v24.19.0**, against disposable local hubs, workspaces and state
files. The tests do not mutate a real team or GitHub issue.

| Check | Observed result | Scope |
|---|---|---|
| `node --test test/enrollment-authority.js` | 8 tests passed, approximately 9.7 seconds | Real `EnrollmentTransport` HTTP and `EncryptedHost` control seams; token impersonation, tampered signatures, relay rollback after applied revocation, fresh owner challenge, false runtime acknowledgment, repeated handover/deduplication, multiple devices and the owner-loss recovery limitation below. |
| `node --test --test-name-pattern='customer history recovery' test/enrollment-authority.js` | 1 test passed, approximately 2.1 seconds | The original owner signing machine is closed; a clean endpoint restores deep-equal history, remains pending, rejects a substitute current-state signature, and can be re-enrolled by a surviving teammate. The host correctly remains unavailable without the original freshness signer. This proves the limitation, not authority-recovery completion. |
| Targeted signed-receipt assertion in the same suite | Passed | Actual host receipt counts as applied; a modified receipt hash does not. |
| `node test/revocation.js` | 12 checks passed | Signed enrollment, rotation, retained history and future-content exclusion. The restored-device scenario now actually imports the pre-removal backup. |
| `node --test test/durable-host.js` | 1 test passed, approximately 1.6 seconds | Real isolated Electron broker restart on macOS; identical host identity and two prior encrypted events readable. |
| `node --test test/encrypted-runtime-lifecycle.js` | 4 tests passed, approximately 4.8 seconds | Public pairing/unpairing with delayed real SDK startup, immediate re-pair before old startup completes, stop while startup is pending, and the actual CLI waiting for a crypto IPC close response on SIGTERM. The unpair/startup regression failed before the generation fix. |
| `node --test test/encrypted-runtime-e2e.js` | 2 tests passed, approximately 31.5 seconds after the lifecycle repair | Full runtime-owned encrypted discovery, task execution, controls and restart acceptance plus approval deadline expiration. |
| `node --test test/desktop-profile-isolation.js` | 2 tests passed, approximately 4.9 seconds | Canonical service identity and actual Electron A/B/A profile isolation. The original two-service probe reported token disclosure; the repaired probe reports no disclosure. |
| `node test/desktop-smoke.js` | Passed after the profile and lifecycle repairs | Actual bundled desktop, local pairing, native folder authorization and runtime restart, encrypted demo task writing `NOTES.md`, and zero uncaught renderer errors. Rendered workspace inspected at `.artifacts/desktop-bootstrap/workspace.png`. An earlier attempt stopped on stale expected empty-project wording; the visible encrypted project count was correct and its assertion was updated. |

The account-token impersonation check failed before the signature gate (`Missing expected
rejection`). The runtime-token acknowledgment check failed before signed receipts (HTTP 200
instead of 403). The durable test exposed an unsupported-origin registration and then a
fixture close-handshake problem; both were repaired before the passing run. Closing the
last hidden fixture window had exited Electron before its close response arrived. The
fixture now remains alive until stopped, close is idempotent, disconnected IPC rejects
pending calls, and test shutdown handles an already-exited child with a bounded fallback.

These tests do not establish accepted-design fidelity, installed-Windows broker behavior,
all browser site-data/locked-storage recovery outcomes, a qualified security review, or a
history-key-only replacement of a lost membership authority. Those remain explicit gates
in the final issue-by-issue completion assessment. Broader product, provider and rendered-UI
checks are owned by the integration verification record; do not infer them from this table.
