# Removing a device, and being honest about what that reaches (issue #16)

Implementation for [issue #16](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/16)
(P15), built on [#8](teammate-enrollment.md)'s enrolment, [#11](approval-grants.md)'s approval
authority and [#15](recovery.md)'s recovery.

## Where removal actually happens

The relay can stop serving a revoked device the moment somebody clicks. It cannot take back a
key that device already holds. So the removal that matters happens on the **execution host**,
which throws the group session away and re-shares it to whoever is left — and everything
written after that is unreadable to the removed device.

That is why a revocation is **pending** until each host says it has applied it, and why the
hosts that have not are named rather than counted. "1 of 2 hosts" does not tell anybody which
machine can still act on keys a removed laptop may still hold.

## Two gaps this work found, both by trying the attack

**A substituted device could take over an enrolled device id.** #8 refuses to *announce* an
enrolled device id with different keys (`endpoint_device_id_reused`), but the key directory
was accepting the *upload* anyway. So a second endpoint claiming an existing device id
overwrote the published keys of the real one — and the legitimate device became
undiscoverable, because every lookup returned the substitute and every confirmation against
the enrolment then failed. Refusing the announcement while accepting the upload protected the
trust decision and broke the device it was protecting. The directory now refuses too.

This was found by accident: the test created an impostor endpoint to assert the announcement
was refused, and the *rest of the test* then failed, because the impostor had quietly replaced
maya's keys.

**A revoked device could still authorize actions.** The host checked that the sender's account
held a project grant — but a grant is about the person and a revocation is about the machine,
so a removed laptop kept its account's grant and went on authorizing work. Rotation stopped it
reading; nothing stopped it acting.

Local trust is sticky on purpose: the host confirmed that device once and has no reason to
forget, so "can it still seal to me" keeps saying yes long after the team removed it. Whether
it may still act is a live question, and the host now asks the enrolment at the time rather
than trusting a verdict it cached.

## What revocation cannot do

`REVOCATION_LIMITS` says it in the product, not only here:

- **Future, not past.** Rotation makes everything written afterwards unreadable to that device.
- **Already-read plaintext is not erased.** Those events are on that machine, and no key
  rotation reaches them. The test asserts the removed reader still holds what it read before.
- **Participant-held history is not un-shared.** Removal ends access; it does not retract.
- **Pending is pending.** Until a host applies it, that device may still read new events on
  the tasks that host owns.
- **Role, key and seat are three separate things.** Revoking a device does not change
  somebody's role or their seat, and the test asserts membership is untouched.

## The criteria

**1 · advance membership/key state; removed endpoints cannot decrypt future content or
authorize actions after host application** — met, both halves, and the second half was the gap
above.

**2 · show pending revocation for unreachable hosts; do not imply instant knowledge** — met.
The enrolment state carries `revocations` with `appliedBy`, `pendingHosts` and `applied`, and a
revocation with no host acknowledgment reports `applied: false` with the host named.

**3 · reject substituted identities, replayed grants and stale approval responses; recovery
cannot roll back authorization** — met. Substitution is refused at both gates; #11's ledger
already refuses replayed grants and #17's work refuses stale approvals; and an endpoint
restored from a backup holding the old exported keys still cannot read what came after the
rotation, which is asserted directly.

**4 · explain what cannot be erased; keep role, key and seat distinct** — met, as text the
product shows and the test asserts.

## Reproduce

`npm run test:revocation` — 12 checks: the substitution refused at the directory and the
confirmed keys surviving it, a participant reading before removal, the pending state naming
the host, the host rotating and acknowledging, the unremoved device still reading, the removed
device failing to read what came after, the already-read plaintext still being readable to it,
membership unchanged, the removed device refused when it tries to act, and a restored backup
not restoring access.

## Limits

Rotation is per host and covers every task that host owns, because working out which tasks a
removed endpoint could read is a guess the host has no reason to make. That is more work than
strictly necessary and is the safe direction to be wrong in.

A host that never comes back never applies its revocations. The pending list says so, by name,
indefinitely — there is no timeout that quietly turns "not applied" into "applied".
