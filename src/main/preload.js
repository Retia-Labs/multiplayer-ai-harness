const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quorum', {
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
  // GitHub, through the git and gh the user already has set up.
  github: {
    capabilities: () => ipcRenderer.invoke('github:capabilities'),
    repoInfo: (threadId) => ipcRenderer.invoke('github:repoInfo', threadId),
    clone: (repo, branch) => ipcRenderer.invoke('github:clone', { repo, branch }),
    push: (threadId) => ipcRenderer.invoke('github:push', { threadId }),
    openPr: (threadId, opts) => ipcRenderer.invoke('github:openPr', { threadId, ...(opts || {}) }),
    currentPr: (threadId) => ipcRenderer.invoke('github:currentPr', { threadId })
  },
  // Sharing a run, and joining someone else's.
  room: {
    share: (threadId) => ipcRenderer.invoke('room:share', { threadId }),
    unshare: (threadId) => ipcRenderer.invoke('room:unshare', { threadId }),
    join: (code, relay) => ipcRenderer.invoke('room:join', { code, relay }),
    leave: (threadId) => ipcRenderer.invoke('room:leave', { threadId }),
    info: (threadId) => ipcRenderer.invoke('room:info', { threadId }),
    onClosed: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('session:roomClosed', listener);
      return () => ipcRenderer.removeListener('session:roomClosed', listener);
    }
  },
  // The editor's view of the thread's workspace - the worktree when it has one,
  // so a person and the agent always read the same tree.
  files: {
    tree: (threadId) => ipcRenderer.invoke('files:tree', threadId),
    read: (threadId, path) => ipcRenderer.invoke('files:read', { threadId, path }),
    // The hash of what was loaded, so a save that would clobber the agent's
    // work is refused rather than performed.
    write: (threadId, path, content, expectedHash) =>
      ipcRenderer.invoke('files:write', { threadId, path, content, expectedHash }),
    viewing: (threadId, path) => ipcRenderer.invoke('files:viewing', { threadId, path })
  },
  // The session log: facts about a run, as opposed to the local window's model
  // of it. This is the surface a second person would read from.
  session: {
    state: (threadId) => ipcRenderer.invoke('session:state', threadId),
    events: (threadId, since) => ipcRenderer.invoke('session:events', { threadId, since: since || 0 }),
    at: (threadId, seq) => ipcRenderer.invoke('session:at', { threadId, seq }),
    verify: (threadId) => ipcRenderer.invoke('session:verify', threadId),
    note: (threadId, text) => ipcRenderer.invoke('session:note', { threadId, text }),
    directive: (threadId, text) => ipcRenderer.invoke('session:directive', { threadId, text }),
    handoff: (threadId, to, note) => ipcRenderer.invoke('session:handoff', { threadId, to, note }),
    claim: (threadId, stepId, release) => ipcRenderer.invoke('session:claim', { threadId, stepId, release }),
    fork: (threadId, seq) => ipcRenderer.invoke('session:fork', { threadId, seq }),
    onChanged: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('session:changed', listener);
      return () => ipcRenderer.removeListener('session:changed', listener);
    },
    // Durable events as they land, from whoever produced them - this agent, or
    // a person on another machine.
    onEvents: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('session:events', listener);
      return () => ipcRenderer.removeListener('session:events', listener);
    },
    // Who is in the room, and what they are looking at.
    onPresence: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('session:presence', listener);
      return () => ipcRenderer.removeListener('session:presence', listener);
    }
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
