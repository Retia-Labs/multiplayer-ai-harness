# Proposed implementation tickets

Superseded for issue publication by [the 28-slice team breakdown](team-issue-breakdown.md), which covers the final spec's 48 stories. This earlier draft remains historical planning context.

The authoritative parent is now [the implementation spec](product-spec.md), published as [GitHub issue #1](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/1). This is a superseded historical slicing draft; use the published team breakdown above. When publishing child issues, incorporate the spec's catch-up, named help requests, private issue/PR links, and updated activation behavior; preserve technical gates and do not add interviews as blockers.

Draft for review, not published GitHub issues. IDs below are local planning references. Publish approved slices in dependency order and replace IDs with actual GitHub blocking links. AFK means implementable from the accepted specification; HITL means a founder decision, external access, real-user session, or specialist review is part of completion. All user-story references point to the early-access PRD.

## Review index

| ID | Title | Type | Blocked by | Stories | Suggested lead |
|---|---|---|---|---|---|
| T01 | Prove one real Codex shared-control session | HITL | None | 6, 8, 10–16, 25 | Runtime |
| T02 | Prove encrypted enrollment, control, and recovery | HITL | None | 17, 26–30 | Collaboration |
| T03 | Install and start the desktop bootstrap on both platforms | AFK | None | 1, 2, 7 | Desktop |
| T04 | Create a private team and pair an execution host | AFK | None | 4, 5, 17 | Collaboration |
| T05 | Create and replay an encrypted task | AFK | T02, T04 | 8, 9, 26, 30 | Collaboration |
| T06 | Start a real Codex task from the packaged app | AFK | T01, T03, T05 | 6–8, 18 | Runtime |
| T07 | Invite a teammate to encrypted project history | AFK | T05 | 3, 4, 9, 27 | Collaboration |
| T08 | Correct and interrupt a running task together | AFK | T06, T07 | 10–13, 17 | Runtime |
| T09 | Delegate and resolve one action approval | AFK | T06, T07 | 14–17 | Runtime |
| T10 | Review a correction and hand over responsibility | AFK | T08 | 18–20 | Product/Desktop |
| T11 | Recover access and revoke a device | AFK | T07 | 27–30 | Collaboration |
| T12 | Reconnect and resume without replaying actions | AFK | T08, T09 | 12, 16, 23–25 | Runtime |
| T13 | Keep tasks running after window close | AFK | T06 | 21–23 | Desktop |
| T14 | Complete a real collaborative task on installed Windows | AFK | T08, T09, T13 | 2, 5–8, 13, 15, 21–25 | Desktop |
| T15 | Deliver trusted installers and a recoverable update | HITL | T03, T11, T12, T13, T14 | 1, 2, 7, 21, 22, 36 | Desktop |
| T16 | Measure activation and returning teams without content | AFK | T08 | 30, 33 | Product/Desktop |
| T17 | Grant and manage paid pilot seats | AFK | T04 | 32 | Product/Desktop |
| T18 | Pass the external Codex pilot release gate | HITL | T09, T10, T11, T12, T15, T16 | 1–31, 33, 36 | All |
| T19 | Onboard 3–5 pilot teams and expand invites | HITL | T17, T18 | 31–33 | Founder pilot lead |
| T20 | Prove the supported Claude authentication and controls | HITL | T01, T02 | 6, 34, 35 | Runtime |
| T21 | Release Claude Code through the same collaborative workflow | AFK | T18, T20 | 6, 8–25, 34, 35 | Runtime |
| T22 | Prove the supported Cursor authentication and controls | HITL | T01, T02 | 6, 34, 35 | Runtime |
| T23 | Release Cursor through the same collaborative workflow | AFK | T18, T22 | 6, 8–25, 34, 35 | Runtime |
| T24 | Prepare the YC evidence and submission package | HITL | None | 33 | Founder pilot lead |

T01–T04 can begin independently. Provider proofs T20/T22 may run before Codex's external release if capacity permits; their production releases depend on the shared release foundation, not each other. T24 begins now and consumes actual pilot evidence as it becomes available; missing the adoption target must not prevent an on-time YC application.

## T01 — Prove one real Codex shared-control session

**What to build:** A bounded integration experiment using the documented interactive interface and two minimal clients, against a real provider on the intended execution environment. Produce a versioned capability/authentication result, not a demo-provider substitute.

**Acceptance criteria:**
- [ ] Start, stream, steer, interrupt, answer a real approval, and resume; capture actual acknowledgments and failure outcomes.
- [ ] Validate subscription and API arrangements separately, including who authorizes execution and incurs usage; record only arrangements that can be offered. Never use a teammate's credentials as evidence of permission to pool subscriptions.
- [ ] Record macOS/Windows constraints, provider versions, experimental dependencies, and the chosen adapter contract. If a core promise fails, return a concrete scope/approach decision before T06.

## T02 — Prove encrypted enrollment, control, and recovery

**What to build:** A thin desktop/browser-to-relay experiment using an established encryption stack: enroll endpoints, exchange one encrypted task and authenticated approval, restore access, and remove a device. Produce the threat model and a library/protocol decision for review.

**Acceptance criteria:**
- [ ] Demonstrate device verification, customer-held recovery on a clean endpoint, and future-content exclusion after revocation; the operator has no recovery secret.
- [ ] An altered/replayed approval or substituted endpoint key is rejected by the execution host. Define host behavior when it cannot establish current authorization.
- [ ] Document browser code-delivery trust, metadata, historical-key retention/recovery tradeoffs, supported platform storage, review effort, and content-derived features that must leave the hub. No homemade crypto or security-audit claim.

## T03 — Install and start the desktop bootstrap on both platforms

**What to build:** Installable internal macOS/Windows builds that start the application and managed runtime from a clean machine, display readiness, and expose useful setup failures. This is an internal bootstrap, not a public release.

**Acceptance criteria:**
- [ ] No dependence on a developer checkout, inherited terminal environment, or accidentally available system Node.
- [ ] Starting a local runtime works independently of whether the hub is local or remote; packaged resource paths and spawn failures are handled.
- [ ] Document tested OS/architecture targets and prerequisites. Both platform artifacts are exercised; publication/signing remains T15.

## T04 — Create a private team and pair an execution host

**What to build:** The owner creates a team, invites a named user, pairs a local host, and shares one selected project through the product UI.

**Acceptance criteria:**
- [ ] Real authentication replaces name-as-identity, with expiring invitations and enforced team/project membership.
- [ ] A signed-in outsider cannot read histories, address a foreign runtime, register arbitrary paths, or impersonate a role/device through direct requests.
- [ ] Pairing and project approval are locally authorized. Account membership alone is not represented as encryption access or action-approval permission.

## T05 — Create and replay an encrypted task

**What to build:** An enrolled endpoint creates a task whose content is stored and relayed encrypted, then reconstructs it after reconnect. A fixture task is sufficient for this slice; real agent work follows in T06.

**Acceptance criteria:**
- [ ] Task names, prompts, output, changes, and detailed activity are absent from relay plaintext and logs; the allowed metadata inventory is explicit.
- [ ] The authorized endpoint reconstructs history in order after reconnect; tampered content is rejected and gaps are visible.
- [ ] Existing plaintext-dependent hub features are relocated or disabled rather than silently retaining content access. Encryption/storage versioning and limits are documented.

## T06 — Start a real Codex task from the packaged app

**What to build:** Install, connect the team service, configure a supported Codex account, select a permitted repository, and run a feature task with encrypted streamed results.

**Acceptance criteria:**
- [ ] Real changes execute on the displayed host; provider credentials stay out of shared descriptors, logs, ciphertext payloads intended for teammates, and the relay.
- [ ] Setup/version/authentication/usage-limit failures are actionable. Credential access uses supported device storage and the validated provider path.
- [ ] Workspace restrictions and execution policy are enforced on the host; remote clients cannot select arbitrary paths or increase privilege. Show actual execution/sandbox capabilities honestly.

## T07 — Invite a teammate to encrypted project history

**What to build:** A trusted participant enrolls an invited teammate's browser or desktop endpoint, grants project/history access, and the teammate reads the same task after joining late.

**Acceptance criteria:**
- [ ] Login/invitation alone cannot substitute an unverified encryption key; the accepted verification flow is visible and testable.
- [ ] History-sharing scope is explicit, and task history, current state, and pending decisions are reconstructed from authorized content.
- [ ] Uninvited/unverified endpoints cannot decrypt or control work; browser key persistence/deletion behavior is explained and tested.

## T08 — Correct and interrupt a running task together

**What to build:** Bob joins Alice's real feature task, sends a correction, observes its delivery, and can explicitly interrupt. The full path includes client, authenticated encrypted control, runtime, and provider acknowledgement.

**Acceptance criteria:**
- [ ] Concurrent messages retain actor attribution, authoritative order, and distinct queued/delivered/rejected states.
- [ ] Stale-turn instructions are rejected; retry does not redeliver accepted input.
- [ ] Interrupt reports requested versus acknowledged/stopped and is tested during tool execution. UI never claims an unreachable host has stopped.

## T09 — Delegate and resolve one action approval

**What to build:** A host owner delegates approval rights to Bob; Bob answers one real provider approval while Alice sees the same decision and result.

**Acceptance criteria:**
- [ ] Ordinary collaborators can steer but cannot approve without an explicit current grant, verified at the host.
- [ ] Display and bind the exact action, task, host, and execution state. Two competing responses produce one authoritative resolution.
- [ ] Replays, altered action payloads, expired grants, and stale approvals after restart fail; accepted dispatch is deduplicated without claiming impossible general exactly-once shell effects.

## T10 — Review a correction and hand over responsibility

**What to build:** Participants inspect the resulting diff, record task outcome, and assign responsibility with an encrypted note and preserved history.

**Acceptance criteria:**
- [ ] The demonstration shows the wrong assumption, Bob's delivered correction, and the resulting real code change.
- [ ] Handoff changes the responsible teammate without changing the execution host or provider credentials; both remain clearly identified.
- [ ] Completing the task records a useful outcome. Reuse existing diff functionality; do not add Git replacement, a full editor, or broad task management.

## T11 — Recover access and revoke a device

**What to build:** A customer restores access on a clean endpoint via a trusted endpoint or recovery material, and then removes an old device through the product.

**Acceptance criteria:**
- [ ] The documented recovery scope works without operator secrets; wrong or missing material fails honestly and all-methods-loss is explained.
- [ ] Revoked devices cannot decrypt future content or authorize new actions. Previously learned plaintext cannot be claimed erased.
- [ ] Recovery never reinstates stale approval grants; rotation, offline endpoints, and recovery-key compromise behavior match the selected protocol.

## T12 — Reconnect and resume without replaying actions

**What to build:** A participant and host recover from network loss, sleeping machine, runtime crash, and service restart with truthful state and supported explicit continuation.

**Acceptance criteria:**
- [ ] Full previous history survives incremental replay; gaps and provider state are reconciled before controls re-enable.
- [ ] Already-started actions are reported with their actual outcome; new authorization-dependent work does not proceed from stale remote approvals.
- [ ] No blind replay of side effects. Pending decisions are restored only if valid or explicitly expired, and duplicate/stale inputs are rejected.

## T13 — Keep tasks running after window close

**What to build:** Closing the desktop window leaves the runtime in the tray/menu bar, with browser collaboration continuing; explicit quit makes its effect clear.

**Acceptance criteria:**
- [ ] Test close/reopen with a real running task and a second participating client on both platforms where the provider path is supported.
- [ ] Explicit quit confirms the impact when tasks run, shuts down managed processes without orphans, and reports unavailable state remotely.
- [ ] Sleep/network loss is not confused with a completed or successfully stopped task; reopening does not launch duplicate hosts.

## T14 — Complete a real collaborative task on installed Windows

**What to build:** Prove the complete real-agent workflow on a clean installed Windows execution host, including remote steering and approval.

**Acceptance criteria:**
- [ ] Shell behavior, binary discovery, Windows paths/drive letters, command shims, and process-tree interruption work in the declared environment.
- [ ] Any required execution environment is installed or explicitly guided and validated; it is not a hidden prerequisite. Preserve the packaged Windows requirement.
- [ ] Project selection, authentication, close/reopen, approval, and actual file changes pass on the recorded Windows version; compare with macOS baseline.

## T15 — Deliver trusted installers and a recoverable update

**What to build:** Founder-reviewed distribution artifacts for macOS and Windows, signed/notarized as applicable, with a verified upgrade and documented rollback/reinstall path.

**Acceptance criteria:**
- [ ] Acquire required signing accounts/credentials, protect them in release infrastructure, and validate clean-machine installation. Human provisioning is tracked as an explicit blocker.
- [ ] Load trusted packaged desktop code with a narrow validated bridge. An update cannot silently expose provider credentials or invalidate encrypted history.
- [ ] Test version compatibility, downgrade/rollback constraints, and recovery. Manual update delivery is acceptable initially if clear and safe; automatic updates are not a hidden launch prerequisite.

## T16 — Measure activation and returning teams without content

**What to build:** A content-free pilot measurement path from actual participant/provider-delivery events to founder counts.

**Acceptance criteria:**
- [ ] Activation requires at least two humans in a real task and a teammate intervention confirmed delivered; signup and solo tasks do not count. Define and document per-person participation precisely.
- [ ] Retry deduplication works; separate unique activated users, completed collaborative tasks, returning teams, and paid-seat status.
- [ ] No prompts, task names, repository identifiers, diffs, or tool content in analytics. Disclose collected metadata and provide a deletion/retention policy.

## T17 — Grant and manage paid pilot seats

**What to build:** Founder-operated individual seat entitlements tied to actual pilot agreements/payments, with clear product-versus-provider billing information.

**Acceptance criteria:**
- [ ] Seat grant/revocation and billing owner are recorded; payment status never grants project/decryption/approval access by itself.
- [ ] Price is configurable or captured manually after a later founder decision; no invented price is treated as accepted.
- [ ] Distinguish active paying teams from offers, trials, and unpaid invoices. Full automated checkout is unnecessary for this slice.

## T18 — Pass the external Codex pilot release gate

**What to build:** Run the installed desktop/browser product through the agreed end-to-end test and threat-model review, producing an explicit go/no-go for external confidential repositories.

**Acceptance criteria:**
- [ ] Both installed execution platforms pass the real two-human correction, delegated approval, diff review, responsibility handoff, background lifecycle, reconnect, and recovery flow.
- [ ] Independent review of the E2EE/control implementation and malicious-relay/unauthorized-user tests completes; plaintext inspection covers storage, logs, telemetry, notifications, and support exports. Claims match review scope.
- [ ] Setup, diagnostics, supported auth/version matrix, encrypted backups/deletion/retention, service restore, and incident/support procedures are usable. No unresolved defect defeats an accepted core promise.

## T19 — Onboard 3–5 pilot teams and expand invites

**What to build:** Founder-led installation and first collaborative task with real startup teams, followed by fixes and controlled expansion toward 50 activated people.

**Acceptance criteria:**
- [ ] Record each team's setup outcome, first useful teammate intervention, friction, and next use without collecting private task content unnecessarily.
- [ ] Review weekly returning-team behavior and paid-seat conversion; choose price before making paid offers. Target three paying teams without treating the target as achieved prematurely.
- [ ] Expand invitations and hackathon distribution only while release gates and support capacity hold. Do not replace active-user evidence with account counts.

## T20 — Prove the supported Claude authentication and controls

**What to build:** A real Claude integration/authentication experiment against the same adapter contract, choosing the supported SDK or binary arrangement deliberately.

**Acceptance criteria:**
- [ ] Verify actual input queuing/steering, interrupt, approval, resume, and both platform requirements; record differences from Codex.
- [ ] Establish a permitted authentication/billing arrangement for the product. Do not assume a personal subscription can be routed through an SDK product.
- [ ] Return a tested support matrix and any required explicit scope decision; no provider-parity claim based solely on fixture translation.

## T21 — Release Claude Code through the same collaborative workflow

**What to build:** Add Claude as a selectable provider with the same encrypted enrollment, permissions, shared task view, and truthful capability states.

**Acceptance criteria:**
- [ ] Real two-user correction, approval where supported by the accepted release scope, interruption, and resume pass on advertised platforms/auth modes.
- [ ] UI distinguishes queued instructions from delivered steering and unsupported actions; existing Codex users remain working.
- [ ] Publish versioned setup and limitations, then run an assisted pilot. If the core workflow cannot be met, return a scope decision instead of silently shipping a weaker promise.

## T22 — Prove the supported Cursor authentication and controls

**What to build:** A real Cursor ACP/SDK experiment selecting the interface that satisfies shared controls and approval requirements.

**Acceptance criteria:**
- [ ] Test real steering versus follow-up, cancellation, permission requests, resume, and local execution; do not conflate ACP, local SDK, detached runs, cloud agents, or native IDE adoption.
- [ ] Verify supported authentication, billing owner, versions, and both platform constraints without assuming transferable subscriptions.
- [ ] Return a capability matrix and chosen path, identifying any unsupported core behavior as a scope decision.

## T23 — Release Cursor through the same collaborative workflow

**What to build:** Add Cursor using the validated path and shared encrypted task experience.

**Acceptance criteria:**
- [ ] Advertised controls work in a real two-human task on advertised platforms and authentication modes; outcomes are accurately labeled.
- [ ] Enrollment, delegated permissions, reconnect, key handling, and telemetry remain consistent with the shared release gates.
- [ ] Existing providers pass focused regressions; complete an assisted Cursor pilot before wider enablement.

## T24 — Prepare the YC evidence and submission package

**What to build:** A founder-owned application preparation track that begins immediately and incorporates real evidence as pilots progress.

**Acceptance criteria:**
- [ ] Explain the specific everyday-development problem, team insight, product workflow, actual progress, and why participants return. Separate observed results from targets.
- [ ] Prepare the one-minute founder video and a separate concise real-product demonstration; get explicit permission for any customer material used.
- [ ] Verify current application fields/deadline before submission; review and submit ahead of the deadline even if 50 users or three paying teams have not been reached. Submission itself is a founder action/explicitly authorized step.

## Review requested

Confirm the testing seams, granularity, blocking edges, and HITL/AFK classification as one build-plan review. Suggested ownership denotes work lanes, not assignments to named founders. No GitHub issue numbers exist for this draft yet.
