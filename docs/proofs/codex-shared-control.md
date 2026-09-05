# Proof: real Codex shared control and supported authentication

Bounded integration proof for
[issue #2](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/2) (P01), under
[the implementation spec](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/1).
It establishes the supported provider / version / authentication contract **before** the
production adapter is written, and records where the contract does not hold.

The machine-generated results live beside this file:

- [`codex-acceptance-matrix.md`](codex-acceptance-matrix.md) — the result matrix
- [`codex-acceptance-result.json`](codex-acceptance-result.json) — every check with its evidence
- [`codex-acceptance-provider.jsonl`](codex-acceptance-provider.jsonl) — Codex's own event stream from the run

## What this proves, and what it does not

**Proves.** Two humans, in two separate sessions, can supervise one real `codex exec` task
running on one person's machine: both watch the same ordered live stream, either can steer
it with attribution, either can stop it mid tool-work, a second turn resumes the same Codex
session, and a retried command identity does not run the action twice. Approvals are routed
to, and resolved exactly once by, a second human on the harness's own tool path.

**Does not prove.** That anyone wants this; that a subscription entitlement may be shared
with teammates; that Codex-executed commands can be gated by a teammate (they cannot — see
[Capability gaps](#capability-gaps-and-what-to-do-about-them)); or that anything survives a
runtime crash mid-command. This is an integration proof, not a security audit and not a
production readiness sign-off.

## Running it

```bash
node test/codex-acceptance.js                      # every lane this machine allows
node test/codex-acceptance.js --lane control       # no provider spend at all
node test/codex-acceptance.js --lane subscription  # the machine's `codex login`
node test/codex-acceptance.js --lane api           # isolated CODEX_HOME + OPENAI_API_KEY
node test/codex-acceptance.js --model gpt-5.4-mini # pin the model
```

`npm run test:codex` runs the control lane, which costs nothing and needs no provider
account, so it belongs in CI. The provider lanes spend real quota and are run by hand.

Exit status is 0 unless a check **failed**. `BLOCKED` is not a failure: it is a capability
this machine or this provider surface cannot supply, and every blocked row carries the
concrete thing an operator must do, or the supported alternative to use instead.

## Pinned version and platform prerequisites

| | |
| --- | --- |
| Codex CLI | **0.142.1** (`codex-cli 0.142.1`) |
| Event vocabulary | `codex exec --json` — `thread.started`, `turn.started/completed/failed`, `item.started/updated/completed`, `error` |
| Proved on | Windows 11 (10.0.26200) x64, Node v24.20.0 |
| Auth used | ChatGPT subscription login (`codex login status` → *Logged in using ChatGPT*) |

`probe()` reports version drift rather than failing on it: a newer CLI usually works, but
the JSONL event vocabulary is not a contract and a translator built on it must be re-proved
per version.

**Windows is the constraining platform, and it needed real fixes:**

- Node cannot spawn npm's `codex.cmd` (`EINVAL`, since the argument-injection fix) and
  cannot see npm's extensionless `codex` shim at all (`ENOENT`). The adapter now resolves
  the vendored `codex.exe` that npm installs as a platform package, and falls back to
  `cmd.exe /d /s /c <shim>`. Before this, the Codex backend could not run on Windows at all.
- `which` is not a Windows command. Capability detection used it, so `codex-cli` reported
  itself unconfigured on every Windows host. It now uses `where.exe` there.
- The local executor's Git-Bash fallback paths were written as single-quoted JS strings
  containing `\b`, which is a backspace escape — the paths could never match. They are
  forward-slashed now.
- The existing `test/protocol-smoke.js` hard-coded `/bin/bash` and could not run on Windows.
  It now resolves the platform shell.

## The provider contract this adapter depends on

Fresh turn:

```
codex exec --json --skip-git-repo-check -C <workspace> --sandbox <policy> [-m <model>] <prompt>
```

Resumed turn:

```
codex exec resume --json --skip-git-repo-check [-m <model>] <session-id> <prompt>
```

Three constraints found the hard way, each now covered by a test:

1. **`--full-auto` is deprecated** and absent from `codex exec --help` in 0.142.x. The
   adapter sends `--sandbox workspace-write` instead.
2. **`codex exec resume` takes a much smaller option set** than `codex exec` — it has no
   `--cd` and no `--sandbox`, because the working root and sandbox policy come from the
   recorded session. Passing either is a hard parse error that fails the whole turn. Resume
   relies on the child process's `cwd` instead.
3. **Codex reads a piped stdin as additional prompt input and waits on it.** The adapter
   spawns with `stdio: ['ignore', …]`; an open, never-written stdin pipe risks a hang.

`stderr` is now captured and surfaced: it carries the failures that never reach the JSONL
stream (bad flag, missing auth, killed sandbox). Swallowing it turned every one of those
into a silent pass — which is exactly the "UI-only success" this ticket exists to rule out.

## Shared control: what a second human can actually do

| Control | Works on a real Codex turn | How it is proved |
| --- | --- | --- |
| Watch the same live stream | yes | both clients' event sequences compared |
| Start a task | yes | Codex acknowledges `thread.started` + `turn.completed` |
| Steer a running turn | yes, as a resumed turn | Codex acknowledges a second exec on the *same* session id |
| Stale-turn rejection | yes | a steer with a wrong `expectedTurnId` is refused |
| Interrupt during tool work | yes | turn ends `interrupted`; the Codex process is gone |
| Resume explicitly | yes | second turn reuses the stored Codex session id |
| Approve a Codex-run command | **no** | `codex exec` never emits an approval request |

**Steering is honest about delivery.** `codex exec` cannot take input into a process that is
already running, so a steer that arrives mid-turn is delivered as an immediate resumed turn
on the same Codex session once the current process exits. `turn/steer` therefore returns a
`delivery` field — `inline` for model-backed and demo backends, `nextProviderTurn` for the
Codex CLI — so a client can distinguish *the agent has this* from *this is queued*. Story 11
asks that chat display is never mistaken for agent receipt; this is that mechanism.

The Codex session handle stays on the runtime. `publicThread()` strips `codexSessionId`
before anything is sent to the hub, so resume works without the sync service ever holding a
provider session identifier.

## Command identity, retries, and the limits of "once"

Command identities are supplied by the caller and keyed per user at the hub. A repeat of an
identity already accepted is treated as a retry, never as a second action: the original
result is replayed with `duplicate: true`, and a caller that retries while the first is
still in flight is joined to it rather than issuing a second one. A command that never
reached a runtime stays retryable. Only settled entries are evictable from the log —
dropping one still in flight would let its retry run the action twice.

Approval resolution is separately single-authority at the execution host: the first
`approval/resolve` for a `requestId` wins and removes it, so a competing decision gets `no
such pending approval`. The proof races two humans resolving the same request with opposite
decisions and asserts exactly one authoritative outcome.

**What this is not.** Deduplication is relay-scoped. It makes a retried command identity run
at most once *through the hub*. It is **not** a claim of exactly-once external side effects:
a runtime that dies after a command has partially run leaves that partial effect behind, and
the harness has no undo and does not fence external side effects. What it does offer is the
append-only thread log, so a human can see the last acknowledged item before the crash.

## Authentication modes, usage owner, and entitlements

Two modes are exercised separately.

**Subscription (ChatGPT).** `codex login status` → *Logged in using ChatGPT*. The account's
model list is cached at `$CODEX_HOME/models_cache.json`, and the service enforces it:
`gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5`, `gpt-5.1` and
`gpt-5-codex` are **all rejected** for a ChatGPT account on this build with
*"model is not supported when using Codex with a ChatGPT account"*. The adapter's advertised
model list was wrong and has been corrected. A model cached for a newer CLI than the one
installed is also rejected — *"requires a newer version of Codex"* — so the probe reports
cache-versus-binary drift as a blocker with the upgrade or `--model` pin as its answer.

**API key.** Exercised in an isolated `CODEX_HOME` authenticated with
`codex login --with-api-key`, so the API login never disturbs the machine's real
subscription login. Absent `OPENAI_API_KEY`, the lane records itself `BLOCKED` with the
exact operator action, rather than silently passing.

**Usage owner.** The Codex credential stored on the execution host. Every teammate's
instruction — steers, interrupts, approvals — is billed to that one account, because the
runtime is the only process that talks to the provider.

**Multi-human authority.** Teammates act *through* the execution host's single provider
identity. The harness attributes every instruction to its author and orders them; the
provider sees one principal. That is the supported shape.

**Not proved, deliberately.** Technical login success is not evidence that a subscription
entitlement may be shared with, or transferred to, teammates. Whether several humans may
direct work billed to one person's ChatGPT subscription is a commercial and terms question,
not a test result, and nothing in this proof should be read as answering it.

## Capability gaps and what to do about them

**A teammate cannot approve a command Codex itself runs.** `codex exec` enforces its own
sandbox and never emits an approval request, so there is no decision to route. The harness's
own tool path *does* route a bounded approval to a second human and resolve it exactly once —
that mechanism is proved — but it does not cover commands Codex executes internally.

*Concrete alternative:* drive Codex through **`codex app-server`**, whose protocol carries
`CommandExecutionRequestApproval`, `FileChangeRequestApproval` and `ApplyPatchApproval`, with
`accept | acceptForSession | decline | cancel` decisions — the same vocabulary
`packages/protocol/index.js` already speaks. It is marked experimental in 0.142.x, so
adopting it is a scoped decision for the production adapter, not a drop-in.

*Interim control:* run the Codex adapter with `--sandbox read-only`, so Codex cannot write
or reach the network without going through the harness's own tools, where approvals work.

**Steers cannot enter a turn already in flight.** Mitigated by resumed delivery and reported
honestly through the `delivery` field; `app-server` also removes this gap.

## What still needs a human

This ticket is `ready-for-human` for reasons the harness cannot resolve itself:

1. **An authorized API test account.** The API lane needs `OPENAI_API_KEY` for an account
   entitled to Codex. Without it that lane reports `BLOCKED`.
2. **Confirming the offered authentication arrangement.** Whether pilot teams bring a
   ChatGPT subscription, an API key, or either, and who is named as the usage owner, is a
   product decision. The proof records what each mode does; it does not choose.
3. **The entitlement question above.** It needs a reading of the provider's terms, not a
   test.

Everything else in the acceptance criteria is executed by
[`test/codex-acceptance.js`](../../test/codex-acceptance.js) and recorded in the matrix.
