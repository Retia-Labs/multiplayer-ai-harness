/**
 * Finding runners, including ones this process did not start.
 *
 * A runner announces itself by writing <session>.runner.json before it serves
 * anything. That file is a claim, not proof: a runner killed with SIGKILL, or
 * anything at all on Windows - where terminating a process does not run its
 * signal handlers - leaves the claim behind with nothing on the other end.
 *
 * So liveness is always checked, never assumed. Believing a stale claim is the
 * worse failure of the two: the app would show a live run that cannot hear
 * anybody, and a person would sit waiting for an agent that no longer exists.
 */
const fs = require('fs');
const path = require('path');

const SUFFIX = '.runner.json';

/**
 * Is this pid a process that currently exists?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means it exists and belongs to somebody else, which still
 * counts as alive.
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function claimFile(logDir, sessionId) {
  return path.join(logDir, sessionId + SUFFIX);
}

function readClaim(logDir, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(claimFile(logDir, sessionId), 'utf8'));
  } catch {
    return null;
  }
}

function dropClaim(logDir, sessionId) {
  try {
    fs.unlinkSync(claimFile(logDir, sessionId));
    return true;
  } catch {
    return false;
  }
}

/**
 * The runner for a session, or null.
 *
 * A claim whose process is gone is deleted as a side effect rather than
 * reported, because there is nothing a caller could usefully do with it and
 * leaving it means asking the same dead question forever.
 */
function findRunner(logDir, sessionId) {
  const claim = readClaim(logDir, sessionId);
  if (!claim) return null;
  if (!pidAlive(claim.pid)) {
    dropClaim(logDir, sessionId);
    return null;
  }
  return claim;
}

/** Every live runner under this log directory. */
function listRunners(logDir) {
  let names;
  try {
    names = fs.readdirSync(logDir).filter((f) => f.endsWith(SUFFIX));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const sessionId = name.slice(0, -SUFFIX.length);
    const claim = findRunner(logDir, sessionId);
    if (claim) out.push(claim);
  }
  return out;
}

/** Remove every claim whose process is gone. Called on app start. */
function reap(logDir) {
  let names;
  try {
    names = fs.readdirSync(logDir).filter((f) => f.endsWith(SUFFIX));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const sessionId = name.slice(0, -SUFFIX.length);
    const claim = readClaim(logDir, sessionId);
    if (!claim || !pidAlive(claim.pid)) {
      if (dropClaim(logDir, sessionId)) removed += 1;
    }
  }
  return removed;
}

/**
 * Ask a runner to stop, and make sure it actually did.
 *
 * SIGTERM first so it can write its closing note and tidy up. On Windows that
 * is already a hard kill, and on Unix a wedged process may ignore it, so the
 * claim is cleaned up here either way once the pid is gone.
 */
async function stopRunner(logDir, sessionId, { timeoutMs = 5000 } = {}) {
  const claim = findRunner(logDir, sessionId);
  if (!claim) return { stopped: false, reason: 'no live runner' };
  try {
    process.kill(claim.pid, 'SIGTERM');
  } catch {
    dropClaim(logDir, sessionId);
    return { stopped: true, reason: 'already gone' };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(claim.pid)) {
      dropClaim(logDir, sessionId);
      return { stopped: true, reason: 'exited' };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(claim.pid, 'SIGKILL');
  } catch {
    /* it went away between the check and the signal */
  }
  dropClaim(logDir, sessionId);
  return { stopped: true, reason: 'killed' };
}

module.exports = { pidAlive, findRunner, listRunners, readClaim, dropClaim, reap, stopRunner, claimFile };
