'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appbox', {
  list: () => ipcRenderer.invoke('appbox:list'),
  activate: (id) => ipcRenderer.send('appbox:activate', id),
  reorder: (ids) => ipcRenderer.send('appbox:reorder', ids),
  menu: (id, x, y) => ipcRenderer.send('appbox:menu', id, x, y),
  menuClose: () => ipcRenderer.send('appbox:menu-close'),
  settingsMenu: (x, y) => ipcRenderer.send('appbox:settings-menu', x, y),
  addApps: () => ipcRenderer.send('appbox:add-apps'),
  onUpdate: (cb) => ipcRenderer.on('appbox:update', (e, data) => cb(data)),
  onStatus: (cb) => ipcRenderer.on('appbox:status', (e, data) => cb(data)),
});
