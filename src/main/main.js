const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const Store = require('./store');
const git = require('./gitutils');
const { AgentSession } = require('./agent');

let win = null;
let store = null;
const sessions = new Map(); // threadId -> AgentSession

// Allow tests (and portable installs) to redirect userData before app.ready.
const userDataArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (userDataArg) app.setPath('userData', userDataArg.split('=').slice(1).join('='));

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: 'Codex',
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
  createWindow();
  setInterval(checkAutomations, 30000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
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
  const s = sessions.get(id);
  if (s) { s.cancel(); sessions.delete(id); }
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
function startTurn(threadId, text, { model, mode, effort, images } = {}) {
  const thread = store.getThread(threadId);
  if (!thread) throw new Error('Unknown thread: ' + threadId);
  if (sessions.get(threadId)?.running) throw new Error('A turn is already running in this thread');

  const userItem = { role: 'user', type: 'message', text, ts: Date.now() };
  if (images && images.length) userItem.images = images.map((i) => i.dataUrl || i);
  store.appendMessage(threadId, userItem);
  if (thread.title === 'New thread') {
    store.renameThread(threadId, text.length > 48 ? text.slice(0, 48) + '…' : text);
  }
  store.setThreadMeta(threadId, { model, mode, effort });

  const session = new AgentSession({
    thread: store.getThread(threadId),
    settings: store.getSettings(),
    model, mode, effort,
    emit: (event) => {
      if (event.kind === 'item-done') store.appendMessage(threadId, event.item);
      if (event.kind === 'turn-done' || event.kind === 'turn-error') sessions.delete(threadId);
      send('agent:event', { threadId, ...event });
    }
  });
  sessions.set(threadId, session);
  session.run(text, userItem.images); // fire and forget; events stream back
}

ipcMain.handle('agent:send', (_e, { threadId, text, model, mode, effort, images }) => {
  const s = sessions.get(threadId);
  if (s && s.running) {
    // Steering: queue into the running turn.
    const userItem = { role: 'user', type: 'message', text, ts: Date.now(), steered: true };
    store.appendMessage(threadId, userItem);
    s.enqueueSteer(text);
    return { ok: true, steered: true };
  }
  startTurn(threadId, text, { model, mode, effort, images });
  return { ok: true };
});

ipcMain.handle('agent:running', () => {
  const out = [];
  for (const [id, s] of sessions) if (s.running) out.push(id);
  return out;
});

ipcMain.handle('agent:cancel', (_e, threadId) => {
  const s = sessions.get(threadId);
  if (s) s.cancel();
  return { ok: true };
});

ipcMain.handle('agent:approve', (_e, { threadId, callId, approved }) => {
  const s = sessions.get(threadId);
  if (s) s.resolveApproval(callId, approved);
  return { ok: true };
});
