# Getting encrypted history back on a clean device (issue #15)

Implementation for [issue #15](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/15)
(P14), built on [#8](teammate-enrollment.md)'s enrolment and the export/import primitives
[#3](e2ee-verification.md) established.

## What already existed, and what did not

`exportHistory` and `importHistory` were here: Matrix's authenticated encrypted room-key export
format, scoped to named rooms, encrypted to a key the customer holds. So was
`enableRecovery`/`restoreRecovery`.

What was missing was everything around them — somewhere for the blob to live that the operator
cannot read, a way to fail when the material is wrong, an onboarding exercise that makes
somebody actually keep the key, and a truthful account of what comes back.

The last one is the part worth being careful about, because the failure mode is somebody
believing a restored laptop is a trusted one.

## The relay holds a blob it cannot open

`e2ee_recovery` stores ciphertext per account and scope. What an operator can see is asserted
by looking directly at the table: **scope, version, timestamp and byte count**. Not the
history, not which task it covers, not which files it touched.

A recovery blob is readable only by the account that stored it — **not by a teammate, not by a
team owner**, asserted with a second account on the same team. History is shared through #8's
grants and handoffs, which are somebody deciding. A backup is somebody's own copy, and
widening that would turn "the operator cannot read your history" into "anybody on your team
can restore it".

## The clean endpoint is genuinely clean

The endpoint that restores in the test is a new `Endpoint` with new keys, no store, no
knowledge of the task and no trust from anybody. Before restoring, it fetches the ciphertext
and **fails to read a word of it** — asserted, `task_integrity_failed`. An endpoint that had
ever held the session keys would pass this test without proving anything.

Four ways it can go wrong, each with its own answer:

| Attempt | Refused with |
| --- | --- |
| the wrong recovery key | `recovery_material_rejected` |
| material too short to be a key | `recovery_key_too_weak` (before anything is tried) |
| history this backup never held | `recovery_scope_mismatch` |
| another account's backup | `no_recovery_material` |

`recovery_scope_mismatch` is separate on purpose: that is not a failure of the material, it is
asking for something the backup never contained, and the fix is different.

With the right key, the restored endpoint reads the log and its events are **deep-equal to the
original endpoint's**.

## What recovery does not restore

Returned every time, as a statement somebody has to read rather than a boolean they can ignore:

- **Endpoint trust.** The restored device is new to everyone else. The enrolment has never
  heard of it — asserted — and it has to announce itself and be confirmed again.
- **Approval authority.** Not in a backup. A grant that had expired or been used is still
  expired or used; the approver set is asserted unchanged across a restore.
- **Provider credentials.** They live on the execution host and are never part of history. The
  blob is scanned for credential shapes and comes back clean.

## The onboarding exercise

A recovery key that was displayed once and never written down is not recovery, and the only
moment anybody will ever check is before it is needed. So the key is issued, shown once, and
**nothing is backed up until the person types it back**. Whitespace is forgiven; nothing else
is. `recovery_drill_incomplete` and `recovery_drill_mismatch` are separate answers.

Rotation replaces the key and overwrites the stored blob, and says what that does not do:
anybody who already downloaded the old ciphertext and holds the old key can still open that
copy. Claiming otherwise would be exactly the kind of promise this issue is about not making.

## Total loss, stated plainly

> If every trusted endpoint is gone and the recovery key is gone, the history cannot be
> recovered. Nobody can recover it — not the operator, not us. There is no second path, by
> design: a copy the operator could open would be a copy an intruder could open.

That text is in `RECOVERY_LIMITS`, asserted by the test, and rendered on the recovery screen
rather than buried in a document. Alongside it, the two storage failures this product actually
has: clearing site data destroys a browser endpoint's identity (the account survives, the
device does not, and it comes back as a new one to be confirmed), and a locked OS keychain
makes an endpoint report itself as having no durable identity rather than silently starting a
new one.

## The criteria

**1 · exercise recovery on a clean endpoint; wrong material fails; the operator sees only
encrypted backups; total loss explained honestly** — met, all four asserted.

**2 · protect persisted secrets using supported storage; document site-data and locked-storage
failure** — met. The browser endpoint uses IndexedDB with a key in `localStorage` and reports
`durable: false` when it cannot have one; the recovery screen says so, and both failure modes
are documented and asserted as text the product actually shows.

**3 · recovery does not restore expired approval grants or provider credentials; scope and
trust transitions explicit** — met, asserted from all three directions.

**4 · onboarding recovery exercise and a replacement/rotation path; do not promise recovery
after total loss** — met.

## Reproduce

`npm run test:recovery` — 18 checks against the real hub, a real host and a genuinely clean
endpoint.

## Limits

The recovery scope is a set of task ids chosen when the backup is made. A task created
afterwards is not in that blob until the next backup; there is no continuous backup, and
implying one would be worse than saying this.

The desktop endpoint's OS-sealed storage is exercised by #3's platform proof rather than here.
This issue's browser path is the one under test.
