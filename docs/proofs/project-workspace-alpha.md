# Project workspace and guided setup proof

Recorded 2026-09-15 for issues #65 and #66. Production implementation tested:
`61e162c01cbe3b63374d8932379c6d78c89aacd8`. Subsequent evidence commits add documentation and captures only.

## Result

The shared web/desktop renderer now opens an authorized project, shows its tasks,
starts work through the existing runtime, and places discussion beside recorded
results. Reload restores accessible project/task selection within the browser
session. A draft cannot silently move to another project or host. Navigation
storage contains opaque identifiers only. Feed snapshots say “Last read”; host
connectivity and the responsible teammate remain separate.

Setup shows team, verified host, project and configured Codex progress and routes
users to existing local authorization controls. Rechecking distinguishes a missing
CLI, incompatible version and missing local account without resetting project
selection. A saved login alone does not count as a configured execution provider.
The provider-switch model fix is inherited from PR #71.

## Design and state coverage

Existing `shell`, `setup`, `review` and `decision` templates are extended using the
shared sections, buttons, composer, encrypted history and recorded diff renderer.
The original accepted captures are unchanged. New production captures live in
[the alpha capture directory](../design/plexus/design/qa/alpha/).

| State | Evidence |
| --- | --- |
| Empty selected project and setup progress | `project-empty-desktop.png`, `project-empty-mobile.png` |
| Completed task, responsible teammate, host and changes | `review-desktop.png`, `review-mobile.png` |
| Local provider status and retry controls | `setup-desktop.png` |
| Exact-action approval and delegation | `approval-desktop.png` |
| Mobile discussion and correction composer | `discussion-mobile.png` |
| Actionable provider setup failure | `provider-setup-failure-desktop.png` |
| Running turn, correction, interruption, offline host, reload and recovery | Browser acceptance assertions |

Desktop (1487×1058) and mobile (390×844) captures were inspected against the accepted
workspace, setup and review references. The intended desktop departure puts
discussion on the left and results on the right. Existing discussion/navigation
drawers remain at their responsive breakpoints; mobile checks found no horizontal
page overflow. Advanced setup still exposes verification details; existing plain
Markdown and raw patch rendering remain visible. This is a functional alpha
extension, not a claim that every existing surface has been visually polished.

## Verification

| Check | Result |
| --- | --- |
| `test:encrypted-workspace` | 17 passed, zero renderer errors |
| `test:e2e` | 38 passed |
| `test:unit` | 25 passed |
| `test:protocol` | Passed |
| `test:desktop` | 19 passed |
| `test:design` | 13 passed |
| `check:design` | Passed |
| `test:desktop:install` with real Codex enabled | 6 passed |

The [browser results](project-workspace-alpha/browser-results.json) use the
production encrypted runtime with a deterministic demo provider. Setup error
cases use a mocked desktop bridge. They do not prove native dialog interaction.

The [installed app results](project-workspace-alpha/installed-macos.json) and
[real Codex result](project-workspace-alpha/installed-codex.json) establish a
fresh isolated installed copy on macOS 26.5.1 arm64, Codex 0.153.4 and a locally
saved ChatGPT account. The launched app had no Node on PATH. It selected a folder,
obtained separate approval consent, completed a real provider turn and verified
the resulting file bytes. Startup failure/retry, hidden-window host lifetime,
explicit quit and uninstall passed. Native consent is automated through the
acceptance harness; this is not a manual usability study.

Installer: `Plexus-0.1.2-mac-arm64.dmg`, 130625785 bytes.
SHA-256: `2a8888b67e6f3f2121c780008d1bdc0cb228da310ec7d5fd4a0f2051daa04eed`.
The unsigned installer was built from the tested commit's production code. The
report's dirty-tree flag reflects pre-existing user documentation changes and
untracked artifacts, which were preserved and excluded from these commits.

## Remaining release gates

This does not satisfy #69: the installed real-provider run was on one physical
machine, not two independently installed teammate machines. Windows, API-account
mode and signing/notarization were not qualified in this run. Installing Codex
and obtaining its local login remain prerequisites; the app guides and validates
that setup rather than installing the CLI or handling credentials itself.

Issues #67/#68 still own collaboration catch-up/correction and contextual review
refinements. Hosted-service qualification #70, pilot operations and the existing
beta technical/release gates remain open. No merge or beta release is implied.
