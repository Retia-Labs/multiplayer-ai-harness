const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('harnessDesktop', {
  pickFolder: () => ipcRenderer.invoke('desktop:pickFolder'),
  // Only the shell running on this machine can answer this, which is what makes reading
  // the code count as local consent.
  pairingCode: () => ipcRenderer.invoke('desktop:pairingCode')
});
