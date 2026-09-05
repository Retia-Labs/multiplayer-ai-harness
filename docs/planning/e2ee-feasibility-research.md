# E2EE feasibility for shared agent work

Research date: 2026-09-05. Primary-source review; no implementation or security audit has been performed. Recommendations below are application design inferences, not cryptographic protocol specifications.

## Feasibility and trust boundary

An encrypted hosted relay with local execution hosts is feasible. Plaintext must exist on authorized participant devices and the execution host; agent providers also receive whatever the runtime sends to them. E2EE against the collaboration hub does not mean that providers, authorized teammates, malware on endpoints, or customer recovery-key holders cannot read content.

The browser creates an important limit: a hub operator that also controls the browser application's delivered code can replace that code and capture decrypted content. Web Crypto does not eliminate this threat; its security model treats hostile scripts as capable of stealing data or using keys. Non-extractable keys do not prevent authorized-origin code from asking them to decrypt. Therefore “the operator can never read content” is not a defensible blanket promise for an operator-served browser client. [W3C Web Cryptography security considerations](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/#security-considerations)

A signed, packaged Electron client can separate relay trust from code-delivery trust, but users still trust the publisher and update pipeline. Browser participation must either accept that code-delivery assumption or use an independently trusted client-delivery mechanism. CSP and integrity protections mitigate injection; they do not turn the author of the delivered application into an untrusted party. Electron should load packaged code, isolate renderers, sandbox them, narrowly expose IPC, and validate IPC senders. [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)

## Established candidates to evaluate

| Candidate | Why evaluate it | Scope still owned by this product |
| --- | --- | --- |
| MLS (RFC 9420) with OpenMLS | Standardized group membership changes and epoch keys, asynchronous groups, forward secrecy and post-compromise security; OpenMLS is a Rust implementation with a WASM compilation feature. | Device identity trust, authorization, storage, offline state convergence, recovery, history policy, Electron/browser packaging, and secure application integration. |
| Matrix SDK crypto stack | Existing group-encryption ecosystem, device verification, key sharing, and encrypted backups; WASM bindings provide a browser integration candidate. | Whether adopting Matrix's room/device model and backend contracts is acceptable; fit with ordered agent controls and local execution; recovery design and review. |

MLS explicitly advances group cryptographic state when membership changes. Removed members must not receive later epoch secrets; this cannot revoke plaintext or keys they already possessed. Maintaining recoverable history introduces additional retained secrets beyond a strictly erased live ratchet. [RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html)

OpenMLS supplies protocol building blocks, not a turnkey product security boundary. Verify the selected release, supported platforms, storage implementation, and WASM packaging in a spike. Do not transfer any library audit claim to this application. [OpenMLS repository](https://github.com/openmls/openmls)

Matrix's guide identifies Olm/Megolm and vodozemac; its WASM crypto package is a concrete alternative to evaluate, not a recommendation to implement those primitives manually. [Matrix encryption guide](https://matrix.org/docs/matrix-concepts/end-to-end-encryption/), [Matrix crypto WASM](https://github.com/matrix-org/matrix-sdk-crypto-wasm)

## Enrollment, approvals, revocation

Application requirements proposed for either candidate:

- Treat each browser profile, desktop device, and execution host as a separately enrolled cryptographic endpoint. Login and an invitation identify a prospective participant; neither alone proves a trustworthy encryption key.
- Require an existing trusted endpoint or the customer's recovery authority to authenticate enrollment. Provide an established verification flow, such as protocol-supported QR or fingerprint verification. A malicious relay must not silently substitute keys or add a device.
- Bind project roles and delegated approver grants to authenticated identities and current membership. The execution host must validate them; the hub's database role is insufficient against an untrusted hub.
- Bind each approval decision to its exact request, execution host, task, action content, authorized device, and validity window. Consume a decision once; reject replay, stale membership, reordered revocation, and changed action content. These are protocol-integration requirements requiring review, not a proposed custom signature format.
- Rotate group state on removal and prevent removed devices from obtaining later keys. An offline host unable to establish current authorization should not execute stale approvals. Decide explicitly how much outage tolerance is acceptable.

MLS separates delivery from authentication: a malicious delivery service cannot simply derive the group key, but the authentication service and endpoint identity binding remain security-critical. This is why enrollment cannot trust an arbitrary public key supplied by the relay. [MLS architecture, RFC 9750](https://www.rfc-editor.org/rfc/rfc9750.html)

## Device storage and customer recovery

On desktop, protect persisted device secrets with OS-backed storage exposed by Electron's main process. Electron documents macOS Keychain and Windows DPAPI semantics; Windows protection does not exclude other processes running as the same user. Storage encryption is not protection against a compromised running device. Validate availability, signed-build behavior, locked-keychain behavior, and failure handling on both supported systems. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

For browser keys, establish supported browser persistence and site-data-deletion behavior. Web Crypto leaves underlying key storage implementation-dependent; do not market browser keys as hardware-backed merely because they are non-extractable. [W3C Web Cryptography](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/#security-considerations)

Customer recovery must restore only an explicitly defined scope: archived content, endpoint enrollment authority, or both. Keep recovery authority distinct from the agent provider's credentials and ordinary login. The customer retains the secret; the hub stores only encrypted backups. Matrix provides a concrete precedent: encrypted server-side key backups need client-held decryption material, and clients authenticate backup metadata before using it. Do not copy a backup algorithm out of documentation; evaluate the supported SDK version and its current security guidance. [Matrix key backups and device verification](https://spec.matrix.org/v1.15/client-server-api/#server-side-key-backups)

Proposed UX: verify recovery by restoring on a clean device during setup; make loss consequences clear; support replacement and compromise response. If all authorized keys and the recovery secret are lost, the operator cannot decrypt the old data. A retained old backup and old recovery key can still expose old history after rotation. Recovery of history must not silently restore obsolete delegated approver privileges.

## Relay metadata and features that must move

Minimum practical relay exposure for the proposed architecture, not a universal protocol requirement: opaque routing/mailbox identifiers, ciphertext sizes and timing, connection IPs, delivery/acknowledgment cursors, storage usage, protocol versions, and account/billing information. Membership/routing relationships may also be exposed depending on the chosen protocol. Document which are retained and for how long. TLS remains necessary for transport and metadata protection; MLS does not hide all traffic information. [MLS architecture](https://www.rfc-editor.org/rfc/rfc9750.html)

Encrypt project names, repository URLs, filenames, prompts, transcripts, tool arguments/results, diffs, approval text, summaries, and presence details unless individually justified as disclosed metadata. Move content search, summarization, file-collision detection, content classification, and action-policy evaluation to trusted clients or execution hosts. The hub can store encrypted indexes or derived outputs without reading them. Hashing predictable filenames alone does not make them private.

Push/email notifications should contain generic activity indicators rather than plaintext task content. Error logs, telemetry, crash reports, analytics, and support exports need explicit content handling. Any activation metric emitted to the hub should be a deliberately disclosed aggregate or event, not transcript inspection. These are design deductions from withholding plaintext from the hub.

## Gates before claiming E2EE in early access

1. Written threat model states browser code-delivery trust, provider exposure, endpoint compromise limits, metadata, recovery scope, and revoked-history limits.
2. One chosen established stack passes macOS/Windows/browser enrollment, offline reconnect, membership change, and corrupted-state recovery tests. No homegrown group cryptography.
3. A malicious-relay test cannot enroll a substitute key, replay approval, alter action content, or make a revoked device authorize new execution.
4. Customer recovery works on a clean device; wrong keys fail; the operator has no decryption or hidden recovery path. No rollback of approval authority occurs.
5. A plaintext-flow inspection covers databases, queues, object storage, logs, telemetry, notifications, and support tools. Content-derived hub features are relocated or disabled.
6. Independent security review covers the implementation and threat model; wording accurately reflects what was reviewed. If review is not complete, disclose that fact and do not call the product security-audited.

These are suggested engineering launch gates. They should be costed explicitly in the short launch plan; E2EE is not a transport toggle.
