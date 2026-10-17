const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabTidy', {
  getState: () => ipcRenderer.invoke('get-state'),
  copyCode: () => ipcRenderer.invoke('copy-code'),
  openExtensionFolder: () => ipcRenderer.invoke('extension-folder'),
  exportTabs: (tabs) => ipcRenderer.invoke('export-tabs', tabs),
  onSources: (callback) => {
    const listener = (_event, sources) => callback(sources);
    ipcRenderer.on('sources-updated', listener);
    return () => ipcRenderer.removeListener('sources-updated', listener);
  },
});
