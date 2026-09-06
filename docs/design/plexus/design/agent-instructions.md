## Plexus app design contract

For UI work in the shared Plexus renderer, desktop shell, or shared UI modules, read `docs/design/plexus/AGENT-DEVELOPMENT.md` before editing. That guide links the accepted design, tokens, screen contracts, and development boundaries. This path assumes the reference pack has been installed at `docs/design/plexus/`.

Before implementing, name the screen/template IDs, existing shared components, affected states, reference captures, and intended checks in the task plan. Pass the same references into delegated UI subtasks.

Extend the accepted Review together design. Reuse shared tokens and components; preserve required template content and product state semantics. Keep browser and Electron on the shared renderer. Use authoritative harness events, never prototype receipt timers, for production behavior.

Before reporting completion, inspect rendered screenshots against the accepted references, run applicable checks, and report state coverage, evidence paths, results, and intentional departures. Do not change visual baselines or design contracts merely to make a regression pass. If a check cannot run, say so explicitly.
