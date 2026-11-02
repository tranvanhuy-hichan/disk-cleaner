const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  disk: () => ipcRenderer.invoke('disk'),
  scan: () => ipcRenderer.invoke('scan'),
  clean: (ids) => ipcRenderer.invoke('clean', ids),
  copy: (text) => ipcRenderer.invoke('copy', text),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, msg) => cb(msg)),
});
