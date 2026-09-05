# Competitive landscape assessment

Checked 2026-09-05 against [the draft build plan](build-plan.md). Primary-source desk research only: no accounts created, software installed, sessions tested or security audits performed. A working documentation page or download link is evidence of a published offering, not proof of production reliability. Unless a date is stated below, the vendor page exposes no clear publication date; the date above is the access date. No adoption, revenue or customer-retention figures are inferred from marketing, logos, repository stars or release counts.

## Assessment

**Inference:** the opportunity is crowded at the exact feature level, not merely adjacent to AI editors. Shared live agent work, local execution, existing provider subscriptions, teammate intervention and context handoff are already marketed together. The draft remains a plausible implementation plan, but its broad feature bundle is not a sufficient differentiation thesis.

**Inference:** the strongest candidate distinction is a particularly reliable, low-friction workflow for authorized teammates to correct and approve the same local agent, with encrypted shared history and explicit customer recovery. That combination is a hypothesis to validate against the products below, not a verified unoccupied market. E2EE and multiple providers individually already appear in alternatives.

## Five strongest commercial overlaps

### 1. Amoeba — closest published desktop product specification

Its installation docs describe signed macOS Apple Silicon and Windows x64 builds, local Codex/Claude execution under each member's existing account, and live shared sessions. The dated changelog reports v0.1.26 on August 30, 2026 and specific installer, streaming and collaboration fixes during August. This is stronger evidence than a landing page alone, although the software was not tested. [Install docs](https://useamoeba.com/docs), [changelog](https://useamoeba.com/changelog)

The control model is meaningfully different from ours: people have separate lanes; only a turn's owner steers it. Taking over checkpoints work and starts a new turn under the taker's account. Its docs promise a single winner for competing takeovers and show last-synced context age. These are vendor-documented behaviors, not independently verified guarantees. [Agent/control docs](https://useamoeba.com/docs/agents/providers)

Its security page documents local execution, git-mediated code synchronization, workspace permissions and transcripts encrypted at rest. It does **not** establish our proposed E2EE relay-content boundary. Current early access is free; flat team pricing, enterprise SSO and self-hosting are future plans without published prices. [Security](https://useamoeba.com/docs/admin/members), [pricing](https://useamoeba.com/pricing)

**Inference:** local execution, BYOP, packaged platforms, handoff and shared context cannot be presented as uniquely ours. Same-host delegated control rather than account-changing takeover, browser participation and independently reviewed E2EE may differentiate—but need comparative testing and a paying customer reason.

### 2. HumanLayer — direct workstation/cloud collaboration platform

HumanLayer advertises a multiplayer agent workspace combining sessions, artifacts, worktrees and reviews, supporting existing Claude/Codex subscriptions or keys and local/remote execution. Its site lists Starter free for up to three people and 200 sessions/month, and Pro at $100/user/month. The page explicitly says the full product is not yet open source; do not confuse its open-source workflow framework with the whole platform. [Product and pricing](https://www.humanlayer.dev/)

Operational documentation explains installing and authenticating a daemon, connecting it to the web app, and sending agent messages from another machine or phone. It also documents process-lifetime versus persisted login credentials and keeping remote daemons alive. These are concrete implementation-facing docs. The examined pages do not establish separately delegated same-action approval semantics or E2EE against HumanLayer's service. [Remote daemon guide](https://docs.humanlayer.com/guide/remote-daemons)

**Inference:** local daemon plus hosted sync, web control, BYOP and contextual team review are directly contested. A three-founder team can compare against a free incumbent offering; price savings alone are weak until a user exceeds free limits.

### 3. Superconductor — explicit same-session team steering, in cloud environments

Its product page explicitly invites teammates to join a run, take control, steer together and ask the agent questions during review. Operational docs describe shared agent chats and cloud implementations, with provider pages for Codex, Claude, Cursor and others. This is direct same-agent collaboration positioning, not only independent agents on a board. [Product](https://www.superconductor.com/), [documentation](https://www.superconductor.com/docs/)

Published pricing is compute-based: Free lists four members and 32 sandbox-hours/month; the displayed Pro tier is $128/month with up to 32 members. Its dynamic Pro hour selector was not fully exposed in the fetched page, so no included Pro-hour figure is asserted. It supports existing subscriptions/API keys; cloud credentials, sandboxing and role controls are documented, not relay-blind E2EE. Enterprise private infrastructure is listed. [Pricing and security FAQ](https://www.superconductor.com/pricing)

**Inference:** simultaneous steering, multi-provider choice and team review are already a marketed product. Our local-host/E2EE arrangement may matter to teams unwilling to move execution to vendor cloud, but loses always-on cloud convenience.

### 4. AQ — revocable control of the same terminal on dedicated infrastructure

AQ describes live agent terminals in which owners grant a teammate keyboard access and revoke it; owners retain input. Tasks use worktrees and persistent tmux on VMs, with Claude/Codex/Cursor and other CLIs using users' own accounts. It supports customer cloud or AQ-managed dedicated machines, accessed through browser/mobile; this is not packaged native Windows execution. Team is advertised at $50/user/month during early access, with personally reviewed access requests. The page describes code and CLI credentials staying on the VM, while model providers still receive inference context. It does not establish E2EE from collaborators through the control service. [AQ product, workflow and pricing FAQ](https://aq.dev/)

**Inference:** the control-grant workflow itself is not novel. Our potential distinction is action-specific delegated permissions and usable local execution with protected history; a shared terminal may already be sufficient for some buyers.

### 5. Flowpad — live context and expert intervention, with important documentation ambiguity

The site pitches adding teammates or experts to Claude Code/Codex sessions, sharing branch/files/history/tool calls, and carrying fixes into shared skills. Its repository provides desktop download links for macOS, Windows and Linux and documents a local server. The repository README focuses on Claude-powered local workflows rather than fully specifying multiplayer permissions. [Product](https://flowpad.ai/), [repository README](https://github.com/langware-labs/flowpad)

The pricing page still marks Team as coming soon, with individual use free and enterprise custom. Its privacy page offers file/git/on-prem/hosted-cloud modes; hosted mode carries content through GCP. This is not a blanket E2EE promise. SOC 2 claims are vendor statements; no audit report was inspected. Its site calls it open source, while the inspected README's license section says all rights reserved; reuse rights were not established. [Pricing](https://flowpad.ai/pricing), [data architecture](https://flowpad.ai/your-data)

**Inference:** treat this as a concrete distribution and positioning competitor, but do not assert the entire advertised team offering is generally available or production-proven. Its ability to preserve existing CLI workflows pressures our requirement to start work through a new app.

## Privacy and open-source counterexamples

**claude-duet:** its MIT repository documents two people interacting with one host-side Claude session, prompt approval by the host, continuing prior context, and E2EE over P2P/WebRTC. It separates ordinary human chat from explicit agent prompts. This is a direct counterexample to claiming that local shared-agent execution plus E2EE is new. It is a terminal-oriented Claude-only project; durable team membership, browser recovery and our separately delegated tool approvals are not established by its README. No execution/security validation was performed. [Repository](https://github.com/EliranG/claude-duet)

**session-multiplayer:** its MIT v0.3.0 README documents E2EE P2P messaging among separate Claude, Codex and other MCP sessions. Codex receives an inbox to poll; this is not shared control of a single running agent. It explicitly discloses permanent unrevocable room keys and lack of forward secrecy. This contests broad E2EE/multi-harness coordination claims while leaving room for a stronger membership/control/recovery product. [Repository and limitations](https://github.com/wybe-labs/session-multiplayer)

## Incumbent substitutes

- **Replit:** documented team threads, isolated task copies, a shared board, and anyone reviewing/applying ready work. This can satisfy parallel teamwork without one shared running agent. The cited docs do not establish our local/BYOP/E2EE combination. [Team workflow](https://docs.replit.com/build/invite-teammates)
- **Devin:** documents human takeover through the IDE and team sessions; current Teams billing has an $80/month minimum, with $40 full seats and free flex seats using shared on-demand credits. Its own agent product is not equivalent to a neutral local harness. [Introduction](https://docs.devin.ai/get-started/devin-intro), [billing](https://docs.devin.ai/admin/billing/self-serve), [current pricing](https://devin.ai/pricing)
- **Zed:** already combines live shared projects with external-agent choices. The examined collaboration docs do not establish multi-human steering/approval of the same live agent. Personal is free with external agents; Business is $30/seat/month. Its privacy/admin story still competes for this budget even without exact control parity. [Collaboration](https://zed.dev/docs/collaboration/channels), [pricing](https://zed.dev/pricing), [external agents](https://zed.dev/docs/ai/external-agents)

## Implications for the draft — inference, not approved changes

1. Keep the exact two-human correction/approval workflow as the pilot test, but compare it with Amoeba, HumanLayer and one cloud alternative using the same task. Measure time to useful intervention, setup friction, context lost, and successful return the following week.
2. Ask potential paying teams why existing options fail for them. A credible wedge might be local-only execution requirements plus private shared context and fine-grained delegation. It is not validated merely because competitor docs omit one feature.
3. Do not expand into a full editor, shared brain or cloud execution to chase their matrices. The accepted plan already has substantial platform and encryption work; comparative usability evidence is more valuable than more checkboxes.
4. Test the seat charge against occasional reviewers. Free small-team tiers and compute-based alternatives may make charging every viewer unattractive. This challenges the commercial hypothesis; it does not silently change the accepted individual-seat model.
5. E2EE is a potential purchase criterion and a delivery cost, not a moat by itself. A defensible advantage would need repeat team use, unusually reliable control/recovery, trusted implementation, strong integration maintenance and distribution into a specific customer segment. None is established yet.
6. Avoid claims such as first multiplayer agent workspace, no existing tool carries context between people, only product with BYOP, or uniquely encrypted collaboration. A supportable early statement is the precise workflow and trust boundary we actually deliver.

**Inference:** proceed with a differentiated pilot and comparative tests, not a uniqueness-based launch narrative. The evidence supports that vendors are building for this problem; it does not prove unsatisfied demand, willingness to pay, a large market for this particular boundary, or competitors' execution quality.
