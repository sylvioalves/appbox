'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('props', {
  get: () => ipcRenderer.invoke('appbox:props-get'),
  save: (patch) => ipcRenderer.send('appbox:props-save', patch),
  remove: () => ipcRenderer.send('appbox:props-remove'),
  forgetToken: () => ipcRenderer.invoke('appbox:props-forget-token'),
  close: () => ipcRenderer.send('appbox:props-close'),
});
