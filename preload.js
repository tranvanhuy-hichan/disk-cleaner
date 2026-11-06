const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  disk: () => ipcRenderer.invoke('disk'),
  scan: () => ipcRenderer.invoke('scan'),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  clean: (ids) => ipcRenderer.invoke('clean', ids),
  copy: (text) => ipcRenderer.invoke('copy', text),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  ignore: (id) => ipcRenderer.invoke('ignore', id),
  reveal: (id) => ipcRenderer.invoke('reveal', id),
  exportCsv: (ids) => ipcRenderer.invoke('export', ids),
  tree: (rel) => ipcRenderer.invoke('tree', rel),
  revealPath: (rel) => ipcRenderer.invoke('tree:reveal', rel),
  onTrayScan: (cb) => ipcRenderer.on('tray:scan', () => cb()),
  openTrash: () => ipcRenderer.invoke('openTrash'),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, msg) => cb(msg)),
});
