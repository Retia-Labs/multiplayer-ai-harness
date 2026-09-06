# Versioned opaque task log with endpoint replay

For issue #6, add a distinct versioned encrypted task protocol to the real hub.
The hub authenticates account/team/paired-runtime routing and persists opaque creation
requests and contiguous encrypted records. It never derives names, status, content
search or file-overlap projections from these tasks. Endpoint reducers own those views.

One paired execution host writes each task log. SDK-authenticated events bind opaque
routing, stable event identity, sequence and the previous record digest. A host-local
encrypted outbox and monotonic checkpoint support retry and reconnect without treating
delivery cursors as execution authority. New readers replay the full log; existing
readers retain their accepted prefix. Missing, modified and conflicting records remain
visible errors, with no plaintext fallback.

This extends [ADR 0003](0003-end-to-end-encrypted-collaboration-content.md). The fixture
uses its established encryption stack while the independent review gate is pending.
It does not migrate the legacy provider/composer flow or declare a production audit.
[Implementation, metadata and limits](../proofs/encrypted-task-replay.md) specify the
browser-code boundary, retained key-state prerequisite and unseen-suffix limitation.
