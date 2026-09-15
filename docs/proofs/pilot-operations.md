# Issues #21–#24 implementation verification

Local verification on Windows x64, 2026-09-10, Node 25.0.0 and Electron 44.2.0
(embedded Node 24.20.0). Implementation branch: `implement/issues-21-24`, based on
main `6bd27c513517c2fb019651af225a92955b78da92`. This is working-tree evidence, not a
claim of published artifacts, production review, real customer traction, or a
completed external-release gate.

## Implemented scope

| Issue | Result |
| --- | --- |
| #21 | Shared first-run stages, actionable failure states, explicit diagnostic preview/download, metadata/provider/recovery disclosure, desktop startup diagnostics. |
| #22 | Signed owner deletion, atomic live purge, immutable task/project tombstones, verified host receipts, active cancellation, durable local fences, conservative recovery-archive cleanup, bounded content snapshots and current-authority restore. |
| #23 | Per-account opt-in, endpoint-derived fixed events, successful solo work separate from activation, two-person/delivered-intervention qualification, retry deduplication, later-week returns, event expiry and deletion. |
| #24 | Founder-local revisioned individual seat records, billing owner/payment classification, customer-visible seat boundaries, and paid-team totals independent of access and provider charges. |

## Checks and evidence

- `npm run test:pilot`: the boundary/storage suite and production browser flow pass.
  The final boundary suite has 12 tests, including a subsequent CLI integration check.
  Browser checks cover no-consent/no-export side effects, allowlisted download,
  missing host, enrollment transport failure and retry, unsupported-account failure,
  rejected customer kit, successful solo task, passive teammate view, real successful
  peer follow-up, activation deduplication after reload, paid/revoked seat display,
  offline task deletion, rejected service restoration, host reconnect/application,
  and project offboarding during an active approval. A reconstructed host does not
  republish the retired project mapping. Fixture files remain unchanged when the
  pending destructive action is cancelled. Logs: `.artifacts/issues-21-24/pilot-final.log`;
  screenshots and structured results: `.artifacts/pilot-browser/`.
- `npm run test:encrypted-controls`: all 20 tests pass, including the production
  runtime lifecycle within the control scenario. New cases pause a real history
  export during deletion, reconcile concurrently, refuse late writes, apply signed
  deletion without a fresh owner response, and retry both legacy and pending
  encrypted events without changing their timestamps. Log:
  `.artifacts/issues-21-24/encrypted-controls-final.log`.
- Enrollment authority: all 16 tests pass. Its Windows teardown now closes hosts
  and proxy resources before removing the temporary database. Log:
  `.artifacts/issues-21-24/enrollment.log`.
- Focused recovery, trust, revocation and pilot boundary run: 41 tests pass.
  `.artifacts/issues-21-24/security-focused.log`. The later expanded pilot boundary
  suite separately passes all 12 tests in `operations-final.log`.
- Existing encrypted workspace browser acceptance: all 15 checks pass, including
  actual scoped approvals, delivered steering, interruption, recovery, provider
  failure guidance and offline revocation. `.artifacts/issues-21-24/workspace-final.log`.
- Protocol smoke, 24 unit checks, 68 team boundary checks, eight hub key-exchange
  checks and legacy multiplayer browser E2E pass. The legacy E2E requires
  `CHROMIUM_PATH` on Windows because its default is a Linux installation path;
  this run points it at Playwright's installed Chromium.
- Source desktop smoke and bootstrap pass. Faults are injected at the renderer's
  transport boundary; the kit failure uses the real file input and inactive
  recovery validation. The successful task uses the actual desktop-spawned runtime
  and SDK broker. `.artifacts/issues-21-24/desktop-final.log`, `bootstrap.log`, and
  `.artifacts/pilot-desktop/`.
- Windows x64 NSIS install proof: all six checks pass, including installation
  outside the checkout, no system Node on the launched app's PATH, task execution,
  setup failure/retry, background lifecycle and uninstall. The lifecycle scenario
  records 13 checks. `.artifacts/issues-21-24/install-final.log` and
  `.artifacts/desktop-install/win32-x64.json`. Earlier installed runs exposed an
  intermittent `EPERM` replacing `encrypted-setup.json`; the bounded Windows retry
  retains the previous complete file, and its permanent-failure behavior is tested.
- `git diff --check` passes. No design contracts, instruction entry points or
  screenshot baselines changed, so `check:design` is not a visual verification claim.

The provider for these task flows is the deterministic demo adapter through the
production Runtime, transport, crypto, policy, and filesystem seams. Unsupported
account and enrollment cases use fixed transport faults; they do not assert that
a particular live provider account was rejected. Tests create only temporary
accounts, seat records and workspace files. They initiate no charges or messages.

## UI contract and visual inspection

Templates: `shell` + `setup` for setup/access, `decision` for reviewed exports and
deletion confirmation, within the existing `review` workspace. Shared primitives:
`uiNode`, `uiButton`, `uiField`, `uiSection` in `apps/web/app.js`; the same
`apps/web/pilot.js`, diagnostics module and existing brand tokens load in desktop.

Compared rendered captures with the accepted `setup-desktop.png`,
`access-desktop.png`, and `review-mobile.png` references under
`docs/design/plexus/design/qa/`. Browser captures use 1487×1058 and 390×844;
dialogs are checked for horizontal centering and viewport fit. Inspected setup,
seat rows, deletion pending/applied, desktop failure previews, and desktop/mobile
confirmation/export dialogs. The inspection caught and fixed the global margin
reset positioning native dialogs at the top-left. Disabled deletion is visibly
distinct and needs an explicit checkbox before submission.

Intentional extensions: the accepted production shell gains a checklist/privacy
section, plain seat rows and scrollable modal report/confirmation panels. No
prototype sample activity or simulated receipts enter production. The startup
screen retains its existing compact bootstrap presentation; it has no separate
accepted design capture. The mobile report scrolls inside its bounded dialog so
the complete JSON and download action remain reachable.

## Remaining verification limits

The monolithic `npm test` run is not green on this Windows environment: pre-existing
Codex fixtures hit temporary-directory cleanup ordering and a symlink privilege
failure. The separate SIGTERM subprocess assertion in
`test/encrypted-runtime-lifecycle.js` also fails under Windows process termination;
the installed app's IPC shutdown/lifecycle proof passes. These are recorded rather
than hidden by weakening test assertions. Original logs are under
`.artifacts/readiness-21-24/` and `.artifacts/issues-21-24/focused.log`.

No macOS or Windows ARM64 execution was performed. Real-provider compatibility,
supported account entitlements, trusted signed distribution, and independent
privacy/control review remain the product specification's release gates. The
installer proof and endpoint/host SDK boundaries retain the limitations described
by their existing tests; demo success is not live-provider evidence.

Operational procedure and retention limits:
[pilot operating guide](../operations/pilot-operations.md).
