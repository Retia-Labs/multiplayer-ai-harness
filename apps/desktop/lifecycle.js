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
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

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
function quitPlan({ activeTasks = 0, activeTaskNames = [], blocked = 0 } = {}) {
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
    // Named, because "some tasks are running" is not something anybody can act on. A teammate
    // already waiting on an approval is named too: they are the person this decision costs.
    detail: (names ? names + (activeTasks > 3 ? ', and others' : '') + '.\n\n' : '')
      + (blocked ? (blocked === 1 ? 'A teammate is waiting on an approval in that work.\n\n'
        : blocked + ' of them have a teammate waiting on an approval.\n\n') : '')
      + 'Quitting stops them where they are. Whatever they already did stays done, and what they '
      + 'were part-way through is recorded as interrupted rather than finished. Teammates will '
      + 'see this host as unavailable until you start Plexus again.\n\n'
      + 'Closing the window instead leaves them running, and anyone in the task can carry on.',
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

// ---- stopping a managed service ----
//
// The shell asks over the IPC channel it spawned the service with. A signal is not an option:
// Windows cannot deliver SIGTERM to a child in a form the child can act on, so a "polite stop"
// that only existed as a signal would be a polite stop that only existed on macOS and Linux.
// Asking is what lets the host interrupt its turns, report them, and tell the team it is going.
function requestShutdown(child, reason = 'quit') {
  if (!child || !child.connected || child.exitCode !== null) return false;
  try { child.send({ type: 'shutdown', reason }); return true; } catch { return false; }
}

// Ask a service a question and wait for its answer on that same channel.
function askService(child, request, { timeoutMs = 2500 } = {}) {
  if (!child || !child.connected || child.exitCode !== null) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('message', onMessage); resolve(null); }, timeoutMs);
    const onMessage = (message) => {
      if (!message || message.type !== request.type) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(message);
    };
    child.on('message', onMessage);
    try { child.send(request); } catch { clearTimeout(timer); child.off('message', onMessage); resolve(null); }
  });
}

function waitForExit(child, ms) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
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

function killTree(pid, platform = process.platform) {
  const sweep = killTreeCommand(pid, platform);
  if (!sweep) return Promise.resolve(false);
  return new Promise((resolve) => {
    try { execFile(sweep.file, sweep.args, () => resolve(true)); } catch { resolve(false); }
  });
}

// Politely first, so the host can stop its turns and tell the team it is going; forcefully
// after that, so quitting never leaves half a fleet behind on the machine.
async function stopService(child, { timeoutMs = 6000, platform = process.platform, reason = 'quit' } = {}) {
  if (!child || !child.pid) return 'already-exited';
  if (child.exitCode !== null && child.exitCode !== undefined) return 'already-exited';
  if (child.signalCode !== null && child.signalCode !== undefined) return 'already-exited';
  const asked = requestShutdown(child, reason);
  if (asked && await waitForExit(child, timeoutMs)) return 'graceful';
  await killTree(child.pid, platform);
  try { child.kill('SIGKILL'); } catch { /* already gone, or gone by the time we asked */ }
  await waitForExit(child, 2000);
  return 'killed';
}

// ---- the setup a fresh launch restores ----
//
// Where to connect, who this is, and how the window sat. Nothing about a task, a turn or a
// command: a launch reconnects and replays the log the relay already holds, and there is
// deliberately nothing here that could re-issue work whose outcome nobody can vouch for. The
// allowlist is the guarantee, not the discipline of whoever writes the next feature.
const STATE_KEYS = ['hubUrl', 'userName', 'bounds', 'lastQuitAt'];

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.fromEntries(Object.entries(raw).filter(([k]) => STATE_KEYS.includes(k)));
  } catch { return {}; }
}

function saveState(file, patch) {
  const kept = Object.fromEntries(Object.entries(patch).filter(([k]) => STATE_KEYS.includes(k)));
  const next = { ...loadState(file), ...kept };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  } catch { /* a remembered window size is never worth failing a launch over */ }
  return next;
}

module.exports = {
  shouldQuitOnWindowClose, quitPlan, shouldLaunchRuntime, trayState, killTreeCommand,
  requestShutdown, askService, waitForExit, killTree, stopService, loadState, saveState, STATE_KEYS
};
