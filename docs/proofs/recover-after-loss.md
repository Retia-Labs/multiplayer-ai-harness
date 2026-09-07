# Recovering after a disconnection or a restart (issue #17)

Implementation for [issue #17](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/17)
(P16), built on [#10](shared-steering.md)'s steering and [#11](approval-grants.md)'s approval
resolution.

## The defect this issue was pointing at

A host that vanished mid-turn left the thread marked **active on every client, forever**.

The hub did two of the three things correctly: it failed the pending command with "runtime
offline; execution outcome may be unknown", and it marked the runtime offline. It then went on
telling every client that a turn was running on a machine that was not answering — and when
the host came back it re-announced that same stale status, because the runtime re-upserts its
persisted threads on reconnect.

So a crash looked exactly like work in progress, and there was no way to tell them apart.

## Connectivity is not an outcome

The fix is a third status. `unknown` says the host went away while this was running, and it is
the only honest answer available at that moment:

| Saying | Claims |
| --- | --- |
| `active` | the work is still running on a machine that is not answering |
| `idle` | it stopped — which reads as **finished** |
| `unknown` | the host went away; whether it finished is not known here |

`idle` is the dangerous guess, because nobody reads "idle" as "we lost contact". The status
carries `wasRunning` (the turn id) and `since`, and the pending approval is withdrawn with it —
answering a request whose host is gone cannot authorise anything, and leaving the prompt up
invites somebody to try.

## The host says what it can account for

A turn lives in a process. When the process ends the turn ends with it, so a thread the host
persisted as `active` with no live session behind it is a thread whose turn was **abandoned**.
`reconcileAfterRestart()` records that before the host re-announces anything, and
`turn/abandoned` goes on the thread's own event stream — so a teammate reading the history
later sees what happened rather than an unexplained gap between a turn starting and the next
one beginning.

`lastTurnStatus` reads `abandoned`, not `completed`. Nobody should read a crash as a result.

## A regression this work caused, and the test caught

The first version of `reconcileAfterRestart()` cleared `openApprovals`. That destroyed a
distinction #11 had been careful about: answering a request the host genuinely issued should
say `approval_stale_after_restart`, and answering an id it never issued should say
`unknown_approval_request`. With the record cleared, the first collapsed into the second — the
host telling somebody who answered a real question that they had invented it.

Outstanding requests now move to `abandonedApprovals` instead of being forgotten, and both
answers survive a restart. The acceptance test asserts each separately.

## And one inconsistency between layers

The hub answered `command_already_in_progress` for an id reused with different input, while
the host answered `command_id_conflict` for the same situation. The hub's was wrong in a way
that matters: it sends somebody looking for work that is running when the problem is the id.
Two layers answering the same question differently is how a caller learns to ignore both. The
hub now says `command_id_conflict` too.

## The criteria

**1 · persist enough state to reconcile history, provider lifecycle and pending approvals
before controls re-enable** — met. Reconciliation runs before the host re-announces, so
nothing is ever published claiming to be running.

**2 · distinguish host connectivity from task outcome; show confirmed results or unknown
state** — met, and this is where the defect was.

**3 · commands deduplicated; invalid approvals expire; no automatic replay of side-effecting
commands** — met. A re-sent id returns the first answer marked `duplicate` rather than running
again; the same id with different input is refused; an approval whose turn did not survive is
refused rather than applied.

**4 · explicit provider resume path, or recovery-required with an actionable choice; reconnect,
restart, stale response and crash-window scenarios** — met. All four scenarios are in the test.
The Codex adapter resumes on its own session id; the demo backend has no resume path, and a
turn that did not survive is reported as abandoned with the thread usable again rather than
silently retried.

## Reproduce

`npm run test:recover-after-loss` — 11 checks: a turn genuinely parked on an approval, the
host disconnecting, the thread going unknown rather than idle or active, the restart recording
the turn as abandoned in the thread's history, both approval refusals, command deduplication
and the id conflict, a fresh client being told the same story, and the task being usable again.

## Limits

No automatic retry, deliberately. A side-effecting command whose completion nobody witnessed is
not re-sent; the person decides.

`unknown` is set when the host's connection closes. A host that is wedged but still connected
looks active, because from the relay's side it is — that is what #9's freshness is for on the
task view.
