'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (patch, autostart) => ipcRenderer.invoke('settings:save', patch, Boolean(autostart)),
  pickDir: (current) => ipcRenderer.invoke('settings:pick-dir', current),
  exportProfile: () => ipcRenderer.invoke('appbox:export-profile'),
  importProfile: () => ipcRenderer.invoke('appbox:import-profile'),
  openEditor: () => ipcRenderer.send('appbox:open-config'),
  reload: () => ipcRenderer.send('appbox:reload-config'),
  close: () => ipcRenderer.send('settings:close'),
});
