# Codex interactive adapter: first slice of issue #7

Issue #7 is in progress. This change repairs the existing app-server adapter's
transport and turn lifecycle. It does **not** enable the provider in the desktop
app or satisfy issue #7's installed-app acceptance criteria.

## Implemented boundary

The adapter completes `initialize` / `initialized` before starting a thread and
sends the `thread/start` sandbox enum in the correct field. It retains separate
product and provider thread/turn identifiers. A successful RPC acknowledgment or
process exit is insufficient for task success: a matching `turn/completed` must
carry a successful terminal status. Notifications from other threads or turns
cannot finish the task or populate its event stream. Early notifications wait
for the turn/start acknowledgment before being applied.

The stdio transport preserves split UTF-8, bounds frames and startup buffering,
rejects pending calls on disconnect, and applies request/turn deadlines. Malformed
messages fail closed. A local cancellation tears down the connection; this is
not a provider-acknowledged interrupt or proof of subprocess-tree confinement.

Only command/file approval requests for the acknowledged active turn reach the
host's approval callback. Repeated provider request IDs invoke that callback
once; only an explicit per-action `accept` becomes an acceptance. Session-wide
permission, unsupported requests and foreign-task approvals are refused. These
checks do not replace the host's approver grants or sandbox enforcement.

Provider stderr is drained without retention. RPC errors and provider error
items are reduced to fixed errors instead of copying credential-bearing text
into task logs. Normal task output remains content and must use the encrypted
path when the production integration is connected. The raw diagnostic hook and
hard-coded model entitlement list have been removed from this adapter.

| Error | Operator action / interpretation |
| --- | --- |
| `codex_unavailable` | Check the host's installed CLI and executable configuration. |
| `codex_protocol_unsupported` | Validate the installed app-server schema/version before retrying. |
| `codex_usage_limit` | Check the execution host's provider quota or wait for its reset. |
| `codex_disconnected`, `codex_request_timeout`, `codex_turn_timeout` | Outcome can be unknown; do not automatically repeat execution. |
| `codex_protocol_invalid`, `codex_frame_too_large` | Stop and inspect the local integration/version. |
| `codex_request_failed` | Check the provider locally; this generic code does not diagnose authentication. |

## Evidence

`npm run test:codex:app-server` runs 18 deterministic tests, including a real Node
subprocess that exits with an outstanding RPC. Tests cover handshake/schema,
early completion, mismatched identity, failed/interrupted turns, startup and turn
timeouts, cancellation, bounded approval decisions, invalid input, split UTF-8,
malformed/oversized frames, sanitized errors, pending approval cleanup and the
unchanged production isolation gate. They use a simulated provider and spend no
provider quota. `npm test` includes this suite; Linux/Windows CI runs it with the
existing control-plane and encrypted-task regression checks.

The locally installed Codex **0.153.0** also passed a real initialization-only
check through the new transport. No provider task was started. Its generated
JSON schema confirmed the request fields and terminal notification shape. This
is not a supported-version certification or a new real-task result matrix.
The protocol source is the [official app-server documentation](https://learn.chatgpt.com/docs/app-server),
checked alongside that installed schema.

## Remaining work for #7

1. Complete #2's interactive provider proof and prove project-confined provider
   reads/writes on the supported hosts. Keep `Runtime.provider()`'s CLI gate
   closed until the actual execution boundary has evidence.
2. Add host-local account/version/model discovery, actionable authentication
   failures and supported account setup without exposing credentials remotely.
3. Connect authorized host project mappings, verified endpoint enrollment and
   the encrypted task writer to provider start/activity/diff/completion. Define
   durable execution identity and crash-unknown handling before automatic retry.
4. Wire provider-acknowledged steering, interruption and explicit resume through
   the host control boundary; the adapter currently advertises no steering.
5. Integrate the shared desktop renderer and complete #4's installed Windows and
   macOS test matrix. Run a useful solo feature task and inspect encrypted replay,
   file changes, displayed workspace/capabilities and credential canaries.
6. Resolve #6's remaining native dependency on #3's qualified encryption review.

No screen, design reference or screenshot baseline changes are part of this
slice. No issue acceptance checkbox is marked complete by the transport tests.
