# Turning the Codex provider on (follow-up to #7)

[#7](real-encrypted-task.md) proved a real Codex task runs and reaches the encrypted log.
[#54](codex-confinement.md) proved the host can apply the file changes Codex proposes without
ever giving it a writable shell.

Both were reached by constructing a `Runtime` in code. That is something only a test does — so
the capability shipped with **no way for a person to switch it on**. The desktop launches the
runtime without it, and `parseArgs` had no flag for it: `codexReadOnly` was never read from
arguments or from config, so it stayed `false` on every host anybody could actually start.

This closes that. It is a follow-up to #7 rather than new work, and it is written down because
the criterion was ticked on evidence from a path no user could reach.

## The switch

```
node packages/runtime --codex-read-only …          # for one run
{ "codexReadOnly": true }                          # in the host's runtime.json
```

## Why the desktop does not pass it

**Because the evidence is local.** The confinement was measured on one platform with one Codex
build, and `test:codex-confinement` — the test that would catch read-only ceasing to hold —
**skips when no authenticated Codex is present**, which is the case in CI and on most machines.
Defaulting the gate open would be opening it on evidence gathered on somebody else's laptop.

**Because the product already decides this kind of thing at the machine.** Authorizing a folder
is host-local and deliberate: *"a project must be authorized on the host itself"*, refused over
the network with `project_add_local_only`. Which provider may run here is the same class of
decision, so it lives in the same host-local file, set by the person standing in front of the
machine.

The desktop therefore needs no change: it already points the runtime at that config directory,
so an operator who turns it on gets it today. A Settings toggle is a small follow-on — the app
already knows how to write that file, which is how folders are authorized.

## A bug this surfaced

Switching a thread from the demo agent to Codex carried the **previous provider's model** over,
and the runtime passed it through as `-m demo-agent`:

```
The 'demo-agent' model is not supported when using Codex with a ChatGPT account.
```

A model belongs to a provider, so carrying one across a provider switch is never right.
`resolveSettings` now drops the model when the provider changes and no model was named with it,
which lets the new provider pick its own default. The acceptance test deliberately starts on the
demo agent and switches, because that is what a person does and it is what was broken.

## Reproduce

`npm run test:codex-switch` — 8 checks: the flag and the config key, the provider refused and
reported as `isolation pending` on a host nobody switched on, the provider offered with both
halves of the truth on a host somebody did, the confined backend, and then a real Codex turn
that reads a canary only the authorized workspace contains and writes a file naming it.

**Measured** with Codex 0.153.4: `WINDOW.md` written in 18 seconds, contents taken from a file
in the project, nothing written outside it, every `codex exec` invocation pinned to
`--sandbox read-only`. Skips loudly without an authenticated CLI.

## Limits

Still off by default, deliberately. Turning it on is a decision somebody makes at a machine
after reading `codex-confinement.md`, not a default the product makes for them.

`codex-app-server` and `claude-code` remain closed entirely — no evidence has been gathered for
either.
