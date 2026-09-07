# Asking a named teammate for help (issue #12)

Implementation for [issue #12](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/12)
(P11), built on [#8](teammate-enrollment.md)'s enrolment and project grants and
[#9](catchup-projection.md)'s projection.

## The question is content, and that decides the design

A help request names a file, quotes an error, or describes what somebody is stuck on. It is
task content, so it lives in the encrypted log and nowhere else — which immediately rules out
the obvious implementation, because **a teammate cannot append to a log they do not write**.
One writer, one sequence, one digest chain is what makes the log worth anything.

So a question travels as a sealed control message: `sealControl` to the host's endpoint,
carried by the relay's device mailbox as an envelope the relay cannot open, appended by the
host after it has checked who sent it.

That indirection is what makes the attribution real. `help.requested` records **who asked**,
and the host takes that from the authenticated sender of the envelope rather than from a name
in the payload. A test sends a request whose payload claims to be from somebody else; the log
records the person who actually sealed it.

## Two gates, and they are not the same gate

Being able to seal to the host is being a **verified endpoint** — cryptography, established by
a person comparing a fingerprint. Being allowed to ask about a project is a **grant** — the
relay's own record of who is on what.

Both are checked, separately, and the test breaks each one on purpose:

| Attempt | Refused with |
| --- | --- |
| a question addressed to somebody with no project grant | `recipient_not_in_project` |
| a question from a verified endpoint with no project grant | `sender_not_in_project` |
| the asker marking their own question resolved | `not_the_help_owner` |

Nothing is written for a refused request. A question addressed outside the project is not
recorded-and-ignored; it does not enter the log at all, because a request nobody can answer
sitting open forever is the failure this criterion is about.

Resolving and cancelling are different acts by different people — the recipient dealt with
it, the asker withdrew it — so the outcome is recorded rather than inferred from who sent it.

## A grant hands nobody a key

Building this surfaced a gap #8 had left open. A project grant is the relay's gate; the host
owns the group session, so it is the only party that can actually share one. Until it does, a
granted teammate can fetch the ciphertext and read none of it — which the test asserts before
admitting anybody, by watching a replay fail with `task_integrity_failed`.

`EncryptedHost.admitParticipants()` closes it: everyone a live grant covers, handed the
history and then admitted to the session. Re-sharing to the current member set is also what
makes removal mean something, because the next share leaves out whoever was revoked.

#8 built the history handoff — an authenticated export only the writer may produce — and left
it with no way to travel. It now rides the same sealed channel, so the blob and the transfer
key that opens it arrive together and only for the device they were meant for. The
verification stays exactly where #8 put it: `acceptProjectAccess` checks the seal came from
the writer, and nothing here loosens that.

## The criteria

**1 · encrypted question, requester, recipient, references, open/resolved/cancelled;
recipients outside the project rejected** — met. The question and both parties are in the
encrypted log; the relay holds ciphertext, and a canary scan over everything it serves and
stores comes back clean. The three refusals above are asserted by attempting them.

**2 · inbox and task views stay consistent across clients and reconnect** — met, and
structurally rather than by luck: the inbox is computed **from the same projections the task
views render**. An inbox built separately is an inbox that can disagree with the task it
points at. A client replaying from sequence zero produces a projection deep-equal to one that
watched it happen. Each entry carries the task's freshness, so "act later" does not quietly
mean acting on something that stopped being true.

**3 · no provider input or execution** — met. The transcript, the tool list and the running
turn count are all unchanged across a help request. There is no path from this channel into
`steerQueue` or any provider call; the only text an agent ever sees comes from starting or
steering a turn, which a person does on purpose.

**4 · no chat/Slack/email integration; any OS notification is generic** — met by not building
one. There is no notification surface at all, so nothing leaks through one. The inbox is a
count and a panel inside the app, and the count is the only thing visible without opening it.

## The plaintext path had the same hole, unguarded

`thread/help` accepted any `to` and `thread/assign` accepted any `assignee` object — no
check that the person exists, is on the team, or can see the thread. Work could be handed to
a name nobody has and would render as assigned on every client. Both are now checked on the
hub, where approval authority is already checked, and refused with
`recipient_not_authorized`. Assigning a thread that does not exist also used to fail with a
`TypeError` rather than an answer.

## Reproduce

- `npm run test:help-inbox` — 18 checks: the sealed question reaching the log, attribution
  taken from the seal rather than the payload, both project-gate refusals, the wrong person
  being refused, resolve and cancel, inbox/task consistency, replay-from-zero equality, no
  provider input, and the relay canary scan.
- `npm run test:catchup:encrypted` — includes the app surface in real Chromium: a question
  asked from a second endpoint entirely, decrypted in the browser, shown in the inbox with
  who asked, resolved from there, and the count returning to zero **only after the host has
  recorded it** rather than when the button was pressed.

## Limits

Delivery is poll-based, like everything else the host does: `collect()` picks up requests
when the host next looks, and `admitParticipants()` applies a grant the same way. There is no
push, and a UI that implied one would be lying about when a teammate will see something.

Whether a recipient still holds project access is checked when the request is made, not
continuously. A recipient revoked afterwards keeps an open question in their inbox that they
can no longer read the task behind — visible as a replay failure rather than as a silent
disappearance, which is the better of the two, but it is not yet reported as its own state.
