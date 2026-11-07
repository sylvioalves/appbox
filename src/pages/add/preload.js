'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('add', {
  get: () => ipcRenderer.invoke('add:get'),
  add: (id, input) => ipcRenderer.invoke('add:add', id, input),
  close: () => ipcRenderer.send('add:close'),
});
