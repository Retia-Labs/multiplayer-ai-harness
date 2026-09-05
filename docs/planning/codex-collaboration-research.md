# Codex integration for multiplayer agent collaboration

Research date: 2026-09-05. Planning evidence, not an implementation or product decision. Official OpenAI documentation was checked alongside the current adapter. No live integration was tested.

## Current repository

[`packages/runtime/codex-exec.js`](../../packages/runtime/codex-exec.js) launches one `codex exec --json` process per turn, stores `codexSessionId`, and resumes it on later runs. It translates selected output events, supplies sandbox flags, and exposes the child process to the session. It does not implement bidirectional approval responses or mid-turn steering. Its hardcoded model list and `--full-auto` flag also need revisiting. These are limitations of this adapter, not evidence that Codex lacks interactive integration.

## Documented app-server capabilities

- Bidirectional JSON-RPC supports initialization, streaming items, and version-specific generated schemas.
- `thread/start`, `thread/read`, `thread/resume`, and `thread/fork` cover creation, inspection, continuation, and branching.
- `turn/start` begins work. `turn/steer` adds input during work, requires matching `expectedTurnId`, fails without an active turn, and cannot change turn settings. `turn/interrupt` requests cancellation; completion reports interruption.
- Command/file approvals are server requests. Respond by request ID; `serverRequest/resolved` clears pending UI. Permission requests also exist.
- Managed ChatGPT browser/device login and API-key login exist. Externally supplied ChatGPT tokens are experimental and require host-owned refresh. Account and rate-limit reads exist.
- Stdio is the default transport. Remote clients and remote Code Mode hosts are distinct connections; all threads in a process share its selected execution host.
- Current documentation explicitly marks the app-server command and WebSocket transport experimental and unsupported for production. Remote exposure requires authentication and TLS; non-loopback listeners otherwise allow unauthenticated connections by default.

Source: [Codex App Server](https://learn.chatgpt.com/docs/app-server).

## Authentication and subscription constraints

ChatGPT sign-in provides subscription access; API-key sign-in bills separately through the Platform account. Local Codex clients support both. Codex cloud requires ChatGPT authentication. Workspace permissions and administrator restrictions still apply. CLI credentials may reside in the operating-system store or a local file and are refreshed during use. Official guidance recommends API keys for programmatic CLI jobs; enterprise access tokens support trusted automation with workspace entitlements. [Authentication](https://learn.chatgpt.com/docs/auth)

These sources establish technical sign-in support. They do **not** establish a right for a commercial multiplayer service to pool accounts, transfer subscription entitlements, or allow arbitrary teammates to spend an owner's allowance. Keep that commercial/authorization question unresolved rather than treating successful authentication as proof. No assertion about a blanket prohibition is made either.

## CLI exec distinction

Official documentation positions `codex exec` for scripts and CI with preset permissions; JSONL events and saved authentication are supported. `--full-auto` is deprecated in favor of explicit sandbox settings. This stream is useful for job observation, but the existing adapter provides no request/response channel for the collaboration controls above. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

## Recommendation and acceptance experiment

Proposed architecture: keep a credential-owning runtime on the execution machine and let the collaboration hub authorize and order participant actions. Start with a stdio app-server adapter, pin the tested Codex version, and preserve provider thread IDs separately from shared product IDs. Do not expose the raw provider server to teammates.

Before committing launch scope, prove one shared session with two clients: join and reconstruct history; steer while running; reject stale steering; interrupt; resolve one approval exactly once; reconnect; resume after runtime restart. Record actor attribution and provider acknowledgement separately. Test permission rejection and account-limit failure, not only successful generation.

The hub still needs its own membership, controller/approval policy, replay, deduplication, and audit trail. Subscription ownership, execution-host availability after the owner disconnects, and experimental dependency tolerance remain explicit product decisions. A cloud-hosted worker would need a separate deployment and credential design; it is not implied by supporting a remote UI.
