# Customer-held owner recovery and local host activation

Issue #15 requires recovery of endpoint trust as well as selected history when a
customer retains recovery material. The history-only backup remains supported but
does not contain the authority to admit a replacement owner device. A separately
provisioned owner recovery kit supplies that missing path.

An owner device authorizes a purpose-limited recovery descriptor in the existing
signed membership history. It identifies the service origin, team, original owner,
immutable genesis, generation and Matrix SDK master public key. The kit encrypts
the SDK cross-signing seeds and selected authenticated history to a random customer
key. It excludes the SDK room-backup key, original device private keys, provider
credentials, delegated approvals and pending commands. These cross-signing seeds
have account scope; selecting fewer history rooms does not narrow that capability.
Provisioning includes an actual clean, inactive SDK import and signing drill.

Recovery creates a fresh endpoint identity in a separate protected store. The kit
must authenticate against the selected account, service, team and any existing
genesis/checkpoint before SDK import. Explicit publication still leaves ordinary
product membership pending. A dedicated `owner.recover` record requires both that
new device's signature and a purpose-specific master signature over its exact
signed parent, descriptor and new recovery epoch. The master never signs ordinary
membership operations, freshness challenges, task controls or approvals.

The transition preserves genesis and prior removals but resets old device
confirmations and project grants. The recovered owner can explicitly confirm
devices and establish project access again. This avoids silently treating a
possibly withheld historical grant list as current authorization. Old ciphertext
and authenticated history remain readable wherever their keys are retained.

Every execution host independently stops at an unactivated recovery epoch. The
existing trusted local confirmation names the exact recovered device, checkpoint,
epoch and access reset. Confirmation atomically saves the local signer, checkpoint
and a pending rotation barrier; it never changes the enrollment genesis or
provider configuration. The desktop restarts the host. After a fresh device
challenge and rotation of all locally known task rooms, including rooms omitted
by the relay, that host can resume. Failed storage or rotation leaves it pending.
Key sharing is ordered with rotation, and queued sharing from an older host
generation cannot run afterwards.

New task requests, controls, receipts and history handoffs bind their issuance
epoch inside encryption. Regranting the same account or reconfirming an old device
therefore cannot revive queued pre-recovery intent. Existing task checkpoints and
command deduplication remain; provider continuations and actionable approval
state are cleared at the host barrier. Approval authority requires fresh local
consent for the recovered epoch.

Replacing a kit's authority uses a new SDK master root and a new signed descriptor
generation. Rewrapping ciphertext alone cannot revoke copied signing seeds.
Already downloaded history remains readable with its old material. Each host
enforces only the authenticated changes it has observed and retained: a new or
offline host cannot detect a never-observed update withheld by the relay. A public
recovery record or another host's status never substitutes for local activation.
Loss of all trusted endpoints and all customer recovery material has no operator
rescue path.

This extends ADRs [0003](0003-end-to-end-encrypted-collaboration-content.md) and
[0005](0005-project-grants-and-confirmed-endpoint-history.md). Implementation tests
do not replace the specification's independent privacy/control review.
