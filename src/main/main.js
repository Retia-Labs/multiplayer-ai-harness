const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const Store = require('./store');
const git = require('./gitutils');
const { RunnerPool } = require('./runners');
const registry = require('../runner/registry');
const { RoomBook } = require('./rooms');
const { EventLog } = require('./log');
const { Recorder } = require('./recorder');
const kernel = require('./kernel');
const workspace = require('./workspace');
const github = require('./github');

let win = null;
let store = null;
let log = null;
let pool = null;
let rooms = null;
const recorders = new Map(); // threadId -> Recorder

/**
 * Who this desktop is. Until there are accounts, the log still has to attribute
 * every action to somebody: "approved by" is the whole point of recording an
 * approval, and "approved by the app" answers nothing.
 */
function me() {
  return (store.getSettings().displayName || require('os').userInfo().username || 'me').trim();
}

/**
 * A thread's recorder, created on first use.
 *
 * Threads that predate the log get a session.started written now rather than a
 * backfilled history: inventing events that never happened would put fiction
 * into a record whose only value is that it is not fiction.
 */
function recorderFor(threadId) {
  let r = recorders.get(threadId);
  if (r) return r;
  const t = store.getThread(threadId);
  r = new Recorder({
    log,
    sessionId: threadId,
    agentName: 'quorum',
    humanName: me()
  });
  if (log.lastSeq(threadId) === 0 && t) {
    r.start({
      title: t.title,
      projectDir: t.projectDir,
      branch: t.branch,
      worktree: t.worktree,
      mode: t.mode || store.getSettings().mode,
      model: t.model || store.getSettings().model
    });
  }
  recorders.set(threadId, r);
  return r;
}

// Allow tests (and portable installs) to redirect userData before app.ready.
const userDataArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (userDataArg) app.setPath('userData', userDataArg.split('=').slice(1).join('='));

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: 'Quorum',
    backgroundColor: '#0d0d0d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  const logDir = path.join(app.getPath('userData'), 'sessions');
  log = new EventLog(logDir);

  // Claims left behind by runners that were killed rather than asked to stop.
  // Believing one would show a live run that nobody can actually talk to.
  registry.reap(logDir);

  pool = new RunnerPool({
    logDir,
    settingsFile: path.join(app.getPath('userData'), 'settings.json'),
    me,
    // Ephemeral: exactly what the agent emitted, forwarded to the window
    // unchanged, so the UI still streams as it always did.
    onLive: (threadId, event) => {
      if (event.kind === 'item-done') store.appendMessage(threadId, event.item);
      send('agent:event', { threadId, ...event });
      if (event.kind === 'turn-done' || event.kind === 'turn-error') {
        send('session:changed', { threadId, seq: log.lastSeq(threadId) });
      }
    },
    // Durable: the facts, which is what anyone who joins later renders from.
    onEvents: (threadId, events) => {
      send('session:events', { threadId, events });
      send('session:changed', { threadId, seq: log.lastSeq(threadId) });
    },
    onPresence: (threadId, present) => send('session:presence', { threadId, present })
  });

  createWindow();

  // Reattach to anything still working from a previous run of the app. With a
  // detached runner this is the ordinary case, not a recovery path.
  for (const claim of registry.listRunners(logDir)) {
    pool.attach(claim.sessionId, claim.workDir).catch(() => {});
  }

  setInterval(checkAutomations, 30000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Detach, never stop. Closing the window is looking away from the work, not
  // a decision to end it - treating it as one would undo the whole reason the
  // runner is a separate process.
  if (pool) pool.closeAll();
  if (rooms) rooms.closeAll();
  if (process.platform !== 'darwin') app.quit();
});

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- settings ----------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => store.setSettings(patch));

// ---------- threads ----------
ipcMain.handle('threads:list', () => store.listThreads());
ipcMain.handle('threads:get', (_e, id) => store.getThread(id));

ipcMain.handle('threads:create', async (_e, { projectDir, worktree } = {}) => {
  if (worktree && projectDir) {
    const t = store.createThread({ projectDir, worktree: true });
    const wt = await git.createWorktree(projectDir, app.getPath('userData'), t.id);
    if (wt.ok) {
      store.setThreadMeta(t.id, { workDir: wt.dir, branch: wt.branch });
    } else {
      store.setThreadMeta(t.id, { worktree: false, workDir: projectDir });
    }
    return store.getThread(t.id);
  }
  return store.createThread({ projectDir });
});

ipcMain.handle('threads:delete', async (_e, id) => {
  // Deleting a thread does end the run: unlike closing a window, this one is
  // an explicit decision to be rid of the work.
  await pool.stop(id);
  const t = store.getThread(id);
  if (t && t.worktree && t.workDir && t.projectDir) {
    await git.removeWorktree(t.projectDir, t.workDir);
  }
  return store.deleteThread(id);
});

ipcMain.handle('threads:rename', (_e, { id, title }) => store.renameThread(id, title));
ipcMain.handle('threads:archive', (_e, { id, archived }) => store.setThreadMeta(id, { archived: !!archived }));

// ---------- project ----------
ipcMain.handle('project:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open project',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const dir = res.filePaths[0];
  store.addRecentProject(dir);
  return describeProject(dir);
});
ipcMain.handle('project:describe', (_e, dir) => describeProject(dir));
ipcMain.handle('project:recent', () => store.getSettings().recentProjects || []);
ipcMain.handle('project:files', (_e, dir) => git.listFiles(dir));
ipcMain.handle('project:reveal', (_e, dir) => shell.openPath(dir));

async function describeProject(dir) {
  const [branch, dirty] = await Promise.all([git.currentBranch(dir), git.isDirty(dir)]);
  return { dir, name: path.basename(dir), branch, dirty };
}

// ---------- git ----------
ipcMain.handle('git:diff', (_e, dir) => git.diff(dir));
ipcMain.handle('git:status', (_e, dir) => git.status(dir));
ipcMain.handle('git:commit', (_e, { dir, message }) => git.commitAll(dir, message));
ipcMain.handle('git:revertFile', (_e, { dir, file, untracked }) => git.revertFile(dir, file, untracked));
ipcMain.handle('git:copyPatch', async (_e, dir) => {
  const text = await git.patchText(dir);
  clipboard.writeText(text || '');
  return { ok: true, bytes: (text || '').length };
});

// ---------- attachments ----------
ipcMain.handle('attach:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Attach image',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
  });
  if (res.canceled) return [];
  const out = [];
  for (const p of res.filePaths.slice(0, 4)) {
    try {
      const buf = fs.readFileSync(p);
      if (buf.length > 8 * 1024 * 1024) continue;
      const ext = path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg');
      out.push({ name: path.basename(p), dataUrl: `data:image/${ext};base64,${buf.toString('base64')}` });
    } catch {}
  }
  return out;
});

// ---------- automations ----------
ipcMain.handle('automations:list', () => store.listAutomations());
ipcMain.handle('automations:save', (_e, auto) => store.saveAutomation(auto));
ipcMain.handle('automations:delete', (_e, id) => store.deleteAutomation(id));
ipcMain.handle('automations:run', (_e, id) => {
  const auto = store.listAutomations().find((a) => a.id === id);
  if (!auto) return { ok: false };
  runAutomation(auto);
  return { ok: true };
});

function checkAutomations() {
  const now = Date.now();
  for (const auto of store.listAutomations()) {
    if (!auto.enabled || !auto.everyMinutes) continue;
    const due = (auto.lastRun || 0) + auto.everyMinutes * 60000;
    if (now >= due) runAutomation(auto);
  }
}

function runAutomation(auto) {
  store.saveAutomation({ id: auto.id, lastRun: Date.now() });
  const thread = store.createThread({
    projectDir: auto.projectDir || null,
    automation: true,
    title: '⚡ ' + auto.name
  });
  send('automation:started', { automationId: auto.id, threadId: thread.id });
  startTurn(thread.id, auto.prompt, {
    model: store.getSettings().model,
    mode: auto.mode || 'agent',
    effort: store.getSettings().effort
  });
}

// ---------- agent ----------
//
// The window does not run the agent any more. It asks a detached runner to,
// and then reads the run back like any other client would. The three things
// that used to be method calls on a live object - start a turn, steer it,
// answer an approval - are now events submitted to the session, which is why
// somebody on another machine can do all three.

/**
 * Where a thread does its work. The worktree when it has one, so an isolated
 * thread stays isolated.
 */
function threadWorkDir(threadId) {
  const t = store.getThread(threadId);
  if (!t) throw new Error('Unknown thread: ' + threadId);
  return t.workDir || t.projectDir || app.getPath('home');
}

async function startTurn(threadId, text, { model, mode, effort, images } = {}) {
  const thread = store.getThread(threadId);
  if (!thread) throw new Error('Unknown thread: ' + threadId);

  const userItem = { role: 'user', type: 'message', text, ts: Date.now() };
  if (images && images.length) userItem.images = images.map((i) => i.dataUrl || i);
  store.appendMessage(threadId, userItem);
  if (thread.title === 'New thread') {
    store.renameThread(threadId, text.length > 48 ? text.slice(0, 48) + '…' : text);
  }
  store.setThreadMeta(threadId, { model, mode, effort });

  // Settings are read by the runner from disk, so they have to be there before
  // it starts rather than passed as arguments it would then hold stale copies of.
  store.setSettings({ model, mode, effort, displayName: me() });

  recorderFor(threadId); // ensures session.started exists before the first turn
  const client = await pool.attach(threadId, threadWorkDir(threadId));
  await client.submit({
    kind: 'turn.started',
    actor: 'human:' + me(),
    clientId: 'turn-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    payload: { turnId: 'turn_' + Date.now(), text, images: (userItem.images || []).length }
  });
  return { ok: true };
}

ipcMain.handle('agent:send', async (_e, { threadId, text, model, mode, effort, images }) => {
  const running = pool.isRunning(threadId) && (await isTurnRunning(threadId));
  if (running) {
    // Steering an in-flight turn. A directive rather than a new turn, because
    // the difference between "I asked for this" and "I redirected it while it
    // was moving" is exactly what the record needs to keep.
    const userItem = { role: 'user', type: 'message', text, ts: Date.now(), steered: true };
    store.appendMessage(threadId, userItem);
    const client = await pool.attach(threadId, threadWorkDir(threadId));
    await client.submit({
      kind: 'directive.sent',
      actor: 'human:' + me(),
      payload: { id: 'dir_' + Date.now(), text }
    });
    return { ok: true, steered: true };
  }
  return startTurn(threadId, text, { model, mode, effort, images });
});

/** Whether a turn is actually mid-flight, as opposed to a runner merely existing. */
async function isTurnRunning(threadId) {
  const client = pool.peek(threadId);
  if (!client) return false;
  try {
    const { meta } = await client.state();
    return !!(meta && meta.running);
  } catch {
    return false;
  }
}

ipcMain.handle('agent:running', async () => {
  const out = [];
  for (const id of pool.live()) {
    if (await isTurnRunning(id)) out.push(id);
  }
  return out;
});

ipcMain.handle('agent:cancel', async (_e, threadId) => {
  if (isGuest(threadId)) {
    // Asking, not doing: stopping a run on someone else's machine is their
    // runner's decision, not ours.
    await rooms.get(threadId).intent('run.paused', { reason: me() + ' asked to stop' });
    return { ok: true, remote: true };
  }
  // Stops the run, not just this window's view of it. Anything less would be
  // a Stop button that leaves the agent working.
  await pool.stop(threadId);
  send('session:changed', { threadId, seq: log.lastSeq(threadId) });
  return { ok: true };
});

ipcMain.handle('agent:approve', async (_e, { threadId, callId, approved }) => {
  if (isGuest(threadId)) {
    // Answering somebody else's gate from here. The host's reducer still
    // decides whether this answer counts, so being in the room is not the same
    // as being allowed.
    const state = kernel.reduce(threadId, log.read(threadId));
    const gate = state.gates.find((g) => g.callId === callId && !g.resolvedAt);
    if (gate) await rooms.get(threadId).intent('gate.resolved', { id: gate.id, approved: !!approved });
    return { ok: true, remote: true };
  }
  // The answer becomes an event before it reaches the agent, so a run can never
  // have proceeded on an approval the log cannot account for - and so anyone
  // authorised can give it, from anywhere.
  const state = kernel.reduce(threadId, log.read(threadId));
  const gate = state.gates.find((g) => g.callId === callId && !g.resolvedAt);
  const client = pool.peek(threadId) || (await pool.attach(threadId, threadWorkDir(threadId)));
  if (gate) {
    await client.submit({
      kind: 'gate.resolved',
      actor: 'human:' + me(),
      payload: { id: gate.id, approved: !!approved }
    });
  }
  send('session:changed', { threadId, seq: log.lastSeq(threadId) });
  return { ok: true };
});

// ---------- GitHub ----------
//
// Cloning is also how somebody who joined a run gets a workspace of their own:
// the room says which repository and branch the work is on, and they clone it.
// Git already moves source between machines extremely well; rebuilding that
// inside a chat protocol would be the wrong instinct.

ipcMain.handle('github:capabilities', () => github.capabilities());

ipcMain.handle('github:repoInfo', async (_e, threadId) => {
  const t = store.getThread(threadId);
  const dir = t && (t.workDir || t.projectDir);
  return dir ? github.repoInfo(dir) : null;
});

ipcMain.handle('github:clone', async (_e, { repo, branch }) => {
  const parent = path.join(app.getPath('home'), 'quorum-repos');
  const res = await github.clone({ repo, intoParent: parent, branch });
  if (!res.ok) throw new Error(res.error);
  store.addRecentProject(res.dir);
  return describeProject(res.dir);
});

ipcMain.handle('github:push', async (_e, { threadId }) => {
  const dir = workDirOf(threadId);
  const res = await github.push(dir);
  if (!res.ok) throw new Error(res.error);
  // Pushing is a fact about the run worth keeping: it is the moment the work
  // left this machine.
  const client = pool.peek(threadId);
  const ev = {
    kind: 'note.posted',
    actor: 'human:' + me(),
    payload: { text: 'Pushed branch ' + res.branch + ' to origin.' }
  };
  if (client) await client.submit(ev);
  else log.append(threadId, ev);
  send('session:changed', { threadId, seq: log.lastSeq(threadId) });
  return res;
});

ipcMain.handle('github:openPr', async (_e, { threadId, title, body, base, draft }) => {
  const dir = workDirOf(threadId);
  const res = await github.openPullRequest(dir, { title, body, base, draft, sessionId: threadId });
  if (!res.ok) throw new Error(res.error);
  const client = pool.peek(threadId);
  const ev = {
    kind: 'note.posted',
    actor: 'human:' + me(),
    payload: { text: 'Opened a pull request: ' + res.url }
  };
  if (client) await client.submit(ev);
  else log.append(threadId, ev);
  send('session:changed', { threadId, seq: log.lastSeq(threadId) });
  return res;
});

ipcMain.handle('github:currentPr', async (_e, { threadId }) => {
  try {
    return await github.currentPullRequest(workDirOf(threadId));
  } catch {
    return null;
  }
});

// ---------- sharing and joining ----------
//
// Two directions, and they are not symmetric on purpose. Sharing hands out a
// code to a run this machine owns. Joining subscribes to a run somebody else
// owns: their runner keeps deciding what enters the log, and everything this
// side wants is sent as a request.

const DEFAULT_RELAY = 'http://127.0.0.1:7788';

function relayUrl() {
  return (store.getSettings().relayUrl || DEFAULT_RELAY).replace(/\/$/, '');
}

ipcMain.handle('room:share', async (_e, { threadId }) => {
  const claim = registry.findRunner(path.join(app.getPath('userData'), 'sessions'), threadId);
  if (!claim) {
    // Nothing to share yet. Start the run first rather than opening an empty
    // room somebody would join and find silent.
    await pool.attach(threadId, threadWorkDir(threadId));
  }
  const live = registry.findRunner(path.join(app.getPath('userData'), 'sessions'), threadId);
  const t = store.getThread(threadId);
  const res = await fetch(live.base + '/s/' + threadId + '/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ relay: relayUrl(), title: (t && t.title) || '' })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Could not share this run');
  store.setThreadMeta(threadId, { roomCode: body.code, relay: relayUrl() });
  send('session:changed', { threadId, seq: log.lastSeq(threadId) });
  return body;
});

ipcMain.handle('room:unshare', async (_e, { threadId }) => {
  const claim = registry.findRunner(path.join(app.getPath('userData'), 'sessions'), threadId);
  if (!claim) return { ok: true, wasShared: false };
  const res = await fetch(claim.base + '/s/' + threadId + '/unshare', { method: 'POST' });
  store.setThreadMeta(threadId, { roomCode: null });
  return res.json().catch(() => ({ ok: true }));
});

ipcMain.handle('room:join', async (_e, { code, relay }) => {
  const base = (relay || relayUrl()).replace(/\/$/, '');
  const t = store.createThread({ title: 'Joining ' + code.toUpperCase() + '…' });
  store.setThreadMeta(t.id, { joined: true, roomCode: code.toUpperCase(), relay: base });
  try {
    const link = await rooms.join({ relay: base, code, threadId: t.id });
    const info = link.roomInfo || {};
    store.renameThread(t.id, info.title || 'Room ' + code.toUpperCase());
    // Say hello in the room, so the people already in it see someone arrive.
    link.intent('note.posted', { text: me() + ' joined.' }).catch(() => {});
    return { ...store.getThread(t.id), room: info };
  } catch (err) {
    // Do not leave behind a thread that will never receive anything.
    store.deleteThread(t.id);
    throw err;
  }
});

ipcMain.handle('room:leave', (_e, { threadId }) => {
  rooms.leave(threadId);
  return { ok: true };
});

ipcMain.handle('room:info', async (_e, { threadId }) => {
  const link = rooms.get(threadId);
  if (!link) {
    const t = store.getThread(threadId);
    return t && t.roomCode ? { code: t.roomCode, relay: t.relay, hosting: true } : null;
  }
  return { code: link.code, relay: link.relay, joined: true, present: link.present };
});

/** True when this machine is a guest in the session rather than its host. */
function isGuest(threadId) {
  return rooms.has(threadId);
}

// ---------- workspace files (the editor) ----------
//
// A thread's workspace is its worktree when it has one, so the editor and the
// agent always look at the same tree - including the isolated branch a worktree
// thread runs on, which is the point of running it there.

/**
 * Like threadWorkDir, but refuses rather than falling back.
 *
 * The runner needs somewhere to start even for a thread with no project open;
 * the editor does not, and quietly showing someone their home directory would
 * be worse than telling them nothing is open.
 */
function workDirOf(threadId) {
  const t = store.getThread(threadId);
  if (!t) throw new Error('Unknown thread: ' + threadId);
  const dir = t.workDir || t.projectDir;
  if (!dir) throw new Error('This thread has no project folder open');
  return dir;
}

ipcMain.handle('files:tree', async (_e, threadId) => {
  const root = workDirOf(threadId);
  const [list, known] = await Promise.all([
    Promise.resolve(workspace.tree(root)),
    workspace.tracked(root)
  ]);
  const inGit = new Set(known);
  return list.map((entry) => ({ ...entry, tracked: inGit.has(entry.path) }));
});

ipcMain.handle('files:read', (_e, { threadId, path: rel }) =>
  workspace.readFile(workDirOf(threadId), rel)
);

/**
 * Saving is recorded in the log the same way an agent edit is.
 *
 * The run is a mixed team, so a person's edit and the agent's edit are the same
 * kind of fact and belong in the same history. Attributing the person's save to
 * the agent - or leaving it out - would make the record quietly wrong about who
 * changed what.
 */
ipcMain.handle('files:write', (_e, { threadId, path: rel, content, expectedHash }) => {
  const root = workDirOf(threadId);
  let before = null;
  try {
    before = workspace.readFile(root, rel).content;
  } catch {
    before = null;
  }
  const res = workspace.writeFile(root, rel, content, { expectedHash });
  if (!res.ok) return res;

  const counts = workspace.diffCounts(before, content);
  log.append(threadId, {
    kind: 'artifact.changed',
    actor: 'human:' + me(),
    payload: {
      path: rel,
      status: res.created ? 'added' : 'modified',
      added: counts.added,
      removed: counts.removed
    }
  });
  send('session:changed', { threadId, seq: log.lastSeq(threadId) });
  return res;
});

/**
 * Which file someone is looking at. Recorded so a watcher can see where
 * attention is, which is the cheapest useful form of presence in an editor.
 */
ipcMain.handle('files:viewing', (_e, { threadId, path: rel }) => {
  log.append(threadId, {
    kind: 'presence.seen',
    actor: 'human:' + me(),
    payload: { viewing: rel || null }
  });
  return { ok: true };
});

// ---------- session log ----------
//
// Everything below reads or appends to the log rather than to thread state.
// This is the surface a second person would talk to, so it is deliberately
// shaped as "facts about a run" and not as "the local window's model".

ipcMain.handle('session:state', (_e, threadId) =>
  kernel.reduce(threadId, log.read(threadId))
);

ipcMain.handle('session:events', (_e, { threadId, since = 0 }) =>
  log.read(threadId).filter((ev) => ev.seq > since)
);

/** The run as it stood at a moment. Scrubbing history is a slice and a replay. */
ipcMain.handle('session:at', (_e, { threadId, seq }) =>
  kernel.sessionAt(threadId, log.read(threadId), seq)
);

/** Tamper check. Reports the first break, or ok. */
ipcMain.handle('session:verify', (_e, threadId) => log.verify(threadId));

ipcMain.handle('session:note', (_e, { threadId, text }) => {
  recorderFor(threadId).note(text, me());
  send('session:changed', { threadId, seq: log.lastSeq(threadId) });
  return { ok: true };
});

/**
 * Steering a run that is already moving. Recorded as sent now; the agent
 * records applied when its loop actually merges the text, which is why the two
 * are separate events rather than one.
 */
ipcMain.handle('session:directive', async (_e, { threadId, text }) => {
  // Submitted rather than written directly: the runner is the single writer for
  // its session, and it is also the only thing that can honestly say when the
  // words reached the model, which is what directive.applied claims.
  const id = 'dir_' + Date.now();
  const client = pool.peek(threadId) || (await pool.attach(threadId, threadWorkDir(threadId)));
  await client.submit({
    kind: 'directive.sent',
    actor: 'human:' + me(),
    payload: { id, text }
  });
  send('session:changed', { threadId, seq: log.lastSeq(threadId) });
  return { ok: true, id };
});

ipcMain.handle('session:handoff', (_e, { threadId, to, note }) => {
  recorderFor(threadId).handOff(to, note);
  send('session:changed', { threadId, seq: log.lastSeq(threadId) });
  return kernel.reduce(threadId, log.read(threadId));
});

ipcMain.handle('session:claim', (_e, { threadId, stepId, release }) => {
  const rec = recorderFor(threadId);
  if (release) rec.releaseStep(stepId, me());
  else rec.claimStep(stepId, me());
  send('session:changed', { threadId, seq: log.lastSeq(threadId) });
  return kernel.reduce(threadId, log.read(threadId));
});

/**
 * Fork a run from a moment into its own worktree.
 *
 * The events up to that point are replayed into the new session, so the fork
 * carries the history that led to the decision rather than starting blank -
 * which is the difference between "try again" and "try again from there".
 */
ipcMain.handle('session:fork', async (_e, { threadId, seq }) => {
  const source = store.getThread(threadId);
  if (!source) throw new Error('Unknown thread: ' + threadId);
  const events = log.read(threadId);
  const at = kernel.sessionAt(threadId, events, seq);

  const t = store.createThread({
    projectDir: source.projectDir,
    worktree: !!source.projectDir,
    title: 'Fork of ' + (source.title || 'run') + ' @' + seq
  });
  if (source.projectDir) {
    const wt = await git.createWorktree(source.projectDir, app.getPath('userData'), t.id);
    if (wt.ok) store.setThreadMeta(t.id, { workDir: wt.dir, branch: wt.branch });
    else store.setThreadMeta(t.id, { worktree: false, workDir: source.projectDir });
  }
  log.append(t.id, kernel.forkPoint(events, seq));
  log.append(t.id, {
    kind: 'note.posted',
    actor: 'system',
    payload: { text: 'Forked from ' + threadId + ' at seq ' + seq + ' (' + at.status + ').' }
  });
  recorders.delete(t.id);
  return store.getThread(t.id);
});
