#!/usr/bin/env node
/**
 * The Quorum command line.
 *
 * Everything the desktop does is the session protocol underneath, so all of it
 * is reachable without a window. That matters for two reasons beyond taste: a
 * run can be started on a server that has no display, and anything scriptable
 * here is something CI can do too.
 *
 *   quorum run "<prompt>"        start a run in the current directory
 *   quorum ls                    live runs on this machine
 *   quorum watch <session>       follow a run in the terminal
 *   quorum say <session> "..."   talk in a run
 *   quorum share <session>       open a room and print the code
 *   quorum stop <session>        end a run
 *   quorum verify <session>      check the chain
 *   quorum relay                 host a relay
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const registry = require('../src/runner/registry');
const { EventLog } = require('../src/main/log');
const kernel = require('../src/main/kernel');
const { SessionClient, waitForServer } = require('../src/net/client');

/**
 * Share the desktop app's data directory, so the CLI and the window are two
 * views of the same runs rather than two parallel worlds.
 */
function dataDir() {
  if (process.env.QUORUM_DATA) return process.env.QUORUM_DATA;
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'quorum-desktop');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'quorum-desktop');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'quorum-desktop');
}

const DATA = dataDir();
const LOGDIR = path.join(DATA, 'sessions');
const SETTINGS = path.join(DATA, 'settings.json');

function me() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    if (s.displayName) return s.displayName;
  } catch {
    /* no settings yet */
  }
  return os.userInfo().username || 'me';
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function clientFor(sessionId) {
  const claim = registry.findRunner(LOGDIR, sessionId);
  if (!claim) die('No live run called ' + sessionId + '. Try: quorum ls');
  return new SessionClient({ base: claim.base, sessionId, token: claim.token || null, as: me() });
}

/* ---------------- commands ---------------- */

async function cmdRun(prompt) {
  if (!prompt) die('What should it do? quorum run "fix the failing test"');
  fs.mkdirSync(LOGDIR, { recursive: true });
  if (!fs.existsSync(SETTINGS)) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(SETTINGS, JSON.stringify({ mode: 'agent', model: 'gpt-5.1-codex-max', displayName: me() }, null, 2));
  }

  const sessionId = 't_' + Date.now().toString(16);
  const child = spawn(
    process.execPath,
    [path.join(__dirname, '..', 'src', 'runner', 'runner.js'),
     '--session', sessionId, '--logdir', LOGDIR, '--workdir', process.cwd(),
     '--settings', SETTINGS, '--port', '0'],
    { detached: true, stdio: ['ignore', 'pipe', 'inherit'] }
  );

  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('the runner did not start')), 20000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.ready) {
            clearTimeout(timer);
            child.unref();
            resolve(parsed);
          }
        } catch {
          /* partial */
        }
      }
    });
  });

  const client = new SessionClient({ base: info.base, sessionId, as: me() });
  await client.submit({
    kind: 'turn.started',
    actor: 'human:' + me(),
    payload: { turnId: 'turn_' + Date.now(), text: prompt }
  });
  console.log('Started ' + sessionId + ' (pid ' + info.pid + ').');
  console.log('It keeps running if you close this terminal.');
  console.log('  quorum watch ' + sessionId);
  await cmdWatch(sessionId);
}

function cmdLs() {
  const runs = registry.listRunners(LOGDIR);
  if (!runs.length) return console.log('No runs going.');
  for (const r of runs) {
    const state = kernel.reduce(r.sessionId, new EventLog(LOGDIR).read(r.sessionId));
    const open = kernel.openGates(state).length;
    console.log(
      r.sessionId.padEnd(20) +
        state.status.padEnd(9) +
        (open ? String(open) + ' waiting  ' : '          ') +
        (state.title || r.workDir)
    );
  }
}

async function cmdWatch(sessionId) {
  const client = await clientFor(sessionId);
  console.log('Watching ' + sessionId + '. Ctrl-C to stop watching; the run continues.\n');
  client.on('events', (events) => {
    for (const e of events) print(e);
  });
  client.on('live', (ev) => {
    if (ev.kind === 'item-delta' && ev.delta) process.stdout.write(ev.delta);
  });
  client.connect();
  await new Promise(() => {});
}

function print(e) {
  const who = e.actor.replace(/^(human|agent):/, '');
  const p = e.payload || {};
  switch (e.kind) {
    case 'turn.started':
      return console.log('\n' + who + ': ' + (p.text || ''));
    case 'turn.message':
      return console.log('\n' + who + ' → ' + (p.text || ''));
    case 'note.posted':
      return console.log('  · ' + who + ': ' + (p.text || ''));
    case 'command.ran':
      return console.log('  $ ' + p.cmd + (p.exitCode ? ' (exit ' + p.exitCode + ')' : ''));
    case 'artifact.changed':
      return console.log('  ~ ' + p.path + ' +' + (p.added || 0) + ' -' + (p.removed || 0));
    case 'gate.requested':
      return console.log('  ! waiting for approval: ' + p.subject);
    case 'gate.resolved':
      return console.log('  ' + (p.approved ? '✓' : '✗') + ' ' + who + ' ' + (p.approved ? 'approved' : 'denied') + ' it');
    case 'step.started':
      return console.log('  → ' + p.id);
    case 'run.finished':
      return console.log('\nDone.');
    default:
      return undefined;
  }
}

async function cmdSay(sessionId, text) {
  if (!text) die('Say what? quorum say <session> "looks good"');
  const client = await clientFor(sessionId);
  await client.submit({ kind: 'note.posted', actor: 'human:' + me(), payload: { text } });
  console.log('Said it.');
}

async function cmdShare(sessionId, relay) {
  const claim = registry.findRunner(LOGDIR, sessionId);
  if (!claim) die('No live run called ' + sessionId);
  const target = relay || process.env.QUORUM_RELAY || 'http://127.0.0.1:7788';
  if (!(await waitForServer(target, { timeoutMs: 3000 }))) {
    die('No relay at ' + target + '. Start one with: quorum relay');
  }
  const res = await fetch(claim.base + '/s/' + sessionId + '/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ relay: target })
  });
  const body = await res.json();
  if (!res.ok) die(body.error || 'Could not share');
  console.log('\n  Room code:  ' + body.code + '\n  Relay:      ' + target + '\n');
  console.log('Anyone with that code can watch, talk, steer and approve.');
}

async function cmdStop(sessionId) {
  const res = await registry.stopRunner(LOGDIR, sessionId);
  console.log(res.stopped ? 'Stopped ' + sessionId + ' (' + res.reason + ').' : res.reason);
}

function cmdVerify(sessionId) {
  const res = new EventLog(LOGDIR).verify(sessionId);
  if (res.ok) console.log('Intact. ' + res.seq + ' events, chain verifies.');
  else {
    console.log('BROKEN at event ' + res.seq + ': ' + res.reason);
    process.exit(1);
  }
}

function usage() {
  console.log(
    [
      'quorum run "<prompt>"        start a run here; it survives this terminal',
      'quorum ls                    live runs on this machine',
      'quorum watch <session>       follow a run',
      'quorum say <session> "..."   talk in a run',
      'quorum share <session>       open a room, print the code',
      'quorum stop <session>        end a run',
      'quorum verify <session>      check the chain is intact',
      'quorum relay                 host a relay for other people to join through'
    ].join('\n')
  );
}

const [cmd, ...rest] = process.argv.slice(2);
const run = async () => {
  switch (cmd) {
    case 'run': return cmdRun(rest.join(' '));
    case 'ls': return cmdLs();
    case 'watch': return cmdWatch(rest[0] || die('Which run? quorum ls'));
    case 'say': return cmdSay(rest[0], rest.slice(1).join(' '));
    case 'share': return cmdShare(rest[0], rest[1]);
    case 'stop': return cmdStop(rest[0] || die('Which run?'));
    case 'verify': return cmdVerify(rest[0] || die('Which run?'));
    case 'relay': return require('./relay.js');
    default: return usage();
  }
};

run().catch((err) => die(String((err && err.message) || err)));
