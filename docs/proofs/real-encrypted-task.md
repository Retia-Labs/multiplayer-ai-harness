# A real task on the host, written to the encrypted log (issue #7)

Implementation for [issue #7](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/7)
(P06). Builds on [#6](encrypted-task-replay.md)'s log, [#8](teammate-enrollment.md)'s
enrolment and [#44](https://github.com/Retia-Labs/multiplayer-ai-harness/pull/44)'s key
exchange, and unblocks [#9](catchup-projection.md)'s catch-up view.

## What did not exist before this

`EncryptedFixtureHost` was instantiated **only in tests**. The runtime advertised
`taskProtocol: encrypted-v1`, refused legacy routes under `--encrypted-tasks-only`, and then
had no production path that opened an encrypted task. Every encrypted history in this
repository was written by test code.

`packages/runtime/encrypted-host.js` is that path. The host publishes an endpoint through the
real hub, finds the tasks addressed to it, opens the ones whose creator the team has
confirmed, and writes an actual turn into the log.

## Three things it refuses to guess

**Whose request to open.** Only an endpoint recorded as `verified` by #8's enrolment. The
host reads those verdicts from the hub and never makes them - hosts got read access to their
own team for this, and only read access, because a host that could vouch for endpoints could
admit itself an audience.

**Where a project lives.** An opaque `ep_` id means nothing until an operator maps it to a
directory. Without a mapping the task is left alone and reported as `project_not_mapped`; the
alternative is a remote identifier selecting a local folder.

**What the task actually is.** `run()` resolves the relay's stored record rather than trusting
the object it was handed. An earlier version verified whatever description a caller passed,
which is a host checking a claim against itself.

## Translating a turn into a log

The two vocabularies line up, so this is translation rather than a second execution engine:
`turn/plan/updated` → `plan.updated`, `item/completed` → `message.added`, `tool.completed` or
`diff.updated` by item type, `turn/completed` → `task.completed`, and a resolved approval →
`decision.recorded`, because an approval is exactly a person taking responsibility.

Two rules govern it. **Only completed facts cross** - a turn streams deltas, and an
append-only encrypted log is the wrong place for a permanent record of a half-written
sentence. **Nothing is invented** - an event with no counterpart is dropped, and the dropped
kinds are named in the module so the omission is deliberate rather than discovered later by
someone reading a gap in a history.

## The criteria

**1 · a real provider task, file changes, meaningful state through the encrypted path** -
**partly met, and the missing half is evidenced.** A real Codex 0.153.4 turn runs on the host
and reaches the log: 6 encrypted events in 17 seconds, replayed by the creator, read by #9's
projection, with the agent quoting a file only the authorized workspace contains. **File
changes are not produced**, because the only mode with measured project confinement is
read-only. See [the confinement evidence](codex-confinement.md); enabling `workspace-write`
would satisfy this clause by shipping an agent that can write outside the project a teammate
authorised.

**2 · credentials stay in the provider/host relationship** - met. Canary and token scans over
everything the relay serves and stores, after a real provider run.

**3 · workspace restrictions and provider capabilities enforced locally and shown
accurately** - met, and the accuracy is the point. The provider gate stays closed by default;
what an operator can open is pinned to read-only, reports `writes: false`, and appears in the
fleet list as "Codex CLI (read-only)" with its reason. `codex-app-server` and `claude-code`
stay closed entirely.

**4 · product identifiers separate from provider ones; solo start** - met. The fleet
descriptor carries no workspace path and no task id, a solo creator starts a task with no
other teammate present, and Codex's own session identity stays inside the host adapter.

## Reproduce

- `npm run test:encrypted-real-task` - 10 checks with the deterministic provider, so the path
  runs the same way everywhere: endpoint publication, solo creation, an unmapped project left
  alone, a real turn written and replayed, the catch-up projection reading it, and the relay
  canary scans.
- `npm run test:encrypted-codex-task` - 7 checks with the actual CLI. Skips loudly without an
  authenticated Codex.
- `npm run test:codex-confinement` - the sandbox evidence. Also skips loudly.

## Limits

**The host's identity does not survive a restart.** The SDK's persistent store is
IndexedDB-backed and Node has none, verified directly:

```
storageSupport: {"persistent":false,"backend":"memory",
                 "reason":"The `indexedDB` getter returned `null` or `undefined`"}
```

So a restarted host cannot read the log it wrote. `EncryptedHost.identityDurability()` says
so rather than leaving it to be discovered. The fix is to run the endpoint where a browser
store exists - the Electron renderer, with the key sealed by `safeStorage`, which #3's
platform proof already exercises on macOS and Windows.

Approvals cannot be routed to a teammate for commands Codex runs: `codex exec` enforces its
own sandbox and never asks. That is `codex-probe`'s `exec-approvals-not-routable` blocker and
it is unchanged here.

Task discovery is a `list` call the host makes; there is no push, so a task is picked up when
the host next looks rather than the moment it is created.
