# Pilot operations, deletion, and content-free measurement

Issues #21–#24 extend the encrypted collaboration product with assisted setup,
customer deletion, optional measurement, and manual individual seat records.
These features preserve the authority boundaries in ADRs 0003–0006.

The shared browser/desktop renderer builds diagnostic exports from fixed fields:
app/Electron/protocol versions, stage status, and allowlisted error identifiers.
It never serializes exceptions, logs, provider configuration, or task objects.
Preview precedes an explicit download; sending that download remains the customer's
choice. Desktop bootstrap failures use the same projection through a restricted
main-process IPC handler, including when the workspace cannot start.

Task/project deletion is an irreversible operation in the existing signed
membership history. Only a currently verified endpoint of the original owner
account may authorize it. A project operation includes its exact current task set;
a concurrent creation makes that operation fail so the owner can review and retry.
The service commits the signed operation, tombstone, ciphertext/index removal,
and project-grant revocation in one transaction. Reusing deleted task/project IDs
is refused, including after customer owner recovery. Minimal routing tombstones
and signed receipts remain to enforce deletion; they contain no task content.

Hosts apply authenticated deletion before requiring a fresh owner response for
new execution. They persist a deletion fence, cancel active execution, rotate the
room to the host alone, remove task execution/control/history state and project
mappings, and issue a signed receipt bound to the deletion's exact hash. Concurrent
or delayed local writes cannot recreate fenced task state. Clients authenticate
both the owner operation and host receipt and show pending hosts explicitly.
Unreachable or unconfirmed hosts remain pending. Deletion does not remove files
from the execution host's project folder or erase keys/plaintext already held by
participants or their SDK stores. A host receipt attests application of this
procedure, not forensic erasure of every participant device.

Supported service snapshots contain only task ciphertext and event routing. They
expire after seven days and restore only into the **current** authority database.
Restore never imports memberships, device trust, credentials, grants, recovery
authority, approvals, or tombstones from an older snapshot. It skips deleted tasks,
missing current creator grants/membership, missing host pairings, and existing
tasks. Loss of the current authority database requires a separate fail-closed
customer recovery procedure; an old full-database image must not be republished as
current authority. This is a content restore tool, not an authority backup system.

Recovery uploads include a task routing manifest. Deletion removes whole archives
that contain affected tasks and retires their scopes against retry. Legacy
unindexed archives belonging to affected participants are removed conservatively.
Untagged legacy mailbox envelopes for affected accounts/hosts are also discarded;
retained tasks may need a fresh history request. Indexed archives containing only
retained tasks remain available. Customers must prepare new archives after
deletion. The service cannot inspect encrypted manifests for omitted contents or
erase separately retained participant copies.

Measurement is off by default and controlled per account. Authorized endpoints
derive fixed events from authenticated task history; the service does not inspect
transcripts. Person/team hashes are pseudonyms, not anonymity: authenticated routing
indexes still identify the reporting account and team. Task IDs are opaque routing
IDs. Events expire after 30 days; content-free retry IDs expire after 365 days.
Opt-out removes both immediately. Task deletion removes both for that task.

Participation means a task start or authenticated control/approval. Activation
requires two distinct participating humans plus a non-initiator's confirmed
intervention. A peer's queued or failed start is insufficient; a successful peer
turn, acknowledged steering delivery, or applied human approval supplies delivery
evidence. Help, invitations, and views are measured separately. Only the reporting
person's consented outcomes leave their endpoint. The relay validates identity,
current access, schema, and retry uniqueness; it cannot independently attest these
content-derived facts without breaking encryption. They are product observations,
not fraud-resistant billing evidence. Older events without authenticated timestamps
are not backfilled as historical measurement.

Seat changes are founder-local, revision-checked records with an idempotency ID,
individual account, billing owner, entitlement status, payment classification, and
optional recorded price/currency. No remote seat-write endpoint exists. Changing a
seat never changes team membership, project grants, endpoint keys, provider setup,
or approval authority. Only active seats recorded as actually paid count toward
paying teams. No price, charge, invoice delivery, or free reviewer tier is created
by this implementation. Founders resolve pilot entitlement commercially; there is
no automatic enforcement that would revoke collaboration access as a side effect.

See [the operating guide](../operations/pilot-operations.md) and
[verification record](../proofs/pilot-operations.md). These implementation checks do
not replace the specification's real-provider, platform, trusted-distribution, or
independent privacy review gates.
