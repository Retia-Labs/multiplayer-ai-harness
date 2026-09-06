const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('harnessDesktop', {
  pickFolder: () => ipcRenderer.invoke('desktop:pickFolder'),
  // Only the shell running on this machine can answer this, which is what makes reading
  // the code count as local consent.
  pairingCode: () => ipcRenderer.invoke('desktop:pairingCode'),
  retryBoot: () => ipcRenderer.invoke('desktop:retryBoot'),
  openDataFolder: () => ipcRenderer.invoke('desktop:openDataFolder'),
  onBootStatus: (fn) => ipcRenderer.on('boot:status', (_e, payload) => fn(payload))
});
