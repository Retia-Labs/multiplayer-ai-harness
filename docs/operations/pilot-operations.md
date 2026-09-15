# Pilot operations

Implements [#21](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/21),
[#22](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/22),
[#23](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/23), and
[#24](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/24).
Authority and retention decisions are in [ADR 0007](../adr/0007-pilot-operations-and-deletion.md).

## Assisted setup and diagnostics

Fleet shows account, device verification, host/project sharing, provider readiness,
first successful solo task, invitation, and customer recovery stages. Complete a
solo task before inviting a teammate. The teammate must accept an account-bound
invitation, compare device fingerprints, receive project access, and confirm the
host. Provider authentication remains on the execution host.

Use **Inspect diagnostic export** to review the exact JSON, then **Download reviewed
report**. Nothing sends that file to a founder automatically. A desktop that cannot
start offers the same inspection from its startup error screen. Do not request raw
logs, task exports, or recovery keys as an equivalent diagnostic shortcut.

Task content is end-to-end encrypted. Routing, identity/membership, timing, sizes,
seat records, and consented measurement remain visible to the service. The chosen
provider receives task inputs; browser clients trust their app origin. Losing all
trusted endpoints and all customer-held recovery material loses encrypted history.

## Delete shared work

A verified endpoint of the original owner account can use **Delete shared task** in
the task controls or **Delete shared project** in Team & access. Review the effects
and check the confirmation before submitting. A changed project task list requires
review and retry. Task deletion removes that task; project deletion also revokes
its grants and retires its opaque project ID. Sharing the local folder again must
use a new project identity, rather than regranting the retired ID.

Live ciphertext, task mailboxes, task measurement and access/index references are
removed transactionally. Minimal tombstones and receipt routing remain. The UI
shows host application pending until it can verify that host's signed receipt.
Hosts cancel active work, deny subsequent controls, remove local task records and
rotate future key sharing. Project files and participant-held copies remain.

Affected recovery archives are deleted as whole archives, including legacy archives
that cannot be selectively indexed. New archives are needed for retained work.
Other retained tasks may need **Request verified history again** after unscoped
legacy mailbox queues are discarded. This never grants new access by itself.

## Service snapshots

Use the existing current hub database. The helper writes only under
`<database>.backups/`; it does not copy the authority database.

```powershell
node scripts/service-backup.js create C:\PlexusData\hub.sqlite
node scripts/service-backup.js prune C:\PlexusData\hub.sqlite
node scripts/service-backup.js restore C:\PlexusData\hub.sqlite snapshot-<timestamp>.json
```

Snapshots expire seven days after creation; expired snapshots cannot restore.
The running service prunes on startup and every minute. When stopped, schedule the
`prune` command daily and before taking the backup store offline; enforce the same
seven-day TTL on any operator-managed storage copies. Monitor the fixed
`retention_maintenance_failed` log code and repair storage permissions promptly.
An offline disk cannot be physically purged until it is mounted again. SQLite
secure deletion and periodic WAL checkpointing reduce retained local pages; they
do not make promises about filesystem snapshots or storage-device remanence.

Restore evaluates **current** membership, project grants, host pairing, and deletion
tombstones. It never rolls existing task logs backwards or restores authority.
Never replace the current hub database with an older whole-database image. If
current authority is lost, keep service access disabled and recover customer trust
explicitly; this helper fails closed when current pairings/grants are absent.

## Optional measurement

Each person can enable or disable **Allow content-free product measurement** in
Fleet. Disabling deletes that person's events and retry IDs. Task deletion removes
task-associated measurement too. Events use fixed kinds/stages/outcomes, person/team
pseudonyms, opaque task IDs, and timestamps. No prompt/title/path/URL/diff/tool
fields are accepted. New host events carry authenticated timestamps; legacy events
are not assigned invented historical dates.

Team owners see a 30-day summary in Team & access. Setup, useful solo completion,
invitations, catch-up, help, control, delivery, approvals and task completion remain
separate counts. A returning team has authenticated active events in two distinct
UTC calendar weeks in that window. Views alone cannot establish a return or
activation. Person/task activation is deduplicated independently of page reloads
and receipt retries. Measurements cover consenting endpoints that observe the
events, so these totals are not a complete census or proof of paying customers.

## Individual seat records

The founder operates this local CLI against an existing hub database. Restrict OS
write access to that database and input files to the founder/operator. Obtain the
real account/team IDs from the pilot accounts; `operatorId` is an audit attribution,
not a substitute for this OS access boundary.

Create a JSON file with exactly these fields. Replace placeholders with existing
account IDs and a fresh 32-character lowercase hexadecimal change ID:

```json
{
  "id": "<32-character-change-id>",
  "teamId": "<team-id>",
  "userId": "<seat-holder-account-id>",
  "operatorId": "<founder-account-id>",
  "billingOwnerId": "<billing-owner-account-id>",
  "status": "active",
  "payment": "unpaid",
  "price": null,
  "currency": null,
  "expectedRevision": 0
}
```

```powershell
node scripts/pilot-seats.js record C:\PlexusData\hub.sqlite .\seat-change.json
node scripts/pilot-seats.js show C:\PlexusData\hub.sqlite <team-id> <seat-holder-account-id>
node scripts/pilot-seats.js summary C:\PlexusData\hub.sqlite
```

Use `show` to inspect the current record. For changes, use its revision and a new change ID. Retrying an identical
change ID is safe; a changed request or stale revision is refused. Set `status` to
`revoked` to end the recorded entitlement. Payment is one of `paid`, `free-pilot`,
`intent`, `invoiced`, or `unpaid`; use `paid` only after independently confirming
actual payment. Price remains `null` until agreed, or is a decimal string with an
uppercase three-letter currency. No amount or payment action is inferred.

Team owners see member records; other members see their own seat. Records include
the billing owner and distinguish product seats from provider usage charges. Seat
history is a separate durable business audit record; measurement opt-out and task
deletion do not alter it. Seat changes do not grant or revoke collaboration access,
decryption keys, provider credentials, or action approvals. The CLI initiates no
charges, emails, or other customer messages.
