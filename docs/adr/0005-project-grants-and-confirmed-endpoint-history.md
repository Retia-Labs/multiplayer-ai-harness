# Project grants, confirmed endpoints, and how history reaches a late joiner

For issue #8, joining a project is two independent decisions rather than one. A *project
grant* is a relay-side record deciding who may fetch a project's ciphertext, now and for
tasks added later. An *endpoint enrollment* records whose device has been vouched for, and
only a confirmed endpoint is ever sealed to. Team membership no longer implies either:
[#6](0004-encrypted-task-event-log.md) let any member retrieve ciphertext, and that is now
scoped to project participants. A grant without a confirmed endpoint yields bytes nobody
can open; a confirmed endpoint without a grant has nothing to fetch. Neither is access.

An account and an invitation link produce a `pending` row and nothing else. Confirmation
comes from an endpoint already verified in that team, or from the team owner acting as its
recovery authority; the fingerprints must match what was announced, and a confirmation
naming other keys is refused rather than applied. Re-announcing a device with different
keys resets it to `pending`, because site-data loss is a new identity and not a returning
one. The team's first endpoint is self-confirmed and recorded as `bootstrap` - every trust
graph has a root, and naming it is better than hiding it.

Megolm decides how history can move. A group session's key exports at its current ratchet
index, so admitting an endpoint to a running session grants the next event and never a past
one. History therefore transfers as a scoped encrypted room-key export, sealed to one
confirmed device. #6 refused every imported session because an export carries no provenance
a reader can check, and deferred the question here. This narrows that refusal rather than
removing it: an imported session is readable only for the session ids delivered by a handoff
the receiving endpoint opened itself, sealed by a fingerprint it had already confirmed.
Device attribution is unavailable for an imported session - the export format has no field
for it - so the writer's curve25519/ed25519 pair and prior local confirmation carry that
check instead. Every other import stays refused, with no plaintext fallback.

This extends [ADR 0003](0003-end-to-end-encrypted-collaboration-content.md) and
[ADR 0004](0004-encrypted-task-event-log.md), and inherits their pending review gate.
[Implementation, refusal codes and limits](../proofs/teammate-enrollment.md) record what is
tested and what is not.
