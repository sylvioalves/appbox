'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ask', {
  get: () => ipcRenderer.invoke('prompt:get'),
  submit: (value) => ipcRenderer.send('prompt:submit', String(value)),
  cancel: () => ipcRenderer.send('prompt:cancel'),
});
