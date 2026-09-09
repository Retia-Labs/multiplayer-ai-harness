'use strict';
// Desktop lifecycle rules, deliberately free of Electron so process cleanup, the quit
// warning and the tray menu can be checked without a display.
//
// The rule this file exists to enforce: closing the window is not quitting. The window is
// one client of an execution host that keeps serving the teammates who are still in the
// task. Quitting is a separate, explicit act, and it says out loud what it ends.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// The shell talks to its services over the IPC channel it spawned them with. A signal is not
// an option: Windows cannot deliver SIGTERM to a child at all, so a "polite stop" that only
// existed as a signal would be a polite stop that only existed on macOS and Linux.
function requestShutdown(child, reason = 'quit') {
  if (!child || !child.connected || child.exitCode !== null) return false;
  try { child.send({ type: 'shutdown', reason }); return true; } catch { return false; }
}

// Ask a service a question and wait for its answer on the same channel.
function askService(child, request, { timeoutMs = 1500 } = {}) {
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

// Killing the parent orphans whatever the host spawned under it - a provider CLI, a git
// process, a test runner still holding the workspace. On Windows only `taskkill /T` takes the
// tree; POSIX gets the process-group kill, which is why services are spawned detached there.
function killTree(pid, platform = process.platform) {
  if (!pid) return Promise.resolve(false);
  if (platform === 'win32') {
    return new Promise((resolve) => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve(true)));
  }
  return new Promise((resolve) => {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
    resolve(true);
  });
}

// Politely first, so the host can stop its turns and tell the team it is going; forcefully
// after that, so quitting never leaves half a fleet behind on the machine.
async function stopService(child, { timeoutMs = 6000, platform = process.platform, reason = 'quit' } = {}) {
  if (!child || !child.pid || (child.exitCode !== null && child.exitCode !== undefined) || child.signalCode !== null) return 'already-exited';
  const asked = requestShutdown(child, reason);
  if (asked && await waitForExit(child, timeoutMs)) return 'graceful';
  await killTree(child.pid, platform);
  await waitForExit(child, 2000);
  return 'killed';
}

// ---------- what the person is told ----------
function describeActive(active = []) {
  if (!active.length) return 'No tasks running';
  const waiting = active.filter((a) => a.waitingOnApproval).length;
  const n = active.length === 1 ? '1 task running' : active.length + ' tasks running';
  return waiting ? n + ' · ' + waiting + ' waiting for approval' : n;
}

// Quitting is the one action here that ends work other people are watching, so the warning
// names whose work it ends and the safe answer is the default.
function quitDialog(active = []) {
  const lines = active.slice(0, 4).map((a) => '• ' + (a.name || 'Untitled task')
    + (a.by ? ' — started by ' + a.by : '')
    + (a.waitingOnApproval ? ' (waiting for approval)' : ''));
  if (active.length > lines.length) lines.push('• …and ' + (active.length - lines.length) + ' more');
  return {
    type: 'warning',
    title: 'Quit Plexus',
    message: active.length === 1
      ? 'A task is still running on this machine'
      : active.length + ' tasks are still running on this machine',
    detail: lines.join('\n')
      + '\n\nQuitting stops them and tells your teammates this host is unavailable.'
      + '\nClosing the window instead leaves them running, and anyone in the task can carry on.',
    buttons: ['Cancel', 'Quit and stop tasks'],
    defaultId: 0,
    cancelId: 0,
    confirmId: 1,
    noLink: true
  };
}

function trayMenuTemplate({ hostName, active = [], hubUrl, windowVisible } = {}, actions = {}) {
  const items = [
    { label: windowVisible ? 'Focus Plexus' : 'Open Plexus', click: actions.open },
    { type: 'separator' },
    { label: hostName ? 'Host: ' + hostName : 'Host: starting…', enabled: false },
    { label: describeActive(active), enabled: false }
  ];
  for (const a of active.filter((x) => x.waitingOnApproval).slice(0, 3)) {
    items.push({ label: '⚠ ' + (a.name || 'A task') + ' needs approval', click: actions.open });
  }
  items.push(
    { type: 'separator' },
    { label: 'Copy team link', enabled: !!hubUrl, click: actions.copyLink },
    { label: 'Open in browser', enabled: !!hubUrl, click: actions.openExternal },
    { type: 'separator' },
    { label: 'Quit Plexus…', click: actions.quit }
  );
  return items;
}

// ---------- the setup a fresh launch restores ----------
// Where to connect, who this is, and how the window sat. Nothing about a task, a turn or a
// command: a launch reconnects and replays the log the relay already holds, and there is
// deliberately nothing here that could re-issue work whose outcome nobody can vouch for.
const STATE_KEYS = ['hubUrl', 'userName', 'bounds', 'lastQuitAt'];

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.fromEntries(Object.entries(raw).filter(([k]) => STATE_KEYS.includes(k)));
  } catch { return {}; }
}

function saveState(file, patch) {
  const next = { ...loadState(file), ...Object.fromEntries(Object.entries(patch).filter(([k]) => STATE_KEYS.includes(k))) };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  } catch { /* a remembered window size is never worth failing a launch over */ }
  return next;
}

module.exports = {
  requestShutdown, askService, waitForExit, killTree, stopService,
  describeActive, quitDialog, trayMenuTemplate, loadState, saveState, STATE_KEYS
};
