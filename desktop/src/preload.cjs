const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kexuDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  testServer: serverUrl => ipcRenderer.invoke('server:test', serverUrl),
  saveServer: serverUrl => ipcRenderer.invoke('server:save', serverUrl)
});

contextBridge.exposeInMainWorld('mohenDesktop', {
  saveAssignmentFiles: payload => ipcRenderer.invoke('assignment-files:save', payload)
});
