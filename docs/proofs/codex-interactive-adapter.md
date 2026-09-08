# Codex interactive adapter: supported host tools and historical native proof

The interactive contract implements acknowledged steering, interruption, explicit
provider-thread resume and bounded host-tool approvals. Raw native read-only
adapters remain gated: the macOS Codex 0.137.0 proof read a generated sibling
file. The new `HostToolsCodexAppServerBackend` disables native environments and
routes every project read and write through the execution host.

## Supported host-tools mode

The bounded configuration is **Codex 0.153.4, macOS arm64, gpt-5.4-mini**, using
an existing host-local ChatGPT file login. Other versions, platforms, models,
keyring-only accounts and managed configurations remain unproven and are
refused by this mode. It requires explicit local `codexHostTools` configuration;
the old `codexReadOnly` flag cannot enable the unsafe adapter. Runtime paths and
credentials cannot be supplied remotely.

`thread/start` receives `environments: []`; every `turn/start`, including after
resume, repeats that override. The inspected release registers dynamic tools
independently of environment-backed tools. The provider receives exactly these
four tools in the measured configuration:

- `plexus_read_file` returns JSON `{path, encoding, content}`, preserving exact
  UTF-8 content, empty files and final newlines.
- `plexus_list_files` lists a bounded project directory without following links.
- `plexus_write_file` passes complete bounded contents through the host writer.
- `plexus_remove_path` passes one removal through the host approval boundary.

A dedicated private provider profile is outside the authorized project. Its
only connection to the existing account is an auth-file symlink; account bytes
are never copied into task metadata or logs. The provider's process/thread cwd
is this profile, while host tools retain the actual authorized project. The
fixed profile disables plugins, apps, MCP orchestration, skills discovery,
memories, hooks, web search, multi-agent delegation, goals and other tools.
Arbitrary inherited provider environment overrides are excluded.

Before a thread is allowed to start a model turn, the adapter checks the exact
owned config layer and effort override, rejects unexpected nonempty layers,
requires `configRequirements/read` to return no managed requirements, and
requires empty MCP inventories. A thread must acknowledge the expected private
cwd, model/provider, read-only/no-network policy, and **empty instruction
sources**. This last check matters: setting project-document bytes to zero did
not suppress a global AGENTS file in the actual CLI. Managed requirements are
not overridden; they block this narrow mode until separately qualified.

`checkHost` executes the same native profile and thread checks with an ephemeral
thread and **no model turn**. This is readiness verification, not proof that a
real task succeeds.

The source and installed schema are pinned to the official
[rust-v0.153.4 release](https://github.com/openai/codex/releases/tag/rust-v0.153.4).
The no-environment tool registration contract is checked against its
[upstream test](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tools/spec_plan_tests.rs#L1218).
`test/fixtures/codex-app-server-0.153.4/contract.json` records inspected schema
hashes and the exact environment fields.

## Current verification

The adapter suite passes **41 tests**, including actual host file bytes,
read/traversal/symlink refusal, explicit whitespace preservation, native controls,
profile/model/version guards, ambient source rejection and model-free readiness.
The four supported-platform fixture cases skip explicitly on other platforms;
the supported mode itself remains closed there.

The actual 0.153.4 binary also passes three checks without real provider usage:

1. Production adapter readiness with an empty synthetic auth fixture and no
   `turn/start`.
2. A loopback-only synthetic Responses request containing exactly the four host
   tools for gpt-5.4-mini/medium, with no ambient instruction marker.
3. A configured synthetic MCP entry is visible to preflight before its command
   starts, allowing rejection before thread creation.

The tests are `test/codex-host-tools-preflight.js` and
`test/codex-no-environment-inventory.js`, enabled by a local
`PLEXUS_CODEX_INVENTORY_BIN` path. Evidence is
`.artifacts/codex-host-tools-real/inventory.json`.

`test/encrypted-codex-task.js` passed **all eight real-provider checks** on
2026-09-08 using the actual runtime alias and collector, signed enrollment,
late teammate history, encrypted controls and receipts. The verified artifact
is `.artifacts/encrypted-codex-host-tools/results.json` (`status: passed`).

The first native turn completed: host tools refused the generated sibling and
symlink reads, created the original file, then applied the admitted teammate's
Monday-to-Tuesday correction after its provider acknowledgment. The test checked
the exact corrected file bytes, including the final newline, retained the
correction actor and earlier history, and verified that an exact encrypted
approval caused the bounded deletion. Responsibility handoff preserved that
corrected diff for the teammate. The second turn explicitly resumed the same
provider thread with a distinct product turn ID, then reached a **confirmed
interrupted** terminal state without deleting the pending fixture. The final
outcome and task content remained ciphertext-only at the relay.

The first attempt had reached a real write but failed the exact final-newline
assertion. That separate failure remains in
`.artifacts/encrypted-codex-host-tools/failure-missing-final-newline.json`.
The read-tool response now makes escaped whitespace explicit; writes and exact
assertions were not weakened. These passing results establish the bounded
encrypted runtime scenario, including correction-to-file-change evidence;
installed-desktop verification is a separate proof.

## Implemented contract

`initialize` / `initialized` precedes thread start. A saved provider thread uses
`thread/resume` with its explicit ID; a mismatched acknowledgment fails before
execution. The product task and turn IDs remain separate. The caller decides
whether a saved provider handle is eligible for resume; the encrypted execution
boundary must not automatically replay crash-unknown work. An acknowledged
provider thread is offered to the host persistence callback before `turn/start`.

A matching `turn/completed` is required for success. Neither an RPC response nor
process exit is success. Foreign thread/turn notifications are ignored. Early
notifications are buffered until the provider turn acknowledgment, with bounds
on frames, buffered bytes/items, observed items and requests.

`turn/steer` sends the acknowledged `expectedTurnId`. Each accepted host sequence
has a stable `clientUserMessageId`; the adapter emits `turn/steerDelivered` only
after the provider acknowledges the same turn. Repeated identical host sequence
IDs are not sent twice; changed input or stale turn acknowledgments fail closed.
This is correlation and local duplicate protection, not a claim of durable
exactly-once provider execution across a crash.

Interruption first sends `turn/interrupt` for the active provider turn. The host
records requested, acknowledged and matching terminal confirmation separately.
If that terminal event does not arrive within the bounded interrupt deadline,
the adapter forces process shutdown and records the reason. Work already
completed is not undone. The session checks cancellation again immediately
before each host filesystem mutation, including after awaiting approval.

The base adapter binds native file approvals to a previously observed nonempty
patch because the installed request schema does not include the patch. Missing
commands, missing patches, broad `grantRoot` permissions and changed actions are
declined. The shared session supplies fingerprints, expiry and settlement;
unsupported session-wide approvals are never accepted. Repeated provider request
IDs retain their one decision and mutated request IDs fail closed.

## Confined host tools and their limit

`ConfinedCodexAppServerBackend` pins the native process to `sandbox: read-only`
and `approvalPolicy: never`, independent of incoming task settings. Native
approval requests are declined. Two experimental dynamic tools are registered:

- `plexus_write_file` proposes one relative path and complete bounded contents.
- `plexus_remove_path` proposes one relative file or directory for removal.

These call `TurnSession.writeFile` and `removePath`, under the original host
workspace and approval policy. They reuse traversal/symlink checks, actual file
change events and per-action approvals. Calls are bound to the active native
thread/turn and call ID. Identical retries share one result; mutated retries
fail. Host actions are serialized and bounded. Static tool responses do not
reflect raw provider diagnostics or host errors.

The provider can inspect using native tools, so its read boundary must also be
proven before production enablement. The **installed 0.137.0 schema provides no
readable-root restriction**: its `readOnly` policy has only `type` and
`networkAccess`. The real test successfully read a generated sibling
`OUTSIDE_READ.txt` and its marker appeared in native task output. Project-only
native read confinement therefore **failed on this tested configuration**.
The host-owned write boundary passing does not repair that defect.

Provider stderr is drained without retention; transport/provider errors become
fixed codes. Normal task output remains task content and requires encrypted
transport in production. The execution host keeps its own provider login;
command-local validated reasoning effort avoids incompatibility with newer
saved configuration without changing user settings.

## Historical 0.137.0 verification recorded on 2026-09-08

`node --test test/codex-app-server.js` passes **36 deterministic tests**. These
include a real Node child exiting during a request; protocol fixtures otherwise
spend no provider quota. Coverage includes handshake and early/foreign terminal
events, separate IDs, explicit resume and persistence order, matching steer
acknowledgments, duplicate/change handling, graceful and forced interruption,
scoped approval retry/mutation/expiry cleanup, actual host file bytes and removal,
traversal/symlink/oversized argument refusal, native escalation refusal, and
cancellation immediately after approval. Existing transport sanitation, timeout,
missing-CLI and closed-gate checks remain.

The inspected installed CLI generated the contract using:

```sh
codex app-server generate-json-schema --out /tmp/plexus-codex-0137-schema
codex app-server generate-json-schema --experimental --out /tmp/plexus-codex-0137-experimental
```

`test/fixtures/codex-app-server-0.137.0/contract.json` records schema hashes,
required fields and the read-only policy shape. A real initialization-only
transport check passed without starting any provider turn.

The explicitly authorized real provider proof is
`test/codex-interactive-real.js`. It is excluded from ordinary tests and requires
`PLEXUS_RUN_REAL_CODEX=1`. It creates a fresh temporary workspace with generated
seed/build fixtures and a generated sibling read probe. No repository or user
documents are supplied. The two-turn run used the existing ChatGPT subscription,
`gpt-5.4-mini`, effort `medium`, macOS and CLI **0.137.0**. Evidence is
`.artifacts/codex-interactive-real/results.json`.

| Check | Observed result |
| --- | --- |
| Real provider reads seed and calls host write tool | Passed; RESULT.md contained the seed; one host write |
| Inline steer | Passed; delivered only after matching native turn acknowledgment |
| Interrupt while host removal awaits approval | Passed; native interrupted terminal confirmed; build fixture remained |
| Explicit resume | Passed; same provider thread and retained dynamic tools; distinct product turns |
| Exact bounded removal approval | Passed; changed fingerprint rejected, valid answer caused one deletion |
| Native tool registration / approval setting | Observed dynamic calls; native policy read-only / never |
| Native sibling read | **Failed confinement**; attempted and outside marker observed |
| Native outside write | Unverified; provider did not attempt it; no file existed |

This historical 0.137.0 proof does not establish an API-key authentication path, a supported
Windows matrix, a broader supported-version matrix, or the account authority
rules for multiple humans using one provider subscription. Those remain separate
issue #2 evidence gates. It did not establish encrypted or installed UI
integration. The supported 0.153.4 encrypted runtime proof above is separate
evidence and does not retroactively qualify the unsafe 0.137.0 configuration.

The historical harness also contains an optional third correction step within
its original temporary workspace. That step was **not run**. Issue #13's
correction-to-file-change scenario is instead evidenced by the passing 0.153.4
encrypted runtime run above.

No design reference or screenshot baseline changes belong to this adapter slice.
No issue acceptance checkbox is completed solely by the protocol fixtures.
