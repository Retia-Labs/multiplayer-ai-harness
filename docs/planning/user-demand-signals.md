# Direct user signals for collaborative agent work

Checked 2026-09-05. These are qualitative public reports, not a representative survey, verified customer interviews, or willingness-to-pay evidence. Issue closure does not establish that a feature shipped or that demand disappeared.

## Signals

1. A Claude Code user reported that debugging and architectural context remained with individual users, creating duplicated effort and difficult handoffs. They requested sharing and optional continuation, and described summary-based transfer as manual and lossy. Filed March 30, 2026; closed as a duplicate. [Issue 40981](https://github.com/anthropics/claude-code/issues/40981)
2. An earlier user requested portable, resumable conversation packages for team knowledge, review, and continuity, including Git integration. Filed October 26, 2025; closed as not planned. This illustrates that the desired outcome may be served by asynchronous context portability rather than simultaneous control. [Issue 10368](https://github.com/anthropics/claude-code/issues/10368)
3. Another user described team-dependent scheduled agents becoming inaccessible when their creator leaves, and requested team ownership and transfer. Filed April 15, 2026; open when checked. This is adjacent evidence for organizational continuity, not direct validation of live coding sessions. [Issue 48322](https://github.com/anthropics/claude-code/issues/48322)

## Implications — product hypotheses

- The clearest direct evidence concerns context, continuity, and ownership. Live co-steering is one possible solution, not yet proved to be the highest-frequency need.
- A transcript alone may not help a late joiner quickly enough. A catch-up view should surface the task objective, accepted decisions, current changes, pending blocker, and intervention opportunity, with links to source events. Generate or derive it on an authorized endpoint to retain E2EE.
- Preserve the existing Git/issue/PR workflow. A link from an issue or PR into the authorized task context may reduce adoption friction; it does not require publishing encrypted task contents to GitHub.
- Test whether teammates need synchronous participation, asynchronous review, responsibility handoff, or true continuation after the original machine goes offline. The accepted first release provides only responsibility handoff on the existing host; do not market that as universal continuity.

## Suggested discovery experiment alongside implementation

Recruit 5–8 reachable startup teams already using coding agents. Ask each to walk through its last actual agent-related handoff, correction, or review bottleneck. Record occurrence, time spent rebuilding context, existing workaround, responsible buyer, and the consequence of doing nothing. Do not begin by asking whether they want multiplayer AI.

Onboard 3–5 qualified teams to the accepted first workflow. Compare measured time-to-understand and time-to-useful-intervention with their previous workflow; observe whether teams return without founder prompting. Make a concrete paid-seat offer once price is chosen. Proposed success/failure thresholds should be agreed before the pilot and treated as experiment criteria, not industry benchmarks.
