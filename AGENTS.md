# Agent Instructions

## Plexus UI design contract

For UI work in `apps/web/`, `apps/desktop/`, or shared UI modules, first read [`docs/design/plexus/AGENT-DEVELOPMENT.md`](docs/design/plexus/AGENT-DEVELOPMENT.md). It links the accepted Review together design, bundled tokens, six screen-template contracts, reference captures, and the runnable prototype. The product specification and domain decisions still govern behavior; a sample screen does not replace them.

Before editing, name the screen/template IDs, shared components to reuse, affected states, reference captures, and intended checks. Pass the same references into delegated UI tasks. Extend the accepted design in the shared web/desktop renderer; keep prototype sample state and receipt timers out of production.

Before reporting completion, inspect rendered screenshots against the accepted references, run applicable checks, and report state coverage, evidence, results, and intentional departures. Run `npm run check:design` when changing the reference pack or its agent entry points. This checks reference integrity; it does not prove visual or runtime correctness. Do not change design contracts or screenshot baselines merely to hide regressions. Report verification that could not run explicitly.

## Agent skills

### Issue tracker

Track issues and product specifications in GitHub Issues for `retia-labs/multiplayer-ai-harness`. See `docs/agents/issue-tracker.md`.

The current implementation specification is `docs/planning/product-spec.md`, published as [GitHub issue #1](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/1). It supersedes earlier planning drafts. User interviews and market-validation exercises are not implementation prerequisites; retain the spec's technical and release gates.

The 28 implementation issues are linked in `docs/planning/team-issue-breakdown.md`. Use their native GitHub blockers when choosing work; readiness labels do not mean dependencies are complete. `docs/planning/README.md` indexes the current docs and historical research.

### Triage labels

Use the default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout: root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
