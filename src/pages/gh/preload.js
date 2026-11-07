'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gh', {
  status: () => ipcRenderer.invoke('gh:status'),
  data: () => ipcRenderer.invoke('gh:data'),
  refresh: () => ipcRenderer.invoke('gh:refresh'),
  login: (token) => ipcRenderer.invoke('gh:login', token),
  logout: () => ipcRenderer.invoke('gh:logout'),
  seen: (keys) => ipcRenderer.invoke('gh:seen', keys),
  seenAll: () => ipcRenderer.invoke('gh:seenAll'),
  lists: (lists) => ipcRenderer.invoke('gh:lists', lists),
  open: (url) => ipcRenderer.send('gh:open', url),
  onEvent: (cb) => ipcRenderer.on('gh:event', (e, data) => cb(data)),
});
