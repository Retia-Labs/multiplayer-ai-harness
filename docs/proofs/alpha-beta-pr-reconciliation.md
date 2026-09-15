# Alpha/beta PR reconciliation — 2026-09-15

Compared `main` at `a5eca7a` with the current heads of PRs #61, #63 and #64.
This is a source reconciliation, not a blanket review or release qualification.

| PR | Head | Already on main / superseded | Remaining work |
| --- | --- | --- | --- |
| [#61](https://github.com/Retia-Labs/multiplayer-ai-harness/pull/61) | `4ef868c` | CLI/config parsing for `codexReadOnly` exists. The old confined exec backend is superseded by the host-tools app-server path; main explicitly records that read-only did not isolate reads. | Provider changes still inherited the previous model. Reproduced and fixed on the alpha planning branch with a unit regression. Do not restore the obsolete provider gate or treat its old proof as current qualification. |
| [#63](https://github.com/Retia-Labs/multiplayer-ai-harness/pull/63) | `1669711` | Both browser fixtures already derive their served modules from `Hub.SHARED_MODULES`. | Asset failure diagnostics and actionable membership-wait reporting remain absent. Carry into #67, retaining successful backup replay and genuine integrity failures. The PR itself does not establish that Windows desktop enrollment works. |
| [#64](https://github.com/Retia-Labs/multiplayer-ai-harness/pull/64) | `5b1a9c5` | Pilot modules are not present on main. | Integrate for #21–#24 with current-main verification. A non-mutating merge preview reports one textual conflict in desktop startup IPC; automatic merges elsewhere still require semantic review. |

## PR #64 integration constraint

The desktop conflict overlaps the new diagnostics handler and the current
`requireShellRenderer` checks on boot retry. Preserve the current sender/frame/origin
validation and the guarded retry handler when adding diagnostics. Accepting the old
retry side would remove an existing boundary. Reuse the current helper where its trust
scope is appropriate; exercise an unrelated renderer attempting both operations.

Existing PR evidence is Windows/demo-scoped and does not qualify the merged result on
macOS, real Codex, signing or privacy review. No PR was merged or closed by this audit.

## Implemented correction

`Runtime.resolveSettings` now drops an inherited model when switching providers without
an explicit replacement. Same-provider changes preserve the model; an explicit new model
wins; the current settings object and host policy ceiling remain intact.

The regression failed before the fix (`demo-agent` was carried into Codex), then all
25 unit checks passed. The protocol smoke passed, and all 55 synthetic Codex
adapter/account checks passed with zero skips. `git diff --check` passed. No live
provider call was used to verify this settings failure. Production UI and design
references are unchanged, so this slice makes no new rendered-UI claim.

## Next integration order

1. Land the provider-settings regression without reopening the obsolete provider path.
2. Integrate the remaining #63 enrollment diagnostics as part of #67.
3. Resolve and verify #64 for pilot operations before adding overlapping support or
   onboarding modules. Its diagnostics and retention implementations feed #21, #22,
   #66 and #70; its PR description is not evidence that a new merge passed.
4. Build #65/#66, then #67/#68 and qualify #69; complete #19/#20/#70 and #25 before
   external beta. Native blockers, not readiness labels, govern availability.

## Integration follow-through

The current disposition and combined-code verification are recorded in
[pending-pr-integration.md](pending-pr-integration.md). #61 is superseded by #71;
#63 and #64 have been reconciled with the project workspace and verified locally,
including a fresh installed macOS build. The earlier table above records the
pre-integration audit and should not be read as current outstanding code status.
