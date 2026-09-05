# Research-backed product grilling

Date: 2026-09-05. Requested as a separate discussion between two subagents: one questioner and one research respondent. This session stress-tests the [product-validity assessment](product-validity-assessment.md); it does not impersonate customers or reopen founder decisions by inference.

## Method

The questioner sends a round of frontier questions to the respondent. The respondent answers from the existing research and separates evidence, inference, uncertainty, and proposed experiments. Later questions depend on the actual answers. The discussion is bounded to three rounds, followed by a synthesis by the primary agent.

The questioner owns [the questions and challenges](grilling-research-questions.md); the respondent owns [the evidence-backed answers](grilling-research-answers.md). Their agreement is analytical agreement, not evidence of customer demand.

## Accepted constraints preserved

- Everyday development for small startup teams; own team and assisted external pilots first.
- Codex first, followed by Claude Code and Cursor; supported customer subscription/API authentication.
- Tasks begin through the product; execution stays on one visible host after responsibility handoff.
- Packaged macOS and Windows applications plus web participation.
- Private invited teams, explicitly shared projects, and separately delegated action approvals.
- E2EE collaboration content with customer-controlled recovery; browser code-delivery and inference-provider boundaries must remain explicit.
- Individual-seat pricing with price deferred; target 50 activated people and three paying teams.
- Variable founder capacity. Calendar targets are not validated effort estimates.

Any recommendation to change these is a proposal for founder review, not an accepted ADR or plan change.

## Evidence audit rubric

1. **Investment interest is not demand.** YC's request establishes the category thesis, not willingness to use or buy this product.
2. **Individual supervision is not multi-human demand.** Research about users correcting their own agents cannot establish a need for teammates to control the same session.
3. **Published features are not tested outcomes.** Competitor documentation establishes overlap, not reliability, customer satisfaction, revenue, or proof of an unserved gap.
4. **A public complaint is a qualitative signal.** It does not establish frequency or representative market size; it may be solved by a simpler workflow.
5. **Technical support is not permission to pool entitlements.** Provider control APIs and authentication must be assessed separately from the allowed customer billing arrangement.
6. **Security building blocks are not a reviewed product.** E2EE implementation, endpoint trust, recovery, and malicious-relay behavior need their own validation.
7. **Responsibility handoff is not host-independent continuation.** Browser departure, runtime disconnection, and moving execution are distinct events.
8. **A proposed pilot threshold is not an industry benchmark.** Small-sample observations guide the next decision; they do not prove causal productivity or product-market fit.

## Scope of output

The useful result is a shortlist of defensible conclusions, unresolved hypotheses, and experiments that could change implementation priority. The session does not publish GitHub issues, alter accepted product scope, or claim customer validation.


## Session synthesis

Completed three actual question-and-answer rounds, covering nine challenges. Later questions were based on the respondent's previous answers. The dialogue did not establish new customer behavior or change accepted scope.

The strongest remaining hypothesis is that the product reduces the time and effort needed for a second person to make a consequential intervention. The research does not yet show that direct control adds enough benefit beyond equivalent catch-up context, or that customers prefer this implementation over alternatives.

### Three comparisons that matter

1. **Equal context, different control:** give participants equally useful catch-up information, then observe whether direct control improves the outcome over advice relayed through the owner. This separates the value of context from the value of the steering button.
2. **Successful setup, voluntary choice:** first establish that the supported account, installation, and first task work; then see whether people choose this product for eligible work. A setup defect and a rejected workflow need different remedies.
3. **Actual host availability:** observe real responsibility transfers with the host dependency visible. Measure when handoff works and when sleep/quit prevents it; do not substitute assignment metadata for continuity.

### Proposed next experiment

A ten-day, founder-assigned learning window alongside T01/T02 and desktop bootstrap work: interview 5–8 reachable teams about recent incidents, observe naturally occurring episodes with 3–5 qualified teams, and review evidence on day ten. These are proposed targets, not commitments or customer availability claims. Before external release gates pass, use existing workflows and internal/redacted prototype demonstrations rather than unready external execution or private-data uploads. Lack of incidents in a short window is limited cohort evidence, not proof that no market exists.

| Observed result | Recommended next priority |
|---|---|
| Catch-up solves the problem; direct control is rarely needed | Improve catch-up/help/review; revisit removing control only with the founder |
| Setup works, but users repeatedly choose native tools | Reduce task-start friction and investigate why; do not assume another adapter fixes it |
| Useful handoffs repeatedly fail because the host is unavailable | Quantify the limitation and bring execution architecture back for a founder decision |
| Teams return and benefit but decline a concrete paid offer | Investigate buyer, alternative, entitlement and price; do not assume pricing alone is wrong |
| Independent teams return and pay for consequential collaboration | Expand the next bounded cohort and validate follow-on providers |

### Primary-agent evidence audit

The exchange kept documented facts, vendor claims, hypotheses, and unknown customer behavior separate. No competitive superiority, market validation, shared-subscription permission, or security guarantee was established by agent agreement. Interpret round 3's phrase “exactly-once approval” as one authoritative approval resolution with deduplicated command acceptance; it is not an exactly-once guarantee for arbitrary shell side effects after a crash.

The knowledge frontier now consists of customer experiments and technical validation. It does not require another open-ended founder questionnaire. The agents' proposed priority changes remain recommendations; the accepted plan and tickets were not modified.

## Full alternating transcript

The questions below are the questioner's actual messages as recorded in its question log; each is followed by the other subagent's recorded answer. Provisional questioner recommendations are preserved so they can be distinguished from the research respondent's position.

### Round 1

**Questioner**

❓ **Q1 — Recurring customer need:** Which narrow buyer/work episode can justify a separate product, and what establishes its frequency beyond the founders' thesis?

➡️ Provisional recommendation: technical leads in small startups with several daily agent users, facing recent consequential correction/context-reconstruction episodes; frequency is unproven and must be observed.

**Research respondent**

**Verified report:** a Claude Code user describes trapped debugging/architecture context, duplicated work and lossy summary handoffs. [Issue 40981](https://github.com/anthropics/claude-code/issues/40981). **Hypothesis:** start with technical leads at small startups with several daily agent users, specifically a colleague needing to correct a consequential implementation assumption during feature work. **Unknown:** no reviewed evidence quantifies this episode's frequency, cost or budget ownership in that segment. **Falsifier:** qualified teams cannot recount recurring recent episodes, or existing PR/chat summaries handle them cheaply. **Suggested action:** interview 5–8 teams about actual recent incidents before showing the solution, then observe recurrence; do not treat the segment as validated.

**Questioner**

❓ **Q2 — Competitive reason to switch:** Given Amoeba/HumanLayer/Superconductor overlap, what single outcome could make this better than an existing/free alternative or current workflow, and what evidence currently demonstrates that superiority?

➡️ Treat faster useful teammate intervention with accountable same-host control as a hypothesis; compare actual tasks rather than feature lists.

**Research respondent**

**Vendor claims:** [Amoeba](https://useamoeba.com/docs/agents/providers) documents owner-only steering and account-changing takeover; [HumanLayer](https://www.humanlayer.dev/) offers local/web collaboration and a free small-team tier; [Superconductor](https://www.superconductor.com/) explicitly markets joint steering. **Hypothesis:** faster useful intervention on an existing local task, with clearly delegated authority and no account/context reconstruction, could win. **Unknown:** superiority has not been demonstrated. Same-host control is already offered elsewhere; privacy is not proof of preference. **Falsifier:** customers achieve equivalent outcomes faster or more cheaply with an alternative. **Suggested action:** compare real intervention tasks against the team's current workflow and one direct competitor, recording both humans' effort and reasons for preference.

**Questioner**

❓ **Q3 — What would falsify live collaboration:** What observation would distinguish need for shared live control from asynchronous catch-up alone, and prevent 50 staged activations being mistaken for demand?

➡️ Separate spontaneous direct intervention, passive catch-up, founder-prompted use, and subsequent-week return. Preserve the activation definition but do not use it as the sole gate.

**Research respondent**

**Verified evidence:** [Anthropic interruption research](https://www.anthropic.com/research/measuring-agent-autonomy) supports human correction, but does not establish that a second human is necessary. [Portable-conversation request](https://github.com/anthropics/claude-code/issues/10368) supports asynchronous continuity. **Hypothesis:** shared control matters when a teammate spontaneously changes consequential ongoing work without routing instructions through its initiator. **Falsifier:** useful activity is mainly later reading/advice, direct actions happen only during demos, or no team returns voluntarily. **Suggested action:** retain the accepted activation definition but separately count catch-up, delivered steering, delegated approvals, handoff, founder-prompting and following-week return. Fifty manufactured two-person actions do not validate demand; thresholds remain proposed pilot criteria.

### Round 2

**Questioner**

❓ **Q4 — Minimum incremental value:** If the discriminating behavior is consequential ongoing intervention, how would you test whether a concise catch-up view plus request-for-help/PR context solves the incident just as well without steering?

➡️ Compare naturally occurring comparable episodes using the existing workflow, catch-up/help, and available live controls. Record waiting, both humans' effort, and outcome. Avoid causal productivity claims from tiny cohorts. Keep accepted controls while evidence ranks polish and expansion.

**Research respondent**

**Verified report:** [Issue 10368](https://github.com/anthropics/claude-code/issues/10368) requests portable conversation context for review/continuity; it does not prove direct steering is necessary. **Hypothesis:** the primary benefit may be reconstructing context, not executing through another person. **Discriminating observation:** after receiving equivalent catch-up context, does the teammate voluntarily need direct control because relaying through the owner adds delay or error? **Falsifier:** advice/PR comments resolve incidents equally well and users ignore controls. **Suggested action:** compare naturally occurring, comparable episodes using existing workflow, catch-up/help, and available controls; record waiting, both humans' effort and outcome. Tiny unmatched samples cannot support causal speedup claims. Prioritize catch-up polish while preserving accepted controls.

**Questioner**

❓ **Q5 — Switching and privacy cost:** Given a hypothesis-only advantage, what would show that starting tasks here and enrolling encrypted devices costs more than the benefit? Can you isolate that from provider/setup defects rather than interpreting every abandoned signup as rejection of collaboration?

➡️ Observe the funnel: compatible account → install/enroll → first solo task → voluntary eligible task selection → invite → useful intervention. Collect the exact abandonment reason. Retain desktop/E2EE constraints; do not presume buyers prefer them.

**Research respondent**

**Vendor claim:** [Flowpad](https://flowpad.ai/) positions collaboration around existing CLI sessions; [claude-duet](https://github.com/EliranG/claude-duet) documents continued prior sessions. These are alternatives to a new starting point, not adoption evidence. **Hypothesis:** users may value intervention yet reject changing where tasks start or managing keys. **Discriminating observation:** supported users complete setup and useful solo work, then repeatedly choose native tools for eligible tasks because collaboration setup is not worthwhile. **Unknown:** actual abandonment causes. **Suggested action:** instrument consented stage outcomes and ask exact reasons; separate auth/platform/provider failures from enrollment friction and deliberate workflow preference. Successful setup followed by low voluntary selection deserves adoption work before more provider breadth.

**Questioner**

❓ **Q6 — Handoff's real job:** If the owner's absence also makes their laptop unavailable, what remaining handoff scenario actually works, and how will you test whether that bounded scenario is frequent enough?

➡️ Test actual meeting/timezone/task-owner transitions with disclosed host dependency and a planned sleep/quit interruption. If useful handoffs mostly require independent execution availability, flag architecture reconsideration for founder approval rather than strengthen the marketing claim.

**Research respondent**

**Verified plan constraint:** [build plan](build-plan.md) keeps execution on the original host. **Vendor contrast:** [AQ](https://aq.dev/) advertises persistent VM sessions independent of laptop availability. **Hypothesis:** bounded handoff helps when an owner enters a meeting, disconnects their browser, or delegates a specialist decision while the execution host stays awake. Timezone handoff works only if that machine remains available. **Falsifier:** most desired handoffs coincide with host sleep/quit and customers cannot keep it available. **Suggested action:** observe actual responsibility changes and exercise sleep/quit with explicit state; count blocked versus useful handoffs. Recurrent host blockage requires a founder scope/architecture decision, not relabeling assignment as host-independent continuity.

### Round 3

**Questioner**

❓ **Q7 — Smallest evidence package:** What bounded 10-day validation run can yield a continue/narrow/reconsider decision before most delivery work is sunk? Specify recruitment, artifacts, owner role, and missing-data treatment.

➡️ Interview 5–8 teams about recent incidents, recruit 3–5 qualified teams, observe naturally occurring incidents rather than forcing a quota, baseline the workaround, distinguish assisted/spontaneous use, and hold a dated review. No incidents speaks to this cohort/window, not universal absence of need. A founder must assign pilot ownership and time; do not invent availability.

**Research respondent**

**Evidence limit:** [the public request](https://github.com/anthropics/claude-code/issues/40981) is qualitative, not validation. **Proposed ten-day run:** days 1–3, a founder-assigned pilot lead interviews 5–8 teams and captures incident/workaround cards; days 4–9, observe naturally occurring episodes with 3–5 qualified teams, using their existing workflow and a safe available prototype; day 10, review stage funnel, incident outcomes, voluntary-return evidence and missing data. Technical owners run feasibility concurrently. **Unknown:** team availability and founder hours. If release gates are unmet, use redacted examples/internal prototypes, not external execution or private-data uploads. No incidents means weak cohort/window evidence, not universal disproof. Continue only with consequential repeat problems; narrow recruitment if those fail to appear.

**Questioner**

❓ **Q8 — Joint value and feasibility gate:** Which technical result is necessary to interpret a pilot fairly, and which failure stops dependent work? Address supported billing/control authority, real approvals/steering, encrypted enrollment/recovery, and host continuity.

➡️ Run T01/T02 and desktop bootstrap alongside research. Distinguish unavailable controls or broken setup from rejection after successful use. Provider/auth feasibility or privacy failure blocks external claims/release. Missing a date does not justify bypassing the gate; technical documentation is not a passing experiment.

**Research respondent**

**Documented capability:** [Codex app-server](https://learn.chatgpt.com/docs/app-server) exposes steering/approval controls; [authentication docs](https://learn.chatgpt.com/docs/auth) do not prove an allowed shared subscription arrangement. **Necessary experiment:** pin a version and demonstrate real two-human delivery, stale rejection, exactly-once approval, interruption, reconnect and host continuity; validate account/control entitlement separately. T02 must demonstrate encrypted enrollment, recovery, revocation and relay-content exclusion; desktop bootstrap must work on both platforms. **Falsifier/blocker:** required controls or permitted authentication unavailable, or plaintext/control exposure contradicting the privacy promise. Stop dependent external release work and choose a supported alternative; do not polish around the gap. Broken setup is not evidence customers reject collaboration. Passing internal experiments is not independent security review.

**Questioner**

❓ **Q9 — Explicit priority changes:** Give an evidence→action map for async wins; functional setup but native tools win; host-blocked handoff; repeated valuable intervention without payment; and paid repeat use. Which actions remain within scope and which need founder approval?

➡️ Reorder catch-up/onboarding and pause optional expansion within scope; test a concrete price before economic conclusions. Escalate actual architecture/scope conflicts. Preserve Codex-first, E2EE, both desktop platforms, BYOP, and provider succession until explicitly changed.

**Research respondent**

**Evidence context:** [portable-context demand](https://github.com/anthropics/claude-code/issues/10368) and [free competitor offering](https://www.humanlayer.dev/) make cheaper substitutes credible, not proven preferable. **Conditional actions:**

| Observation | Proposed action | Decision boundary |
| --- | --- | --- |
| Async catch-up consistently wins | Prioritize catch-up/help and review polish; measure direct control separately | Reordering within scope is fine; removing accepted shared controls needs founder agreement |
| Setup works but users choose native tools | Fix starting-point friction and assess private issue/PR links before more polish | Importing existing sessions changes accepted scope and requires founder decision |
| Handoffs repeatedly blocked by sleeping hosts | Clarify availability; quantify unsuccessful transfers | Remote execution or migration requires architecture/scope approval |
| Useful repeated interventions, no payments | Make one concrete price/entitlement offer; record buyer, alternative and rejection reason | Price remains a founder decision; free reviewers or changed pricing unit require explicit agreement |
| Useful paid repeat collaboration | Continue reliable delivery, onboard the next bounded cohort and validate follow-on providers | Retain accepted constraints; no claim of product-market fit from three teams |

**Unknown/falsifier:** unpaid use after an explicit reasonable offer may reveal insufficient value or the wrong buyer; it is not automatically a pricing problem. Prioritize reliability and evidence before optional breadth, but do not silently abandon Codex-first, E2EE, both desktop platforms, BYOP or provider succession.
