# Private teams and explicitly shared execution hosts

Implementation record for
[issue #5](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/5) (P04), under
[the implementation spec](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/1).

Run the boundary proof with `npm run test:team`. It currently reports **68 checks** and
**20 distinct refusal codes**; most checks assert that something is **refused**, and that it
is refused for the precise boundary it crossed. `npm run test:protocol` covers an invited
late joiner replaying the same log over WebSocket and the bearer-authenticated HTTP fallback.
`node test/desktop-smoke.js` covers host-local folder authorization through the native picker,
including refusal when the selected runtime is not the one managed by that desktop shell.
The existing browser E2E reports **38 checks**, and the desktop shell smoke reports **10**.

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
team — read from the database, never from the request. A thread's team and runtime ownership
are immutable after creation: another paired runtime cannot overwrite a known thread ID or
append to its history, even if it submits an otherwise valid thread object. The runtime also
persists that team ID with each local thread and republishes only threads belonging to its
current pairing, so moving a host never carries old-team threads into a new team.

Membership is re-read for every team broadcast, thread event, presence update and activity
update. Removing a member drops that user's live subscriptions and pending command routes
for that team, revokes delegated approval and outstanding invitation grants, and excludes
the already-open socket from future content immediately.

**Invitations target one existing account, are single-use, and expire.** The invitee first
shares the stable account ID shown at the no-team gate or in Settings. The owner enters that
ID, the invitation records the immutable user ID and displays the account's name, and a
different authenticated account cannot redeem its code. Display names remain non-authoritative.
Redemption distinguishes *wrong recipient*, *invalid*, *expired*, *already accepted* and
*revoked*, because those are different security facts.

**Roles are administration only, and that is enforced.** `owner` can invite, remove and pair.
It grants **no** approval authority: resolving an approval requires a separate delegated
grant, checked at the hub before routing and again on the execution host, which is the
machine actually taking the risk. Even the team owner cannot approve until somebody delegates
it — including to themselves.

An earlier version of this document claimed this criterion was met because the membership row
carried no `approver` field. That was wrong: the shape of a row is not enforcement, and
`approval/resolve` was in fact reachable by any member. It is now a separate table, a separate
grant, and two checks.

Decryption access remains out of scope here and belongs to issue #3.

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

Pairing also records a persistent, high-entropy credential generated by the runtime. The
runtime keeps the credential in its local store and the hub stores its hash. A later
connection claiming that runtime ID becomes the active paired host only after proving the
same credential, so an impostor cannot replace the real socket or rewrite its descriptor.
The persisted credential lets the legitimate host authenticate again after a restart.
Unpairing removes the host from the team's fleet but deliberately retains that credential
reservation: the same installation can offer a fresh local code, while another installation
cannot claim the now-unpaired runtime ID. The local code rotates for every pairing cycle, so
a code observed before an earlier pairing cannot reattach the host later.

**Which folders are reachable is a decision made at the machine.** `project/add` from a
remote caller is refused outright (`project_add_is_host_local`); the operator authorizes
directories with `--project` or `runtime.json`. A native desktop selection is written to the
local runtime's `runtime.json`, then the locally managed runtime is restarted to load it. The
preload bridge returns no selected path to the web client, so that absolute host path is not
forwarded through `project/add`. `thread/start` requires a non-null workspace that exactly
matches an authorized project; a missing or different path is refused with
`project_not_authorized` instead of being registered implicitly.

**Execution policy has a host-side ceiling.** `--max-preset` (default `agent`) caps what a
remote teammate may ask for. Thread defaults are derived from that ceiling, and every thread
start, turn start and settings update resolves a named preset into its canonical approval
and sandbox policies. Supplying raw `approvalPolicy` or `sandboxPolicy` fields cannot bypass
the preset: mismatches and requests above the ceiling fail with
`policy_escalation_refused`. Generic and demo providers receive structured read, list, write,
and remove capabilities instead of a shell. Those capabilities reject absolute paths,
traversal and every symlink component; writes use atomic replacement so an existing hard
link is not modified in place. Approval never overrides this project boundary. CLI providers,
remote Git subprocesses and remote worktree creation fail closed until a supported
project-confined sandbox is validated.

The fleet advertises only presets at or below each host's ceiling and selects the host's
safe default. Approval controls appear only for a currently delegated approver and only for
the per-action decisions offered by the execution host; the unsupported session-wide choice
is not presented. Runtime command results are accepted only from the authenticated socket
that received that exact command, so another paired host cannot forge the result.

## Distinct failures

The ticket asks that outsider history access and foreign runtime routing fail
*distinguishably*. They do — the boundary suite currently observes 20 distinct refusal codes,
and the client maps protocol boundary failures to sentences a person can act on.

| Code | Means |
| --- | --- |
| `unauthenticated` | no valid token on the connection (HTTP 401) |
| `not_a_member` | signed in, but not in that team (HTTP 403) |
| `owner_role_required` | in the team, but the operation needs an owner |
| `unknown_team` / `unknown_thread` / `unknown_runtime` | no such thing (HTTP 404) |
| `foreign_runtime` | that host belongs to another team |
| `runtime_unpaired` | that host is not attached to any team yet |
| `runtime_authentication_failed` | a connection claimed a paired host ID without its persisted credential |
| `foreign_thread` | a runtime tried to change or append to a thread it does not own |
| `unknown_user` | an invitation target is not an existing account |
| `already_a_member` | an invitation cannot replace an existing membership or role |
| `invitation_recipient_mismatch` | the invitation was issued to a different account |
| `invitation_invalid` / `_expired` / `_already_accepted` / `_revoked` | four other invitation refusals |
| `pairing_code_invalid` / `_expired` | wrong code vs stale code |
| `project_not_authorized` | a path the host operator never shared |
| `project_add_is_host_local` | folders are shared at the machine, not over the network |
| `provider_not_isolated` / `project_operation_unavailable` | an execution path is hidden until its project confinement is proven |
| `policy_escalation_refused` | more access than this host allows |
| `not_a_delegated_approver` | membership or team administration did not grant approval authority |
| `command_already_in_progress` / `command_id_conflict` / `command_outcome_unknown` | command IDs are deduplicated without inventing a result after restart |

The HTTP event fallback carries the same content as the live socket, so it now carries the
same authorization: a bearer token (or `?token=`), then a membership check. The protocol
proof creates a fresh invitation targeted to the late joiner's account, waits for acceptance,
and uses that joiner's bearer token for the HTTP cursor replay.

## Desktop UI evidence

`npm run test:e2e` captures the affected shared desktop renderer at the accepted
**1487 × 1058** viewport with reduced motion and fixed invitation display text:

- [Private team, named invitation, host, project and provider setup](../harness/fleet.png)
  covers the `shell` + `setup` contract in the ready/connected state.
- [One-action approval for a delegated approver](../harness/bob-approval.png) covers the
  `shell` + `decision` contract in the pending/granted state.

The same E2E also checks the missing-grant state from the owner's account: the request stays
visible, but decision controls do not appear. Narrow-browser/mobile layout evidence is kept
outside this desktop-focused slice.

## What this does not do

- **No encryption.** Every membership is marked `enrollment: pending` and the UI says
  "Encryption pending" next to the signed-in user. The hub still stores thread content in
  the clear; issue #3 owns that, and this slice deliberately does not pretend otherwise.
- **Delegated approval is enforced but minimal.** A grant exists, is checked at the hub and
  re-checked on the execution host, and can be revoked. What is *not* here is the richer
  delegation flow issue #11 owns: scoping a grant to one thread or one action, expiry, and
  the UI for handing it over. The host's check also still trusts the hub's assertion; making
  that independent of an untrusted relay is issue #3's territory.
- **No seats or billing.** "Paid seat" appears in the criterion only to say it grants
  nothing by itself, which is true here because seats do not exist.
- **User tokens are bearer tokens in local storage.** The persisted runtime credential
  authenticates a reconnect to this hub, but it does not provide end-to-end command or event
  authentication against an untrusted relay. Those remain part of issue #3's security work.
