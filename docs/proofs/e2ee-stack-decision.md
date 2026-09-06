# Encryption stack decision and enrollment spike

First deliverable for
[issue #3](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/3) (P02): the ticket
asks for "a reviewed protocol/library decision and threat model, not custom cryptography".
This is the decision, the evidence behind it, and a spike that proves the part of criterion 1
that can be proved with running code.

Run it with `npm run test:e2ee`.

## The decision

**`@matrix-org/matrix-sdk-crypto-wasm` 18.8.0** — the vodozemac (Olm/Megolm) crypto machine
that Element ships, as prebuilt WebAssembly.

Nothing in `packages/e2ee/` implements a cryptographic primitive. It is a transport binding
and nothing else, because the library is shaped around Matrix's client-server endpoints and
this product has its own hub.

## Why, on evidence rather than documentation

| | matrix-sdk-crypto-wasm | OpenMLS | ts-mls |
| --- | --- | --- | --- |
| On npm | **yes**, 18.8.0 | **no** | yes, 1.6.4 |
| Downloads / week | **2,580,000** | n/a | 12,700 |
| Build cost here | none — prebuilt WASM | **Rust + wasm-pack added to a repo with no build step** | none, pure TS |
| Audit posture | ships in Element at scale, Apache-2.0 | RFC 9420 reference-grade, Rust | **"has not undergone a formal security audit"**, one maintainer |
| Protocol | Olm/Megolm (not MLS) | MLS, RFC 9420 | MLS, RFC 9420 |
| Package size | 8.6 MB | n/a | 1.4 MB |

`ts-mls` is disqualified by its own README: an unaudited single-maintainer implementation is
what "not custom cryptography" is meant to exclude, whoever wrote it. OpenMLS is the better
*protocol* for group membership changes — epoch keys and post-compromise security are exactly
what a team product wants — but consuming it means adding a Rust toolchain and a WASM build
to a codebase that currently runs `node packages/hub/server.js` and nothing else. That is a
real cost to weigh again if group semantics start to hurt.

**Verified, not assumed:** the crypto machine initialises standalone under Node 24 with no
homeserver, and asks for its key operations as plain JSON that our own hub can answer. That
was the question the choice turned on.

## What the spike proves

Two endpoints, our own deliberately stupid relay, no homeserver:

```
  ✓ two endpoints enrolled against the relay
  ✓ the relay holds public keys and nothing private
  ✓ an endpoint discovers another through the relay
  ✓ the relay holds only ciphertext — 1602 bytes, m.olm.v1.curve25519-aes-sha2
  ✓ the intended endpoint decrypts it, attributed to its sender
  ✓ a substituted key is a different identity, not the same one
  ✓ a modified control message does not decrypt — fails closed
  ✓ a removed endpoint receives no further content
  ✓ and is no longer offered to anyone establishing a session
```

The content under test is a real control message — an `approval/resolve` carrying
`rm -rf build` — and the test asserts on **what the relay holds**, not on what the endpoints
managed to say. The relay's entire state is serialised and searched for the plaintext, the
command, and even the control method name. None of them appear.

## Two findings worth carrying forward

**wasm-bindgen takes ownership of its wrappers.** A `UserId` passed into one call is freed
and cannot be passed into the next; reusing one produces `null pointer passed to rust` from
deep inside the WASM, with a stack trace that names an unrelated type. Every use constructs
a fresh wrapper. Any production adapter will hit this.

**The outer envelope type must be `m.room.encrypted`.** That is the signal to decrypt.
Getting it wrong does not raise an error — the event simply arrives looking like plaintext,
which is the worst possible failure mode for this product. The envelope is therefore built
inside `sealTo()` and never left to a caller. The receive path surfaces `decrypted` per
event, so a `PlainText` or `UnableToDecrypt` event can never be mistaken for an authentic one.

## What this does NOT prove

Stated plainly, because the ticket's remaining criteria are not met:

- **Clean-endpoint recovery.** No recovery key, no restore, no history scope. Criterion 3 is
  untouched.
- **Key rotation on membership change.** Revocation here stops future *delivery* through the
  relay. It does not rotate group state, and Olm/Megolm gives no post-compromise security the
  way MLS epochs would. A removed device cannot be made to un-know what it already held —
  that limit is real and belongs in the threat model, not hidden behind a passing test.
- **Replayed approvals and stale authorization.** Criterion 2 names both; only key
  substitution and message tampering are covered so far.
- **Desktop and browser key storage.** No Electron `safeStorage`, no IndexedDB, no packaging
  check. Criterion 4 is untouched.
- **The hub is not wired to this.** `KeyDirectory` is in-process. Real thread content still
  goes through the hub in the clear, and the collision radar and thread names still depend on
  the hub reading it — that conflict is unresolved and is a product decision, not a coding one.
- **This is not a security review.** No audit, no qualified reviewer, no formal threat model
  document yet.

## The threat boundary, so far

What the relay still sees even when content is sealed: which endpoints exist and their public
keys, who is talking to whom, envelope sizes and timing, and delivery cursors. That is
inherent to the shape, not a defect — but it must be written down before anyone claims
"the operator cannot read your work", and the browser code-delivery problem from
[the feasibility research](../planning/e2ee-feasibility-research.md) still stands: an operator
who serves the web client can serve different code. A signed desktop build separates those
trusts; a browser tab does not.
