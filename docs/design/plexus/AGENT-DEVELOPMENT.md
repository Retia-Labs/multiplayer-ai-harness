# Making agents follow the Plexus design

The design must live in the development repository, be loaded by each coding agent, and be checked before merge. A link to this conversation, an optional skill, or an instruction to “match Plexus” does not provide that control. Instructions guide implementation; shared code reduces opportunities to diverge; required checks and review determine what can merge.

**Current status:** the accepted reference pack lives in this repository at `docs/design/plexus/`. The root [AGENTS.md](../../../AGENTS.md) loads this workflow; the existing [CLAUDE.md](../../../CLAUDE.md) symlink resolves to the same root instructions. Production UI remains in [apps/web/](../../../apps/web/), shared by browser and Electron. This pack does not migrate that UI or connect its simulated behavior to the runtime.

## Repository contract and current checks

Use the version of this pack committed with the task's checkout. Its guides, `design/` contracts and captures, `src/` reference implementation, and `public/assets/` brand/font assets travel together. The nested React/Vite app is an optional isolated preview, not a second production renderer. Do not commit its `node_modules/` or build output.

Run **`npm run check:design` from the repository root** when changing these references or their instruction wiring. Run this check locally; GitHub Actions is disabled for this repository. It verifies reference-pack integrity: required references and wiring, contract/token structure, and synchronized gallery exports. It does **not** establish visual fidelity, behavior coverage, production adoption, or required branch protection. A passing check is not proof that an agent followed the screen design.

The remaining production work is to consolidate tokens and common UI anatomy in the shared renderer, establish deterministic production fixtures, and add targeted behavior and visual checks. Record real shared-module paths here as those changes land; do not invent imports before modules exist. Repository maintainers must configure any required checks or design-owner review separately before treating them as merge gates.

For each agent client, verify that a fresh task loads the root instruction. A client using another instruction filename should get a short pointer to `AGENTS.md`, not a separately maintained copy of the rules. Include the relevant references in delegated tasks. Keep the current [product specification](../../planning/product-spec.md), root [domain language](../../../CONTEXT.md), and [ADRs](../../adr/) authoritative for product behavior; the visual pack never grants an unsupported capability.

## Before changing a screen

Read these references, relative to this document:

- [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md): typography, layout, responsive behavior, and shared anatomy.
- [design/plexus-app.tokens.json](design/plexus-app.tokens.json): values to map into the shared production tokens.
- [design/screen-templates.json](design/screen-templates.json): screen-to-template mapping, required slots, states, and semantic rules.
- [DEVELOPMENT-HANDOFF.md](DEVELOPMENT-HANDOFF.md): actual renderer/protocol boundaries and the first integration slice.
- The applicable accepted screenshots under [design/qa/](design/qa/), opened as images. Text descriptions alone are insufficient for visual work.

Then give a short task-specific design contract in the implementation plan: **screen and template IDs; existing components to reuse; states affected; reference captures; checks to run**. This is an implementation record, not a new approval round. Resolve routine choices using the selected design and continue.

For example: “Approval uses `shell` + `decision`. Preserve request, scope, evidence, actions, and receipt. Cover pending, settled elsewhere, expired, host unavailable, and missing grant. Reuse shared status/button/dialog primitives. Compare the approval capture at the fixed desktop viewport.”

## While implementing

- **Extend the selected design.** Direction 3, Review together, is the accepted app language. Retain Outfit, supplied Plexus assets, quiet dark surfaces, restrained lime, flat pane divisions, and the documented drawer behavior. Routine tickets do not trigger new branding, layout randomization, marketing sections, or a framework migration.
- **Use shared code.** Reuse the production token and component layer. Add a reusable variant there before consuming it in another screen. Prototype private `m-*` helpers and literal CSS values require consolidation during extraction; copying them into every screen would preserve duplication.
- **Honor the template.** Account for each applicable required slot and state. A slot can occupy an existing region. Hide or disable unavailable actions with an explanation, and show an empty/missing-evidence state when data is absent. Do not fabricate content to satisfy a slot.
- **Preserve product meaning.** Responsibility, execution host, provider, grants, and actor are separate. Host loss leaves execution potentially unknown. Agent instructions retain command/turn identity and receipts. Human help remains separate. Approvals are scoped; handoff preserves the host; summaries open actual sources.
- **Use authoritative state.** Presentation emits intent and renders harness events through an adapter. Never port simulated receipt timers or hard-coded success states into production. Use the canonical protocol; capture eligibility and turn identity at the appropriate boundary.
- **Make changes explicit.** If the feature needs a new pattern, define the contract and shared implementation together and identify the design change in the PR. Do not silently weaken rules or update reference images just to hide a regression. A materially new design decision needs product/design review; routine implementation does not.

## Before calling the task done

1. Run the affected behavior checks, including the applicable unavailable/pending/stale/settled states. The contract's state list is an inventory, not an implemented test suite.
2. Render the changed screen with stable fixtures, bundled fonts, fixed time, and nonessential motion disabled. Capture at **1487 × 1058** and **390 × 844**, with the appropriate drawer states. Check **1024 × 900** when intermediate layout behavior changes.
3. Compare the actual captures with the accepted references at the same state and scale. Inspect both the full screen and important details. Fix clipping, unreadable controls, lost context, and meaningful layout/type/state drift before reporting completion. Report blocked visual verification honestly.
4. Run `npm run check:design` from the root when changing the reference pack or its wiring, then run the relevant existing harness checks. Preserve unit, protocol, multiplayer E2E, and desktop checks; name what ran and what could not run. The prototype's packaging tests do not substitute for them.
5. Provide the template IDs, shared components reused or changed, state coverage, screenshot paths, test results, and intentional deviations in the PR. An independent reviewer checks the contract and evidence against the change.

## What makes the rules enforceable

| Layer | What to put in place | Limit |
| --- | --- | --- |
| Repository instructions — installed | Root `AGENTS.md`, the `CLAUDE.md` pointer, and this workflow | Agents can overlook or misunderstand instructions; verify discovery per client. The files alone cannot prevent a merge. |
| Reference integrity — installed | Local `npm run check:design` | Checks pack structure, links/wiring, and exports; does not inspect rendered pixels or production behavior. It is not automatically a required merge gate. |
| Shared implementation — production work | One token source and common controls/templates; keep transport outside presentation | Only effective once screen implementations actually use it. |
| Production static checks — future work | After extraction, prohibit new raw design literals in screen styles outside documented exceptions; constrain shared-component imports and validate template metadata against a real schema | Lint can catch structural drift, not judge design quality. The supplied JSON is not currently a schema or validator. |
| Design-specific behavior tests — future work | Use real adapter/protocol fixtures for stale commands, unknown delivery, pending interruption, scope/expiry, grants, and source availability | Coverage must be implemented; a state label alone proves nothing. |
| Visual checks — future work | Deterministic screenshots for affected templates at fixed viewports; fail on reviewed thresholds | Establish production-renderer baselines first. Browser screenshots do not cover every Electron/native behavior. |
| Required review and CI — repository settings work | Make applicable checks required; require design-owner review for token/template/baseline changes | CI checks can be bypassed if repository settings allow it. A baseline update needs independent review. |

Start with the review template and its shared shell. Establish one passing production implementation and fixture before adding broad lint or visual gates. Ratchet enforcement over the migrated screens; avoid a blanket rule that immediately fails on unported legacy code. The remaining screens then inherit the proven shared structure.

## Reusable task prompt

Use this for the initial production slice with the references already in this checkout:

> Implement the Plexus Review screen in the existing shared renderer. Read the repository AGENTS.md and docs/design/plexus/AGENT-DEVELOPMENT.md first. Use the `shell` and `review` contracts, accepted desktop/mobile captures, and existing shared tokens/components. Connect the read-only diff and one attributed correction through the current harness protocol. Cover host loss, stale-turn rejection, and distinct acceptance/delivery receipts. Preserve the current renderer architecture. Before finishing, inspect the rendered screenshots, run applicable tests, and report the contract IDs, reused components, state coverage, evidence paths, and intentional deviations. Do not update design baselines to conceal regressions.

Subsequent tickets use the same form with the relevant screen, contract IDs, behavior, and affected states. Include those references in delegated subtasks as well; a parent agent reading the contract does not demonstrate that each worker did.

## Check that a new agent is following it

Start a fresh task for a small existing-screen change. Before it edits, verify that its plan identifies the correct template, source capture, shared components, and affected states. Afterward, inspect its diff and rendered evidence. If it invents a design or skips visual verification, fix instruction discovery or the workflow before scaling to parallel feature work.

Keep one owner per shared module when agents work in parallel. Workers own named screen files and request shared changes through that owner. This prevents several agents from independently adding almost-identical buttons, status labels, or spacing variants.

## Project-centered alpha extension — 2026-09-15

Issues #65/#66 extend the accepted identity with the founder-approved Mutex-inspired interaction structure. Production uses a project rail, a project-filtered task list/feed and one shared task composer. On desktop above 1100px, the selected encrypted task places its conversation on the left of recorded results. At 1100px and below, the existing results view and explicit discussion drawer remain; at 760px and below, navigation remains a drawer. No general chat, automatic push/sync, preview orchestration or project-wide scheduler is introduced.

The `workspace` screen reuses `shell`; `setup` reuses `shell` + `setup`; selected work preserves all `review`/`decision` slots. Setup progress derives team, host verification/connectivity, selected project and advertised configured Codex state. A local login is not a configured execution capability. Retry and cancellation retain existing setup. A browser directs host-local steps to the desktop owner.

Project/task navigation remembers only opaque encrypted IDs in session storage scoped to account and team, validates them against currently available objects, and restores the selected task through authenticated replay. A draft cannot be sent after changing its project or host. Home-feed status is labeled as last read; selecting a task refreshes its verified history. Host connectivity is shown separately from task state and responsibility.

The original captures under `design/qa/` remain unchanged. Additional production evidence lives in `design/qa/alpha/` and the current validation record is `docs/proofs/project-workspace-alpha.md` at repository root. These captures document the intentional layout extension, not blanket approval of all product states.
