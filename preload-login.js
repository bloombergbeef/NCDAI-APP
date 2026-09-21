const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ncdai', {
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
  register: (payload) => ipcRenderer.invoke('auth:register', payload),
  getSavedEmail: () => ipcRenderer.invoke('auth:get-saved-email'),
  onRegistrationStatus: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('registration:status', listener);
    return () => ipcRenderer.removeListener('registration:status', listener);
  },
  backToLogin: () => ipcRenderer.invoke('auth:back-to-login'),
});
