# A sourced, fresh catch-up for a joining teammate (issue #9)

Implementation for [issue #9](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/9),
built on [#6](encrypted-task-replay.md)'s task log and [#8](teammate-enrollment.md)'s
enrolment. It inherits #3's open review gate.

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

Approvals are *not* invented in the same way. The log records no approval requests yet, so
the projection says exactly that and the screen prints it. They arrive with the provider
integration in [#7](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/7).

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

- `npm run test:catchup` - 12 checks: empty projection, sourcing, recorded vs derived, the
  five freshness states, unresolvable sources, and the late-join equality over a real
  encrypted log through the paired hub.
- `npm run test:catchup:view` - 6 checks in real Chromium at both viewports: required slots,
  recorded/derived visibly distinct, unknown, stale and empty states, source open and source
  unavailable, and no horizontal clipping.

## Limits

The screen is wired into the production renderer and reachable from a thread's topbar, but
**nothing in the production app yet supplies it with an encrypted task's projection** - the
app has no encrypted-task client, which is #7's integration. Until then it renders the
projection of an empty log, which is an honest screen saying nothing has been recorded rather
than a blank one implying nothing happened. The projection itself is exercised against a real
encrypted log in tests.

Generated summaries are not implemented. The issue makes them optional and non-blocking, and
the projection is deterministic without one; adding a model-written summary would need the
authorized-provider relationship that #7 establishes.

No production reference baseline was changed. `npm run check:design` passes.
