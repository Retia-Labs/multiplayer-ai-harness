# Product discovery

Status: discovery complete and superseded for implementation by [the product spec](product-spec.md). This remains the decision history and research context.

The implementation spec is published as [GitHub issue #1](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/1), labeled `ready-for-agent`.

## Founder inputs — 2026-09-05

- Thesis: longer-running coding agents create a need for teammates to share control, steer ongoing work, and carry context across participants. Git alone does not provide that collaboration experience.
- Primary early-access use: everyday development for small startup teams. Hackathons remain an acquisition channel; incident response is a candidate future use, not the selected first workflow.
- Initial distribution: the founders' own team, startup engineering pilots, and free access through sponsored tracks at small Singapore hackathons.
- Target: 50 activated individual users within approximately 60 days, with a hoped-for three paying teams. Activation is defined below.
- Capacity: three cofounders with variable time commitments, reaffirmed by the founder. Do not assume fixed weekly hours; propose ordered milestones and dependencies. Responsibilities and budget remain unresolved.
- Provider release order: launch with Codex, then add Claude Code and Cursor in quick succession. The order between the latter two and concrete delivery dates are not yet specified; each integration needs its own behavior and authentication validation.
- Business model constraint: bring your own provider, accepting supported subscription or API authentication. Provider usage belongs to the customer's provider relationship; technical login support alone does not establish permission to share credentials or entitlements.
- Accepted shared-control model: authorized collaborators submit ordered, attributed input; interruption is explicit; approvals require separately granted permission and resolve once. Closing the initiating browser does not stop work while the execution host stays online. Responsibility handoff preserves the execution host; automatic execution migration is deferred.
- Tasks start through this product. Taking over an already-running native editor/CLI session is outside the first release.
- Required launch surfaces: packaged macOS and Windows desktop apps, plus web access. A browser interface with only a separately installed runner does not meet the founder's desktop requirement.
- First pilot workflow: a teammate joins a long-running feature task, catches a wrong assumption, redirects the agent, and can take over responsibility with the same shared context.
- Desktop lifecycle: closing the window keeps ongoing work running in the tray/menu bar. Explicit quit explains that this host's tasks become unavailable. Detailed quit confirmation and interrupted-task recovery remain to be specified.
- Privacy requirement: end-to-end encryption for shared content; the synchronization service cannot recover plaintext. Restore access through authorized devices/teammates or a customer-held recovery key; loss of all recovery methods means loss of access to encrypted history. The selected AI provider still receives task inputs. Exact cryptographic design and necessary metadata boundary require validation. Do not equate TLS or server-side encryption with E2EE.
- Access model: private invite-only teams, explicitly shared projects; invited project collaborators can observe, steer, and interrupt. Only the execution-host owner and explicitly delegated approvers can authorize pending actions. No public task links initially.
- Pricing unit: individual seats, with provider usage billed separately. The founder explicitly deferred choosing the pilot seat price; this does not block implementation planning.
- Activation: count users after participation in a real collaborative task with at least two humans and a teammate intervention delivered to the agent. Track task completion, teams returning the following week, and three paying teams separately.
- Rollout: founders' own team, then 3–5 personally onboarded external pilot teams, then broader invite-only access toward the activation target.
- Latest instruction: proceed to an implementation specification without user interviews or a ten-day customer-validation prerequisite. Preserve technical feasibility and external-release gates; learn from disclosed content-free usage after release. Seat price remains deferred.

## External milestone

YC Winter 2027's published application deadline is November 2, 2026 at 8 p.m. Pacific (November 3 at noon Singapore time). Source: https://www.ycombinator.com/apply (checked 2026-09-05).

The customer target is the founders' product milestone, not a YC eligibility requirement. YC accepts idea-stage applications: https://www.ycombinator.com/faq.

## Repository baseline

Read-only code inspection; tests have not been executed during discovery.

- Existing code implements shared event streams, presence, attributed steering and approvals, file-change review, worktrees, assignment, and demo-provider collaboration tests.
- Identity, organization boundaries, runtime pairing, and execution permissions need work before access by untrusted users.
- The Claude Code adapter is not correctly dispatched by the session loop. Codex CLI does not implement the harness's shared approval and live-steering behavior. One real provider path needs end-to-end validation.
- Reconnect, pending approvals, and restart recovery have durability gaps.
- Current handoff changes assignment; it does not move execution to another teammate's machine.
- File diffs and command output are sent to the hub. The README's claim that code never leaves the machine is too broad.
- Collision checks do not cover arbitrary shell or CLI writes. They must not be described as universal conflict prevention.
- Desktop is a development shell with no installer/signing/release configuration. It launches external Node, needs product onboarding and runtime pairing, and currently skips starting a local runtime when configured for a remote hub.
- Windows execution needs platform-specific work: `/bin/bash` execution, `which` discovery, and colon-delimited project paths do not support normal native Windows use as written. Installed-app validation on both target operating systems is required.
- Desktop close currently kills child services. Window close, explicit app quit, background execution, and host-disconnect behavior must be defined separately.

## Draft and validation work

- Discovery round complete. Use the canonical product spec for execution. The founder requested immediate specification/publication without another interview; seat pricing is deliberately deferred.
- Draft must propose implementation details and release gates for E2EE/device enrollment, provider authentication, recovery, onboarding, Windows/macOS distribution, telemetry, and follow-on providers. Mark unresolved technical feasibility as explicit validation work rather than silently assuming support.
- Planning must accommodate variable founder capacity; propose ownership lanes and cost assumptions for review rather than treating them as confirmed commitments.

## Research completed

- [Shared control](shared-control-research.md): the founder accepted the core shared-control recommendation; remaining permission and recovery details still require resolution.
- [Codex](codex-collaboration-research.md): app-server provides a richer control surface than this repo's exec adapter. Experimental-status and exact-version behavior require validation.
- [Claude and Cursor](claude-cursor-collaboration-research.md): Claude SDK and Cursor ACP/SDK expose useful controls, with materially different steering, approval, and authentication behavior. Do not promise equivalent behavior or pooled personal subscriptions.
- The founder accepted sessions started through this product and execution remaining on the original host; native-session adoption and automatic migration are deferred.
- Documentation research establishes candidate integration surfaces, not a tested release. One real-provider, two-human integration experiment should precede a multi-provider launch commitment.
