# Industry trends assessment

Prepared 2026-09-05 against the draft build plan. Primary studies and first-party telemetry only. No customer validation was conducted here. Competitor inventory and YC requests are deliberately outside this report.

## Assessment

The direction is credible, but the demand for this particular product remains unproven. There is strong evidence of AI coding adoption, consequential human supervision, and a gap between individual efficiency and team outcomes. There is no reviewed evidence that startup teams will routinely join the same running agent, switch their task-starting workflow, or pay separately for shared control.

The strongest near-term hypothesis is **getting the right teammate into an agent task at a consequential moment, with enough shared context to correct or approve it quickly**. “Git was built before agents” is a narrative, not evidence that version control is the customer problem. Measure intervention delay and avoided rework, rather than trying to demonstrate that more participants or more generated code are inherently better.

## Evidence and its limits

### Adoption is broad; agent adoption is a narrower segment

Google's September 23, 2025 summary of DORA's global survey of nearly 5,000 technology professionals reports 90% using AI at work, a median two hours of daily use, and over 80% perceiving a productivity improvement. This establishes a receptive category, not the addressable market for multi-human coding-agent control. It includes roles beyond developers and is respondent-reported, not experimental measurement. [Google/DORA 2025 summary](https://blog.google/innovation-and-ai/technology/developers-tools/dora-report-2025/)

Stack Overflow's 2025 survey distinguishes agents from general AI: 52% of respondents to the agent question did not use agents or used simpler tools (31,877 responses). Among agent impacts, only 17% agreed agents improved team collaboration, versus roughly 70% reporting less time on specific tasks; that question had 12,823 responses. Separately, 66% reported almost-correct AI solutions as a frustration and 45% reported time-consuming debugging (31,476 responses); 75% cited distrust of an answer as a reason to ask a human in a hypothetical advanced-AI future (29,163 responses). These self-selected survey subsets are not a representative census or actual purchasing behavior. Low collaboration impact could mean unmet need, or that collaboration is unnecessary for most tasks. [Stack Overflow survey](https://survey.stackoverflow.co/2025/ai)

### Real intervention exists; long autonomous work is not the median

Anthropic's February 18, 2026 analysis of millions of interactions found Claude Code's 99.9th-percentile turn duration rose from under 25 to over 45 minutes between October 2025 and January 2026, while the median remained around 45 seconds. Experienced users interrupted roughly 9% of turns versus 5% for newer users while also auto-approving more. Its model-classified interruption reasons included missing technical context/corrections (32%); reason clustering used 500,000 interruptions and 500,000 completed turns. This is strong behavioral support for timely correction, but vendor telemetry from one product, with inferred categories and no proof that the correcting person should be a second human. Do not describe the extreme tail as typical agent behavior. [Anthropic agent autonomy](https://www.anthropic.com/research/measuring-agent-autonomy)

METR's time-horizon page, updated May 8, 2026, measures task difficulty in human-expert completion time at a specified success probability. Its suite has over 100 mostly well-specified software/ML/security tasks. A 50% horizon is neither reliable unattended work nor elapsed agent runtime; the page warns estimates above 16 hours are unreliable with its suite. Benchmark progress supports longer-task potential, not a forecast of multi-hour real-team handoffs. [METR time horizons](https://metr.org/time-horizons/)

### Team coordination may matter more, but humans may consult one another less

Anthropic's December 2, 2025 workplace study used an August survey of 132 engineers/researchers, 53 interviews, and internal telemetry. Most respondents reported fully delegating only 0–20% of work; oversight remained important. Engineers described more AI management and review. Yet about half described unchanged team collaboration, while others consulted colleagues less because Claude answered routine questions. This cuts both ways: context-heavy collaboration can be valuable, but adding synchronous group participation may oppose the very independence users value. The sample is one unusually AI-fluent vendor with early tool access, not small startup teams generally. [Anthropic workplace study](https://www.anthropic.com/research/how-ai-is-transforming-work-at-anthropic)

DORA's March 10, 2026 qualitative synthesis says initial generation savings can shift into auditing/verification, and reports an association between greater adoption and both throughput and delivery instability. This supports investigating the whole delivery process. It does not causally establish that shared live control reduces review load, nor that a separate collaboration layer is the best intervention. [DORA: balancing AI tensions](https://dora.dev/insights/balancing-ai-tensions/)

### Productivity evidence is mixed and changing

METR's July 2025 randomized study covered 16 experienced open-source developers and 246 tasks on familiar mature projects: early-2025 AI increased completion time by 19%, despite optimistic perceptions. It is a causal result for that setting, not a general verdict on current agents. [Original study](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)

Its February 24, 2026 update involved 57 developers, 143 repositories, and over 800 tasks. Raw estimates suggested speedups but confidence intervals crossed zero; recruitment/task-selection effects and concurrent-agent time measurement made the estimate unreliable. METR expects larger benefits than its early study but explicitly rejects a confident current effect estimate. Neither “AI still slows everyone” nor “METR proved a 20% current speedup” is justified. [METR study redesign](https://metr.org/blog/2026-02-24-uplift-update/)

METR's May 11, 2026 survey of 349 technical workers (including 87 software engineers) reports median self-reported value gains of 1.4–2× depending on question framing. This supports perceived value, with explicit skepticism about quantitative self-reporting; it is not measured team throughput. No source reviewed here demonstrates willingness to buy an additional multiplayer seat. [METR technical-worker survey](https://metr.org/blog/2026-05-11-ai-usage-survey/)

## What this changes in validation

The following are proposed decision thresholds for a small pilot, not statistically established benchmarks. Keep the accepted privacy and platform promises; run customer research alongside feasibility work rather than waiting for the full release.

| Experiment | Evidence to collect | Proposed decision rule |
| --- | --- | --- |
| Recent-event interviews with 8–10 startup teams already using agents | Last two actual agent-context handoffs/corrections: who needed help, what triggered it, current workaround, delay, rework. Ask for remembered events before presenting the solution. | If fewer than half can name a recent recurring episode, narrow the segment before scaling invitations. |
| Observe 10–20 naturally occurring interventions across 3–5 pilot teams | Time from request to useful contribution; joining teammate's context-reading time; both humans' active minutes; whether work changed; whether it later needed correction. Compare their existing chat/PR/screen-share workflow on comparable tasks. | Continue if several teams repeat voluntarily and at least three can identify a material concrete benefit. Do not infer a causal speedup from unmatched anecdotes. |
| Shared context versus shared execution control | Separate viewing/catch-up, advice to the original owner, direct steering, approval, and responsibility handoff usage. | If most value comes from context viewing with little direct control, emphasize asynchronous context and review; do not force every task into multiplayer. |
| Workflow-switch friction | Fraction of eligible real tasks users choose to start through the product after founder-assisted onboarding; reasons they return to native tools. | Low voluntary starts means onboarding or workflow replacement is a problem even if the demo gets praise. |
| Paid continuation | Give an explicit seat-price offer after useful repeated tasks; record paid invoices, rejected offers, approver, and reasons. | Three paying teams must mean actual paid collaboration access, not free hackathon participation or willingness-to-pay answers. |
| Distribution comparison | Separate own-team, assisted startup, and hackathon cohorts; measure repeat collaboration the following week. | Use hackathons for acquisition/learning, not as a substitute for everyday development retention. |

## Implications for the existing plan

Keep Codex-first, private pilots, attributed intervention, delegated approvals, and responsibility handoff as a focused test. The capability to work longer makes context durability valuable even when collaborators are not online simultaneously. Prioritize a useful catch-up view and explicit request for help over a permanently crowded control room.

Track total human time, completed work, returning teams, and actual payments alongside the 50-user activation target. Activation already requires a second human's delivered intervention; that makes it especially important not to manufacture unnecessary interventions merely to hit the metric. Record spontaneous versus founder-prompted collaboration separately.

No reviewed trend establishes that E2EE, three provider adapters, or simultaneous Mac/Windows/browser availability will drive payment. They may be important trust/access requirements already accepted in the plan, but should not be described as validated market differentiators. Industry evidence justifies running the pilot; only observed customer behavior can validate its exact scope and pricing.
