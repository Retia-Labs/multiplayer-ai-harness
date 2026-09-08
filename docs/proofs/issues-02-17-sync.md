# Issues 2–17: publication and verification record

Date: 8 September 2026. Implementation checkpoint:
[`28f567e`](https://github.com/Retia-Labs/multiplayer-ai-harness/commit/28f567ee46fc4832e2717ffa15e002a1e1442b66).

The five commits below were published as an engineering checkpoint. They
contain integrated product behavior and evidence-backed repairs, but the latest
source has not completed release qualification. In particular, the last workspace
test failed on an ambiguous fixture selector; its correction is committed but has
not been rerun. A green historical suite or closed issue does not establish current
acceptance. This publication pass runs no tests, adds no features and runs no GitHub
Actions. It follows the user's instruction to document, notify the relevant owners
and sync the repository.

## Published changes

The baseline is `1be13d40c60ad50d7b79eadd31360a86be2ba428`. The implementation
checkpoint is five commits ahead of that baseline, without divergence at the sync
preflight. The accompanying documentation commit is separate from these changes.

| Commit | Change and evidence boundary |
| --- | --- |
| [`2bc1d74`](https://github.com/Retia-Labs/multiplayer-ai-harness/commit/2bc1d74d57cb50e63818c58962e69e6956e90fdd) | Connects the shared renderer to production encrypted execution and confined Codex host tools; repairs membership, controls, approvals, durable event ordering and desktop crypto isolation. Local aggregate, browser, source Electron and installed macOS proofs are recorded in the integration report. |
| [`e7865f2`](https://github.com/Retia-Labs/multiplayer-ai-harness/commit/e7865f284d606c51d421f8a0813b6fd1a6e38815) | Binds native consent and private provider profiles to the selected account; repairs SDK bootstrap. Installed real-Codex collaboration passes 15 checks. A subsequent consent guard is covered by targeted checks, an aggregate pass and a rebuilt installed demo flow; the earlier real-provider proof does not qualify later source. |
| [`5a27ab1`](https://github.com/Retia-Labs/multiplayer-ai-harness/commit/5a27ab15dcb0fa0f8ff0f018275f159c0e00b2ee) | Allows explicit local appointment of a replacement owner verified by a surviving teammate, preserving genesis and host checkpoint. Source Electron recovery passes 11 checks; this is not an installer proof. |
| [`db31535`](https://github.com/Retia-Labs/multiplayer-ai-harness/commit/db3153511a2dc67110c95054592a70813288a58e) | Revokes the original device, pauses hosts independently and repairs encrypted history delivery/retry. The two-source-Electron plus Chrome flow passes 7 checks, the aggregate suite passes, and a rebuilt macOS demo installer passes 5 checks. These results precede owner-kit recovery. |
| [`28f567e`](https://github.com/Retia-Labs/multiplayer-ai-harness/commit/28f567ee46fc4832e2717ffa15e002a1e1442b66) | Adds customer-held owner authority recovery without a surviving trusted teammate, fresh device/project authorization and separate activation on each host. Dedicated browser and source Electron flows pass 6 checks each. Latest aggregate and installed-artifact qualification remain outstanding. |

Detailed behavior, test commands and historical revision limits are in the
[integration report](issues-02-17-integration.md). The latest source results and
stopping point are in the [owner recovery handoff](owner-recovery-handoff.md).
[ADR 0006](../adr/0006-customer-held-owner-recovery-and-host-activation.md) records
the recovery authority and host activation boundary.

## Issue-to-implementation assessment

Each row reports the implemented behavior and the evidence that exercises it. It
does not certify every issue acceptance criterion. The current-source qualification
limits in the next section apply to every row. Owners were checked against the
tracker for this publication pass; listing them does not invent a new assignment.

| Issue / recorded owner | Implemented and exercised | Remaining work or evidence limit |
| --- | --- | --- |
| [#2 — Real Codex control/authentication](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/2) / @likalight | Real ChatGPT-backed writes, acknowledged steering, interruption, exact approval, handoff and resume; explicit account mode and continuity checks. Integration report, first two commits. | Real API-account execution is unverified; synthetic/preflight tests do not prove it. Confirm the supported multi-human entitlement arrangement. |
| [#3 — Encrypted enrollment/control/recovery](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/3) / @likalight | Actual SDK storage, signed membership, authenticated history, replay refusal and customer-only recovery. Dedicated latest recovery checks below. | Qualified independent privacy/control review remains required; implementation review is not that sign-off. |
| [#4 — macOS/Windows bootstrap](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/4) / @likalight | Bundled macOS startup, pairing, local project authorization, durable crypto and installed execution/retry/uninstall at earlier checkpoints. | Rebuild and exercise the installer for `28f567e`; current Windows execution is unverified. Distribution signing belongs to the later distribution slice. |
| [#5 — Team and shared host](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/5) / @likalight | Team/invitation flow, exact endpoint verification, explicit host consent and scoped project/policy boundaries. Recovery resets access and requires fresh local activation. | Retain independent protocol review and fresh authorization after recovery. |
| [#6 — Durable encrypted task](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/6) / @dylothx | Production host discovers and executes encrypted tasks; ordered replay, integrity refusal, restart and recovered-task creation are exercised. | Final corrected workspace test and aggregate qualification remain unrun. |
| [#7 — Installed real Codex task](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/7) / @dylothx | Earlier installed real-provider proof writes actual bytes through confined host tools with explicit local account consent. Latest recovery uses source Electron and demo tools. | Real proof is limited to Codex 0.153.4, macOS arm64, `gpt-5.4-mini` and file-backed ChatGPT login. It does not qualify the latest installer or real API mode. |
| [#8 — Teammate/history enrollment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/8) / @likalight | Signed enrollment, project grants, late history, delayed host confirmation and reload. The latest workspace run passed late history after confirming the original owner's exact fingerprint. | Customer-only recovery is now implemented in dedicated source flows; whole-workspace rerun still outstanding. |
| [#9 — Sourced catch-up](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/9) / @likalight | Catch-up references authenticated events, actual diffs, provider state, decisions and approvals. Historical full browser and latest partial workspace results exercise it. | Latest partial run is not a full-suite pass. No server plaintext summary is introduced. |
| [#10 — Shared steering/interruption](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/10) / @likalight | Actor/turn binding, deduplication, queued/delivered receipts and native acknowledgments. Recovery epoch tests prevent old commands acquiring new authority. | Native use retains #7's supported configuration limits. |
| [#11 — Exact approval rights](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/11) / @likalight | Exact grants, competing responses, expiry, stale refusal and real filesystem effects. Latest Electron recovery requires separate fresh native approval consent. | This is not general exactly-once execution for arbitrary external effects; recovery must never restore old approval grants. |
| [#12 — Private help inbox](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/12) / @likalight | Named encrypted help, resolution/cancellation and late context; latest workspace run passed its recorded inbox checkpoint. | External messaging and content-bearing OS notifications are outside this slice. |
| [#13 — Review/handoff](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/13) / @likalight | Actual source review, authorized handoff and independent outcomes; historical real provider changes Monday to Tuesday and preserves the corrected diff through handoff. | Same provider/platform/account limitations as #7; demo acknowledgments are not interpreted model corrections. |
| [#14 — Related issue/PR links](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/14) / @likalight | Encrypted associations, safe rendering, private navigation and removal; latest partial workspace run passed the association checkpoint. | Product associations do not themselves publish to the external tracker. This authorized publication pass is separate. |
| [#15 — Clean-device recovery](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/15) / @likalight | Customer kit restores authenticated selected history and fresh owner identity with no surviving trusted device; wrong/retired material refuses. Browser and source Electron each pass 6 checks. | Latest installed recovery and additional locked-storage/site-data/platform permutations remain unverified. Native dialog appearance was not captured. |
| [#16 — Device revocation](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/16) / @likalight | Original and replacement device removal preserve genesis; independent hosts apply/persist removal, cancel grants and rotate future sessions. Latest recovery fences old epochs and resets access. | Offline hosts remain pending until applied. Revocation does not erase previously obtained plaintext/history. |
| [#17 — Loss/restart recovery](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/17) / @likalight | Crash markers, interrupted writes, stale approvals, relay failure, re-pair races and explicit recovery state. Customer-only recovery now restores authority only after each host's local activation. | No automatic replay of prior provider actions. Latest aggregate/installer qualification and independent review remain outstanding. |

## Latest verification record

These are observations from the existing local artifacts, re-read during
publication. No checks were rerun. The recorded source Electron artifact identifies
an uncommitted working tree based on `db31535`; the implementation was subsequently
committed as `28f567e`. It is not an exact committed-artifact or installer attestation.

| Evidence scope | Recorded result |
| --- | --- |
| Kit, protocol, epoch fences and two-host production runtime | 26 passed, no failures/skips |
| Browser persistent SDK lifecycle | 2 passed |
| Native local-control/RPC consent contracts | 21 passed, no failures/skips |
| Browser owner recovery | 6/6 passed; zero uncaught errors; demo provider; memory host SDK test adapter |
| Source Electron owner recovery | 6/6 passed; zero uncaught renderer errors; demo provider; actual OS-protected durable broker |
| Existing workspace browser | 9 checkpoints passed, then ambiguous `Recovery key` selector failed; exit 1. Exact-label correction is committed but not rerun. |
| Latest aggregate suite / rebuilt installer | Not run after owner recovery |
| Current Windows / real API-account execution / specialist protocol review | Unverified |

The missing broker-module routes and null IPC options caused genuine Electron
failures; both were repaired before the successful dedicated Electron run. Failed
logs remain retained locally. Native dialog choices in that run were fixtures;
dialog appearance is unverified. Eleven desktop/mobile recovery captures were
reviewed with no document overflow; existing compact Fleet/vertical Recovery
departures are recorded in the handoff. No reference baseline changed.

The [sanitized verification record](owner-recovery-verification.json) publishes
only result counts, test scope, provider type and SHA-256 hashes of the retained
local records. Raw `.artifacts/` logs, screenshots, runtime identities, recovery
material, account data and machine paths are not included in this publication.
Hashes identify the locally retained evidence; they are not independent validation
and do not make an unpublished artifact remotely inspectable.

## Owner attention and next work

@likalight owns the tracker items above except #6–7, owned by @dylothx.
@Dharshan2004 is the parent-spec author and should receive the cross-cutting
qualification note. Existing open [PR #60](https://github.com/Retia-Labs/multiplayer-ai-harness/pull/60)
(tray lifecycle) and [PR #61](https://github.com/Retia-Labs/multiplayer-ai-harness/pull/61)
(provider switching), both by @likalight, overlap the changed desktop/runtime and
provider paths. Their authors should reconcile against this checkpoint before
merging; neither PR is claimed merged or verified by this publication.

The read-only overlap review found that #61's model reset on provider change is
still absent from `Runtime.resolveSettings`. Port that behavior while retaining
the account-bound `HostToolsCodexAppServerBackend`; the PR's older `codexReadOnly`
backend must not replace it because its sibling-file read boundary was disproved.
For #60, preserve the hidden durable crypto broker, service-specific partitions,
bundled renderer and awaited shutdown. Tray busy state must observe
`EncryptedExecution` as well as the legacy runtime. These are integration tasks,
not features completed by this sync.

When testing is separately resumed, start with the corrected workspace browser
test, then qualify the local aggregate suite and rebuilt macOS installer against
the committed source. Arrange current Windows execution, real API-account usage
authorization/entitlement and independent privacy/control review separately.
GitHub Actions testing remains excluded. This record does not reopen or close
issues, waive technical release gates, or begin another implementation cycle.

## Repository publication receipt

The initial normal fast-forward push succeeded: remote `main` advanced from
`1be13d4` to [`faa0333`](https://github.com/Retia-Labs/multiplayer-ai-harness/commit/faa03336f86b3a2c0389c0017c2f010df4b9ae1d),
containing the five implementation commits and the documentation/verification
ledger. Local `main` now tracks `origin/main`. Documentation commits carry
`[skip ci]`; no workflow was dispatched or used for testing. No force push, release
tag, installer upload or merge of PR #60/#61 was performed.

The following 21 comments were posted and read back through GitHub. Every body and
URL matched the prepared text. Existing issue states and assignments were retained.
Mentions follow recorded issue ownership: @likalight for #2–5 and #8–17, @dylothx
for #6–7; both receive the parent summary, and @Dharshan2004 receives the unassigned
distribution/signing coordination note. The receipt commit records these links;
the terminal sync check records its final local/remote revision.

| Tracker item | Published update |
| --- | --- |
| Issue #1 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/1#issuecomment-5582905338) |
| Issue #2 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/2#issuecomment-5582905658) |
| Issue #3 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/3#issuecomment-5582905938) |
| Issue #4 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/4#issuecomment-5582906506) |
| Issue #5 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/5#issuecomment-5582906973) |
| Issue #6 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/6#issuecomment-5582907383) |
| Issue #7 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/7#issuecomment-5582907919) |
| Issue #8 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/8#issuecomment-5582908455) |
| Issue #9 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/9#issuecomment-5582908861) |
| Issue #10 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/10#issuecomment-5582909276) |
| Issue #11 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/11#issuecomment-5582909651) |
| Issue #12 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/12#issuecomment-5582910013) |
| Issue #13 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/13#issuecomment-5582910548) |
| Issue #14 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/14#issuecomment-5582910937) |
| Issue #15 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/15#issuecomment-5582911315) |
| Issue #16 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/16#issuecomment-5582911690) |
| Issue #17 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/17#issuecomment-5582912041) |
| Issue #19 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/19#issuecomment-5582912539) |
| Issue #20 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/20#issuecomment-5582913099) |
| PR #61 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/pull/61#issuecomment-5582913510) |
| PR #60 | [Verified comment](https://github.com/Retia-Labs/multiplayer-ai-harness/pull/60#issuecomment-5582913913) |
