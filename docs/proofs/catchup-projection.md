# A sourced, fresh catch-up for a joining teammate (issue #9)

Implementation for [issue #9](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/9),
built on [#6](encrypted-task-replay.md)'s task log and [#8](teammate-enrollment.md)'s
enrolment. #3's review gate is closed (founder review, accepted).

## Design contract

| | |
| --- | --- |
| Screen | `catchup` |
| Templates | `shell` + `evidence` |
| Slots | scope, summary, records, detail, followup |
| States covered | current, stale, unknown, behind, error, empty, source-open, source-unavailable |
| Reference | `docs/design/plexus/design/qa/catchup-desktop.png` |
| Captures | 1487 × 1058 and 390 × 844, `.artifacts/catchup/` |
| Shared code reused | `apps/web/styles.css` tokens, `.mini-btn`, `.mono`, existing badge anatomy |

## What the projection is, and where it runs

`packages/e2ee/catchup.mjs` is a pure function from an accepted task snapshot to the view
model. It runs on an endpoint that has already decrypted the log; no relay computes it, and
no plaintext projection is added anywhere on the server. Three properties are the point:

**Every line carries its source.** Each field records the sequence and type of the event it
came from, and `sourcesOf()` enumerates them so a renderer can prove each one resolves.
`openSource()` returns `source_unavailable` for a reference that does not, which is
information rather than an error to swallow.

**Recorded and derived are never blurred.** A field is `recorded` when the log states it,
`derived` when this code worked it out, `context` when it came from the workspace rather than
the log, and `unavailable` with a reason when nothing supports it. The screen shows that
distinction; it does not tidy it away.

**Nothing invents a human decision.** #6's event vocabulary had no way to say "somebody
decided", so a catch-up built on it could only infer decisions from messages - which is what
this issue forbids. `decision.recorded` is added to the vocabulary for that reason: an
explicit actor, text and optional basis. It is an additive event type; readers on the old
vocabulary refuse unknown types, so a log containing one requires an updated reader. There is
no deployed data, so the protocol version is unchanged.

Approvals are not invented either, and they are no longer absent. `approval.requested` is
now part of the vocabulary, carrying the request id and **the action it would authorise** -
an approval prompt with the action hidden is how people authorise things they did not read.
There is no second event type for the answer: a `decision.recorded` whose `basis` is the
request id is what answers it, which is the same event that records who took responsibility.

Two consequences fall out of pairing them that way. An approval nobody answered stays
outstanding, **including one that expired** - "this expired unanswered" is a true statement
about the log, whereas clearing it would be the projection deciding a request went away
because a clock moved. And a decision naming a request that was never asked for answers
nothing, so an unrelated decision cannot quietly clear a live blocker.

## What the task is stopped on

An outstanding approval outranks the plan's current step as the blocker: a step in progress
is work continuing, and an unanswered approval is work that cannot. Both are `derived` - the
log records a *request*, not a state of being blocked, and marking the blocker as recorded
would put words in the writer's mouth.

The requests themselves are `recorded`, each pointing at the event that asked.

## Which provider touched the code

A creator picks a provider and a host runs one, so a creator naming one is a preference and a
host naming one is a fact. `task.created` is written by the **host** - it quotes the creator's
sealed objective - so the provider is asserted there, as an optional field, and the projection
reports it as `recorded` pointing at that event.

A provider passed in as context loses to one in the log, and the tests assert exactly that by
passing a different one. Without either, the screen says the provider is not recorded rather
than naming one nobody wrote down.

## Freshness

`caught-up` means "through the head the relay advertised", which is not the same as "up to
date with the host": a host that stopped talking to the relay leaves the two looking
identical. So freshness is computed from what the endpoint can honestly claim.

| State | Meaning |
| --- | --- |
| `current` | read through the latest accepted event, host connected |
| `stale` | host connected, nothing has happened for a while - quiet, not lost |
| `unknown` | host not connected, or nothing accepted yet; nothing can be confirmed |
| `behind` | the relay advertises events this endpoint has not accepted |
| `replaying` | still reading |
| `error` | the last catch-up failed; the accepted prefix is still shown |

An empty log reports `unknown`, not `current`. That was wrong in the first implementation and
the rendered capture is what caught it: a screen claiming "Up to date" over an empty task is
the exact failure this slice exists to prevent.

## Late join equals continuous observation

The central claim is checkable and checked: one reader catches up after every append, the way
someone with the tab already open does; another opens the task afterwards and replays from
sequence zero. Their projections are asserted **deep-equal**. Same events, same catch-up,
regardless of when you arrived.

## Rendered states

`apps/web/catchup.js` renders the projection and performs no reduction of its own. Freshness
and provenance never rely on colour alone - each carries its own word and its own explanation,
so the state survives a screenshot and a monochrome display.

Captures in `.artifacts/catchup/`: `catchup-current-1487.png`, `catchup-current-390.png`,
`catchup-unknown-1487.png`, `catchup-stale-1487.png`, `catchup-empty-1487.png`.

### Intentional deviations from the accepted capture

- **Responsible / execution host / provider sit in the scope row**, not a left rail. The
  reference composes them into the shell's sidebar; in the production renderer that space is
  the thread list, so they move into the screen's own scope slot. Same facts, same
  separation, different region.
- **A freshness badge and an explanation line are added.** The reference shows only "Updated
  20s ago", which cannot express disconnected, behind or failed. Criterion 3 requires those.
- **A "Waiting on" section is added** for the current blocker and pending approvals, which
  criterion 1 names and the reference does not show.
- **Reached from a topbar chip**, matching the existing Changes/Audit affordances, rather than
  the reference's Changes/Activity/Catch-up tab strip. The tab strip belongs with the wider
  shell work, not this slice.

## Reproduce

- `npm run test:catchup` - 20 checks: empty projection, sourcing, recorded vs derived, the
  five freshness states, unresolvable sources, the late-join equality over a real encrypted
  log through the paired hub, and the approval pairing - outstanding, answered, expired, and
  a decision naming an unrelated request.
- `npm run test:catchup:encrypted` - 13 checks in real Chromium against **the production
  app**: the browser opens a persistent endpoint and is enrolled, publishes only public keys,
  is shown the host's fingerprint and confirms it, starts an encrypted task, and then reads a
  task the host parked on an unanswered approval - objective, plan, blocker and source links
  all decrypted in the browser, with the relay holding none of it. It then forgets the host
  and asserts the screen falls back to the ceremony with no task content, answers the approval
  and asserts the request is replaced by the attributed decision, and finally runs a second
  task that writes a file so recent changes and a *recorded* completion status are read from a
  real log rather than left unproven by a task that never finishes.
- `npm run test:encrypted-real-task` - includes the approval round trip end to end: a real
  turn asks, a teammate reads the parked task from the log alone, answers it, and the same
  projection stops asking.
- `npm run test:catchup:view` - 7 checks in real Chromium at both viewports: required slots,
  recorded/derived visibly distinct, outcome and activity rendered, unknown, stale and empty
  states, source open and source unavailable, no horizontal clipping, and agreement between
  the browser's source resolver and the projection's `openSource`.

The browser does not load the ESM projection module, so `resolveSource` in
`apps/web/catchup.js` mirrors `openSource`. Two implementations of one rule is a drift risk,
so the view test probes both with the same references and asserts they agree.

## What the screen shows

Scope row: freshness, covered range, responsible, execution host, provider, and the task's
status with its provenance. Then objective, recorded decisions, current plan, recent changes,
what the host reported doing, and what the task is waiting on. Every claim that came from an
event carries a source link that opens that event; a reference that does not resolve renders
as unavailable.

## The app actually reads a task now

`apps/web/encrypted.js` is the browser's own encrypted endpoint: an identity in this
browser's persistent store, published through [#44](https://github.com/Retia-Labs/multiplayer-ai-harness/pull/44)'s key exchange,
announced to #8's enrolment, and used to replay a task [#7](real-encrypted-task.md)'s host
wrote. The app opens it on entering a team, and the enrolment badge stops claiming
"enrollment is not implemented yet" and starts reporting what this device's state actually is.

Three refusals are deliberate:

**It cannot vouch for itself.** It announces and waits. The only exception is an owner
bootstrapping the first endpoint in a team, because there is nobody else to ask.

**It will not read a host it has not been told to trust.** Opening the catch-up screen for a
task written by an unconfirmed host shows the fingerprint and the ceremony, not the task -
and the browser test asserts that *nothing* from the task is on screen at that point. The
relay lists the host's key; a person decides whether it is the right one.

**Its store key is honest about where it lives.** It is in this browser and only this
browser, which is weaker than a desktop's OS-sealed key. Clearing site data destroys the
identity, and #8 treats what comes back as a new device that has to be confirmed again.
`durable: false` is reported rather than silently producing an identity that dies with the tab.

While fixing this, a real gap in #7's host path surfaced: the host read the team's `verified`
verdicts but never recorded them in its own crypto store, so it could not open a creation
request from a creator the team had verified. Tests had been confirming both directions by
hand, which hid it. `EncryptedHost.verifiedEndpoints()` now honours the team's verdict
locally - and drops any endpoint whose directory keys disagree with what the enrolment
recorded, because that disagreement is a finding rather than a detail to smooth over.

## Limits

Generated summaries are not implemented. The issue makes them optional and non-blocking, and
the projection is deterministic without one; adding a model-written summary would need the
authorized-provider relationship that #7 establishes.

No production reference baseline was changed. `npm run check:design` passes.
