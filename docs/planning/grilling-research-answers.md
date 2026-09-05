# Grilling: research respondent answers

2026-09-05. Actual three-round exchange with the separate questioner agent `/root/yc_timing`. These answers represent the available research, not the founder or interviewed customers. Recommendations are proposed; accepted scope and domain definitions remain unchanged.

## Round 1

### Q1 — Recurring customer need

**Verified report:** a Claude Code user describes trapped debugging/architecture context, duplicated work and lossy summary handoffs. [Issue 40981](https://github.com/anthropics/claude-code/issues/40981). **Hypothesis:** start with technical leads at small startups with several daily agent users, specifically a colleague needing to correct a consequential implementation assumption during feature work. **Unknown:** no reviewed evidence quantifies this episode's frequency, cost or budget ownership in that segment. **Falsifier:** qualified teams cannot recount recurring recent episodes, or existing PR/chat summaries handle them cheaply. **Suggested action:** interview 5–8 teams about actual recent incidents before showing the solution, then observe recurrence; do not treat the segment as validated.

### Q2 — Competitive reason to switch

**Vendor claims:** [Amoeba](https://useamoeba.com/docs/agents/providers) documents owner-only steering and account-changing takeover; [HumanLayer](https://www.humanlayer.dev/) offers local/web collaboration and a free small-team tier; [Superconductor](https://www.superconductor.com/) explicitly markets joint steering. **Hypothesis:** faster useful intervention on an existing local task, with clearly delegated authority and no account/context reconstruction, could win. **Unknown:** superiority has not been demonstrated. Same-host control is already offered elsewhere; privacy is not proof of preference. **Falsifier:** customers achieve equivalent outcomes faster or more cheaply with an alternative. **Suggested action:** compare real intervention tasks against the team's current workflow and one direct competitor, recording both humans' effort and reasons for preference.

### Q3 — Falsifying live collaboration

**Verified evidence:** [Anthropic interruption research](https://www.anthropic.com/research/measuring-agent-autonomy) supports human correction, but does not establish that a second human is necessary. [Portable-conversation request](https://github.com/anthropics/claude-code/issues/10368) supports asynchronous continuity. **Hypothesis:** shared control matters when a teammate spontaneously changes consequential ongoing work without routing instructions through its initiator. **Falsifier:** useful activity is mainly later reading/advice, direct actions happen only during demos, or no team returns voluntarily. **Suggested action:** retain the accepted activation definition but separately count catch-up, delivered steering, delegated approvals, handoff, founder-prompting and following-week return. Fifty manufactured two-person actions do not validate demand; thresholds remain proposed pilot criteria.

## Round 2

### Q4 — Minimum incremental value

**Verified report:** [Issue 10368](https://github.com/anthropics/claude-code/issues/10368) requests portable conversation context for review/continuity; it does not prove direct steering is necessary. **Hypothesis:** the primary benefit may be reconstructing context, not executing through another person. **Discriminating observation:** after receiving equivalent catch-up context, does the teammate voluntarily need direct control because relaying through the owner adds delay or error? **Falsifier:** advice/PR comments resolve incidents equally well and users ignore controls. **Suggested action:** compare naturally occurring, comparable episodes using existing workflow, catch-up/help, and available controls; record waiting, both humans' effort and outcome. Tiny unmatched samples cannot support causal speedup claims. Prioritize catch-up polish while preserving accepted controls.

### Q5 — Switching and privacy cost

**Vendor claim:** [Flowpad](https://flowpad.ai/) positions collaboration around existing CLI sessions; [claude-duet](https://github.com/EliranG/claude-duet) documents continued prior sessions. These are alternatives to a new starting point, not adoption evidence. **Hypothesis:** users may value intervention yet reject changing where tasks start or managing keys. **Discriminating observation:** supported users complete setup and useful solo work, then repeatedly choose native tools for eligible tasks because collaboration setup is not worthwhile. **Unknown:** actual abandonment causes. **Suggested action:** instrument consented stage outcomes and ask exact reasons; separate auth/platform/provider failures from enrollment friction and deliberate workflow preference. Successful setup followed by low voluntary selection deserves adoption work before more provider breadth.

### Q6 — Handoff's real job

**Verified plan constraint:** [build plan](build-plan.md) keeps execution on the original host. **Vendor contrast:** [AQ](https://aq.dev/) advertises persistent VM sessions independent of laptop availability. **Hypothesis:** bounded handoff helps when an owner enters a meeting, disconnects their browser, or delegates a specialist decision while the execution host stays awake. Timezone handoff works only if that machine remains available. **Falsifier:** most desired handoffs coincide with host sleep/quit and customers cannot keep it available. **Suggested action:** observe actual responsibility changes and exercise sleep/quit with explicit state; count blocked versus useful handoffs. Recurrent host blockage requires a founder scope/architecture decision, not relabeling assignment as host-independent continuity.

## Round 3

### Q7 — Smallest evidence package

**Evidence limit:** [the public request](https://github.com/anthropics/claude-code/issues/40981) is qualitative, not validation. **Proposed ten-day run:** days 1–3, a founder-assigned pilot lead interviews 5–8 teams and captures incident/workaround cards; days 4–9, observe naturally occurring episodes with 3–5 qualified teams, using their existing workflow and a safe available prototype; day 10, review stage funnel, incident outcomes, voluntary-return evidence and missing data. Technical owners run feasibility concurrently. **Unknown:** team availability and founder hours. If release gates are unmet, use redacted examples/internal prototypes, not external execution or private-data uploads. No incidents means weak cohort/window evidence, not universal disproof. Continue only with consequential repeat problems; narrow recruitment if those fail to appear.

### Q8 — Joint value and feasibility gate

**Documented capability:** [Codex app-server](https://learn.chatgpt.com/docs/app-server) exposes steering/approval controls; [authentication docs](https://learn.chatgpt.com/docs/auth) do not prove an allowed shared subscription arrangement. **Necessary experiment:** pin a version and demonstrate real two-human delivery, stale rejection, exactly-once approval, interruption, reconnect and host continuity; validate account/control entitlement separately. T02 must demonstrate encrypted enrollment, recovery, revocation and relay-content exclusion; desktop bootstrap must work on both platforms. **Falsifier/blocker:** required controls or permitted authentication unavailable, or plaintext/control exposure contradicting the privacy promise. Stop dependent external release work and choose a supported alternative; do not polish around the gap. Broken setup is not evidence customers reject collaboration. Passing internal experiments is not independent security review.

### Q9 — Evidence to priority changes

**Evidence context:** [portable-context demand](https://github.com/anthropics/claude-code/issues/10368) and [free competitor offering](https://www.humanlayer.dev/) make cheaper substitutes credible, not proven preferable. **Conditional actions:**

| Observation | Proposed action | Decision boundary |
| --- | --- | --- |
| Async catch-up consistently wins | Prioritize catch-up/help and review polish; measure direct control separately | Reordering within scope is fine; removing accepted shared controls needs founder agreement |
| Setup works but users choose native tools | Fix starting-point friction and assess private issue/PR links before more polish | Importing existing sessions changes accepted scope and requires founder decision |
| Handoffs repeatedly blocked by sleeping hosts | Clarify availability; quantify unsuccessful transfers | Remote execution or migration requires architecture/scope approval |
| Useful repeated interventions, no payments | Make one concrete price/entitlement offer; record buyer, alternative and rejection reason | Price remains a founder decision; free reviewers or changed pricing unit require explicit agreement |
| Useful paid repeat collaboration | Continue reliable delivery, onboard the next bounded cohort and validate follow-on providers | Retain accepted constraints; no claim of product-market fit from three teams |

**Unknown/falsifier:** unpaid use after an explicit reasonable offer may reveal insufficient value or the wrong buyer; it is not automatically a pricing problem. Prioritize reliability and evidence before optional breadth, but do not silently abandon Codex-first, E2EE, both desktop platforms, BYOP or provider succession.

## Respondent conclusion

The decisive near-term work is a ten-day, capacity-assigned learning window alongside the already-planned feasibility experiments. The result must distinguish recurring context pain from demand for direct teammate control, and functional setup rejection from defects. No customer demand, comparative advantage, allowed shared subscription arrangement or security guarantee was established by agreement between these two agents. The recommended next priority depends on observed evidence, with scope conflicts returned to the founder explicitly.
