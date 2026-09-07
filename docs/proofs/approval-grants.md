# Delegating approval rights and resolving an action once (issue #11)

Implementation for [issue #11](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/11)
(P10). Control-plane work on the existing approval path; no provider integration and no
encrypted-path changes.

## What an approval was bound to

Nothing except an id:

```js
resolveApproval(requestId, decision, by)
```

Criterion 1 asks the host to validate "the current verified actor, grant and exact
task/turn/host/action". It validated the actor and the grant, and then accepted any answer
that named a live request id - not the turn it belonged to, and not the action it was
approving.

An answer must now carry the turn and a fingerprint of the exact action, and each way of
being wrong has its own refusal. One code covering a replay, an expiry, a mutated action and
a host restart would hide exactly the differences that matter.

| Code | Raised when |
| --- | --- |
| `not_a_delegated_approver` | the actor holds no approval grant, checked at the hub and again at the host |
| `approval_binding_required` | an answer names an id but not the turn and action |
| `stale_turn` | the answer belongs to a turn that is not the one running |
| `approval_action_changed` | the fingerprint describes a different action than the pending one |
| `approval_request_expired` | the request timed out; the action is declined rather than left hanging |
| `approval_already_settled` | somebody answered first - the refusal names who, and how |
| `approval_stale_after_restart` | the host remembers asking, but the request did not survive it |
| `unknown_approval_request` | nothing is or was pending under that id |
| `approval_scope_unsupported` | a client asked for session-wide approval |

## One resolution, and the loser is told

Two people answering at once is ordinary; being unable to see who won is not. Exactly one
answer is authoritative, the late one is refused, and the refusal names the actor and the
decision - *"approval_already_settled: bob already answered accept"*. The same record reaches
every client as `serverRequest/resolved`, which is where a UI shows it.

Returning success-with-a-flag to the loser was the first design and it was wrong: #2's
existing acceptance check counts exactly one successful resolution, and it was right to.

## Surviving a restart, precisely

Settled answers are recorded on the thread, so a restarted host still knows who approved
what. Outstanding requests are recorded too, and that distinction matters more than it
looks: without it, every answer arriving at a host with no live session got
`stale_after_restart`, including answers naming ids the host had never issued. That invents a
history that did not happen. Now the host says `stale_after_restart` only when it remembers
asking, and `unknown_approval_request` otherwise.

Accepted dispatch is deduplicated - the approved command runs once, not once per answer - but
this makes no general exactly-once claim about shell effects, which the criterion explicitly
does not ask for.

## Session-wide approval is not offered

`ApprovalDecision.ACCEPT_FOR_SESSION` exists in the protocol vocabulary because the Codex
app-server protocol carries it. Nothing in this product implements it:

- `availableDecisions` on every request lists accept, decline and cancel only
- the host refuses `acceptForSession` outright with `approval_scope_unsupported`
- the Codex backend collapses anything that is not `accept` to `decline`
- `policy.js` accepts a `sessionAllowed` set that **no code path populates**, and now says so

That last one was the live risk: a dead switch that would grant session-wide approval the
moment somebody wired it, with no bounded semantics anywhere. Wiring it would need those
semantics first, which is what criterion 4 asks for.

## Callers had to change

Unlike #10's turn binding, where every caller already passed the field, **no caller passed an
approval binding**: the production web app's three call sites, `protocol-smoke`,
`codex-acceptance` and `codex-approval`. All updated, and the hub now carries `turnId`,
`fingerprint` and `expiresAt` into the `pendingApproval` projection so a client can echo what
it is answering.

## Reproduce

`npm run test:approvals` - 19 checks: expiry (against the session directly, so it does not
wait ten minutes), the exact action and its context shown, an ungranted teammate refused, a
binding demanded, a wrong turn and a mutated action refused, session-wide approval refused
both by omission and on request, two competing answers yielding one resolution with the loser
told who won, the resolution broadcast to every client, a replay changing nothing, dispatch
happening once, a revoked grant taking effect immediately, a settled answer surviving a host
restart, an answer to a request that did not survive, and an answer naming a request that
never existed.

Regressions: protocol smoke, 16 unit, 68 team boundary, 10 codex acceptance, 22 shared
steering, 8 encrypted task and multiplayer browser e2e.

## Limits

The host validates the actor the hub attributes to the command; it cannot independently
verify membership, which remains the hub's judgement, re-checked on every command rather than
cached. Approval requests expire after ten minutes by default and that window is not
configurable per action yet. Nothing here changes what a provider does with an approved
action - the Codex adapter's own request identity dedupe is unchanged and still separate.
