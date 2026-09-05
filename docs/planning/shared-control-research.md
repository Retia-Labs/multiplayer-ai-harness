# Shared-control research

Research date: 2026-09-05. Primary-source desk research for everyday development in small startup teams. This informs the ongoing interview; recommendations below are inferences, not approved product decisions. No services or provider integrations were tested.

Planning context: approximately 59 days, three founders with variable availability, 50 individual users and a hoped-for three paying startup teams. Individual Claude/Codex/Cursor adapter capabilities are outside this note's scope.

The founder also requires macOS, Windows and web. **Inference:** shared-control semantics should be consistent across clients, with explicit capability/status reporting when a runtime or agent cannot perform an action. This requirement does not itself decide whether browsers are control-only or host execution remotely; that remains a product decision. Do not equate a working macOS host plus browser access from Windows with a native Windows execution runtime unless the founder accepts that scope.

## Findings from existing products

### Collaboration access is distinct from machine execution authority

Live Share separates read-only participation from collaborative terminal use. Hosts create shared terminals and choose whether guests may write; observing a session does not inherently grant shell control. Its security documentation also describes session-scoped guest authorization and encrypted peer transport. [Microsoft Live Share security](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security)

Code With Me distinguishes read-only, file-editing and full-access permissions. Hosts can change permissions per guest, and guests request escalation. Ending the session or exiting the host IDE invalidates the shared link; a guest leaving is distinct from the host ending the session. These are useful host/guest interaction precedents, not evidence of agent delegation. [JetBrains Code With Me user guide](https://www.jetbrains.com/help/ide-services-cloud/getting-started-with-codewithme-for-business.html)

Zed channels retain a team room and notes, while projects are explicitly shared from someone's machine. Channel membership and guest write access are controlled separately; unsharing disconnects project collaborators. Following a collaborator is a view behavior that ends on independent navigation, not a transfer of authority. The cited page does not establish that multiple humans can control the same running agent. [Zed channels](https://zed.dev/docs/collaboration/channels)

### Parallel team tasks already exist; shared-agent intervention needs a sharper promise

Replit documents teammates starting separate Agent threads in the same project, with a shared task board and isolated task copies. Ready changes can be reviewed and applied by teammates. It explicitly distinguishes agent input from team chat: text entered to Agent is actionable, so teammates should communicate elsewhere. The docs describe conflict resolution when applying tasks, not a guarantee that conflicts never arise. This is a direct precedent for team visibility and parallel work, but not a documented arbitration policy for contradictory steering of one running agent. [Replit invite teammates](https://docs.replit.com/build/invite-teammates)

Devin presents a conversational session with an embedded IDE where a human can inspect, edit, run commands and take over work. Its historical release notes separately introduced a pause control and team collaboration in shared sessions. This establishes human intervention and shared sessions as product patterns; the examined pages do not specify simultaneous-human command ordering, competing approvals or automatic transfer when an owner disconnects. [Devin introduction](https://docs.devin.ai/get-started/devin-intro), [Devin 2024 release notes](https://docs.devin.ai/release-notes/2024)

### Generic synchronous collaboration is not enough evidence of demand

JetBrains announced Code With Me's sunset on March 16, 2026, citing changes in collaboration demand and continued engineering cost. The announcement names 2026.1 as its last officially supported IDE release and Q1 2027 for public-service shutdown. Treat its controls as a historical design reference, not a recommended dependency or evidence of a growing category. This single product decision does not establish that multiplayer agent collaboration lacks demand. [JetBrains sunset announcement](https://blog.jetbrains.com/platform/2026/03/sunsetting-code-with-me/)

## Recommended early-access model — inference

**Inference:** aim for a narrow promise: a teammate joins ongoing agent work, understands its current state, contributes a correction or resolves a delegated approval, and the resulting change appears in one attributed history. Avoid requiring a new editor, broad task-management system or cross-machine process migration to demonstrate that benefit.

### Separate the three meanings of control

**Inference:** model these separately in language and permissions:

| Concept | Proposed meaning | Why it matters |
| --- | --- | --- |
| Runtime owner | Person authorizing access to the machine, workspace and provider relationship | Team membership must not silently authorize arbitrary execution on a teammate's machine. |
| Task lead | Person currently responsible for the outcome | Responsibility can move without moving the process or credentials. |
| Participant permissions | Explicit rights to observe, send agent input, interrupt, or answer approvals | A reviewer may need to observe or comment without initiating execution. |

These need not become three separate settings panels. An initial invitation could grant observer or collaborator access, with a separate explicit grant for approving runtime actions. Runtime ownership stays visible. Broader organization policy and custom roles can wait.

### Concurrent participation

**Inference:** allow authorized collaborators to submit input, but present its delivery state accurately: queued, delivered to the agent, rejected because the turn changed, or unsupported by this backend. Attribute each message, assign one authoritative order and bind it to the intended turn. Do not concatenate two simultaneous messages invisibly or imply a message was consumed merely because it entered the chat log.

**Inference:** comments intended for humans should be visibly distinct from instructions sent to the agent. For the pilot, using existing team chat for discussion is acceptable; a broad in-product chat system is unnecessary. Contradictory steering should remain visible and may require a task-lead decision. The agent should not be presented as a reliable policy arbiter.

**Inference:** avoid mandatory exclusive control for every prompt at first: that may reduce the value of everyday shared participation. Introduce an exclusive intervention mode only if the provider cannot support safe input ordering or pilot users repeatedly conflict. This is a hypothesis to test, not an established competitor convention.

### Approvals and interruption

**Inference:** an approval is an explicit, bounded permission to perform a displayed action on a named runtime/workspace. It is not the same as approving a plan, assigning a task, or granting general organization membership. Only a runtime owner or explicitly delegated approver should answer it.

**Inference:** one request should have one accepted resolution. Later clicks receive an already-resolved result naming the decision and actor. Approval must bind to the exact pending action and current execution state; a changed action or restarted agent must not inherit a stale approval. Record requested, resolved and execution-result events separately.

**Inference:** expose interrupt to collaborators whose granted authority includes intervention. Report acknowledged stopping/stopped states; clicking a button must not falsely prove the underlying process and its children have stopped. An unresolved approval should keep work waiting, rather than gain permission because its requester disconnected.

### Handoff and disconnection

**Inference:** ship responsibility handoff first: transfer the task lead with a note and shared history while execution remains on its existing runtime. Label it "Assign" or "Hand off responsibility". Do not promise that the process moves to another computer.

| Event | Proposed early-access behavior — inference |
| --- | --- |
| Task lead closes their browser; runtime stays connected | Continue within existing permission grants; other authorized collaborators can participate. |
| Guest disconnects | Keep the agent's state unchanged; remove presence after connection loss is detected. |
| Runtime loses connection to hub | Display last-known state as disconnected/unknown. Reject new control requests rather than pretending they executed. Locally, do not start new actions dependent on fresh authorization. |
| Already-started local action continues during disconnect | Show that execution is unconfirmed remotely; reconcile its actual result after reconnect. Instant remote cancellation cannot be guaranteed through a lost connection. |
| Runtime process crashes or machine sleeps | Mark interrupted/unavailable after detection. Preserve history and require a supported recovery path; do not present reassignment as recovery. |
| Runtime reconnects | Reconcile current turn, outstanding approvals and event history before enabling control. Do not replay execution commands blindly. |

**Inference:** cross-machine continuation is a separate future feature. It needs a transferable workspace state, reproducible environment, credentials and provider-session compatibility decisions. A new session from a summary and patch can be useful, but must be called a new continuation, not seamless migration.

## Suggested acceptance scenarios — inference

1. Alice starts real agent work; Bob joins later and understands the current turn, pending action and relevant changes without Alice narrating it.
2. Alice and Bob send near-simultaneous steering; both see attribution, authoritative ordering and delivery outcomes.
3. Two delegated approvers answer one request; exactly one resolution wins and the action executes at most once.
4. An observer cannot start work, change execution permissions or approve an action. Revoking a collaborator affects an already-open client.
5. Alice closes her browser while her runtime stays online; Bob continues within the grant. Separately, disconnecting the runtime produces an honest unavailable state.
6. A reconnect preserves prior history, adds missing events and does not repeat actions. An old approval cannot authorize a new action after restart.
7. Assigning the task to Bob preserves its context and clearly names the machine still running it.

## Product decisions still needed

- Do initial collaborators receive steering and interrupt by default, or must the runtime owner enable them separately?
- Is delegated approval part of the first real-agent pilot, or does the first provider limit collaboration to observing and steering?
- Can ongoing work continue without any human watching, and what authority is granted before that happens?
- Is the first activation event two humans participating in a completed real task, or just a shared session created? **Inference:** measure the former, plus repeat team use, to test whether shared control provides value beyond a demo.
- Can three pilot teams identify a recent task where shared context and teammate intervention would have saved time? **Inference:** use those incidents to select the first supported interaction; 50 signups alone will not validate the daily-workflow thesis.

The examined official sources do not settle concurrent steering arbitration, approval races or portable agent execution. Recommendations on those points are original design proposals requiring user decisions and implementation validation.
