const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('harnessDesktop', {
  accountSession: () => ipcRenderer.invoke('desktop:account:session'),
  accountStart: () => ipcRenderer.invoke('desktop:account:start'),
  accountPoll: () => ipcRenderer.invoke('desktop:account:poll'),
  accountLogout: () => ipcRenderer.invoke('desktop:account:logout'),
  versions: { electron: process.versions.electron },
  diagnostics: () => ipcRenderer.invoke('desktop:diagnostics'),
  hubUrl: location.protocol === 'plexus-app:' ? ipcRenderer.sendSync('desktop:hubUrl') : null,
  endpointStoreKey: () => ipcRenderer.invoke('desktop:endpointStoreKey'),
  encryptedSetup: () => ipcRenderer.invoke('desktop:encryptedSetup'),
  codexStatus: () => ipcRenderer.invoke('desktop:codexStatus'),
  configureCodex: () => ipcRenderer.invoke('desktop:configureCodex'),
  confirmEncryptionAuthority: (authority) => ipcRenderer.invoke('desktop:confirmEncryptionAuthority', authority),
  confirmApprovalAuthority: (authority) => ipcRenderer.invoke('desktop:confirmApprovalAuthority', authority),
  confirmFreshnessAuthority: (authority) => ipcRenderer.invoke('desktop:confirmFreshnessAuthority', authority),
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
