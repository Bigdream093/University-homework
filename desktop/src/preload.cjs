const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('kexuDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  testServer: (serverUrl) => ipcRenderer.invoke('server:test', serverUrl),
  saveServer: (serverUrl) => ipcRenderer.invoke('server:save', serverUrl),
})

contextBridge.exposeInMainWorld('mohenDesktop', {
  saveDownloadFile: (payload) => ipcRenderer.invoke('download:save', payload),
  pauseDownload: (requestId) => ipcRenderer.invoke('download:pause', requestId),
  resumeDownload: (payload) => ipcRenderer.invoke('download:resume', payload),
  cancelDownload: (requestId) => ipcRenderer.invoke('download:cancel', requestId),
  openDownloadFolder: (requestId) => ipcRenderer.invoke('download:open-folder', requestId),
  openDownloadsFolder: () => ipcRenderer.invoke('download:open-downloads-folder'),
  dismissDownload: (requestId) => ipcRenderer.invoke('download:dismiss', requestId),
  listDownloads: () => ipcRenderer.invoke('download:list'),
  onDownloadProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('download:progress', listener)
    return () => ipcRenderer.removeListener('download:progress', listener)
  },
})
