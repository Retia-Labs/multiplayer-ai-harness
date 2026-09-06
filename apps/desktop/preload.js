const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('harnessDesktop', {
  // Selection in the native dialog is the authorization. The main process persists it
  // for the local runtime and deliberately does not expose the filesystem path here.
  pickFolder: (runtimeId) => ipcRenderer.invoke('desktop:pickFolder', runtimeId),
  // Only the shell running on this machine can answer this, which is what makes reading
  // the code count as local consent.
  pairingCode: () => ipcRenderer.invoke('desktop:pairingCode'),
  // Identifies the one execution host whose local folders this shell may authorize.
  runtimeId: () => ipcRenderer.invoke('desktop:runtimeId'),
  retryBoot: () => ipcRenderer.invoke('desktop:retryBoot'),
  openDataFolder: () => ipcRenderer.invoke('desktop:openDataFolder'),
  onBootStatus: (fn) => ipcRenderer.on('boot:status', (_e, payload) => fn(payload))
});
