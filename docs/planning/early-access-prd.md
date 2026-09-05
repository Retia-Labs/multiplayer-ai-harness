# Multiplayer AI Harness — early-access PRD

Superseded by [the implementation spec](product-spec.md). This draft remains historical context; use the spec's requirements and technical gates. Interviews are not a prerequisite.

Status: draft for founder review, 2026-09-05. Product choices reflect discovery; proposed engineering details and validation gates require review. No implementation or integration validation has been completed as part of this planning work.

## Problem Statement

Small startup teams increasingly delegate substantial development work to coding agents. When another teammate needs to correct an assumption, help with a decision, or take responsibility, they must reconstruct the work from messages, local sessions, and code changes. Version history does not preserve the complete live collaboration experience. The team needs shared context and meaningful control over ongoing agent work.

## Solution

Packaged macOS and Windows desktop applications start and supervise collaborative coding-agent tasks on a user's execution host. Authorized teammates join through desktop or web, understand the current work, send attributed instructions, interrupt, resolve explicitly delegated approvals, and hand off responsibility while retaining context. Closing the desktop window keeps the execution host running in the tray/menu bar; explicitly quitting explains that its tasks will become unavailable.

Launch with Codex and add Claude Code and Cursor in quick succession through separately verified adapters. Customers bring their own supported subscription or API relationship. Charge individual seats for collaboration, with provider usage billed separately; seat price is intentionally deferred.

The hosted synchronization service relays end-to-end encrypted collaboration content. Only authorized endpoints can decrypt it. Recovery uses authorized devices/teammates or a customer-held recovery key; the operator cannot recover content. The selected inference provider still receives the inputs required to execute the task.

The first demonstrated workflow is a teammate joining a feature task, correcting a wrong assumption, observing the resulting change, and taking responsibility if needed. Initial distribution is the founders' own team, 3–5 assisted startup pilots, and broader invite-only access including Singapore hackathons.

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
16. As a teammate, I want competing approval responses to produce one authoritative outcome so that an action does not execute twice.
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

## Implementation Decisions

### Accepted product boundaries

- Product-started tasks, with one visible execution host per task. Responsibility handoff does not migrate execution or credentials.
- Shared participation with ordered, attributed instructions and explicit interruption; approval authority is separately delegated.
- Private invite-only teams with explicitly shared projects; no public task links for early access.
- Packaged macOS and Windows execution clients plus web collaboration; Windows browser support alone is insufficient.
- Codex first; Claude Code and Cursor follow as separate releases. No claim of three-provider behavioral parity.
- E2EE and customer-controlled recovery are early-access requirements, not post-launch upgrades.
- Window close retains the background runtime; explicit quit ends host availability with clear notice.

### Proposed engineering approach — validate before external release

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

The proposed test seams and release gates are part of the founder's build-plan review. No green test result is claimed by this document.

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

The product decision record, provider research, E2EE feasibility findings, delivery plan, and proposed tickets accompany this PRD. The build-plan review confirms shared understanding, testing seams, and ticket granularity before publishing implementation issues.
