# Pending PR integration — 2026-09-15

## Disposition

- **#61:** closed as superseded. #71 already delivered the provider-switch model
  regression fix. The obsolete read-only provider path is not reintroduced.
- **#63 (`1669711`):** integrated with current main in `188568c`. Keep main's shared
  fixture-module list; retain asset diagnostics and actionable enrollment waiting
  errors. Four new public-client seam tests preserve readable restored history,
  ordinary integrity failures and rollback evidence. This addresses part of #67;
  it does not close the whole collaboration UX issue or qualify Windows.
- **#64 (`5b1a9c5`):** integrated with the project workspace in `dbd1af6`. This
  delivers the implementation for #21–#24: onboarding/diagnostics, signed deletion
  and bounded backups, opt-in measurement, and manually managed seat records.

The integration preserves original PR commits through merge ancestry. Tests and
artifacts below qualify the combined production code at
`dbd1af6e2b3134517d7032d883335e15bd788c42`; the subsequent commit changes the
screenshot test and evidence only. Starting main was `466fb9d`.

## Resolutions and review

The desktop conflict is resolved by reusing `requireShellRenderer` for both
`desktop:diagnostics` and `desktop:retryBoot`. The current sender, main-frame and
origin checks remain enforced. The bootstrap test now verifies that an unrelated
renderer cannot call diagnostics, retry or open the data folder.

The HTML conflict retains project navigation, setup progress, task feed and composer.
Pilot onboarding/privacy controls appear below the composer, rather than replacing
those workspace controls. Both browser and installed desktop use `apps/web/pilot.js`
and the product modules. Diagnostic exports use actual installed desktop versions;
a browser without that information reports `unknown`, replacing the old hard-coded
app version. No diagnostic data is automatically sent.

Deletion review covers signed owner authorization, atomic service purging, persistent
host fences, cancellation before acknowledgement, current-authority restore and
preserving the runtime's latest freshness checks. Tests exercise deletion during a
history transfer, offline application, retired project mappings after restart and
unchanged local project files. Measurement and seats remain independent of access,
keys, approvals and provider billing.

## Local verification

| Check | Result |
| --- | --- |
| Pilot boundary suite | 11 passed; 1 Windows-specific file-lock test skipped on macOS |
| Pilot production browser | 7 recorded scenarios plus onboarding error/retry helper passed; zero renderer errors |
| Encrypted workspace browser | 17 passed |
| Encrypted control receipts | 20 passed |
| Enrollment authority/freshness | 40 passed |
| Recovery trust | 1 passed |
| Owner recovery | 26 Node tests and browser recovery scenarios passed |
| Revocation | 12 passed |
| Recover after loss | 11 passed |
| Mailbox browser | 6 scenarios passed, including tampered/cross-team journal rejection |
| Encrypted task browser | 3 scenarios passed |
| Teammate enrollment browser | 8 passed |
| Catch-up view and enrollment error precedence | 7 rendered checks and 4 seam tests passed |
| Unit / protocol / legacy multiplayer | 25 unit tests, protocol pass, 38 multiplayer checks |
| Desktop source smoke and bootstrap | Passed, including unrelated-renderer refusal and startup retry |
| Fresh installed macOS arm64 | All 6 installer checks passed; 13 lifecycle checks passed |
| Design reference integrity / whitespace | Passed |

Commands use the repository's `npm run test:*` scripts and the isolated Playwright
browser installation. GitHub Actions remains disabled; no workflow files are added.
The initial protocol/catch-up invocations were prevented from starting by sandbox
loopback restrictions or a missing default browser path; reruns with the correct
permissions/browser path passed.

A pilot screenshot rerun exposed measurement before mobile media-query layout
settled (old 964px dialog bounds immediately after shrinking the viewport). The
resulting screenshot already fitted the new viewport. The capture helper now waits
two animation frames before measuring, records bounds on failure, and retains the
same strict centered/viewport-fit assertion. The complete browser flow then passed.

## Installed evidence

[Installer record](pending-pr-integration/installed-macos.json) and
[installed task record](pending-pr-integration/installed-task.json):

- macOS 26.5.1, arm64, Electron 44.2.0; fresh isolated installation outside checkout.
- `Plexus-0.1.2-mac-arm64.dmg`, 130637788 bytes.
- SHA-256: `c387d8305d1a49d61122be0c64ad79668312828f6c6149f4f66ea3899c939040`.
- Deterministic demo provider through the production runtime, crypto and filesystem;
  real file bytes verified with no Node on the launched app's PATH.
- Installed setup exercises enrollment, unsupported-account and invalid-recovery-kit
  faults through the renderer; startup diagnostics and privileged IPC guards pass.
- Native consent/tray actions use existing automation seams. This is not a manual
  usability study, signed release, real-provider run or two-machine qualification.
- The dirty-tree flag reflects preserved user documentation/artifacts. No unrelated
  user changes are staged; production code was fixed at the tested commit.

## Design evidence

Templates: `shell` + `setup` for workspace/onboarding/access, `decision` for export
and deletion dialogs, existing `review`/`evidence` for task work. Reused components:
`uiNode`, `uiButton`, `uiField`, `uiSection`, existing composer and encrypted records.

[Production captures](pending-pr-integration/captures/) were inspected at 1487×1058
and 390×844 against accepted setup/access and alpha review references. Coverage:
setup ready/missing/failed, optional measurement, diagnostic preview, seat status,
offline deletion, and disabled deletion confirmation. The long mobile export scrolls
within its bounded dialog; download remains reachable. The workspace discussion and
results layout remains intact. The compact startup screen retains its existing
presentation and has no separate accepted prototype baseline.

Intentional extensions are the pilot checklist/privacy section after the task
composer, plain seat rows and confirmation/export dialogs. Existing baseline images
and template contracts are unchanged. The previous Windows proof in
[pilot-operations.md](pilot-operations.md) remains historical evidence, not evidence
that this new combined build passed Windows.

## Remaining work

#67 remains open for the complete join/catch-up/correction UX, and #68 for approval
and review refinements. #69 still requires two physical machines. #70 must qualify
an operated service across networks, including restart/restore and operational
ownership. Windows, live-provider behavior, signed distribution and independent
privacy/control review were not qualified in this integration run. No customer
charges, customer messages or deployment were initiated.
