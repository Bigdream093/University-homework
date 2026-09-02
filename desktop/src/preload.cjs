const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kexuDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  testServer: serverUrl => ipcRenderer.invoke('server:test', serverUrl),
  saveServer: serverUrl => ipcRenderer.invoke('server:save', serverUrl)
});

contextBridge.exposeInMainWorld('mohenDesktop', {
  saveAssignmentFiles: payload => ipcRenderer.invoke('assignment-files:save', payload),
  saveMaterialFile: payload => ipcRenderer.invoke('material-file:save', payload),
  pauseMaterialDownload: requestId => ipcRenderer.invoke('material-download:pause', requestId),
  resumeMaterialDownload: payload => ipcRenderer.invoke('material-download:resume', payload),
  cancelMaterialDownload: requestId => ipcRenderer.invoke('material-download:cancel', requestId),
  openMaterialDownloadFolder: requestId => ipcRenderer.invoke('material-download:open-folder', requestId),
  dismissMaterialDownload: requestId => ipcRenderer.invoke('material-download:dismiss', requestId),
  listMaterialDownloads: () => ipcRenderer.invoke('material-download:list'),
  onMaterialDownloadProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('material-download:progress', listener);
    return () => ipcRenderer.removeListener('material-download:progress', listener);
  }
});
