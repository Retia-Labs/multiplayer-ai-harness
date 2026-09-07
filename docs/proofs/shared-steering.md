# Two teammates steering and interrupting one task (issue #10)

Implementation for [issue #10](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/10)
(P09). Control-plane work on the existing turn machinery; no provider integration and no
encrypted-path changes.

## The hole this closes

`turn/steer` enforced its turn binding only when the caller supplied one:

```js
if (cmd.expectedTurnId && cmd.expectedTurnId !== s.turnId) throw new Error(...)
```

Omit the field and the instruction lands on whatever turn happens to be running. That is
exactly what criterion 2 forbids - an instruction written for a turn that has since ended,
silently applied to a different one. Every existing caller already passed the field, so
nothing depended on the looseness; it was a hole nobody had fallen into yet.

Naming the turn is mandatory now, with its own refusals: `turn_binding_required` when the
field is absent, `stale_turn` when it names a turn that is not running.

## A visible message is not delivery

Three different things used to look alike: the message appearing in the transcript, the host
accepting it, and the agent receiving it. They are now distinguishable.

The host assigns each accepted instruction a number in the order it accepted them, so two
people typing at once produce one order and it is the host's - not whichever client rendered
first. The reply states what actually happened:

| Outcome | Meaning |
| --- | --- |
| `queued` | the host accepted it; the running turn will read it on its next model call |
| `queuedForNextProviderTurn` | accepted, but this provider only takes instructions between turns |
| `turn/steer/delivered` | it entered a model call - the first moment the agent has it |
| refusal with a code | not accepted at all, and the reason is specific |

**Queued and delivered genuinely come apart**, which is the sharpest statement of why they
are separate words. The queue is drained at the top of an agent loop that may not run again,
so an instruction accepted while a turn is finishing is accepted and then never delivered.
The test asserts that case rather than the happy one: the host said `queued`, and meant only
that.

A retried command with the same id is answered as a duplicate carrying the original sequence
number, so a retry never takes a second place in the order.

## Interrupting is a request, not an event

`turn/interrupt` used to call `interrupt()` and return `{}`. It now names its turn, returns
`{ state: 'requested', stopping: true }`, and records `turn/interrupt/requested` with the
actor who asked. The hub projects a `stopping` flag on the thread until the turn actually
ends.

**Nothing here claims that work already done has been undone.** A file the agent wrote before
the interrupt is still written; the record says a stop was requested and later that the turn
ended, and the test asserts the log never contains "undone", "reverted" or "rolled back". A
host that has gone offline yields an unknown outcome rather than a success.

## Help goes to a person

Criterion 4 requires that a human help message is never automatically converted into agent
input. There was no help concept in the protocol at all, so `thread/help` and
`thread/help/resolve` are added: recorded, attributed, addressable to a teammate, and
rendered as an open request on the thread.

The separation is structural rather than a check. Text reaches an agent only through
`TURN_START` or `TURN_STEER`; there is no path from a help request into `steerQueue` or any
provider call, and the test asserts the help text never enters that queue and never takes a
place in the instruction order.

Two holes in this feature were found by probing it rather than by the checks that were
already passing, and both are fixed. A request sent with no thread was recorded against a
null thread, so it could never be answered; help now belongs to a thread. And a resolution
naming any invented id was accepted, which put an answer in the log for a question nobody
asked and cleared a real open request while doing it. Open ids are now kept on the thread -
so they survive a host restart - and a resolution is checked against them.

## Authority is current

The host checks authority when the instruction arrives, not when the session began: a
teammate removed from the team is refused (`not_a_member`) on their next instruction, with no
reconnect required. Approval authority remains a separate grant from membership, as #5
established, and is checked on both the hub and the host.

For legacy threads "verified collaborator" means current team membership. Encrypted tasks
carry the stronger requirement - a confirmed endpoint enrolment - through
[#8's contract](teammate-enrollment.md), and that path is unchanged here.

## A shutdown race, found on the way

`session.run().then(...)` wrote to the runtime store after `stop()` had closed it, which
crashed the process on an unhandled rejection whenever a turn was interrupted during
shutdown. The completion now returns early if the runtime is stopping.

## Reproduce

`npm run test:steering` - 22 checks: near-simultaneous ordering and outcomes, attribution,
queued that never becomes delivered, a retry the host accepts exactly once, unbound and stale
instructions, help never becoming agent input, an empty help request, a help request with no
thread, a resolution for a request never made, interrupt binding and lifecycle, the stopping
flag appearing and clearing, an interrupt while a command is executing, no claim of undone
effects, removal taking effect immediately, and an interrupt to a disconnected host.

Two of those checks assert things the earlier ones only appeared to. A retry matching its
original reply does not prove the host refused it, so the host's accepted count is asserted
directly; and a stopping flag that is allowed to be absent proves nothing, so it is asserted
to appear and then clear.

Regressions on this branch: protocol smoke, 16 unit, 68 team boundary, 10 codex acceptance
and multiplayer browser e2e all pass.

## Limits

Delivery is reported when an instruction enters a model call, which is what this host can
observe. It is not a provider acknowledgement: no provider in this repository acknowledges
individual instructions, and claiming otherwise would be the same overstatement this slice
exists to remove. Interruption during tool execution is exercised against the local executor;
a provider-side interrupt acknowledgement arrives with the real provider integration in #7.
