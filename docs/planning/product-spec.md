# Implementation spec: private multiplayer agent collaboration

Status: implementation specification, 2026-09-05. Synthesized from founder decisions, repository inspection, YC/industry/competitor research, and the two-agent grilling session. The founder explicitly requested proceeding without user interviews. This spec supersedes the earlier planning drafts where they conflict; those documents remain historical context.

**Execution instruction:** begin implementation with the bounded Codex, encryption, and desktop foundation work described below. No interview, ten-day market-validation exercise, pricing decision, or additional discovery approval is a prerequisite. Technical tests, supported provider authorization, and the external-release gates still apply. This specification does not claim that market demand or the existing code has been validated.

## Problem Statement

Small startup teams increasingly delegate substantial development work to coding agents. When another teammate needs to correct an assumption, help with a decision, or take responsibility, they must reconstruct the work from messages, local sessions, and code changes. Version history does not preserve the complete live collaboration experience. The team needs shared context and meaningful control over ongoing agent work.

## Solution

Packaged macOS and Windows desktop applications start and supervise collaborative coding-agent tasks on a user's execution host. Authorized teammates join through desktop or web, understand the current work, send attributed instructions, interrupt, resolve explicitly delegated approvals, and hand off responsibility while retaining context. Closing the desktop window keeps the execution host running in the tray/menu bar; explicitly quitting explains that its tasks will become unavailable.

Launch with Codex and add Claude Code and Cursor in quick succession through separately verified adapters. Customers bring their own supported subscription or API relationship. Charge individual seats for collaboration, with provider usage billed separately; seat price is intentionally deferred.

The hosted synchronization service relays end-to-end encrypted collaboration content. Only authorized endpoints can decrypt it. Recovery uses authorized devices/teammates or a customer-held recovery key; the operator cannot recover content. The selected inference provider still receives the inputs required to execute the task.

The first demonstrated workflow is a teammate joining a feature task, using a concise catch-up view, correcting a wrong assumption, observing the resulting change, and taking responsibility if needed. Explicit requests for help/review make the same workflow useful asynchronously. Link tasks to existing issues and PRs without publishing private content. Initial distribution is the founders' own team, 3–5 assisted startup pilots, and broader invite-only access including Singapore hackathons. Recruiting or interviewing these teams does not block building the product.

## User Stories

1. As a developer, I want to install a packaged macOS app so that I can begin without setting up this repository.
2. As a developer, I want to install a packaged Windows app so that my machine can execute collaborative tasks.
3. As a teammate, I want browser access so that I can join work without installing a desktop app on that device.
4. As a team owner, I want to create a private team and invite named people so that access is intentional.
5. As an execution-host owner, I want to pair my device and explicitly share a project so that membership does not expose arbitrary local files.
6. As a developer, I want supported provider authentication and a clear account/usage owner so that billing and authority are understandable.
7. As a developer, I want actionable setup errors for missing or unsupported provider components so that onboarding is recoverable.
8. As a developer, I want to start a Codex feature task through the product so that its work is collaborative from the beginning.
9. As a teammate, I want to join late and see history, changes, current activity, and pending decisions so that I can contribute without a verbal recap.
10. As a collaborator, I want to send an instruction to the active task so that I can correct a wrong assumption.
11. As a collaborator, I want the instruction's actor, order, and delivery result to be visible so that chat display is not mistaken for agent receipt.
12. As a collaborator, I want stale instructions rejected after the target turn changes so that I do not redirect the wrong work.
13. As a collaborator, I want explicit interruption with acknowledged status so that I know whether the agent actually stopped.
14. As an execution-host owner, I want to delegate action-approval rights separately so that participation does not imply unrestricted execution authority.
15. As a delegated approver, I want to see the exact pending action, project, and execution host so that I can make a bounded decision.
16. As a teammate, I want competing approval responses to produce one authoritative outcome so that conflicting decisions do not dispatch the same approved action twice.
17. As a participant, I want unauthorized commands rejected at the execution host so that a compromised or mistaken relay cannot grant itself authority.
18. As a collaborator, I want to review changes produced by the task so that I can judge whether the correction worked.
19. As a task lead, I want to hand responsibility to another teammate with a note so that ongoing work retains its context.
20. As a participant, I want the execution host to remain visible after handoff so that reassignment does not imply process migration.
21. As a desktop user, I want window close to retain the background runtime so that teammates can continue participating.
22. As a desktop user, I want explicit quit to explain the effect on running tasks so that I do not accidentally strand teammates.
23. As a participant, I want host disconnection, unknown execution status, and recovery distinguished so that the interface does not imply actions ran while disconnected.
24. As a returning participant, I want reconnect to restore complete context without duplicate commands so that brief network loss does not corrupt work.
25. As a developer, I want interrupted sessions recovered only through a supported, explicit resume path so that stale approvals are not reused.
26. As a customer, I want shared content encrypted between authorized endpoints so that the synchronization operator cannot read it.
27. As a customer, I want to authorize another device or teammate and choose the history shared so that key access follows project access.
28. As a customer, I want a recovery key and an understandable recovery exercise so that I can recover without operator decryption.
29. As a project owner, I want revoked devices excluded from future content and control so that access removal is effective.
30. As a customer, I want the product to explain metadata visibility, endpoint trust, AI-provider disclosure, and irreversible recovery loss so that its privacy promise is precise.
31. As a pilot team, I want assisted onboarding and diagnostics that exclude task content so that founders can help without access to private code.
32. As a paid user, I want my seat entitlement recorded separately from provider usage so that purchasing collaboration does not imply bundled inference.
33. As a founder, I want content-free activation and retention measurements so that I can distinguish real collaboration from signups.
34. As a customer, I want supported Claude Code and Cursor releases soon after Codex so that the product can fit my team's provider choice.
35. As a customer, I want truthful per-provider controls and setup information so that unsupported live steering or approval behavior is never presented as available.
36. As a pilot customer, I want a tested upgrade and rollback path so that an update does not strand my runtime, encrypted history, or credentials.


37. As a joining teammate, I want a concise catch-up view of the objective, accepted decisions, current plan, relevant changes, and blocker so that I can contribute without reading the entire transcript.
38. As a participant, I want catch-up items linked to source events and labeled with their freshness so that I can verify them and identify outdated context.
39. As a task lead, I want to request help or review from a named authorized teammate so that the right person can intervene when available.
40. As an invited helper, I want an inbox item opening the exact task and question so that I can act asynchronously without reconstructing the request.
41. As a participant, I want human help requests distinguished from agent instructions so that asking a teammate does not accidentally redirect execution.
42. As a developer, I want to associate an existing issue or PR URL with a task so that development context remains connected to the team's existing workflow.
43. As a project member, I want private task links to enforce membership and device verification so that copying a link does not grant access or expose plaintext.
44. As a developer, I want a useful solo task flow before inviting a teammate so that collaboration does not require coordinating two people just to begin work.
45. As a team owner, I want account, project membership, encryption access, and paid-seat entitlement separated so that changing one does not silently grant another.
46. As a customer, I want explicit project/task deletion and offboarding behavior so that retention, backups, and device revocation are understandable.
47. As a founder, I want content-free measurement of setup stages, catch-up, direct control, and voluntary return so that later usage reveals which parts of collaboration help.
48. As an implementer, I want concrete technical gates and acceptance criteria so that work can begin without conducting customer interviews or inventing market validation.

## Implementation Decisions

### Product and release boundaries

- Product-started tasks, with one visible execution host per task. Responsibility handoff does not migrate execution or credentials.
- Shared participation with ordered, attributed instructions and explicit interruption; approval authority is separately delegated.
- Private invite-only teams with explicitly shared projects; no public task links for early access.
- Packaged macOS and Windows execution clients plus web collaboration; Windows browser support alone is insufficient.
- Codex first; Claude Code and Cursor follow as separate releases. No claim of three-provider behavioral parity.
- E2EE and customer-controlled recovery are early-access requirements, not post-launch upgrades.
- Window close retains the background runtime; explicit quit ends host availability with clear notice.

### Engineering approach — required behavior and bounded feasibility work

- Retain the shared web interface and Electron shell, separating local runtime lifecycle from connection to the hosted service. Bundle or explicitly manage a compatible runtime so users do not need to launch from a developer shell.
- Use an adapter boundary with start, observe, steer/follow-up, interrupt, approval, and resume capabilities. Preserve provider identifiers independently from product task identifiers. Capability and delivery outcomes must be explicit.
- Validate Codex app-server through a local stdio connection instead of assuming the existing noninteractive exec wrapper supports collaborative controls. Pin the validated version. Test subscription and API arrangements separately; advertised arrangements must be permitted and operationally tested.
- Establish native Windows execution or explicitly identify a required supported execution environment in onboarding. The first validation must determine whether a prerequisite such as WSL is necessary; do not label a hidden prerequisite native Windows support or silently reduce the accepted platform scope.
- Establish authenticated user identities, private team/project membership, device enrollment, and host pairing. Do not trust caller-supplied organization, runtime, or role identifiers.
- Separate membership, decryption access, steering/interruption rights, and action-approval grants. Verify permission and message authenticity on the execution host, including current authorization state, rather than treating hub routing as authority.
- Use an established cryptographic protocol/library selected through an E2EE validation task; no homegrown cryptography. Define device keys, project/history sharing, authenticated membership changes, recovery, rotation, and revocation before building on the encrypted transport.
- Encrypt task titles, prompts, messages, plans, tool arguments/results, diffs, handoff notes, and detailed activity. Limit cleartext to explicitly documented routing, delivery, identity/membership, size/timing, billing, and opt-in measurement metadata. Minimize identifying project labels and filesystem information at the relay.
- Move content-derived projections, search, and file-overlap reasoning to authorized endpoints or the execution host. The relay cannot retain plaintext feature logic while the product claims E2EE. Basic collision warnings may be retained only where their coverage can be proved and described accurately.
- Web clients are authorized endpoints. Document the trust in delivered application code and its origin; E2EE is not a promise against a malicious client release, compromised endpoint, or the selected inference provider. Decide the precise browser enrollment and storage mechanism in the validation task.
- Commands carry unique identifiers, target task/turn, actor identity, and authorization context. The execution host validates, orders, acknowledges, and deduplicates accepted commands. Do not equate at-most-once command acceptance with a blanket exactly-once guarantee for shell side effects after crashes.
- Bind approvals to the exact pending action and execution state. A stale or changed action cannot inherit an earlier approval. One valid response wins; other clients see the resolution and actor.
- Maintain durable encrypted event replay and runtime reconciliation. A disconnected host cannot receive new remotely authorized actions; already-started local work may continue and must be reported honestly after reconciliation. Pending approvals remain blocked until safely resolved or expired.
- Use supported provider execution restrictions, explicit workspace allowlists, and isolated worktrees where appropriate. Existing string heuristics and worktrees are not a security sandbox. A collaborator cannot select arbitrary paths or escalate runtime policy.
- Count activation with minimal client/host-reported product events and stable pseudonymous identifiers, never raw task content. Separate signup, active participation, confirmed agent delivery, task completion, returning teams, and paid seats. Telemetry has retry deduplication and an explicit consent/disclosure policy.
- Record paid seats through manual pilot operations initially. Pricing is deferred; automated checkout and billing can follow demonstrated demand. No free or paid entitlement should silently grant project access or decryption keys.

### Domain records and protocol responsibilities

The following are logical contracts; they do not prescribe a database vendor or source layout. Persist versioned records and document schema migration before external release.

| Record | Required behavior and ownership |
|---|---|
| Team / membership | Stable identity, invited/active/removed membership, and an authenticated owner/admin. Team administration never implicitly grants execution-host approval authority. |
| Enrolled endpoint | Stable device identity bound to the verified person, trust state, key/protocol version, and revocation state. A browser profile, desktop participant, and execution runtime are distinct cryptographic roles even when colocated. |
| Project share | Opaque project identifier, explicitly authorized host/workspace mapping, member access, and current encryption/membership state. Human-readable names and local paths are encrypted. |
| Task | Stable product identifier, encrypted objective/title, project, creator, responsible teammate, execution-host identity, provider reference, and open/completed/cancelled outcome. Task lifetime is distinct from one provider turn. |
| Turn | Provider correlation, current lifecycle, accepted input references, plan/items, pending decisions, and terminal result. Starting a new turn does not rewrite the previous turn's history. |
| Control command | Unique command identity, originating verified endpoint, target task/turn, authorization context, encrypted operation payload, and explicit acceptance/delivery/result events. Retry preserves command identity. |
| Approval | Exact pending provider request/action, task/turn/host, current grant context, unresolved/resolved/expired state, deciding actor, and resulting dispatch. Only one valid resolution is accepted. |
| Help request | Task, requesting member, named project-member recipient, encrypted question and context references, open/resolved/cancelled state, and task link. It is human-directed and carries no implicit provider command. |
| Related work | Optional issue/PR URL stored encrypted with the task. It is a user-provided association, not permission to read or write the external system. |
| Event / replay cursor | Ordered, versioned durable event references with integrity/authenticity according to the selected protocol; encrypted content and sufficient delivery metadata for resume. Relay cursors are not execution authorization. |

The collaboration service provides authenticated account/invitation management, opaque project/task routing, encrypted event append/replay, and delivery acknowledgments. Execution hosts provide the authoritative outcome of commands and approval dispatch. Clients produce decrypted views from accepted events. Invalid authentication, unavailable host, stale turn, expired approval, revoked access, and unsupported provider capability must be distinct outcomes rather than generic success.

### User flows and state rules

1. **Start alone:** install desktop → authenticate → enroll/pair host → select and explicitly share a project → configure a supported provider account → start a task. An invite is optional; a useful first solo task must be possible.
2. **Join:** an invited member follows a private task link, verifies/enrolls the endpoint, and receives project/history access through an authorized endpoint. Default early-access sharing is project-level access to its existing shared history and future tasks, shown explicitly when granted. Do not imply selective per-message sharing or that a URL contains decryption authority.
3. **Catch up:** show objective, responsible teammate, host/provider, current plan/status, explicitly recorded decisions, recent changes, and pending help/approvals. Every decision/summary item must link to source events or a saved artifact and expose freshness. Begin with deterministic projections; generated summaries are optional and run only at authorized endpoints under the customer's provider relationship. Inferred decisions must never be presented as human-approved decisions.
4. **Ask a teammate:** select a project member and send a task-linked question. It appears in that member's in-app inbox and resolves explicitly. External email/Slack integrations and a general chat system are not required. Any OS notification is generic and contains no decrypted task text.
5. **Steer:** explicitly send agent input targeting the active turn. Multiple authorized collaborators may send input; accepted messages are ordered and attributed. If the provider can only queue or accept a later follow-up, display that exact outcome. Do not silently switch a stale instruction onto a new turn.
6. **Interrupt:** show requested/stopping until the provider/runtime confirms interruption. A network outage cannot be reported as a confirmed stop. Do not claim that interruption rolls back completed side effects.
7. **Approve:** the host validates the action, current task/turn, grant, verified actor, and request state. The first valid resolution wins; all participants see the same actor and decision. Late responses show already-resolved/expired status. Per-action approval is the early-access default; do not expose a broad accept-for-session option until its scope is enforced and tested.
8. **Review and hand off:** view the resulting diff, associate an issue/PR if useful, and reassign responsibility with an encrypted note. The new responsible member must already have project access. Host, workspace, and provider credential ownership stay unchanged.
9. **Leave or disconnect:** browser departure and closing the desktop window leave work running on the connected host. Explicit desktop quit warns when tasks are active, then shuts down managed work and reports unavailable state. Host sleep/crash or lost connectivity shows unknown/unavailable execution state until reconciled.
10. **Resume:** a live host reconnect reconciles persisted events, accepted commands, provider state, and pending approvals before control is enabled. A crashed runtime uses an explicitly supported provider resume path; if state cannot be reconciled, show recovery-required instead of silently restarting commands. Duplicate side-effect execution must not be the default recovery strategy.

Represent turn activity as queued, running, awaiting-approval, interrupt-requested, completed, interrupted, failed, or recovery-required, according to observed provider/runtime events. Represent host connectivity separately as connected, reconnecting, or unavailable. A task can remain open across completed/interrupted turns; absence of a connected host must not mark it complete.

### Encryption, membership and recovery implementation gate

Select an established supported encryption stack by demonstrating the required behavior across desktop, runtime, and browser. The gate produces a protocol/library choice, versioned threat model, storage/enrollment design, and working test evidence. It is an implementation task, not a request for another product interview. Evaluate the existing research's candidates; do not implement new cryptographic primitives or claim an audit based on a library's reputation.

Keep the server unable to decrypt stored/shared task content through any ordinary operator, account-reset, backup, or support path. The trust model includes authorized endpoint code and the application publisher/update pipeline; an operator-served browser necessarily trusts delivered client code. This is not a claim against malicious endpoint software or inference providers.

Use verified project membership/key distribution with explicit enrollment confirmation. A newly created server account or password reset does not establish cryptographic trust. Protect desktop keys with supported OS-backed storage, define browser persistence and recovery after site-data loss, and avoid syncing provider credentials to participants.

Recovery material is customer-held; the service may store encrypted backups only. Restore project/history access and endpoint trust according to the chosen protocol, never obsolete delegated approval grants. Verify recovery on a clean endpoint during setup. Explain that previously disclosed plaintext cannot be revoked and that losing every trusted endpoint/recovery method makes history unrecoverable.

Revocation advances the authenticated membership/key state and excludes removed endpoints from future content under that state. Each execution host acknowledges application of the new authorization state. Show revocation pending for an unreachable host; do not assert that a disconnected machine instantly learned the change. Reconciliation must apply current membership before accepting new remote controls. An adversarial relay must not be able to invent grants, substitute endpoint identities, or replay an accepted approval; document availability/withholding limitations explicitly.

Provide task/project deletion and member/device offboarding. Remove deleted ciphertext from live stores, drop access/index references, and document the bounded backup-retention behavior before external release. Deletion cannot erase exported plaintext or participant-held copies. Redact content from logs, diagnostics, telemetry, crash exports, and notifications by construction.

### Execution sequence and acceptance gates

| Stage | Deliverable | Required evidence / next action |
|---|---|---|
| A — Codex capability | One real interactive Codex task with two clients and supported customer authentication | Prove actual input delivery, interruption, bounded approval response, replay and provider resume; pin the supported version and platform/auth matrix. |
| B — Encrypted participation | Verified endpoints exchange task content/control and restore access using customer material | Prove relay unreadability, authenticated enrollment/control, recovery, revocation, and failure behavior with the selected stack. |
| C — Installed bootstrap | Installable macOS and Windows applications managing their local runtime | Run outside a checkout/developer shell, connect to a remote team service while starting a local host, surface prerequisites/errors, and begin signing/distribution setup. |
| D — Real shared task | Private team/project setup, encrypted Codex task, catch-up, help, steering, delegated approval, diff and responsibility handoff | Full observable workflow through the primary product test seam. No interview or payment prerequisite. |
| E — External release | Recovery/revocation, reconnect, background lifecycle, installed-platform execution, trusted distribution and content-free diagnostics | Pass real-provider tests on both advertised execution platforms, an independent review of the implemented privacy/control boundary, and plaintext-leakage/adversarial tests. |
| F — Provider succession | Claude Code and Cursor using the same product concepts | Run their compatibility experiments once the common contract is stable; ship each promptly after it passes the same applicable workflow/security gates. Choose order from engineering readiness; do not delay Codex for parity. |

A, B, and C can start concurrently. Authenticated team/host pairing can also begin as an independent implementation slice. Preserve the proposed ownership lanes: runtime/providers, collaboration/encryption, and desktop/product experience. They are work responsibilities, not invented founder availability commitments.

If a gate fails, document the specific failing behavior and implement a supported alternative within the accepted scope. Escalate only a genuine scope conflict such as an unavailable required control, unsupported customer authentication arrangement, or inability to satisfy the stated encryption/platform promise. Do not replace failed technical behavior with a marketing caveat.

### Passive learning and commercial operations

No user interviews, comparison trials, or ten-day discovery exercise are required before coding or release. After launch, measure setup stage completion, useful solo starts, invitations, catch-up, help requests, delivered steering, approvals, task outcomes, and returning teams through disclosed content-free events. Derive counts at authorized endpoints rather than inspecting transcripts at the relay.

Keep the agreed activation definition. For implementation, a participating individual must start the qualifying task or contribute an authenticated control/approval action; passive page views are measured separately. The task must contain at least two distinct human participants and a non-initiating teammate's intervention confirmed delivered to the agent. Deduplicate by person/task/event identity. Do not count a help message, queued-but-undelivered input, or signup alone as activation.

Record paid seats separately from access grants and provider charges. Use founder-operated pilot entitlement/payment records initially. Seat price remains deferred; do not choose a price, grant free reviewer tiers, or gate implementation on a pricing interview. The target remains 50 activated people and three paying teams; it is not a statement of achieved traction.

## Testing Decisions

Test observable behavior at the desktop/browser-to-runtime boundary, using existing multi-client protocol and browser tests as prior art. Use targeted module tests only for protocol/state invariants that are difficult to exercise reliably through that boundary.

1. Two real users on a packaged client and browser: authenticated join, encrypted replay, real Codex task, teammate correction delivered, changed output, and responsibility handoff.
2. Two near-simultaneous instructions: stable attribution/order, clear delivery states, and stale-turn rejection.
3. Two approval responses: one resolution, one accepted dispatch, accurate UI, and no reuse after restart or action mutation.
4. Unauthorized user/device and revoked collaborator: fail through both UI and direct protocol requests, including arbitrary path and privilege escalation attempts.
5. Relay/database/log inspection with canary content: no plaintext prompts, titles, code, diffs, tool arguments/results, or keys. This is a leakage test, not proof of cryptographic security.
6. Enroll another device, recover from customer-held material, rotate/revoke, and verify a removed device cannot decrypt future content. Explicitly test complete recovery loss and malicious enrollment attempts.
7. Browser/desktop reconnect, sleeping host, runtime crash, and relay restart: preserve history, reconcile state, reject stale decisions, and do not replay side-effecting commands blindly.
8. Clean-machine installed macOS and Windows flows: provider setup, project selection, run, remote approval, tray/menu-bar behavior, explicit quit, reopen, upgrade, and rollback. Record OS/architecture/provider versions.
9. Exact supported Codex authentication modes and later adapter releases: validate real provider behavior, cancellation during tool work, approvals, limits/errors, and resume. Fixture/demo tests do not replace these checks.
10. Activation/retention/seat operations: no duplicate counting after retry; solo tasks and signup-only accounts do not qualify; task content never enters analytics.

Use one primary product acceptance seam: installed desktop and browser clients talking through the collaboration service to an execution host. The existing multi-user protocol and browser scenarios are the starting point. Keep adapter fixtures, crypto-stack conformance checks, and state-machine unit tests underneath this seam for failures that cannot be diagnosed reliably through the full product. Do not create a parallel test architecture per feature.

11. Catch-up and help: after an unfamiliar participant joins, the objective, sourced decisions, current plan, diff, and blocker are navigable; stale state is labeled. Sending a human help request creates no provider input. Only an explicit send-to-agent action reaches the provider.
12. Task links and outcomes: a copied private link does not bypass membership or key verification; associated issue/PR URLs round-trip encrypted. Creating an association never posts content or comments to an external tracker automatically.
13. Onboarding stages: the installed app can complete useful solo work before an invite; setup failures, supported-but-rejected actions, and successful provider delivery are recorded distinctly without content-bearing telemetry.
14. Revocation/deletion: pending host acknowledgment is visible, no stale control is accepted after the host applies a new membership epoch, and task/project deletion follows the documented live-storage/backup policy.

These tests are implementation work, not a customer-interview gate. No green test result, completed security review, or production readiness is claimed by publication of the spec.

## Out of Scope

- Replacing Git, building a full editor, or implementing a general team chat system.
- Adopting arbitrary already-running native IDE/CLI sessions.
- Automatic execution migration, cloud execution, or seamless cross-provider session transfer.
- Incident-response or production-operations positioning for the first release.
- Public task links, self-hosting, enterprise SSO, custom enterprise roles, and broad compliance certifications.
- Automatic operator recovery of encrypted content or pooled personal provider credentials.
- Universal collision prevention, semantic merge guarantees, and a full billing automation system.
- Three-provider parity as a prerequisite for the first Codex pilot.

## Further Notes

The target is 50 activated individual users and three paying teams before the YC Winter submission window, not an adoption forecast or a YC eligibility condition. Founder capacity varies; scope priorities and release gates are firmer than the proposed calendar. Seat price remains intentionally open.

The founder has chosen to build now without interviews. Industry research supplies context and hypotheses, not a required discovery process. Observe actual usage after release through the specified content-free measurements; do not manufacture interventions to hit activation targets.

The earlier 24-ticket breakdown is a sequencing aid, not a second specification. Preserve its stable story references where possible, but use this spec for catch-up/help/link requirements and removal of interview prerequisites. Publish child implementation issues separately when splitting the work; this parent spec is ready for agent execution beginning with the technical foundation gates.

Seat price, named founder assignments, and exact account provisioning costs remain deferred operational decisions. They do not block implementation. A failed technical gate must result in a concrete implementation alternative or a narrowly stated blocker, not a renewed product interview.
