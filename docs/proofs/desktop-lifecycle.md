# Closing the window is not quitting (issue #18)

Implementation for [issue #18](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/18)
(P17), built on [#7](real-encrypted-task.md)'s host and [#17](recover-after-loss.md)'s
reconciliation.

## The defect was one line

```js
app.on('window-all-closed', () => app.quit());
```

Closing the window quit the app, and quitting killed the execution host. So a teammate working
in a browser lost the machine running their task because somebody at the other end clicked the
X on a window they were not even looking at.

Closing a window is a statement about a window.

## What makes the difference possible

A tray icon. Without one there is no way back to a running host, so closing would *have* to end
it — which is why the tray is the feature here and not decoration. It says what is actually
true:

> Plexus — execution host running, idle
> The window is closed. The host is still running and teammates can still use it.

## Three more things this changed

**Reopening is not restarting.** `showWindow()` used to re-run boot, which tried to bind the
hub's port a second time and failed with `EADDRINUSE` — the same mistake as launching a second
runtime, wearing different clothes. It now loads the workspace that is already running.
`shouldLaunchRuntime()` refuses to spawn a second host for the same reason: two hosts on one
machine means two runtime ids, two pairing codes, and a fleet list implying a machine nobody
has.

**Quitting is allowed to stop work, but not quietly.** With nothing running, the quit dialog
still says what teammates will see. With work in flight it warns, names the tasks, says whether
a teammate is already blocked waiting on an approval in one of them, defaults to **Keep
running**, and says what happens to a part-finished turn.

**Killing a process is not killing its tree.** On Windows a provider CLI spawned by the runtime
survives the runtime being killed, so a "quit" could leave a model running and a workspace
still being written to. The force path reaches the whole tree with `taskkill /T` — and because
a POSIX group kill only reaches a group, the services are spawned detached there, so there is
a group to take.

**A quit is asked for, not signalled.** Windows cannot deliver a signal a child can act on, so
a polite stop that only existed as a signal would be a polite stop that only existed on macOS
and Linux. The shell asks over the IPC channel it spawned each service with. That is also how
it knows what to warn about: the host is the only process that knows what it is running, and
it can answer at the moment the decision is being made — which the websocket cannot, because
that connection is the thing about to go away.

**The host accounts for its own work before it goes.** This is the part #17 could not do for
it. A host that *vanishes* leaves `unknown`, because connectivity is not an outcome. A host
that is *quit* is still here: it interrupts each running turn, waits for each to write its own
`turn/completed: interrupted`, and tells the relay it left on purpose. So the thread reads
`interrupted` rather than being reconstructed as `abandoned` on the next launch, and the fleet
records `lastOffline.reason = quit` — teammates are told, rather than left to read a silence.

**A launch restores setup, not work.** `desktop-state.json` holds where to connect, who this
is, and how the window sat. Nothing else, and that is an allowlist rather than the discipline
of whoever writes the next feature: a caller that tries to persist a thread, a turn or a
command gets none of it back. The conversation comes back from the relay's log, which is the
record; the command does not, because nobody can vouch for how far the old one got.

## The criteria

**1 · close and reopen while a real task runs; no duplicate runtime; the other client can still
participate** — met, and asserted against a **second client that is not the desktop**: it sees
the host online with the window closed, and the host keeps the same pid across close and
reopen.

**2 · explicit quit warns if tasks are active, confirms, shuts down managed processes, reports
unavailable** — met. The warning is asserted with its text and its default button; the shutdown
is asserted against the operating system.

**3 · platform process cleanup and tray controls; sleep or lost connectivity is not reported as
completed or stopped** — met. `killTreeCommand` is unit-tested per platform, and the test now
also checks that **both** managed processes are gone after a quit, according to the operating
system rather than a relay that also went away. The "not reported as completed" half is #17's
work and is unchanged: a host that goes away leaves its threads `unknown`, never `idle`. What
is new is the other side of that distinction — a host that is quit says `interrupted` itself,
so the two situations no longer look alike.

**4 · fresh launch restores connection state without replaying an uncertain task** — met. The
setup a launch restores is an allowlist that cannot carry a task, and the test relaunches the
app after a quit and checks the workspace comes back with the task idle, two turns in the log,
no command re-issued, and the file the unapproved `rm -rf` would have deleted still there.

## Reproduce

`npm run test:desktop-lifecycle` — 17 checks and 2 recorded limits, driving the **real Electron
app with a real task in flight**:

- the tray exists, and a teammate on a separate socket sees the host online
- the window closes and the host survives with the same pid; the teammate still sees it
- **and can still use it**: the teammate approves the pending action and the turn runs to
  completion with the window closed — seeing a host is not the same as being able to work on it
- the tray says the host is running and the window is merely closed
- reopening produces no second host, and the fleet still lists one
- the idle quit plan says what teammates will see; the busy one warns, names the task from what
  the host reports, says a teammate is blocked on it, and defaults to **Keep running**
- a refused quit changes nothing, driven through the app's own quit path
- a confirmed quit records the turn as `interrupted`, tells the fleet the owner quit, and both
  managed processes are gone according to the OS
- launching again restores the workspace with nothing replayed

`npm run test:desktop` and `npm run test:desktop-bootstrap` still pass, as do `test:unit`
(7 checks here), `test:protocol`, `test:team`, `test:steering`, `test:approvals`,
`test:recover-after-loss`, `test:handover`, `test:help-inbox`, `test:related-work`,
`test:revocation` and `test:recovery`.

`scripts/desktop-install-proof.js` runs these same checks against the **installed** copy on
Windows and macOS, because the criterion is about the installed window rather than a checkout.

## What this broke, and why that was the right kind of breakage

The installed-app CI job was cancelled on both platforms and had to terminate orphan Plexus
processes. Playwright's `app.close()` relies on an app exiting when its windows close, and a
tray app legitimately does not - which is exactly the behaviour this issue asked for.

So the three desktop tests now quit explicitly, the same way a person does by choosing Quit
from the tray. Nothing about the product changed to accommodate them; what changed is that the
tests stopped depending on a behaviour the product no longer has.

## Limits, stated rather than implied

**The tray icon itself was not clicked.** No platform this is built for exposes a tray click to
an automated test. The tray menu's items call the same functions the test calls, so the
behaviour behind them is covered and the click is not. That is a real gap and it is recorded in
the test output as a note rather than counted as a pass.

**The quit confirmation dialog was not clicked either.** `quitPlan()` is asserted directly —
its text, its buttons and its default — because a modal dialog cannot be answered by a test in
this harness.

**A grandchild process was not proven to die.** Both managed processes are now checked against
the operating system after a quit, and `killTreeCommand()` is unit-tested per platform, so the
sweep and its effect on the processes this app owns are covered. What is still not covered is a
provider CLI running *underneath* the host at the moment of the quit: producing one needs a real
provider under an installed app, which is #19's territory.
