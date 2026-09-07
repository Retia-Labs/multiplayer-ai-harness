'use strict';
// What closing a window means, what quitting means, and the difference between them.
//
// These were the same thing until issue #18: `window-all-closed` called `app.quit()`, which
// killed the execution host. So a teammate working in a browser lost the machine running
// their task because somebody on the other end clicked the X on a window they were not even
// looking at. Closing a window is a statement about a window.
//
// The decisions live here rather than inline in main.js because they are the part worth
// testing, and because an Electron main process is an awkward place to reason about anything.

// Closing the last window quits only when there is nothing left to keep the app alive for.
// With a tray icon there is: the host keeps running and the tray is how somebody gets it back.
function shouldQuitOnWindowClose({ hasTray }) {
  return !hasTray;
}

/**
 * What an explicit quit has to do before it does anything.
 *
 * The point is that quitting is allowed to stop work - that is what it is for - but it is not
 * allowed to stop work quietly. Somebody who quits while two tasks are running should be told
 * that, in those words, before it happens.
 */
function quitPlan({ activeTasks = 0, activeTaskNames = [] } = {}) {
  if (!activeTasks) {
    return {
      confirm: false,
      title: 'Quit Plexus',
      message: 'Quitting shuts down the execution host on this machine.',
      detail: 'Teammates will see this host as unavailable until you start Plexus again.'
    };
  }
  const names = activeTaskNames.slice(0, 3).join(', ');
  return {
    confirm: true,
    title: 'Quit while work is running?',
    message: activeTasks === 1
      ? 'One task is running on this machine.'
      : activeTasks + ' tasks are running on this machine.',
    // Named, because "some tasks are running" is not something anybody can act on.
    detail: (names ? names + (activeTasks > 3 ? ', and others' : '') + '.\n\n' : '')
      + 'Quitting stops them where they are. Whatever they already did stays done, and what they '
      + 'were part-way through will show as abandoned rather than finished. Teammates will see '
      + 'this host as unavailable until you start Plexus again.',
    buttons: ['Quit anyway', 'Keep running']
  };
}

// Reopening a window must not start a second execution host. Two hosts on one machine means
// two runtime ids, two pairing codes and a fleet list that implies a machine somebody does
// not have - and #18 asks for exactly this not to happen.
function shouldLaunchRuntime(child) {
  if (!child) return true;
  return child.exitCode !== null || child.signalCode !== null;
}

// What the tray says. The host being up is the thing somebody is checking, so it leads.
function trayState({ runtimeRunning, activeTasks = 0, windowOpen }) {
  if (!runtimeRunning) {
    return { tooltip: 'Plexus - execution host stopped', detail: 'Teammates see this machine as unavailable.' };
  }
  const work = activeTasks === 0 ? 'idle'
    : activeTasks === 1 ? '1 task running' : activeTasks + ' tasks running';
  return {
    tooltip: 'Plexus - execution host running, ' + work,
    detail: windowOpen ? null : 'The window is closed. The host is still running and teammates can still use it.'
  };
}

/**
 * Stopping a child process and its descendants.
 *
 * On Windows a provider CLI spawned by the runtime is not killed by killing the runtime:
 * `child.kill()` ends one process and leaves its tree behind, which is how a "quit" leaves a
 * model still running and a workspace still being written to. `taskkill /T` is the platform's
 * answer and there is no portable substitute, so this branches on purpose.
 */
function killTreeCommand(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') return { file: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
  // Elsewhere the runtime is a process-group leader and a negative pid reaches the group.
  return { file: 'kill', args: ['-TERM', '-' + pid] };
}

module.exports = { shouldQuitOnWindowClose, quitPlan, shouldLaunchRuntime, trayState, killTreeCommand };
