'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mail', {
  status: () => ipcRenderer.invoke('mail:status'),
  login: (user, pass) => ipcRenderer.invoke('mail:login', user, pass),
  logout: () => ipcRenderer.invoke('mail:logout'),
  folders: (refresh) => ipcRenderer.invoke('mail:folders', Boolean(refresh)),
  select: (box) => ipcRenderer.invoke('mail:select', box),
  watch: (paths) => ipcRenderer.invoke('mail:watch', paths),
  list: (more) => ipcRenderer.invoke('mail:list', Boolean(more)),
  thread: (thrid, fresh) => ipcRenderer.invoke('mail:thread', thrid, Boolean(fresh)),
  prefetch: (thrids) => ipcRenderer.invoke('mail:prefetch', thrids),
  message: (box, uid) => ipcRenderer.invoke('mail:message', box, uid),
  search: (query) => ipcRenderer.invoke('mail:search', query),
  readAll: (box) => ipcRenderer.invoke('mail:readAll', box),
  send: (msg) => ipcRenderer.invoke('mail:send', msg),
  draftSave: (msg) => ipcRenderer.invoke('mail:draftSave', msg),
  draftDelete: (uid) => ipcRenderer.invoke('mail:draftDelete', uid),
  pickFiles: () => ipcRenderer.invoke('mail:pickFiles'),
  download: (box, uid, indexes, label) => ipcRenderer.invoke('mail:download', box, uid, indexes, label),
  openFolder: (dir) => ipcRenderer.send('mail:openFolder', dir),
  trust: (email, on) => ipcRenderer.invoke('mail:trust', email, on),
  flag: (box, uids, flags) => ipcRenderer.invoke('mail:flag', box, uids, flags),
  move: (box, uids, where) => ipcRenderer.invoke('mail:move', box, uids, where),
  open: (url) => ipcRenderer.send('mail:open', url),
  onEvent: (cb) => ipcRenderer.on('mail:event', (e, data) => cb(data)),
});
