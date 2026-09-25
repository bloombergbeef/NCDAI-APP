const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ncdai', {
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getAppUrl: () => ipcRenderer.invoke('shell:get-app-url'),
  onUpdateStatus: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  onPingStatus: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('ping:status', listener);
    return () => ipcRenderer.removeListener('ping:status', listener);
  },
});
