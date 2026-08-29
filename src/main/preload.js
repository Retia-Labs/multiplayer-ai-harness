const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codex', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },
  threads: {
    list: () => ipcRenderer.invoke('threads:list'),
    get: (id) => ipcRenderer.invoke('threads:get', id),
    create: (projectDir) => ipcRenderer.invoke('threads:create', { projectDir }),
    delete: (id) => ipcRenderer.invoke('threads:delete', id),
    rename: (id, title) => ipcRenderer.invoke('threads:rename', { id, title })
  },
  project: {
    pick: () => ipcRenderer.invoke('project:pick'),
    describe: (dir) => ipcRenderer.invoke('project:describe', dir),
    recent: () => ipcRenderer.invoke('project:recent')
  },
  git: {
    diff: (dir) => ipcRenderer.invoke('git:diff', dir),
    status: (dir) => ipcRenderer.invoke('git:status', dir)
  },
  agent: {
    send: (args) => ipcRenderer.invoke('agent:send', args),
    cancel: (threadId) => ipcRenderer.invoke('agent:cancel', threadId),
    approve: (args) => ipcRenderer.invoke('agent:approve', args),
    onEvent: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('agent:event', listener);
      return () => ipcRenderer.removeListener('agent:event', listener);
    }
  }
});
