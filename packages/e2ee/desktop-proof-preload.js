const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('proofDesktop', { storeKey: () => ipcRenderer.invoke('proof:store-key') });
