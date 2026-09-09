# Owner recovery handoff — 8 September 2026

This bounded final pass adds customer-material-only owner authority recovery to the
implementation at `db3153511a2dc67110c95054592a70813288a58e`. It closes the previously
documented no-surviving-teammate implementation gap for issues #8, #15 and #17 in
the tested local source flows. It does not certify every acceptance criterion of
issues #2–17. Work stops here at the user's request; no further implementation cycle
or GitHub Actions run is authorized by this handoff.

The subsequent authorized documentation and repository publication are recorded in
[issues-02-17-sync.md](issues-02-17-sync.md), including verified issue/PR comment links.
That sync did not resume implementation or tests.

## Implemented behavior

The owner prepares an encrypted customer-held kit using the actual Matrix SDK
cross-signing material and selected authenticated history, then rehearses recovery
into a clean endpoint. Rotation and re-enablement require a fresh account signing
root. Wrong keys, retired kits, wrong context, rollback, and tampered or missing
staging metadata refuse recovery. Restoration stages a separate inactive SDK store;
publication requires explicit customer action.

A dual-signed recovery transition preserves the original enrollment root and
revocation history, admits the fresh owner endpoint, and resets other device and
project access. Every execution host remains paused until its own local consent and
key rotation finish. Previously offline hosts remain pending independently. Old
task/control epochs, provider continuations and approval grants cannot acquire new
authority through recovery. Project access and native action approval require
separate fresh authorization.

The shared renderer implements setup, drill, encrypted-kit download, disable/replace,
staged history, explicit publication and per-host pending/active states. ADR 0006
records the trust boundary and limitations.

## Actual local results

| Check | Final result | Evidence |
| --- | --- | --- |
| Protocol, kit, epoch fencing and two-host production runtime | 26 passed, 0 failed/skipped | `.artifacts/owner-recovery-handoff/focused.log` |
| Actual browser persistent SDK lifecycle | 2 passed | Same focused log |
| Native local-control/RPC consent contracts | 21 passed, 0 failed/skipped | `.artifacts/owner-recovery-handoff/native.log` |
| Browser owner recovery | 6/6 passed, no uncaught errors | `.artifacts/owner-recovery-browser/results.json` |
| Source Electron owner recovery | 6/6 passed, no uncaught renderer errors | `.artifacts/desktop-owner-recovery/results.json` |
| Existing workspace browser regression | 9 checkpoints passed, then fixture selector failure; exit 1 | `.artifacts/owner-recovery-handoff/workspace.log` |

The Electron proof used the actual OS-protected durable crypto broker, production
runtime and local demo file tools. It deleted the original customer SDK store,
restored exact history with no surviving trusted teammate, exercised native cancel
and activation, wrote a distinct recovered task file, and required fresh approval
consent before a later exact filesystem action. Login and native dialog decisions
were fixtures. Native dialog visuals were not captured.

The observed Electron errors were real failures: missing broker module routes and
an omitted options argument serialized as null over IPC. Both causes were repaired
before the final successful run; failed logs remain in the named failure folders.
The existing browser test also omitted Bob's visible team-authority confirmation.
Its fixture now confirms the exact original owner's fingerprint before accepting
history; production authorization was not weakened.

The last workspace run passed that history step and eight other checkpoints, then
stopped because its fuzzy `Recovery key` label matched both the new owner key and
the existing history-only key. The two history-only selectors now use an exact
label. This final fixture correction has **not been rerun** at the stopping point;
the workspace suite is not claimed green. Older `results.json` files in that
artifact directory are not evidence for this failed run. Syntax checks passed for
all 32 changed JavaScript modules, and `git diff --check` passed.

Eleven desktop/mobile recovery captures were inspected. Saved, staged, pending,
active and approval states are covered; there is no document overflow. Existing
compact Fleet/vertical Recovery layout departures are recorded in
`.artifacts/desktop-owner-recovery/render-review.md`. Approval buttons fall below
that screenshot's viewport, so their disabled/enabled behavior is proven by UI
assertions. No design reference or screenshot baseline changed.

Spec review found one re-enablement defect, repaired before the final flows, and
no remaining actionable implementation mismatch in its inspected scope. Standards
review found no documented breach and three maintainability suggestions. Both
reviews are retained under `.artifacts/owner-recovery-handoff/`; neither constitutes
independent specialist security review.

## Remaining qualification and next task

The aggregate suite and rebuilt installer were not rerun after this recovery phase,
in accordance with the bounded stop. Earlier green suite and installer records
belong to their recorded revisions. This pass made no paid provider calls and ran
no GitHub Actions. Current Windows execution, a separately authorized real
API-account scenario, and qualified privacy/control review remain unverified.

The next task is release qualification of this recovery change: first rerun the
existing workspace browser test after its exact-label correction, then run the local
aggregate suite and rebuilt macOS installer against the committed source, address
any demonstrated regression, and arrange the remaining platform/provider and
independent-review gates separately. No new features are needed to make this
handoff reviewable. Standards suggestions can remain follow-up maintenance.
