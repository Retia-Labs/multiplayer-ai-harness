const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('plexusCrypto', {
  storeKey: () => ipcRenderer.invoke('plexus-crypto:store-key'),
  transport: (method, args) => ipcRenderer.invoke('plexus-crypto:transport', method, args)
});
