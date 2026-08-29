const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codex', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },
  threads: {
    list: () => ipcRenderer.invoke('threads:list'),
    get: (id) => ipcRenderer.invoke('threads:get', id),
    create: (opts) => ipcRenderer.invoke('threads:create', opts || {}),
    delete: (id) => ipcRenderer.invoke('threads:delete', id),
    rename: (id, title) => ipcRenderer.invoke('threads:rename', { id, title }),
    archive: (id, archived) => ipcRenderer.invoke('threads:archive', { id, archived })
  },
  project: {
    pick: () => ipcRenderer.invoke('project:pick'),
    describe: (dir) => ipcRenderer.invoke('project:describe', dir),
    recent: () => ipcRenderer.invoke('project:recent'),
    files: (dir) => ipcRenderer.invoke('project:files', dir),
    reveal: (dir) => ipcRenderer.invoke('project:reveal', dir)
  },
  git: {
    diff: (dir) => ipcRenderer.invoke('git:diff', dir),
    status: (dir) => ipcRenderer.invoke('git:status', dir),
    commit: (dir, message) => ipcRenderer.invoke('git:commit', { dir, message }),
    revertFile: (dir, file, untracked) => ipcRenderer.invoke('git:revertFile', { dir, file, untracked }),
    copyPatch: (dir) => ipcRenderer.invoke('git:copyPatch', dir)
  },
  attach: {
    pick: () => ipcRenderer.invoke('attach:pick')
  },
  automations: {
    list: () => ipcRenderer.invoke('automations:list'),
    save: (auto) => ipcRenderer.invoke('automations:save', auto),
    delete: (id) => ipcRenderer.invoke('automations:delete', id),
    run: (id) => ipcRenderer.invoke('automations:run', id)
  },
  agent: {
    send: (args) => ipcRenderer.invoke('agent:send', args),
    running: () => ipcRenderer.invoke('agent:running'),
    cancel: (threadId) => ipcRenderer.invoke('agent:cancel', threadId),
    approve: (args) => ipcRenderer.invoke('agent:approve', args),
    onEvent: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('agent:event', listener);
      return () => ipcRenderer.removeListener('agent:event', listener);
    },
    onAutomation: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('automation:started', listener);
      return () => ipcRenderer.removeListener('automation:started', listener);
    }
  }
});
