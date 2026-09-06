# Reference prototype instructions

These instructions govern the isolated preview under `docs/design/plexus/`. For production UI work, follow the repository root `AGENTS.md` and target `apps/web/`; do not edit this preview and claim the desktop product changed.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Selected direction and reusable templates

Before UI work, read `AGENT-DEVELOPMENT.md` and follow its task intake, implementation, and evidence requirements. The contract is already selected; do not generate a new visual direction for routine feature work. Report checks that were not run instead of claiming compliance. The repository root now loads that workflow. Run root `npm run check:design` after changing this pack or its instruction wiring; it checks reference integrity only, not visual or behavioral compliance. Production renderer integration and visual gates remain separate implementation work.

The user selected visual direction 3, “Review together,” on 6 September 2026. Use `design/selected-direction.png` as the visual target: a restrained dark, three-pane workspace with a task rail, read-only review area, and shared discussion. Preserve the Plexus website identity with local Outfit, supplied logo assets, pale-green accent, real Phosphor icons, 5–6px controls, and 5–12px grouped panels. Keep operational screens dense and readable; reserve any showcase scroll effects for the template gallery. At 1100px and below, open discussion as a right drawer; at 760px and below, open navigation as a left drawer rather than stacking either region into the work content.

Read `DESIGN-SYSTEM.md` before adding screens. Reuse the slot/state/semantic contracts in `design/screen-templates.json` and the portable values in `design/plexus-app.tokens.json`. Extend these files when a new reusable pattern is introduced. Refresh matching `public/exports/` copies after editing the tokens, contracts, or design guide so gallery downloads stay current. Use Node 20.19+ within Node 20, or Node 22.12+, to satisfy the installed Vite React plugin.

Keep responsibility, execution host, provider account, and actor attribution distinct. Host connectivity is independent from turn state and task outcome. A responsibility handoff keeps the current execution host. Give agent input a sender, target turn, and delivery receipt; stale-turn commands are rejected. Keep interruption requested until acknowledged. Separate human help from agent input. Approvals cover one named action, with the first valid decision winning. Summaries need inspectable sources.

Project-level access includes existing history and future tasks. Revocation for an unreachable host can remain pending. This prototype implements local sample UI behavior only; do not imply live authentication, command execution, delivery guarantees, encryption, invitation delivery, or access enforcement. Label setup and security-related states as concept behavior.
