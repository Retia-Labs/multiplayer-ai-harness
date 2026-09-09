# Closing the window is not quitting (issue #18)

Implementation for [issue #18](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/18)
(P17), built on [#7](../../test/desktop-smoke.js)'s installed desktop app and
[#17](recover-after-loss.md)'s rule that connectivity is not an outcome.

## The defect this issue was pointing at

The execution host was tied to the window. `window-all-closed → app.quit()`, and the quit
handler killed the services. So a person tidying their desktop — or hitting the close button
because they were done looking at it — silently ended a task somebody else was watching, and
the only signal their teammate got was the one #17 built for a crash.

That is a bad trade in both directions. It makes closing the window dangerous, and it makes
quitting invisible: the app never said what it was about to end, and never confirmed that
ending it was what the person meant.

## Two different acts, told apart

| Action | What happens to the host | What the team sees |
| --- | --- | --- |
| Close the window | keeps running, reachable from the tray | nothing — the task carries on |
| Quit | turns interrupted, processes stopped, tree taken | `turn/completed: interrupted`, then the host offline with `lastOffline.reason = quit` |
| Crash / sleep / lost network | gone without saying | #17's `unknown` — no outcome claimed |

The third row is unchanged and deliberately so. A quit is the one case where the host is still
here and *can* account for its work, so it does: each running turn is interrupted and given the
chance to write its own `turn/completed: interrupted` before the socket closes. A host that
vanished cannot do that, which is exactly why `unknown` exists.

## The window

`win.on('close')` hides instead of closing, and `window-all-closed` no longer quits. The window
is one client of the host, not its container. Reopening comes from the tray, from
`app.on('activate')`, or from launching the app again — which is where the single-instance lock
matters: without it a second launch starts a second hub and a second host against the same data
directory, which is the duplicate the acceptance criterion asks about and also two processes
fighting over one sqlite file.

The first time the window goes away, a notification says the host is still running. A host that
outlives its window is only a good surprise if it is not a surprise.

## The quit

`requestQuit()` asks the host what it is running — the host is the only process that knows —
and if anything is, it shows what it would end, by name, with who started it and whether a
teammate is already blocked on it. Cancel is the default. `before-quit` routes Cmd-Q, the dock
menu and the taskbar close through the same warning, so there is no path that skips it.

Then `shutdown()` stops the services for real:

1. The host is **asked** over the IPC channel it was spawned with, not signalled. Windows
   cannot deliver a signal a child can act on, so a polite stop had to be a message to exist on
   every platform this app ships to.
2. It interrupts its turns, waits for each to write its outcome, tells the relay it is going on
   purpose, and exits.
3. Anything still alive after that is taken **with its process tree** — `taskkill /T` on
   Windows, a process-group kill on POSIX, which is why services are now spawned detached
   there. Killing only the parent leaves a provider CLI or a git process holding the workspace
   after the app is gone.

## A fresh launch restores setup, not work

`desktop-state.json` holds where to connect, who this is, and how the window sat. It holds
nothing else, and that is enforced by an allowlist rather than by the discipline of whoever
writes the next feature: a caller that tries to persist a thread, a turn or a command gets none
of it back. The conversation comes back from the relay's log, which is the record; the command
does not, because nobody can vouch for how far the old one got.

## Evidence

`node test/afk-tray.js` — 40 checks against the app, driving a real task on a real host with a
real teammate on the other side of the relay. The tray icon and the native modal cannot be
clicked by a test, so the shell exposes the same entry points those controls use and lets the
test answer the warning; what the warning *says* is asserted, only the click is stood in for.

The load-bearing ones:

- a teammate approves and the turn runs to completion **with the window closed**
- the window is hidden, not destroyed; both service processes are still running
- reopening, and launching the app a second time, add no second host
- the tray names the host, says what is running, raises anything blocked on a person, and
  always offers an explicit quit
- the quit warning names the task and its owner, says a teammate is blocked, defaults to
  Cancel, and can be refused with everything left running
- the confirmed quit records `interrupted` — not `completed` — and the team is told the host is
  unavailable *because its owner quit*
- both service pids are gone and nothing is left listening on the port
- relaunching restores the workspace with the task idle, no turn replayed, no command
  re-issued, and the unapproved `rm -rf src` still not run

`node test/unit.js` adds four checks that need no display: the warning's content and defaults,
the tray's contents, the setup allowlist, and that a stop is asked for over the child's own
channel.

`scripts/desktop-install-proof.js` runs `afk-tray.js` against the **installed** copy on Windows
and macOS, because the criterion is about the installed window rather than a checkout.
