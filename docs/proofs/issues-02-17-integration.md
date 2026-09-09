# Issues 2–17: integration repairs and remaining acceptance work

**8 September recovery update:** the subsequent customer-held owner recovery
implementation and its bounded verification are recorded in
[owner-recovery-handoff.md](owner-recovery-handoff.md). Its browser and source
Electron no-surviving-teammate flows both pass 6/6. This supersedes the unfinished
customer-material-only implementation statements for #8, #15 and #17 below.
The earlier aggregate-suite and installed-artifact results in this document do not
qualify the later recovery changes; remaining release gates are retained.
The [repository sync record](issues-02-17-sync.md) indexes the published commits,
current issue ownership, verification limits and outstanding PR integration work.

The user subsequently excluded testing that requires GitHub Actions from this pass.
Local macOS, browser and provider verification continues; current Windows execution
is recorded as not run and does not hold up this local pass. An earlier Windows result
does not qualify the current implementation.

This records the implementation following the 8 September 2026 audit of
`1be13d40c60ad50d7b79eadd31360a86be2ba428`. It supplements the earlier issue proofs;
it does not turn their closed GitHub states or checked boxes into evidence that the
current product satisfies every criterion. The current issue bodies and parent issue
#1 govern scope. No GitHub issue has been edited by this implementation pass.

## What changed

The production runtime now discovers encrypted tasks, authenticates their creators
and controls, maps opaque project IDs to locally authorized directories, and runs
provider sessions through the shared encrypted event writer. Previously, several
acceptance tests supplied the host loop themselves, so passing those tests did not
prove that a task started from the product could execute.

The shared renderer connects task creation, source diffs, catch-up, teammate history,
steering, exact approvals, help, responsibility, outcomes, related links and customer
recovery. It keeps drafts across asynchronous refresh, distinguishes failed turns
from task outcomes, shows actionable provider errors, and disables control when the
host is unavailable. Desktop and mobile evidence is generated from those real
controls, without importing prototype state.

Membership changes are signed and linked to an authenticated history. The host pins
the authority through local confirmation, checks an authenticated current head before
re-enabling controls, verifies device/project standing, and signs revocation receipts.
History recovery retains authenticated writer provenance instead of admitting every
imported session. These application authorization changes use the existing Matrix
SDK and standard WebCrypto primitives; they still require the specification's
independent privacy/control review.

The desktop now loads a bundled renderer and a separate durable SDK crypto broker.
Both privileged schemes are registered together, and their protocol handlers belong
to the correct Electron sessions. OS-wrapped keys and persistent stores survive
restart. Account, endpoint and runtime state are isolated per hub service. An
unpaired host cannot finish an old asynchronous startup and reinstall stale state.

Execution markers precede provider effects but follow the durable task creation
event. A terminal marker is persisted only after the encrypted event queue flushes;
crashing during terminal encryption retains a running marker and requires recovery.
Restart or failure to append activity produces recovery-required rather than
an automatic rerun. Approval expiration settles and records the exact request even
without a caller response; interrupted and disconnected requests are settled too.
Grants end with their request/turn. Steering order is separate from the shared event
cursor, preventing delivery receipts from corrupting replay order.

Action approval authority has its own local native consent and exact verified
endpoint identity. Trusting a membership signer does not confer approval rights.
Requests carry their current approval owner independently of historical task data.
The renderer uses that identity and the exact live grant, including expiry, rather
than team ownership. Access status accepts only verified host revocation receipts.
Open fingerprint comparisons survive setup refresh without changing the displayed key.

The CLI account probe now reads successful status on stderr and distinguishes
configuration failure from logout. A command-local reasoning setting avoids
inheriting an unsupported value from another application without editing the
customer's configuration. Exec failures expose fixed codes, completion must be
observed before edits apply, and concurrent sessions keep separate proposals.

The interactive Codex adapter supports matched steering acknowledgments, explicit
thread resume, interruption request/terminal distinction, and bounded host tools.
The older read-only execution path is disabled, including saved opt-in settings,
because an actual sibling-file read disproved its project read boundary.

A separate explicit host-tools opt-in uses Codex 0.153.4, macOS arm64 and
`gpt-5.4-mini`. Empty native environments remove native filesystem/process tools;
reads, listing, writes and removal go through the host's existing workspace boundary.
A private provider profile disables ambient instructions, MCP, apps and plugins.
Unexpected configuration, managed requirements, instruction sources or MCP inventory
stop execution before model work. Native consent names the selected file-backed
ChatGPT or API-key login, its usage owner and separate API billing. Mode and account
have separate private provider profiles; local consent pins an opaque account binding.
Account checks precede model requests, and a native thread cannot resume under a
different account. ChatGPT token refresh preserves the binding. API preflight and
tool inventory pass using synthetic credentials and a local model-service fixture;
this does not establish real API-account execution or entitlement. The separate
real-provider scenario also passed: eight checks covering actual read refusals,
file writes, acknowledged correction, exact approval, handoff, explicit thread
resume and confirmed interruption on this supported configuration.

## Issue assessment

“Implemented and exercised” below describes the listed behavior, not independent
security review or coverage on platforms that were not run. Existing foundation
proofs remain applicable to their original revisions and scopes.

| Issue | Current implementation assessment | Remaining acceptance work or limit |
| --- | --- | --- |
| [#2](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/2) | One real ChatGPT-backed encrypted scenario exercises actual writes, native shared steering/interrupt, approval, handoff and resume; command deduplication and competing approvals have deterministic coverage. API mode selection, account continuity and private resume binding are implemented and locally tested with synthetic credentials. | Separate authorized real API-account test and supported multi-human entitlement arrangement. GitHub Actions testing is excluded from this pass; current Windows execution remains unverified. |
| [#3](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/3) | Established SDK storage/recovery foundation retained; signed membership, provenance, replay and revocation tests strengthened. | Qualified review of the new integrated privacy/control protocol; retained platform proofs do not review this new protocol. |
| [#4](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/4) | macOS installed-app proofs cover bundled startup, pairing, project selection, encrypted execution, failure/retry and uninstall. The latest rebuilt installer runs a demo task; earlier installed real-Codex evidence retains its separately recorded revision. | Current Windows changes require a Windows run. Public signing remains the later distribution slice. |
| [#5](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/5) | Team, invitations, host consent, project/policy limits and direct-request boundaries exercised. Device state reflects actual verification. | New cryptographic integration retains the independent-review gate. |
| [#6](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/6) | Opaque task persistence, ordered replay, integrity failure, browser restart and production host execution are connected and tested. | Full external-release platform and adversarial review gates remain. |
| [#7](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/7) | Production encrypted execution, actual Codex host-tool edits, durable identity, explicit local provider consent and actionable errors implemented. The supported native scenario passes actual project-read refusals. | Restricted to Codex 0.153.4, macOS arm64 and gpt-5.4-mini. Real execution is verified with the file-backed ChatGPT login; API login has synthetic/preflight coverage only. Installed real-provider evidence is recorded separately below. Older read-only opt-ins remain disabled. |
| [#8](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/8) | Signed enrollment, explicit project grants, late teammate history, delayed host confirmation and reload exercised through the renderer. Both teammate-verified replacement and customer-material-only owner recovery now require separate local host activation. | Dedicated no-survivor browser/Electron flows pass; the final existing-workspace run stopped at a history-key selector ambiguity after nine checkpoints. The exact-selector correction remains unrerun. |
| [#9](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/9) | Sourced catch-up, actual patches, current provider, decisions, approvals and freshness connected to authenticated events. | No generated summary or server plaintext projection is introduced. |
| [#10](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/10) | Actor/turn binding, deduplication, queued/delivered receipts and interruption exercised through real native acknowledgments and encrypted production controls. | Native production use retains #7's supported-configuration limits. |
| [#11](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/11) | Exact action grants, competing responses, expiry, mutation refusal and stale-after-restart behavior exercised with real local filesystem effects. | No broad session approval or general exactly-once external-effect guarantee. |
| [#12](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/12) | Named encrypted help, inbox resolution/cancellation and late context connected; help is separate from provider input. | External messaging and content-bearing OS notifications are outside this slice. |
| [#13](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/13) | Diff/source review, handoff, authorized recipients and independent task outcomes exercised. The continuous real-provider scenario proves Bob's acknowledged correction changes actual Monday text to Tuesday, then handoff preserves that corrected diff. | Same supported provider/platform/authentication limits as #7. |
| [#14](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/14) | Encrypted related links, safe rendering, private task navigation and association removal exercised. | Association does not publish anything to the external tracker. |
| [#15](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/15) | Customer-held owner kit, clean SDK drill, wrong/retired-kit refusal, rotation, inactive history staging and explicit owner admission are implemented. No-surviving-teammate flows pass 6/6 in Chrome and 6/6 in source Electron with OS-protected storage. Genesis is preserved; hosts need local activation and project/approval rights need fresh authorization. | The latest recovery source has no rebuilt-installer or aggregate-suite pass. Windows, broader storage-failure permutations and independent privacy/control review retain their limits. |
| [#16](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/16) | Signed state, rollback resistance, future session rotation and verified per-host acknowledgments exercised, including original-device removal and independent online/offline hosts. Removal cancels affected approval grants and work, including storage-failure cases. | Hosts remain pending until they apply removal; no erasure of old plaintext/history. |
| [#17](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/17) | Restart/crash markers, stale approvals, interrupted writes, relay append failure, re-pair races and explicit recovery state exercised. Customer-held authority recovery now works without a surviving teammate and leaves every host pending until local activation. Old command epochs and approval grants remain invalid. | Final aggregate/installer qualification is outstanding. Recovery does not permit automatic provider/action replay; tray integration remains in open PR #60 and issue #18. |

## Evidence and reproducibility

Use Node 24. Browser tests require a supported Chromium executable, supplied locally
through `CHROMIUM_PATH`. Electron tests require a desktop session and working OS key
protection. The fixtures use disposable hubs, accounts and workspaces. Real-provider
proofs send synthetic test content to the customer's configured inference provider;
the synchronization hub receives encrypted task content.

| Check | Evidence scope |
| --- | --- |
| `npm test` | Aggregate deterministic regressions, including the new collaboration integration scripts. Final execution result is recorded below. |
| `npm run test:encrypted-workspace` | Fifteen production-renderer workflows and twelve captures at 1487×1058 and 390×844; actual local files; no uncaught browser errors. |
| `npm run test:encrypted-controls` | Scoped controls, exact approvals, automatic expiry, multiple restart windows, append failures and encrypted execution outcomes. |
| `npm run test:enrollment-authority` | Signed membership/receipts, rollback/refusal cases, multiple devices and history-only recovery's authority limit. |
| `npm run test:runtime-lifecycle` | Four lifecycle scenarios, including unpair/re-pair during delayed startup and actual CLI shutdown. |
| `npm run test:desktop-isolation` | Two services in actual Electron; no account token sent across services, with original account/endpoint/runtime preserved on return. |
| `npm run test:durable-host` | Actual Electron broker process restart; same identity and prior encrypted history. |
| `npm run test:desktop` | Visible desktop startup, local pairing/authorization and actual encrypted demo file execution. |
| `npm run test:desktop:install` | Current platform's installer, copied/installed app, startup failure/retry and cleanup. Windows evidence must run on Windows. |
| `npm run test:codex:exec` | Account status, sanitized errors, missing completion, concurrent proposal isolation, acknowledged resumed steering and pre-start cancellation. |
| `npm run test:codex:app-server` | Native protocol contract, matched controls, bounded requests and confined host tools. |
| `npm run test:codex:inventory` with `PLEXUS_CODEX_INVENTORY_BIN` | Two actual Codex 0.153.4 tool-inventory checks plus production profile preflight on macOS arm64: only the four host tools, no ambient instruction canary, and configured MCP stays unstarted during preflight. No real credentials or model service used. Unsupported/missing-binary cases skip explicitly. |
| `npm run test:encrypted-codex-task` with explicit real-provider opt-in | Eight checks passed in `.artifacts/encrypted-codex-host-tools/results.json`: supported native mode, production runtime collector, encrypted controls, read refusal, actual correction, approval, handoff, resume and interruption. A skipped opt-in is not evidence. Historical 0.137 exec output remains under `.artifacts/encrypted-codex-task/` and is not current isolation evidence. |
| `node test/codex-interactive-real.js` | Real native controls and host tools; `.artifacts/codex-interactive-real/results.json` also records the demonstrated sibling-file read boundary failure. This is not a production-isolation pass. |

Rendered evidence and its design/state coverage are in
`.artifacts/encrypted-workspace/README.md`. Security/lifecycle details and the recovery
regression are in [encrypted-host-integration.md](encrypted-host-integration.md).

## Gates that a green test suite does not remove

Fresh membership challenges depend on the host's locally selected owner signing
endpoint. A surviving verified teammate can enroll a replacement owner device, after
which the host operator may explicitly appoint it locally. Clean history recovery
alone does not recover that authority. The separately configured customer-held
owner kit now supports explicit authority recovery without a surviving teammate;
each host still requires local consent and key rotation. Account/relay metadata cannot silently
repin a host or lower its applied authorization checkpoint.

The older native CLI can read a generated sibling file under its read-only sandbox.
Its saved `codexReadOnly` flag no longer enables production execution. The separate
supported host-tools mode must retain its exact version, platform, model, profile and
preflight checks; a generic read-only CLI is not an equivalent configuration.

No API test account is configured in this environment. Technical success with the
local ChatGPT login does not settle whether a provider entitlement is transferable
to other humans. Windows verification, independent privacy/control review and the
later distribution/signing requirements are not inferred from local macOS success.

## Final verification record

`npm test` exited zero with the complete deterministic chain and all fifteen browser
workflows. Logs are preserved under `.artifacts/issues-02-17-verification/`.
The separate actual Electron storage restart/service-isolation run passed all three
checks. The desktop smoke passed with zero uncaught renderer errors, separate native
approval consent, actual file execution and clean shutdown with a hidden crypto broker.

A parallel browser run reproduced a membership-head race despite the aggregate pass:
an owner proof for the bootstrap head could become stale when a project was granted.
The host now requests a new nonce immediately only for an authentic signed ancestor
of the fully verified current log. Forged proofs, old nonces and obsolete generations
cannot renew or enable control. The final authority/lifecycle run passed **16/16**,
and the complete browser workflow passed **15/15** after this fix.

The final rebuilt macOS arm64 installer passed **5/5** installation checks. Its
installed UI configured the supported local Codex account, started a real encrypted
task, read a freshly generated input and wrote exactly matching bytes. A final rerun
of that same installer explicitly waited for the encrypted provider turn to complete
before closing, then exited cleanly with zero uncaught renderer errors. The installed process had system Node
excluded from its PATH. This run used Codex **0.153.4**, ChatGPT authentication and
`gpt-5.4-mini`. Its result is in `.artifacts/desktop-install/darwin-arm64.json` and
`.artifacts/desktop-bootstrap/codex-results.json`; the installer SHA-256 is
`440063b698aa0f2ad9019ecf6b78d7b70dd97f718381c3656836d109902d4dc4`.
The source was an uncommitted working tree based on the audit revision, as the
machine-readable installer record explicitly states. No Windows or signing result
is inferred from this run.

Reproduce the real proofs only with explicit provider-usage authorization and the
supported local binary. `PLEXUS_RUN_REAL_CODEX=1` plus `PLEXUS_TEST_CODEX_BIN` enables
the encrypted collaboration proof. `PLEXUS_DESKTOP_CODEX_PROOF=1` plus `CODEX_BIN`
enables one real task in `npm run test:desktop:install`. Ordinary deterministic
testing does not set either real-provider opt-in.

## Follow-up account, SDK and installed collaboration checks

The next local pass is based on `2bc1d74`. It adds explicit ChatGPT/API account modes,
private mode/account profiles, account-bound native resume and renewed local consent
when the account changes. Older saved configurations without an account binding now
show setup required and refuse execution before any provider process starts. A
readiness check alone does not grant consent. Two public runtime regressions verify
refusal with zero spawns and successful execution after explicit account pinning.

The focused provider set passed **62 checks**. The actual Codex 0.153.4 API preflight
and local model-service/tool inventory passed **three checks** with synthetic API
credentials. They verify account mode, the four host tools, configuration and ambient
tool refusal; they do not establish real API quota, entitlement or model execution.
The SDK bootstrap regression passed **two checks**, and the retained encryption
acceptance suite passed 22 checks with six separately recorded limits. See
[the SDK investigation](encrypted-host-integration.md#sdk-recovery-investigation-and-bootstrap-repair).

One continuous installed Electron + separate Chrome + real Codex scenario passed
**15 checks across two provider turns**. The installed app's actual durable broker
and runtime remained in use. A late browser teammate received encrypted history,
submitted an acknowledged correction, received one exact action grant, approved
removal, inspected the changed-file source and accepted responsibility. Codex changed
`NOTES.md` to exactly match separately generated `correction.txt` bytes. Both turns
completed; the teammate subsequently recorded the task outcome as a separate action.
There were zero uncaught errors in either window.

That real run also passed all five installer checks, including deliberate
failure/retry and uninstall. Its installer SHA-256 was
`39ec424c1a93a09399a54f879b84c2c505fe52c4e20a29499501df80fa174a78`.
The result explicitly records an uncommitted tree based on `2bc1d74`; it preceded the
last legacy-configuration consent guard. Its source already used a newly consented,
bound account. The guard's rejection path was verified separately, without repeating
the paid provider scenario. The corresponding installer, bootstrap and collaboration
records and execution log are preserved under `.artifacts/issues-02-17-followup/` as
`installed-real-codex.json`, `installed-codex-bootstrap.json`,
`installed-codex-collaboration.json` and `installed-real-codex.log`.

After the final consent guard, a fresh installer passed **5/5** checks and its
installed desktop/browser demo scenario passed **15/15**, again with no uncaught
errors. This rebuilt installer has SHA-256
`eea64a3d72de8e89e9ded95c171f28b633d04c7f4f3780a73149b1991c5bbf5e`.
That final run used no provider quota; its records are
`final-installed-demo.json`, `final-installed-demo-collaboration.json` and
`final-installed-demo.log` in the same evidence directory.
The full `npm test` chain was rerun after the consent guard and exited zero,
including all fifteen production-browser workflows. Its terminal log is
`final-npm-test.log` in that directory.

Reproduce the continuous real proof by adding `PLEXUS_DESKTOP_COLLABORATION_PROOF=1`
to the real installed command above and supplying `CHROMIUM_PATH`. The distinct
`PLEXUS_DESKTOP_COLLABORATION_PROOF=demo` option refuses real Codex opt-in and
rehearses the same visible controls with a deterministic provider. Its extra follow-up
tests browser-originated writing; demo steering only acknowledges directions and is
never credited as an interpreted model correction.

All seven real captures in `.artifacts/desktop-collaboration/codex-*.png` were inspected:
five at 1487×1058 and two at 390×844, covering catch-up, exact approval, actual source,
review and the mobile discussion drawer. The existing shared `shell`, `review`,
`evidence`, `decision` and `setup` anatomy is retained; no renderer or reference layout
was changed in this follow-up. Controls and host/actor/scope context were readable,
with no pane overlap or document overflow. Existing departures from the reference
remain: plain diffs, inline JSON sources, technical IDs and a large mobile title.
The new native API consent wording has not received a rendered screenshot check.
The render review is saved as `.artifacts/issues-02-17-followup/render-review.md`.

This follow-up's Standards review found no actionable violations or baseline smells.
Its Spec review found the legacy account-consent bypass described above; the fix was
independently rechecked with both public regressions passing. No actionable finding
remains from those two reviews. Neither review supplies the separate specialist
privacy/control sign-off. Sole-authority recovery also remains an implementation gap;
the SDK bootstrap repair does not silently recover authority.

Deliberately induced Electron failures now print `RECOVERY TEST` before showing the
expected error screen, distinguishing those scenarios from unexpected test failures.
GitHub Actions testing is excluded at the user's direction. Current Windows
execution and real API-account usage are not inferred from these local results.

## Trusted replacement authority follow-up

The later trusted-replacement pass, based on `e7865f2`, adds an explicitly local
appointment for an owner device verified by a surviving teammate. The original
membership genesis stays pinned. The new selection and the host's authorization
checkpoint commit atomically; a single-use native confirmation binds the device,
team, host, signed head and previous selection. The host restarts before using v2
challenges addressed to that selection. Membership recovery grants no action-approval
rights and imports no provider credentials.

Its independent host review reproduced and repaired four defects: cancellation
depending on a second relay fetch, a durable task omitted after restart retaining
an old session key, polling resuming between persistence and its generation fence,
and reconnect being unable to apply a selected signer's revocation because challenge
creation was refused first. The final focused host/local-control run passed **27/27**;
its log is `.artifacts/authority-recovery/final-host-tests.log`.

The actual desktop recovery scenario additionally found a client integration bug:
the authenticated backup restored a host fingerprint while the SDK lacked trust in
that recipient, making new task creation fail with `endpoint_unverified`. Creation
and control delivery now restore SDK trust only after the live keys match the exact
stored pin. A different published host key remains a refusal. Fleet retains a failed
creation's explanation beside the composer and clears it on retry or context change.

This pass uses the existing `shell` and `setup` templates, `uiSection`, `uiNode`,
`uiButton`, fingerprint presentation and composer error styling. The new states are
original signer, pending recovery, verified replacement, selected replacement,
revoked selection, remote-only setup and refused task creation. Existing native
confirmation is extended without changing design references or introducing prototype
state. The initial Standards and independent host Spec records are
`.artifacts/authority-recovery/standards-review.md` and `spec-review.md`.

The final full `npm test` chain exited zero after the production changes were frozen,
including **26 authority/protocol/revocation checks**, **20 local confirmation/IPC
checks** and all **15 production-browser workflows**. Its log is
`.artifacts/authority-recovery/final-npm-test.log`.

`npm run test:desktop:authority-recovery` passed **11/11** continuous recovery checks
using actual Electron with its durable SDK broker and a separate Chrome teammate.
The scenario restores history on a clean renderer, enrolls a replacement, cancels
then accepts local appointment, executes a new file write, refuses recovered approval
rights, obtains separate native consent for an exact action, and applies replacement
revocation. A further clean browser substitutes valid SDK-generated host keys and
passes three refusal assertions: no task submission, no pending control, and retention
of the authenticated pin with an actionable error. All three renderer contexts report
zero uncaught errors. Results are `.artifacts/desktop-authority-recovery/results.json`
and `restored-host-trust.json`.

Ten renderer captures cover seven desktop states at 1487×1058 and three mobile
states at 390×844. The revoked-device explanation and exact-key mismatch alert are
readable and wrap without horizontal overflow. The existing production departure
from the accepted Setup reference remains: setup is a vertical panel within Fleet,
with technical host IDs and the large mobile Fleet heading, rather than the reference's
guided setup layout. No reference or baseline was changed to conceal that difference.

This recovery scenario runs the source Electron application against the uncommitted
tree based on `e7865f2`; it is not a newly installed-artifact proof and uses the demo
provider without paid calls. Native dialog choices are supplied by the test fixture.
The separate OS dialog screenshot attempt returned no image, so native dialog layout
remains visually unverified. Earlier installed and real-provider evidence above retains
its original revision and scope.

At this pass's revision, original bootstrap-device revocation and recovery using customer material without
any surviving verified teammate remained unimplemented. This completed the locally
tested trusted-teammate branch; it is not full closure of issues #15–17
or specialist approval of the privacy/control protocol. GitHub Actions remain
excluded, and current Windows execution is not inferred from local macOS checks.

## Standards review

The independent review identified four actionable findings: expired membership
challenges were never renewed; Access trusted a raw relay revocation summary;
approval controls used team ownership; and native consent overstated read isolation.
All four have implementation fixes and targeted regressions. The separate duplicate
OS-key-storage helper observation was addressed by sharing one protection helper.
Screenshot and full-suite verification are tracked separately above.

## Spec review

The independent review identified three implementation failures: read-only Codex
could bypass the intended project read boundary; membership authority implicitly
conferred action approval; and terminal completion could be persisted ahead of its
durable encrypted event. The old provider path is gated, approval consent is separate,
and terminal persistence follows the event flush. The supported replacement's real
provider acceptance passed separately from those fixes. A further bounded independent
review found no concrete actionable defect in the new host-tools boundary, without
claiming a specialist security sign-off or performing provider calls.

Review totals: Standards had four actionable findings and one duplication observation,
all addressed; Spec had three implementation findings, all addressed. The remaining
acceptance limits are the explicit provider, platform, independent-review and
sole-authority recovery gates above.

## Original-device removal and cross-host history follow-up

This pass is based on `5a27ab1`. A different verified device of the original owner
account can now revoke the original device while preserving the immutable signed
genesis. Each execution host independently applies and acknowledges removal. An
appointed host continues under its replacement signer; an implicit-original host
persists a revoked selection and requires its own local appointment. Current proofs,
project/device checks and rollback protection remain mandatory.

The failure-path review repaired proof publication during concurrent removal,
cancellation stopping at the first failed save, cancellation skipped by failed host
checkpoint storage, and a same-process rollback after storage recovered. The host
retains authenticated observations in memory as well as checking its durable floor;
it does not claim that a failed disk write survived process loss. Failed approval
settlement now records a host cancellation consistently in saved state, retry replies
and history, with no workspace effect.

The two-host Electron flow found two further product defects. A selected host could
silently change during its native project restart; selection now remains on that host
with unavailable controls while offline. Reading a confirmed host could consume a
second host's history handoff before its fingerprint was confirmed. Unconfirmed
messages now stay sealed. Authenticated handoffs use an encrypted local retry journal
for missing-task/import failures, and a fresh authenticated `task.history` request
repairs lost messages while the authorized host is available. No provider or approval
action runs on that read-only path. An independently reproduced loop retrying already
consumed packets is fixed with a bounded refusal-digest cache for explicit SDK
undecryptable results. Unknown-host messages and transient SDK exceptions retain
their separate retry behavior.

The focused host/storage run passed **31/31**; the public mailbox regression passed
**6/6**. The independent consumed-message probe now restores real history and records
zero retained packets, repeat SDK openings or undecryptable results on three later
polls. Evidence is under `.artifacts/genesis-revocation/` and
`.artifacts/desktop-genesis-revocation/`; the latter retains the original mailbox
failure and corrected result. The final full `npm test` chain exited zero on the frozen
source, including **40 authority/revocation**, **20 local confirmation/IPC**, **17
encrypted-control**, **6 mailbox** checks and all **15 production-browser workflows**.
Its log is `.artifacts/genesis-revocation/npm-test.log`. The initial missing-Chromium-path run
and earlier passing runs before later fixes are preserved separately.

The continuous two-source-Electron plus Chrome scenario passed **7/7**, with zero
uncaught renderer errors. It verifies unchanged genesis, exact local appointment,
independent pending/applied host receipts, post-removal file writes, separate approval
authority, durable implicit-host pause, retained old history and refusal of new
ciphertext/controls to the removed device. Seven captures were inspected: five at
1487×1058 and two at 390×844. Setup/Access reuse `shell` + `setup`; the approval state
uses `decision`. Existing shared primitives, flat device sections and Fleet setup
remain; no design references or baselines changed. Native dialog behavior and wording
were tested, but native dialog appearance remains visually unverified.

A fresh macOS arm64 installer independently passed **5/5** build/install/runtime/
retry/uninstall checks, including eighteen desktop smoke assertions and the induced
startup-failure cases explicitly labelled `RECOVERY TEST` in the log. It ran outside
the checkout without Node on its PATH and reported no uncaught renderer errors.
This installed proof uses the demo provider; the seven-step two-host scenario is a
source-app proof. Installer SHA-256:
`e7cfee61d9e07cda90b3e06922e43c3331f835b7f4c8270b4303634aba15d35e`.
The exact build record is `.artifacts/genesis-revocation/installed-darwin-arm64.json`;
the log is `installed-proof.log` in that directory. Both describe the modified tree
based on `5a27ab1`, without GitHub Actions or paid provider calls.

Independent Standards and Spec reviews are retained as
`.artifacts/genesis-revocation/standards-review.md` and `spec-review.md`, with the
additional journal review in `mailbox-review.md`. Their completion-time qualifications
are separate from the later aggregate/install results. No unresolved implementation
finding remains in the reviewed slice. Customer-material-only authority recovery,
real API-account coverage/entitlement, specialist privacy/control review and current
Windows verification remain explicit limits. This is not full closure of issues 2–17.
