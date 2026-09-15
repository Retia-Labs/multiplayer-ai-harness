# Product planning and implementation

## Current source of truth

- [Alpha/beta execution plan](alpha-beta-execution.md), with the approved project-centered UX, internal alpha and external beta gates, and [new issue manifest](alpha-beta-manifest.json).
- [PR reconciliation](../proofs/alpha-beta-pr-reconciliation.md), identifying existing, superseded and outstanding changes in PRs #61, #63 and #64.
- [Implementation specification](product-spec.md), published as [GitHub issue #1](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/1).
- [Team issue breakdown](team-issue-breakdown.md), with work lanes, story coverage and dependencies.
- [Issue manifest](team-issues/manifest.json), with the publication mapping and complete local issue bodies in the same directory.
- [Plexus design reference and prototype](../design/plexus/README.md), with [agent implementation rules](../design/plexus/AGENT-DEVELOPMENT.md), shared tokens, screen contracts, and accepted captures. These guide presentation; the product spec and ADRs govern behavior.

The spec supersedes earlier drafts where they differ. User interviews and a market-validation exercise are not implementation prerequisites. Preserve technical feasibility, privacy, platform and external-release gates. Readiness labels describe the kind of work; choose issues whose blockers are complete.

## Decisions and supporting evidence

- [Discovery record](product-discovery.md).
- [Domain glossary](../../CONTEXT.md) and [architectural decisions](../adr/).
- [Product-validity assessment](product-validity-assessment.md).
- [YC request assessment](yc-multiplayer-rfs-assessment.md), [competitive landscape](competitive-landscape-assessment.md), [industry evidence](industry-trends-assessment.md), and [direct user reports](user-demand-signals.md).
- [Shared-control research](shared-control-research.md), [Codex research](codex-collaboration-research.md), [Claude/Cursor research](claude-cursor-collaboration-research.md), and [E2EE feasibility](e2ee-feasibility-research.md).
- [Two-subagent grilling session](grilling-research-session.md), including its actual questions, answers and conditional conclusions.

## Historical drafts

[Build plan](build-plan.md), [early PRD](early-access-prd.md), and [original 24-ticket proposal](implementation-tickets.md) preserve the earlier reasoning and schedule. Their proposed interviews and older slicing do not override the current spec or published team issues.
