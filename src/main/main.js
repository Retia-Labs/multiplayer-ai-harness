const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Codex',
    backgroundColor: '#111111',
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
ipcMain.handle('threads:create', (_e, { projectDir }) => store.createThread(projectDir));
ipcMain.handle('threads:delete', (_e, id) => {
  const s = sessions.get(id);
  if (s) { s.cancel(); sessions.delete(id); }
  return store.deleteThread(id);
});
ipcMain.handle('threads:rename', (_e, { id, title }) => store.renameThread(id, title));

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

async function describeProject(dir) {
  const [branch, dirty] = await Promise.all([git.currentBranch(dir), git.isDirty(dir)]);
  return { dir, name: path.basename(dir), branch, dirty };
}

// ---------- git ----------
ipcMain.handle('git:diff', (_e, dir) => git.diff(dir));
ipcMain.handle('git:status', (_e, dir) => git.status(dir));

// ---------- agent ----------
ipcMain.handle('agent:send', async (_e, { threadId, text, model, mode }) => {
  const thread = store.getThread(threadId);
  if (!thread) throw new Error('Unknown thread: ' + threadId);
  if (sessions.get(threadId)?.running) throw new Error('A turn is already running in this thread');

  store.appendMessage(threadId, { role: 'user', type: 'message', text, ts: Date.now() });
  if (thread.title === 'New thread') {
    store.renameThread(threadId, text.length > 48 ? text.slice(0, 48) + '…' : text);
  }
  store.setThreadMeta(threadId, { model, mode });

  const session = new AgentSession({
    thread: store.getThread(threadId),
    settings: store.getSettings(),
    model,
    mode,
    emit: (event) => {
      // persist finished items; stream everything to the renderer
      if (event.kind === 'item-done') store.appendMessage(threadId, event.item);
      if (event.kind === 'turn-done' || event.kind === 'turn-error') sessions.delete(threadId);
      send('agent:event', { threadId, ...event });
    }
  });
  sessions.set(threadId, session);
  session.run(text); // fire and forget; events stream back
  return { ok: true };
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
