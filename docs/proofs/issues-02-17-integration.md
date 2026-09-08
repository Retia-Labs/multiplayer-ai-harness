# Issues 2–17: integration repairs and remaining acceptance work

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
stop execution before model work. Native consent names use of the existing local
file-backed ChatGPT login, including shared refresh; other authentication paths are
not implied. The actual CLI's synthetic tool inventory passes. The separate
real-provider scenario also passed: eight checks covering actual read refusals,
file writes, acknowledged correction, exact approval, handoff, explicit thread
resume and confirmed interruption on this supported configuration.

## Issue assessment

“Implemented and exercised” below describes the listed behavior, not independent
security review or coverage on platforms that were not run. Existing foundation
proofs remain applicable to their original revisions and scopes.

| Issue | Current implementation assessment | Remaining acceptance work or limit |
| --- | --- | --- |
| [#2](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/2) | One real ChatGPT-backed encrypted scenario exercises actual writes, native shared steering/interrupt, approval, handoff and resume; command deduplication and competing approvals have deterministic coverage. | Separate authorized API-account test, supported multi-human entitlement arrangement, and full advertised-platform/provider isolation evidence. |
| [#3](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/3) | Established SDK storage/recovery foundation retained; signed membership, provenance, replay and revocation tests strengthened. | Qualified review of the new integrated privacy/control protocol; retained platform proofs do not review this new protocol. |
| [#4](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/4) | Rebuilt macOS installer passes installation, bundled startup, pairing, project selection, a real Codex encrypted task, failure/retry and uninstall. | Current Windows changes require a Windows run. Public signing remains the later distribution slice. |
| [#5](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/5) | Team, invitations, host consent, project/policy limits and direct-request boundaries exercised. Device state reflects actual verification. | New cryptographic integration retains the independent-review gate. |
| [#6](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/6) | Opaque task persistence, ordered replay, integrity failure, browser restart and production host execution are connected and tested. | Full external-release platform and adversarial review gates remain. |
| [#7](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/7) | Production encrypted execution, actual Codex host-tool edits, durable identity, explicit local provider consent and actionable errors implemented. The supported native scenario passes actual project-read refusals. | Restricted to Codex 0.153.4, macOS arm64, gpt-5.4-mini and the tested file-backed ChatGPT login. Installed real-provider evidence is recorded separately below. Older read-only opt-ins remain disabled. |
| [#8](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/8) | Signed enrollment, explicit project grants, late teammate history, delayed host confirmation and reload exercised through the renderer. | Lost sole authority is the recovery limit described below. |
| [#9](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/9) | Sourced catch-up, actual patches, current provider, decisions, approvals and freshness connected to authenticated events. | No generated summary or server plaintext projection is introduced. |
| [#10](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/10) | Actor/turn binding, deduplication, queued/delivered receipts and interruption exercised through real native acknowledgments and encrypted production controls. | Native production use retains #7's supported-configuration limits. |
| [#11](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/11) | Exact action grants, competing responses, expiry, mutation refusal and stale-after-restart behavior exercised with real local filesystem effects. | No broad session approval or general exactly-once external-effect guarantee. |
| [#12](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/12) | Named encrypted help, inbox resolution/cancellation and late context connected; help is separate from provider input. | External messaging and content-bearing OS notifications are outside this slice. |
| [#13](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/13) | Diff/source review, handoff, authorized recipients and independent task outcomes exercised. The continuous real-provider scenario proves Bob's acknowledged correction changes actual Monday text to Tuesday, then handoff preserves that corrected diff. | Same supported provider/platform/authentication limits as #7. |
| [#14](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/14) | Encrypted related links, safe rendering, private task navigation and association removal exercised. | Association does not publish anything to the external tracker. |
| [#15](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/15) | Customer setup drill, wrong-key refusal, replacement, clean browser history restore and explicit re-enrollment exercised; desktop keys use OS storage. | History-only recovery cannot replace a permanently lost sole membership signing authority. Desktop site-data/locked-storage permutations and platform coverage retain their explicit limits. |
| [#16](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/16) | Signed state, rollback resistance, future session rotation and verified per-host acknowledgments exercised. | Hosts remain pending until they apply removal; no erasure of old plaintext/history. |
| [#17](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/17) | Restart/crash markers, stale approvals, interrupted writes, relay append failure, re-pair races and explicit recovery state exercised. | Sole-authority loss prevents authenticated reconnect; automatic provider/action replay remains prohibited. |

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

The fresh membership challenge currently depends on the pinned owner signing
endpoint. Clean history recovery does not recover that private signing authority.
A trusted teammate can verify a replacement endpoint, but cannot make it sign as
the lost authority. A supported authority replacement needs a separately designed,
registered and reviewed recovery mechanism. Silently repinning from account/relay
metadata would reintroduce the rollback problem this work repairs.

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
