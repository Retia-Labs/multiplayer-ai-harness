# Build plan: Codex-first multiplayer early access

Superseded for implementation by [the product spec](product-spec.md). This document preserves earlier scheduling context. The founder subsequently instructed building without interviews or a ten-day market-validation gate; the spec is authoritative where requirements or sequencing differ.

**Status: draft for one founder review.** Prepared 2026-09-05. This is the proposed delivery plan from the completed discovery session, not a claim that the product is release-ready or that the calendar is a committed estimate.

## Outcome

Deliver packaged macOS and Windows apps, plus browser collaboration, for small startup teams to join, correct, approve, and hand over ongoing agent work with its context intact. Launch with Codex and bring-your-own-provider authentication; introduce Claude Code and Cursor in quick succession through validated integrations.

Target **50 activated individual users and three paying teams** before the YC Winter submission deadline. Charge individual seats, with price decided later and provider usage paid separately. Start with our own team, personally onboard 3–5 external teams, then expand invite-only access including Singapore hackathons.

## Accepted scope

| Area | Decision |
|---|---|
| Primary customer | Small startup engineering teams doing everyday development |
| First workflow | Alice starts a feature task; Bob joins, corrects an assumption, reviews the change, and can take responsibility |
| Where work starts | Through our product; arbitrary existing IDE/CLI session adoption is deferred |
| Execution | One visible local execution host per task; responsibility handoff keeps that host |
| Control | Authorized collaborators can observe, steer, and interrupt; approvals are separately delegated |
| Access | Private invited teams and explicitly shared projects; no public task links |
| Platforms | Packaged macOS and Windows execution apps and a web participation client |
| Lifecycle | Window close keeps the host running in the tray/menu bar; explicit quit explains the effect and ends host availability |
| Privacy | E2EE shared content; customer-controlled device/team/recovery-key restoration; no operator content recovery |
| Provider order | Codex first; Claude Code and Cursor follow in quick succession, each with explicit capability/authentication validation |
| Commercial model | Individual seats; subscription or API provider authentication where supported and permitted; no assumed pooled credentials |
| Launch method | Own team → assisted external pilots → broader invite-only access |

## Delivery strategy

The first release is one complete collaborative workflow. It does not need a full editor, Git replacement, public sharing, cloud workers, cross-machine migration, or automated billing. These are the scope buffers if capacity gets tight. The accepted privacy, installed-platform, permission, and recovery requirements are not buffers to remove silently.

**Critical path:** prove Codex and encryption → authenticated host/project setup → encrypted real task and teammate enrollment → steering/approvals → recovery and installed-platform reliability → reviewed external release → assisted pilots.

Three facts make this more than a UI packaging exercise:

1. The existing Codex adapter wraps noninteractive execution and does not implement the documented interactive control surface.
2. E2EE requires moving content-derived hub features to authorized endpoints and establishing device verification, recovery, revocation, and authenticated control.
3. The desktop shell is development-only; it needs installable delivery, managed runtime startup, platform-aware execution, and clean-machine verification.

Do the integration and encryption experiments first. If a core interface, authentication arrangement, or encryption approach fails, produce a concrete alternative before building dependent work. No research report in this repository substitutes for these experiments.

## Proposed calendar and gates

Dates are planning checkpoints for the roughly eight-week window, not effort estimates. Three founders have variable availability; review actual throughput at every checkpoint and reforecast. Multiple lanes can progress when people are available, but no calendar promise assumes full-time work.

| Target checkpoint | Observable result | Gate / proposed tickets |
|---|---|---|
| **Sep 11 — feasibility review** | Real Codex control experiment; encrypted enrollment/recovery experiment; desktop bootstrap artifacts; clear support/authentication matrix | T01–T04 underway, with T01/T02 decisions resolved or explicitly escalated |
| **Sep 20 — own-team workflow** | Two founders use real Codex: late join, correction, delegated approval, diff review, handoff, and window-close continuity | T05–T10 and T13; internal use while hardening continues |
| **Oct 4 — assisted external pilot** | Clean-machine installs on both platforms; encrypted recovery/revocation; reconnect reliability; reviewed permissions/privacy; content-free activation measurement | T11–T16 and T18; T17 enables paid-seat operations |
| **Oct 5–18 — repeat use and provider succession** | Personally onboard 3–5 teams; repair observed friction; run Claude/Cursor proofs and release each when it passes shared gates | T19–T23; provider proofs can start earlier once the contract is stable |
| **Oct 19–26 — controlled expansion and evidence** | Broader invite-only distribution; track real activation, repeat teams, and paid conversion; stabilize the demo | T19 and T24 |
| **Oct 30 — internal submission target** | Founder-reviewed application, founder video, real-product demo, and honest metrics | T24; finish ahead of the external deadline |

YC's published Winter 2027 deadline is **November 2, 2026, 8 p.m. Pacific / November 3, noon Singapore time**. Verify it and the actual application fields again before submission. [YC application page](https://www.ycombinator.com/apply)

If the Oct 4 external gate slips, reduce invitation volume and defer optional features/follow-on releases as explicitly agreed; do not label incomplete encryption, unsupported Windows execution, or demo-only approvals ready. Missing an adoption target should not cause a missed application: YC accepts idea-stage companies. [YC FAQ](https://www.ycombinator.com/faq)

## Three ownership lanes

These are proposed responsibilities, not assignments to named founders. Each founder can take a lane based on skills and actual availability; keep one implementation slice in progress per person and hand over using the issue's acceptance evidence.

| Lane | Owns | First useful work | Later responsibility |
|---|---|---|---|
| **Runtime and providers** | Real agent behavior, permission enforcement, control ordering, recovery | T01 Codex experiment | T06, T08, T09, T12; Claude/Cursor proofs and releases |
| **Collaboration and encryption** | Identity, enrolled endpoints, encrypted history, authorization grants, key recovery | T02 encryption experiment and T04 private pairing | T05, T07, T11; threat model and implementation review |
| **Desktop and pilot experience** | Installers, native lifecycle, onboarding, changes/handoff experience, measurement | T03 desktop bootstrap | T10, T13–T17; coordinate T18 installed release gate |

One founder must also coordinate pilot recruitment, interviews, paid offers, and the YC package. This is real work within the available capacity, not a fourth full-time role. Begin recruiting and drafting the application while engineering proceeds. Use assisted onboarding observations to choose fixes; do not occupy all three founders exclusively with adapters until the final week.

Start signing/notarization account provisioning and access to clean macOS/Windows test machines immediately alongside desktop bootstrap work. They are external prerequisites for T15, even though the full release ticket completes later. Establish a hosted-service budget and security-review owner early; amounts and actual spending require a separate operational decision, not an invented planning assumption.

## Architecture and privacy boundary

The packaged desktop owns the execution runtime and provider relationship. Desktop and browser participants send authenticated encrypted commands through the hosted relay. The execution host validates current rights, targets the correct task/turn, serializes accepted control, and publishes encrypted results. The relay routes and persists ciphertext and a deliberately limited metadata set.

Encrypted content includes project/task names, repository details, prompts, messages, tool arguments/results, diffs, handoff notes, and content-derived activity. The exact remaining identity, membership, routing, size/timing, billing, and opt-in measurement metadata must be documented and minimized. Decrypting endpoints compute content-dependent views; the existing plaintext collision/activity logic cannot stay at the relay unchanged.

E2EE protects content from the synchronization service's data access. Authorized endpoints, the selected inference provider, and holders of customer recovery material have defined access. Browser participation trusts the browser application's delivered code; desktop users likewise trust the publisher and update pipeline. Non-extractable browser keys do not eliminate malicious-origin-code risk. Avoid a blanket claim that the publisher could never obtain content through compromised or malicious client code. [W3C Web Crypto security considerations](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/#security-considerations)

Select an established encryption stack through T02, rather than inventing group key exchange. Recovery restores a defined history/enrollment scope without reinstating expired execution privileges. Revoking an endpoint excludes it from future content/control; it cannot erase plaintext previously read. Complete an independent implementation/threat-model review before the external privacy claim; describe the actual review scope rather than asserting a certification.

## Release gates

**Codex external release:** both installed platforms and web pass the same two-human feature-correction workflow; supported authentication is verified; project/host access and delegated approvals reject unauthorized requests; recovery, revocation, reconnect, background lifecycle, and update behavior are proven; encrypted content is absent from relay/log/analytics inspection; known limitations are visible in onboarding.

**Each follow-on provider:** a real integration, advertised OS/authentication matrix, honest input-delivery states, interruption and approval behavior, and supported resume pass the shared workflow. Use common controls only where semantics truly match. Unsupported required behavior returns a scope decision, not a misleading enabled button.

**Expanded invitations:** assisted pilots can install and complete useful work, defects affecting the core promises are addressed, and a founder can support the next cohort. Success is repeat use and teammate intervention, not just a successful staged demo.

## Measurement and revenue

| Measure | Definition / treatment |
|---|---|
| Signup | Account created; not activation |
| Activated individual | A distinct person with authenticated participation in a real task involving at least two people and a teammate intervention delivered to the agent; proposed qualifying participation is starting the task or sending an accepted control/approval action |
| Collaborative task completed | A qualifying shared task with an explicit completion/outcome; record separately from activation |
| Returning team | A team with another qualifying collaborative task in a subsequent week; report cohort dates and counts |
| Paying team | A team with a current paid collaboration-seat purchase; separate paid invoices from trials, promises, and unpaid invoices |
| Target | 50 activated individuals and three paying teams; report actuals honestly even if lower |

Implementation must distinguish client submission from confirmed agent delivery and deduplicate retries. Use minimal disclosed metadata; do not inspect customer transcripts at the server to compute metrics. Seat price remains deferred. Manually recorded individual entitlements and founder-operated pilot billing are sufficient initially; decide price before making paid offers.

## YC preparation in parallel

Start the problem, team, and product narrative now. As pilots progress, record concrete intervention examples, returning-team behavior, actual paid conversion, and what changed because of feedback. Obtain permission for any customer material used in the application or demo.

The founder video is one minute with all founders introducing themselves and explaining what they are building and why. Product demonstration is separate. [YC video instructions](https://www.ycombinator.com/video)

Use a real Codex session for the demo: Alice's agent makes an incorrect assumption, Bob joins from another client, corrects it, resolves a delegated action where needed, sees the changed diff, and takes responsibility while the host remains clear. Keep a stable test repository and a reproducible scenario. Do not represent fixture-provider output as a live provider integration.

## First execution batch after review

1. **T01:** prove real Codex control and supported authentication.
2. **T02:** prove encrypted endpoint enrollment, authenticated control, and customer recovery.
3. **T03:** produce installed desktop bootstrap builds for both platforms; begin distribution prerequisites.
4. **T04:** implement private team/project setup and explicit execution-host pairing when the collaboration lane has capacity.

In parallel, the pilot lead recruits candidate teams and prepares T24's application outline. Once the first experiments resolve, publish/claim the next unblocked slices. Every completed slice supplies a demo or test artifact so another founder or agent can continue from the issue without this conversation.

## Documents and review

- [PRD and user stories](early-access-prd.md)
- [24 proposed tickets with dependencies and acceptance criteria](implementation-tickets.md)
- [Discovery decisions](product-discovery.md)
- [Shared-control research](shared-control-research.md)
- [Codex integration research](codex-collaboration-research.md)
- [Claude/Cursor research](claude-cursor-collaboration-research.md)
- [E2EE feasibility and sources](e2ee-feasibility-research.md)

One review should confirm the scope and privacy boundary, the observable test seams, ticket granularity/dependencies, and HITL versus AFK classification. After acceptance, publish the PRD and tickets to GitHub in dependency order with native blocking links where available. Deferred price and operational spend do not require another discovery interview. Provider, encryption, and OS feasibility experiments remain explicit work, not silently accepted technical facts.
