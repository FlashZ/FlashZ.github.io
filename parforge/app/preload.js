const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('parforge', {
  getState: () => ipcRenderer.invoke('state:get'),
  addWatchFolder: () => ipcRenderer.invoke('watch:add'),
  removeWatchFolder: (folder) => ipcRenderer.invoke('watch:remove', folder),
  processFolder: () => ipcRenderer.invoke('process:choose'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  choose7Zip: () => ipcRenderer.invoke('7zip:choose'),
  installPar2: () => ipcRenderer.invoke('par2:install'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onLog: (callback) => ipcRenderer.on('log', (_event, entry) => callback(entry))
});
