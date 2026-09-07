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
still says what teammates will see. With work in flight it warns, names the tasks, defaults to
**Keep running**, and says what happens to a part-finished turn — it will show as *abandoned*
rather than finished, which is #17's distinction and the honest word for it.

**Killing a process is not killing its tree.** On Windows a provider CLI spawned by the runtime
survives the runtime being killed, so a "quit" could leave a model running and a workspace
still being written to. The force path now reaches the whole tree with `taskkill /T` before
falling back to the single handle.

## The criteria

**1 · close and reopen while a real task runs; no duplicate runtime; the other client can still
participate** — met, and asserted against a **second client that is not the desktop**: it sees
the host online with the window closed, and the host keeps the same pid across close and
reopen.

**2 · explicit quit warns if tasks are active, confirms, shuts down managed processes, reports
unavailable** — met. The warning is asserted with its text and its default button; the shutdown
is asserted against the operating system.

**3 · platform process cleanup and tray controls; sleep or lost connectivity is not reported as
completed or stopped** — partly met, and the gap is named below. The cleanup path exists and
`killTreeCommand` is unit-tested per platform. The "not reported as completed" half is #17's
work: a host that goes away leaves its threads `unknown`, never `idle`.

**4 · fresh launch restores connection state without replaying an uncertain task** — met by
#17's `reconcileAfterRestart()`, which records an interrupted turn as `abandoned` and replays
nothing.

## Reproduce

`npm run test:desktop-lifecycle` — 11 checks driving the **real Electron app**: the tray
exists, a teammate on a separate socket sees the host online, the window closes and the host
survives with the same pid, the teammate still sees it, the tray says so, reopening produces no
second host, the fleet still lists one, both quit plans are correct, and after an explicit quit
the host process is gone according to the OS.

`npm run test:desktop` (the existing smoke) still passes.

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

**Process-tree cleanup is asserted as a decision, not as a killed tree.** `killTreeCommand()`
returns the right command per platform and that is unit-tested; proving a grandchild process
actually dies needs a provider running under an installed app, which is #19's territory.
