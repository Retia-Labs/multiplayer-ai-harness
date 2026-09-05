# Research grilling: questions and unsettled tree

Date: 2026-09-05. Actual three-round exchange between research questioner (`yc_timing`) and research respondent (`product_baseline`), requested by the founder. This challenges the [validity assessment](product-validity-assessment.md), not the founder's preferences. Answers are recorded separately in [grilling-research-answers.md](grilling-research-answers.md).

This exchange is desk analysis. Agreement between agents does not validate demand, approve a scope change, or prove technical feasibility. Existing desktop, privacy, execution-host, provider-sequence and activation decisions remain fixed unless the founder explicitly revisits them.

## Round 1: need, competition, falsifiability

❓ **Q1 — Recurring customer need:** Which narrow buyer/work episode can justify a separate product, and what establishes its frequency beyond the founders' thesis?

➡️ Provisional recommendation: technical leads in small startups with several daily agent users, facing recent consequential correction/context-reconstruction episodes; frequency is unproven and must be observed.

❓ **Q2 — Competitive reason to switch:** Given Amoeba/HumanLayer/Superconductor overlap, what single outcome could make this better than an existing/free alternative or current workflow, and what evidence currently demonstrates that superiority?

➡️ Treat faster useful teammate intervention with accountable same-host control as a hypothesis; compare actual tasks rather than feature lists.

❓ **Q3 — What would falsify live collaboration:** What observation would distinguish need for shared live control from asynchronous catch-up alone, and prevent 50 staged activations being mistaken for demand?

➡️ Separate spontaneous direct intervention, passive catch-up, founder-prompted use, and subsequent-week return. Preserve the activation definition but do not use it as the sole gate.

**Answer assessment:** Respondent cited actual context-sharing complaints and provider interruption telemetry, but correctly conceded that neither measures second-human demand or frequency in the chosen segment. No demonstrated competitive superiority was supplied. It proposed recent-incident interviews, actual-task comparisons, and separate behavior classes. These are useful experiments, not settled evidence. The next frontier tests simpler alternatives and adoption costs, because a broad feature bundle is not justified merely by a plausible problem.

## Round 2: simpler alternative, switching cost, bounded handoff

❓ **Q4 — Minimum incremental value:** If the discriminating behavior is consequential ongoing intervention, how would you test whether a concise catch-up view plus request-for-help/PR context solves the incident just as well without steering?

➡️ Compare naturally occurring comparable episodes using the existing workflow, catch-up/help, and available live controls. Record waiting, both humans' effort, and outcome. Avoid causal productivity claims from tiny cohorts. Keep accepted controls while evidence ranks polish and expansion.

❓ **Q5 — Switching and privacy cost:** Given a hypothesis-only advantage, what would show that starting tasks here and enrolling encrypted devices costs more than the benefit? Can you isolate that from provider/setup defects rather than interpreting every abandoned signup as rejection of collaboration?

➡️ Observe the funnel: compatible account → install/enroll → first solo task → voluntary eligible task selection → invite → useful intervention. Collect the exact abandonment reason. Retain desktop/E2EE constraints; do not presume buyers prefer them.

❓ **Q6 — Handoff's real job:** If the owner's absence also makes their laptop unavailable, what remaining handoff scenario actually works, and how will you test whether that bounded scenario is frequent enough?

➡️ Test actual meeting/timezone/task-owner transitions with disclosed host dependency and a planned sleep/quit interruption. If useful handoffs mostly require independent execution availability, flag architecture reconsideration for founder approval rather than strengthen the marketing claim.

**Answer assessment:** The respondent narrowed the control test: give equivalent catch-up context first, then observe whether owner-mediated advice is insufficient. That avoids attributing the benefit of context to the steering button. It distinguished technical onboarding failures from users successfully starting solo work but subsequently choosing native tools. It limited workable handoff examples to an awake host; it withdrew any assumption that timezone transfer works when the owner closes the laptop. Customer preferences and scenario frequencies remain unknown. The next frontier is a bounded experiment with consequences, not additional feature speculation.

## Round 3: evidence package, feasibility, priority decisions

❓ **Q7 — Smallest evidence package:** What bounded 10-day validation run can yield a continue/narrow/reconsider decision before most delivery work is sunk? Specify recruitment, artifacts, owner role, and missing-data treatment.

➡️ Interview 5–8 teams about recent incidents, recruit 3–5 qualified teams, observe naturally occurring incidents rather than forcing a quota, baseline the workaround, distinguish assisted/spontaneous use, and hold a dated review. No incidents speaks to this cohort/window, not universal absence of need. A founder must assign pilot ownership and time; do not invent availability.

❓ **Q8 — Joint value and feasibility gate:** Which technical result is necessary to interpret a pilot fairly, and which failure stops dependent work? Address supported billing/control authority, real approvals/steering, encrypted enrollment/recovery, and host continuity.

➡️ Run T01/T02 and desktop bootstrap alongside research. Distinguish unavailable controls or broken setup from rejection after successful use. Provider/auth feasibility or privacy failure blocks external claims/release. Missing a date does not justify bypassing the gate; technical documentation is not a passing experiment.

❓ **Q9 — Explicit priority changes:** Give an evidence→action map for async wins; functional setup but native tools win; host-blocked handoff; repeated valuable intervention without payment; and paid repeat use. Which actions remain within scope and which need founder approval?

➡️ Reorder catch-up/onboarding and pause optional expansion within scope; test a concrete price before economic conclusions. Escalate actual architecture/scope conflicts. Preserve Codex-first, E2EE, both desktop platforms, BYOP, and provider succession until explicitly changed.

**Answer assessment:** The respondent supplied a finite ten-day proposal and explicit missing-data treatment. It added an important boundary: before external release gates pass, use consented/redacted historical examples and safe internal demonstrations rather than prematurely running customer work. T01/T02 passing is necessary technical evidence, not a substitute for independent privacy review or customer evidence. It mapped each outcome to a priority change and separated those changes from architecture/scope alterations requiring founder approval. We stop after three rounds as requested; the remaining frontier is empirical work and ownership decisions, not something two agents can settle.

**Technical precision:** Any shorthand about an approval happening once means one authoritative approval resolution and deduplicated command acceptance. It does not guarantee exactly-once external shell side effects across a crash; execution reconciliation must preserve that distinction.

## Final unsettled decision tree

1. **Can we reach the proposed buyer and observe recurring consequential incidents?**
   - Unknown: pilot lead, actual founder time, reachable teams, incident frequency/cost, purchase authority.
   - Next step: founder assigns a pilot owner; proposed days 1–3 interview 5–8 teams about recent incidents before a solution pitch. Days 4–9 observe natural episodes in 3–5 qualified teams, subject to safe access gates. Day 10 reviews evidence.
   - No incidents or no recruits: record the exact missing evidence and narrow/recruit differently; do not fabricate activations or generalize to the entire market.
2. **Can the promised experience be tested safely and accurately?**
   - Unknown: pinned provider behavior, permissible account/control arrangement, encryption enrollment/recovery/revocation, installed-platform behavior, continuity.
   - Next step: T01/T02 and desktop bootstrap; record real provider and client versions. Keep an internal or redacted research track if external gates are incomplete.
   - Failure: block dependent external release, investigate a supported alternative, and bring any changed product constraint back for explicit approval.
3. **After equivalent catch-up, does direct control add useful value?**
   - Async solves the episode: prioritize catch-up/help and task links within existing tickets; dropping accepted controls is a separate founder decision.
   - Live intervention adds value: preserve the evidence of what changed, whether the owner could otherwise help, and both participants' effort.
4. **After successful setup, do teams voluntarily start eligible work here?**
   - No: diagnose starting-point friction and workflow fit before broader provider rollout. Existing-session adoption would change accepted scope and requires approval.
   - Yes: measure spontaneous invitations, useful intervention, and subsequent-week return independently of founder assistance.
5. **Does responsibility handoff remain useful with the original execution host?**
   - Host availability repeatedly blocks actual desired work: quantify it; request an architecture decision on a supported alternative. Do not equate reassignment with migration.
   - Awake-host cases recur and work: maintain the bounded promise and use observed cases in positioning.
6. **Will the buyer pay for repeated value?**
   - Valuable repeat use, no payment: make a concrete seat offer after the deferred price is chosen; identify buyer, alternative, budget and objection. A vague willingness question or unpaid invoice is not payment.
   - Paid voluntary repeat use: expand one supportable cohort and improve reliability; proceed with validated provider succession. This still does not establish product-market fit.

## Result of the challenge

The assessment's broad direction survives as a hypothesis, but the recommendation should be sharper: **prove a second person's incremental contribution after catch-up, voluntary task-start behavior after successful setup, and useful handoff under the actual host constraint.** Those observations can change priorities; matching an RFS, passing adapter tests, or reaching assisted activation counts cannot answer them.

The proposed ten-day validation run is a planning recommendation, not an assigned or started customer-research campaign. No outreach, competitor trial, implementation, founder preference change, or market-validation claim occurred in this grilling exchange. The only questioner-owned artifact is this file.
