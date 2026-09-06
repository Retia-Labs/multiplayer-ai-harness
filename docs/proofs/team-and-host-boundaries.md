# Private teams and explicitly shared execution hosts

Implementation record for
[issue #5](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/5) (P04), under
[the implementation spec](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/1).

Run the proof with `npm run test:team`. It is a boundary suite, so most checks assert that
something is **refused**, and that it is refused with its own distinct code.

## What was open before

The prototype had no authorization at all. Every one of these was reachable by anyone who
could open a socket:

| Hole | What it allowed |
| --- | --- |
| `hello { name }` resolved an existing account by name | Typing a teammate's name **became** that teammate |
| `org` was whatever the caller said it was | Joining any workspace by naming it |
| `project/add` was routed to the runtime | Registering **any path on the host's disk** from a browser |
| `thread/start` auto-registered an unknown `cwd` | Starting an agent anywhere on that machine |
| commands routed on a caller-supplied `runtimeId` | Driving **someone else's** execution host |
| `GET /api/threads/:id/events` | Reading **any thread's full history**, unauthenticated |
| `GET /api/threads?org=` | Listing any workspace's threads, unauthenticated |
| `turn/start { settings.preset }` | Asking for `full-access` on a host that never agreed |

## The model now

**An account is an identity, not an authorization.** Logging in by name mints a *new*
account with its own token; it never resolves to an existing one. Two people called "alice"
are two strangers. Access comes from a membership row, and a membership row comes only from
an accepted invitation.

**A team is the private boundary.** Threads, runtimes and projects each belong to exactly
one. Every read and every command is checked against the caller's membership of the owning
team — read from the database, never from the request.

**Invitations are single-use and expire.** Redemption distinguishes *invalid*, *expired*,
*already accepted* and *revoked*, because those are four different security facts.

**Roles are administration only.** `owner` can invite, remove and pair. That is deliberately
*not* decryption access and *not* action-approval authority — those are separate grants that
issues #3 and #11 own. The membership row carries no such field, and the test asserts its
absence rather than trusting the comment.

## Pairing an execution host

A host starts **unpaired**, holding a short code it prints on its own console:

```
----------------------------------------------------
  This host is not paired with a team yet.
  Pairing code:  TA6N-2LFH
  Enter it in Plexus to share alice@laptop.
----------------------------------------------------
```

Possession of that code *is* the local consent: it is displayed only on the machine being
shared, so a remote member cannot claim a host they cannot see. An owner enters it to attach
the host to their team; the code is single-use and expires in 10 minutes. On the desktop app
the shell mints the code itself and offers it to the person sitting at the machine, which is
the same consent with less typing.

**Which folders are reachable is a decision made at the machine.** `project/add` from a
remote caller is refused outright (`project_add_is_host_local`); the operator authorizes
directories with `--project` or `runtime.json`. `thread/start` on anything else is refused
with `project_not_authorized` instead of quietly registering it, which is what it used to do.

**Execution policy has a host-side ceiling.** `--max-preset` (default `agent`) caps what a
remote teammate may ask for; `turn/start` and `thread/settings/update` both refuse to cross
it with `policy_escalation_refused`.

## Distinct failures

The ticket asks that outsider history access and foreign runtime routing fail
*distinguishably*. They do — the suite records 13 distinct codes, and the client maps each to
a sentence a person can act on.

| Code | Means |
| --- | --- |
| `unauthenticated` | no valid token on the connection (HTTP 401) |
| `not_a_member` | signed in, but not in that team (HTTP 403) |
| `owner_role_required` | in the team, but the operation needs an owner |
| `unknown_team` / `unknown_thread` / `unknown_runtime` | no such thing (HTTP 404) |
| `foreign_runtime` | that host belongs to another team |
| `runtime_unpaired` | that host is not attached to any team yet |
| `invitation_invalid` / `_expired` / `_already_accepted` / `_revoked` | four different refusals |
| `pairing_code_invalid` / `_expired` | wrong code vs stale code |
| `project_not_authorized` | a path the host operator never shared |
| `project_add_is_host_local` | folders are shared at the machine, not over the network |
| `policy_escalation_refused` | more access than this host allows |

The HTTP event fallback carries the same content as the live socket, so it now carries the
same authorization: a bearer token (or `?token=`), then a membership check.

## What this does not do

- **No encryption.** Every membership is marked `enrollment: pending` and the UI says
  "Encryption pending" next to the signed-in user. The hub still stores thread content in
  the clear; issue #3 owns that, and this slice deliberately does not pretend otherwise.
- **No delegated approvers.** Any member of a team can currently resolve an approval on a
  thread they can see. Separating approval authority from membership is issue #11; the data
  model keeps them apart so that work does not have to unpick a conflated role.
- **No seats or billing.** "Paid seat" appears in the criterion only to say it grants
  nothing by itself, which is true here because seats do not exist.
- **Tokens are bearer tokens in local storage.** Good enough for a local-first prototype,
  not a session-security design.
