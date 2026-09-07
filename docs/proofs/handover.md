# Reviewing a correction and handing over the task (issue #13)

Implementation for [issue #13](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/13)
(P12), built on [#9](catchup-projection.md)'s projection, [#10](shared-steering.md)'s shared
steering and [#12](help-inbox.md)'s sealed control channel.

## The defect this issue was pointing at

Criterion 4 asks for the task outcome to be recorded **independently from individual turn
status**. It was not. `packages/runtime/encrypted-run.js` translated a turn completing
straight into `task.completed`:

```js
if (method === Events.TURN_COMPLETED) {
  const outcome = event.status === TurnStatus.COMPLETED ? 'completed' : ...;
  return { type: 'task.completed', payload: { outcome } };   // before
}
```

So a task was finished the moment an agent stopped talking — before anybody had looked at
what it did. A teammate opening the catch-up screen mid-review saw "completed". That is the
single most misleading thing a status field can say, and it is precisely what this criterion
exists to prevent.

They are now two events with two meanings:

| Event | Says | Written by |
| --- | --- | --- |
| `turn.completed` | the agent stopped, and how | the host, from the turn |
| `task.completed` | the work is done or is not going to be | a person, and their name is required |

The projection reports both, side by side. A task with a finished turn and no recorded
outcome is **`open`**, and `open` is derived — the log does not say it, it merely fails to say
anything else. The screen shows Status and Last turn as separate facts, so a finished agent
can never quietly pass for finished work.

`task.completed` also carries `by`, required. An outcome with nobody attached is exactly the
kind of unattributed conclusion #9 forbids.

## A second defect, found by playing the scenario out

Criterion 1 asks for a scenario with an original assumption, a **teammate correction**, and a
resulting file change. Running a second turn on the same task fails:

```
TaskReplayError: event_id_conflict
```

Event ids are derived from a running count that restarted at zero for each run, so a second
turn collided with the first turn's events. Nobody had run two turns on one encrypted task
before — which is to say nobody had corrected an agent's work, which is the entire subject of
this issue. The run now continues the log instead of restarting it.

## Handing over

`responsibility.handover` travels on #12's sealed channel and becomes a
`responsibility.changed` event carrying `to`, `from`, `by` and an optional note. The note is
content, so it is encrypted with everything else — a canary scan asserts it never reaches the
relay.

Three things deliberately do not travel with it:

**Project access.** A recipient must already hold a grant; handing work to somebody without
one is refused with `recipient_not_in_project` and nothing is written. Access is granted
deliberately, never inherited from being handed a task.

**Approval authority.** The hub's approver set is untouched, and the test asserts the exact
before/after.

**The host and whose provider account pays.** The fleet descriptor is byte-identical before
and after, and the projection keeps reporting the same execution host and provider. The
screen shows the new owner *and* the unchanged host, which is what criterion 2 asks for: a
handover that quietly moved whose account was being billed would be a surprise, not a feature.

Responsibility also moves from context into the log. Once somebody has handed a task over,
`responsible` is `recorded` and points at the event — and it outranks whatever the screen was
told, the same rule the provider follows.

## Recording an outcome

`task.outcome` requires a live project grant, so somebody outside cannot close another team's
work (`sender_not_in_project`). It is recorded once: a second attempt is refused with
`task_already_settled` and the first outcome stands, because two people disagreeing about
whether something is done is a conversation, not a race to write last.

## The criteria

**1 · the complete scenario, navigable** — met. The test plays it: an agent acts on the
original objective and changes a file, a teammate corrects it, the correction is recorded and
attributed, a second turn changes the file again, and the resulting projection carries the
objective, the changes and the correction with **every one of its 8 source references
resolving** to an event the endpoint accepted.

**2 · handoff changes responsibility only, and shows the unchanged owner** — met, asserted by
comparing the approver set and the host descriptor across the handover and by checking the
projection still reports the same host and provider.

**3 · recipient must already have project access; no silent approval rights or credentials**
— met, by attempting the handover to somebody without a grant and asserting nothing was
written.

**4 · outcome recorded independently of turn status; reuse the diff experience** — met. The
conflation is fixed and asserted from both directions. No editor or Git replacement was
added; the projection's existing `changes` field is what the screen renders.

## Reproduce

- `npm run test:handover` — 11 checks: the scenario, the turn/task separation from both
  sides, the refused handover, the handover itself with its note, the approver-set and
  host-descriptor comparison, the outcome recorded once and only by a participant, and the
  relay canary scan.
- `npm run test:catchup:encrypted` — the app shows Status and Last turn as separate facts.

## Limits

The handover surface exists on the client (`handOverResponsibility`) and in the log, but the
app has no button for it yet — the catch-up screen displays who is responsible and does not
yet offer to change it. That is UI work on a settled contract rather than an open question.

A handover does not notify the recipient. It appears when they next read the task, like
everything else the host records; #12's inbox covers questions, not ownership changes.
