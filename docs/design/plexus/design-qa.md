# Plexus prototype design QA

final result: passed

**Evidence provenance:** this report and its captures were produced for the isolated React/Vite prototype on 2026-09-06 and imported into `docs/design/plexus/`. They are reference evidence, not test results for the production `apps/web/` renderer or Electron application. Importing the pack did not rerun the browser interactions described below.

Date: 2026-09-06. Scope: selected option 3, **Review together**, plus supporting screens and responsive behavior. No actionable P0/P1/P2 findings remain in this prototype. This is a visual and frontend interaction review, not certification of backend behavior or complete specification coverage.

## Comparison target and normalization

- Source visual truth: [design/selected-direction.png](design/selected-direction.png), the user's selected third displayed concept.
- Implementation: `http://127.0.0.1:4173/?screen=review`, captured in the in-app browser at [design/qa/review-desktop.png](design/qa/review-desktop.png).
- Source pixels: **1487 × 1058**. Final implementation pixels and CSS viewport: **1487 × 1058**, captured at one image pixel per CSS pixel. No final density rescaling, browser chrome, or device frame.
- Matched state: dark theme; Checkout recovery selected; `src/checkout/retry.ts` selected; Alex responsible; Alex's Mac connected; Codex turn 4; Maya's delivered direction; open human-help request; empty correction draft.
- Intentional content additions: Catch-up navigation, template/setup/access entry points, turn label, and sample-data disclosure. The source's unverified Issue #42 is replaced with a working “Link an issue or PR” association flow. Empty drafts correctly disable Send.
- Full-view combined evidence: [comparison-final.png](design/qa/comparison-final.png), source left / implementation right, **2974 × 1058**.
- Focused combined evidence: [typography and direction](design/qa/comparison-type.png), [diff](design/qa/comparison-diff.png), and [collaboration](design/qa/comparison-collaboration.png). Each places corresponding source and implementation crops together; these were visually inspected alongside the full view.

## Findings and comparison history

| Iteration | Finding and impact | Fix and post-fix evidence |
| --- | --- | --- |
| Initial comparison — blocked | **P2:** The genuine logo appeared too small because its SVG contains internal whitespace. Navigation, metadata, and diff text were undersized, reducing hierarchy and making the workbench denser than the reference. | Corrected the supplied logo's display scale and increased the appropriate text sizes. Preserved the brand asset itself. Initial evidence: [comparison-before.png](design/qa/comparison-before.png), captured at 1488 × 1058; its one-pixel width difference was identified before final comparison. |
| Typography revision — blocked | **P2:** Increasing code text exposed an inherited proportional line height that made diff rows too tall and shifted the check panel down. | Set a 30px desktop diff row height/line height; tightened summary and message spacing. Recaptured at the source's exact 1487 × 1058 dimensions. Post-fix evidence: [comparison-diff.png](design/qa/comparison-diff.png) and [comparison-final.png](design/qa/comparison-final.png). |
| Final combined review — passed | No actionable P0/P1/P2 differences. Main pane proportions, code rhythm, artifact/check hierarchy, conversation, and composer preserve the selected direction. | Latest full-view and focused comparisons above were inspected after the fixes. Residual differences are classified below. |

## Required fidelity surfaces

| Surface | Review result |
| --- | --- |
| Fonts and typography | Bundled Outfit carries the Plexus identity. Heading weight, single-line title, body wrapping, navigation hierarchy, and mono code remain close to the reference. Corrected small body/code sizing. Minor differences in metadata scale, antialiasing, and glyph spacing remain P3; text is readable in focused crops. |
| Spacing and layout rhythm | Three continuous panes, an 86px top bar, subtle dividers, restrained radii, and a bottom composer retain the reference composition. Diff rows and the check panel have the corrected vertical rhythm. Minor message spacing differences are P3. Narrow layouts move side regions into accessible drawers rather than shrinking the workbench. |
| Colors and tokens | Near-black canvas, raised charcoal surfaces, pale ink, muted secondary text, and lime selection/action accents follow the existing Plexus brand. Amber remains reserved for pending attention; red/green diff tint communicates changes. The inactive Send state is intentionally muted. |
| Image quality and assets | Uses genuine supplied Plexus SVG assets and the bundled Outfit font, with Phosphor icons for standard UI symbols. Logo sizing was corrected without redrawing it. No screenshot is used as the live UI. The mock's subtle raster lighting/texture is intentionally replaced by flat app surfaces; vector assets are sharp. |
| App copy and content | Review content preserves the reference task, direction, code change, evidence, and conversation. Responsibility, execution host, provider account, actor, help, and approval stay separate. Unsupported external actions are labeled as sample behavior. The invented issue association was removed. |

## Browser and interaction verification

All nine routes were rendered in the in-app browser: Review, Workspace, Activity, Catch up, Inbox, Approval, Setup, Access, and Templates. Each desktop screenshot is saved under [design/qa/](design/qa/). The fresh browser run reported no console errors and no horizontal document overflow across those screens; see [browser-checks.json](design/qa/browser-checks.json).

The following sample flows were exercised through browser controls:

- Open source/result dialogs and inspect attributed event records; close dialogs through their controls and Escape.
- Send a correction and observe distinct host-acceptance and delivery receipts tied to the target turn.
- Hand off responsibility while retaining Alex's Mac as execution host; confirm updates affect the selected task.
- Create a human-help request on another task, locate it in Inbox, reopen the correct task, and resolve help independently of agent input.
- Record one delegated approval and preserve its settled state across navigation. Interrupt a turn, wait for confirmation, start a follow-up, and verify the old approval expires without actionable buttons.
- Simulate host loss: disable instruction/approval controls and show unknown execution state. Reconnect through reconciliation; uncertain instructions are not silently replayed.
- Change project/steering grants, navigate away and back, and confirm action eligibility follows the retained sample state.
- Complete the staged setup/recovery exercise and create a solo sample task. Start a planned sample task without claiming a real provider execution.
- Open template specimens, inspect their JSON contracts, and follow screen links. Export copies are included in the build.

Responsive checks:

| Viewport | Evidence and result |
| --- | --- |
| 1487 × 1058 | All nine desktop screens; no horizontal document overflow. |
| 1024 × 900 | [Activity tablet](design/qa/activity-tablet.png); navigation and content remain usable without overflow. |
| 390 × 844 | [Review mobile](design/qa/review-mobile.png) and [collaboration drawer](design/qa/collaboration-mobile.png); navigation, conversation, draft input, Send, and template inspection remain reachable. Final mobile captures were recaptured after the viewport resize settled. |

## Build checks and limits

The production Vite build and Sites output preparation passed under Node 22.22.3. The starter's four Sites worker contract tests passed. These verify packaging behavior; they do not test multiplayer semantics. The prototype remains a local frontend with reset-on-reload sample state.

There is no live authentication, provider execution, encryption, access enforcement, invitation delivery, or cross-device synchronization. At the original capture date, the actual harness was inspected for the [development handoff](DEVELOPMENT-HANDOFF.md), but its renderer was not modified and its integration/desktop test suites were not run as part of that prototype review. This report does not certify the later reference-pack import or any production changes. Full screen-reader, contrast-ratio, operating-system, and long-running multiplayer audits remain production adoption work.

## Implementation checklist

- [x] Compare the selected image and implementation in combined full and focused views.
- [x] Correct P2 logo/text sizing and diff vertical rhythm, then recapture.
- [x] Check all nine screens, primary sample interactions, desktop/tablet/mobile, and console output.
- [x] Provide shared tokens, six template contracts, genuine assets, and a development adoption guide.
- [ ] During production adoption, replace sample state/timers with authoritative harness events and run the existing harness suites in both clients.

## Follow-up polish

P3 only: tune secondary metadata scale and conversation spacing further if the team chooses tighter visual matching. The flat surface treatment, functional navigation additions, truthful issue-link action, and disabled empty-draft button are accepted product adaptations. Establish approved screenshot baselines in the shared renderer before adding automated visual regression checks.
