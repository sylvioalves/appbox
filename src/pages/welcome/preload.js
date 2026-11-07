'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('welcome', {
  add: () => ipcRenderer.send('appbox:add-apps'),
});
