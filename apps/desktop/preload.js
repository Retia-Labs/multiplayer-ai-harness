const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('harnessDesktop', {
  pickFolder: () => ipcRenderer.invoke('desktop:pickFolder')
});
