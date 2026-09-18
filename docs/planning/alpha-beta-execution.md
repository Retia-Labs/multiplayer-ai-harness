# Alpha and beta execution

## Hosted alpha execution plan — clarified 2026-09-18

The approved experience centers on projects, a shared task feed and adjacent results, taking interaction inspiration from Mutex while preserving Plexus identity, the shared renderer, encryption, local provider credentials, host authority and separately delegated approvals. General team chat, automatic Git synchronization/push, preview orchestration and project-wide scheduling remain outside this change.

The founder uses **alpha** to mean a complete hosted product for invited users at `https://app.tryplexus.dev`: verified account sign-in, desktop download/authorization, team invitations, guided project/provider setup and the working collaboration journey. A localhost demo or a successful installer smoke test is not alpha readiness.

The earlier “Internal alpha” milestone (#69) is an **engineering qualification**: macOS + Codex + a browser teammate on two physical machines. Its evidence remains required, but does not authorize external distribution. Hosting account, DNS configuration, GitHub OAuth application credentials and signing credentials must be arranged; as of 2026-09-19 a dedicated DigitalOcean server is provisioned and DNS/HTTPS are verified; OAuth credential installation, live sign-in and full service qualification remain pending.

The customer-facing alpha retains the existing external-release gates: macOS and Windows qualification, signed installers and upgrades, supported provider/authentication evidence, independent privacy/control review, hosted-service restore, recovery/revocation/deletion, onboarding/support and content-free measurement. Renaming the milestone does not waive these gates. Paid seats are required before charging; free internal use is independent. Claude Code and Cursor remain follow-on releases.

Execution order: implement verified browser/desktop account authentication (#75); complete the hosted download/invitation/onboarding path (#76); deploy and qualify the service (#70); exercise the same release artifact with real accounts, provider usage and separate machines (#69); pass trusted distribution/platform/review gates (#19/#20/#25); begin invited alpha use. Workspace slices #65–#68 and earlier PR reconciliation are complete. Closed foundation issues #2–#18 retain their evidence; new defects receive linked follow-ups.

### Implementation slices

- [#75 — Authenticate hosted browser and desktop accounts](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/75)
- [#76 — Complete hosted sign-in, desktop download and teammate onboarding](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/76)

- [A01 / #65 — Open a project and start useful work from one workspace](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/65)
- [A02 / #66 — Complete first-run project and Codex setup through the app](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/66)
- [A03 / #67 — Join and correct an ongoing task from the project workspace](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/67)
- [A04 / #68 — Resolve an approval and review the result in context](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/68)
- [A05 / #69 — Qualify the internal alpha on two separate machines](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/69)
- [B01 / #70 — Qualify the hosted collaboration service for pilots](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/70)

## Evidence and operating rules

Read native GitHub blockers before claiming work. Readiness labels describe work type, not dependency completion. Reconcile PR #64 before editing overlapping onboarding, deletion or measurement modules. Record exact commits and artifacts for qualification; historical local results do not establish a new build passed.

## Identity and deployment boundary

GitHub sign-in is the initial account-authentication direction, using a stable provider account ID and minimal identity scopes. Repository authorization and provider billing are separate. Do not infer account identity from a display name or merge existing accounts by an unverified email. Use short-lived, revocable sessions and a system-browser desktop authorization exchange; production must reject local/demo name-based authentication across HTTP and WebSocket paths.

Signing in proves account ownership. It does not grant encrypted history, enroll a browser device, authorize a local folder, appoint a host approver or recover encrypted content. Existing explicit cryptographic/host authorization remains required.

Prepare one service origin (`app.tryplexus.dev`) with HTTPS/WSS, persistent SQLite storage for the current single-instance architecture, managed process restart, content-safe health checks and the existing deletion-aware backup/restore tooling. The user selected and approved DigitalOcean hosting: a separate Singapore Droplet with 1 vCPU, 1 GB RAM and 25 GB persistent disk at US$6/month before tax and additional usage. Source revision `db32f80` is installed; Caddy and Cloudflare DNS provide verified HTTPS at `app.tryplexus.dev`. The relay remains stopped pending GitHub OAuth credentials. See the [deployment configuration and qualification steps](../operations/hosted-alpha.md). Service restarts interrupt connections and require tested reconnect. Persistent storage does not replace deletion/revocation-preserving backup and restore. No customer-ready claim follows from infrastructure provisioning alone.

## Mutex comparison

The [reference README](https://github.com/lavanyagarg112/mutex-astra-hackathon) describes GitHub login, companion authorization, repository setup, a Render deployment blueprint and downloadable installers. Those are the concrete product-completeness gaps driving #75/#76/#70. Reading the README does not independently verify its deployed behavior or establish feature parity.

Plexus retains encrypted shared context, local provider credentials, attributed steering and separate approval grants. Automatic Git synchronization/push, preview orchestration, project-wide scheduling and general chat remain outside the approved scope; they are not implied by similar onboarding and workspace usability.
