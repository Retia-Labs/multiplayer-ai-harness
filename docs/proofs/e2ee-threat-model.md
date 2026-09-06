# Threat model: end-to-end encrypted collaboration content

Required by [issue #3](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/3),
criterion 1, and by [ADR 0003](../adr/0003-end-to-end-encrypted-collaboration-content.md).

This describes the experiment in `packages/e2ee/`, proved by `npm run test:e2ee`. It is not
a security audit and no qualified reviewer has read it.

## What is being protected, and from whom

**Protected:** task content — prompts, transcripts, tool arguments and results, diffs,
approval text, and the control messages that steer an agent.

**From:** the synchronisation service (the hub), its database, its logs, and anyone with
access to them. That includes us.

**Not from:** the endpoints themselves, the execution host, or the inference provider. Those
are covered below, and the distinction matters more than the encryption does.

## Three trust boundaries

### 1. The relay

The hub routes sealed envelopes and holds a directory of public keys. It is never given a
private key and never given plaintext.

Proved: with a real `HubStore` sqlite file on disk, the file is searched byte-for-byte for
the task text, the command, and a canary string. None appear, while the sealed event is
demonstrably present. The relay's whole in-memory state is searched the same way.

**Cleartext metadata the relay still needs**, and therefore still sees:

| Metadata | Why it is unavoidable here |
| --- | --- |
| Endpoint ids and their public keys | Devices cannot establish sessions with strangers they cannot name |
| Which endpoints exchange envelopes | Routing. The relay must know which mailbox to fill |
| Envelope sizes and timing | Inherent to any relay that carries bytes |
| Delivery cursors and sequence numbers | The ordering guarantee the product is built on |
| Team and membership relationships | The hub authorises access; it cannot do that blind |

That list is the honest limit of "the operator cannot read your work". Traffic analysis of
who works with whom, when, and how much, remains available to the operator.

### 2. The application code

**A hub operator who serves the web client can serve different web client code.** Web Crypto
does not prevent this and non-extractable keys do not either: authorised-origin code can ask
a key to decrypt without ever extracting it. So for a browser tab, "the operator cannot read
your content" is **not a defensible claim** — it reduces to "the operator is not currently
choosing to".

A signed, packaged desktop build separates relay trust from code-delivery trust, because the
code arrives through a different channel with a different signer. The user still trusts the
publisher and the update pipeline. This is why the desktop app matters to the security story
and not only to the product one.

### 3. The inference provider

**Encryption ends at the execution host.** The runtime decrypts a task in order to act on
it, and then sends whatever the agent needs — prompts, file contents, diffs, command output —
to the selected provider: OpenAI, Anthropic, a local model, or the Codex or Claude Code CLI.

The provider therefore sees task content in the clear, under whatever terms that provider's
account carries. No property of this design changes that, and any wording that implies
otherwise is false. E2EE here means *the collaboration service* cannot read the work. It does
not mean nobody outside the team can.

This boundary must be stated wherever the encryption is described to a customer.

## What the experiment proves

- Two endpoints establish sessions through a relay that holds only public keys.
- One task and its control messages travel sealed; neither the relay's memory nor its sqlite
  file contains the plaintext.
- A new endpoint of the same account starts **unverified**, and becomes verified only when an
  already-trusted endpoint signs it with the account's cross-signing identity.
- A key the relay makes up is never verified, because verification is a signature from an
  endpoint the account already trusts rather than a claim the relay can assert.
- A modified control message fails closed instead of yielding altered plaintext.
- A customer-held recovery key restores a clean endpoint with no operator secret involved.
- A removed endpoint stops receiving content and is dropped from the directory.

## What it does not protect against, stated plainly

**A compromised endpoint.** Anything a device can read, an attacker on that device can read.
Encryption is not endpoint security.

**A removed device un-knowing what it held.** Removal is forward-only. Rotation means the
device cannot read anything sent afterwards, but the old session is still in its store, so a
device removed at 3pm keeps everything it decrypted before 3pm. No protocol retracts what has
already been seen; this is a property of the world, not of the library.

**A forgotten rotation.** Rotation happens because the application asks for it. If a
membership change ever fails to trigger one, the removed device keeps reading and nothing
visibly breaks. MLS makes membership change and key change the same operation, which removes
that failure mode; with Megolm it has to be enforced by the code path and tested for. That is
now the strongest remaining argument for revisiting OpenMLS.

**Traffic analysis.** See the metadata table.

**A malicious or subverted web client.** See boundary 2.

**The inference provider.** See boundary 3.

## Consequences for features that exist today

The hub currently reads content to do useful things, and under E2EE it cannot:

- **The collision radar** compares file paths across threads *on the hub*. Under encryption
  those paths are ciphertext. It has to move to the execution hosts or the clients.
- **Thread names** are stored and broadcast in the clear for the sidebar.
- **Search** over threads becomes client-side or index-based.

None of these are solved here. They are product decisions about what the hub is still
allowed to know, and they should be decided before the production adapter is written rather
than discovered during it.

## Review required

Before any public claim of end-to-end encryption:

1. Independent review of enrollment, verification, recovery and revocation as designed here.
2. A decision on whether Olm to-device messaging is sufficient, or whether group semantics
   with post-compromise security (MLS) are required for device removal to mean what
   customers will assume it means.
3. Explicit wording for boundaries 2 and 3 in any customer-facing description.
