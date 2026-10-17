const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabTidy', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveIgnoredNames: (rules) => ipcRenderer.invoke('save-ignored-names', rules),
  copyCode: () => ipcRenderer.invoke('copy-code'),
  openExtensionFolder: () => ipcRenderer.invoke('extension-folder'),
  closeTabs: (tabs) => ipcRenderer.invoke('close-tabs', tabs),
  onSources: (callback) => {
    const listener = (_event, sources) => callback(sources);
    ipcRenderer.on('sources-updated', listener);
    return () => ipcRenderer.removeListener('sources-updated', listener);
  },
});
