'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menu', {
  onOpen: (cb) => ipcRenderer.on('menu:open', (e, data) => cb(data)),
  action: (id, key) => ipcRenderer.send('appbox:menu-action', id, key),
  close: () => ipcRenderer.send('appbox:menu-close'),
});
