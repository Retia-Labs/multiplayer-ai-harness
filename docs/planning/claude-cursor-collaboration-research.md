# Claude and Cursor collaboration integration research

Checked 2026-09-05 against first-party documentation. This is documentation research, not a tested integration or a legal opinion. “Unknown” means not established by the reviewed sources, not impossible.

## Recommendation

Build shared supervision around a runtime the product starts and owns. A server can authenticate teammates, serialize their commands, broadcast events, and route each approval to one authorized decision. This is an architectural inference from the interfaces below; neither provider supplies the application's multi-human authorization or conflict resolution.

Do not promise arbitrary takeover of an agent already running in someone's native IDE or terminal. Session resume is not necessarily attachment to that active process. Keep machine migration separate from changing the human controller.

For the first pilot, select one adapter through an integration spike. Claude Agent SDK streaming mode and Cursor ACP are credible candidates; Cursor is not limited to headless print mode. Do not commit to three-provider parity before testing the exact control path.

## Claude Agent SDK

- **Documented:** streaming input uses a persistent interactive process, queues messages sequentially, supports interruption and permission requests. Adding an instruction is not a guarantee it immediately supersedes current work; expose queued input separately from interrupt-and-redirect. Single-message mode lacks dynamic queuing and real-time interruption. [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- **Documented:** `canUseTool` handles approval and user-input requests, including modified tool input or denial. This gives an application a place to route a decision to a teammate. It does not establish every tool call will prompt regardless of permission configuration. [Approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- **Documented:** transcripts persist locally; `resume` selects an explicit session and `fork` creates a separate continuation. Sessions preserve conversation, not workspace files. Cross-host continuation can use an external session store or moved transcript files; workspace restoration remains separate. **Unknown:** adopting another live CLI process through these SDK calls. [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)

## Claude Code native Remote Control and authentication

- **Documented:** native Remote Control exposes a local session through Claude's web/mobile interfaces; the local process must remain running. Local process exit makes it offline; SSH sessions can be kept alive using a persistent terminal. **Unknown:** a supported third-party multi-user API for this native remote-control surface. This is not evidence of transferable execution. [Remote Control](https://code.claude.com/docs/en/remote-control)
- **Documented policy distinction:** SDK products should use API authentication; third-party Claude login/rate-limit offerings need prior approval. [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- **Documented policy nuance:** the legal page separately permits platforms to host an unmodified Claude Code binary with end-user authentication under stated conditions, including preserving its authentication methods and direct end-user billing. It prohibits collecting/intermediating Claude session credentials and routing user requests through Free/Pro/Max credentials. Customer-managed API keys for authorized users are distinguished from those restrictions. **Unresolved:** whether the proposed shared session, actor identities, and billing arrangement satisfies all conditions. Do not advertise pooling personal subscriptions across teammates. Confirm the exact intended commercial/authentication flow before promising subscription reuse. [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)

## Cursor CLI ACP

**Documented:** `agent acp` is a custom-client integration over JSON-RPC/stdio. It exposes `session/new`, `session/load`, `session/prompt`, streamed `session/update`, and `session/cancel`. Tool approvals use `session/request_permission` with allow-once, allow-always, or reject-once; unanswered requests can block. It also supplies blocking question and plan approval extensions. Login, API key, and auth-token paths are documented. Team-level dashboard MCP servers are unavailable in ACP. **Unknown:** whether a prompt during an active turn is accepted as immediate steering; the documented flow alone does not establish that. **Unknown:** loading an arbitrary running Cursor IDE conversation as the same live process. [Cursor ACP](https://cursor.com/docs/cli/acp)

## Cursor SDK and cloud are different paths

**Documented:** the TypeScript SDK has optional local `run.steer`; cloud and detached local handles return `revert_to_followup`. Code must inspect the outcome rather than display “steered” unconditionally. `Agent.resume` reattaches by ID or continues after local process restart. Default local headless tool execution has no interactive approval prompt; hooks or sandbox settings gate tools. This differs materially from ACP's explicit permission request protocol. API keys are account/team scoped. **Unknown:** cross-user subscription reuse rights or universal takeover of existing IDE chats. [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)

**Documented:** cloud API follow-up runs retain agent conversation and workspace state, but only one run can be active; another create-run request returns `409 agent_busy` until the active run terminates or is cancelled. Thus a follow-up API call is not live steering. Cloud state is independent of a user's browser, but agent machines still have lifecycle requirements. **Unknown:** a per-tool human approval callback equivalent to ACP in the reviewed cloud endpoint contract. [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints)

## Minimum integration acceptance checks

These are proposed tests, not completed work:

1. Alice launches a task from the product; Bob joins and receives the ordered transcript, tool activity, current state, and pending approval.
2. Bob queues an instruction; UI distinguishes accepted, queued, delivered, and rejected outcomes.
3. Bob interrupts and redirects; verify actual provider behavior during a slow tool and a running subagent.
4. Two users answer one approval concurrently; exactly one decision reaches the runtime and both see its author.
5. Alice closes her browser; Bob continues while the execution host remains alive.
6. Restart the runtime with retained transcript and workspace; verify recovery, pending-decision expiry, and duplicate-action prevention.
7. Repeat under the exact pilot authentication arrangement; record billing ownership and provider-version support.

Machine loss, moving execution to Bob's laptop, native IDE adoption, and seamless cross-provider conversation transfer should remain outside the initial promise until independently proven.
