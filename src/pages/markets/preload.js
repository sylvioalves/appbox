'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('markets', {
  data: () => ipcRenderer.invoke('mkt:data'),
  chart: (sym, range) => ipcRenderer.invoke('mkt:chart', sym, range),
  search: (text) => ipcRenderer.invoke('mkt:search', text),
  add: (sym) => ipcRenderer.invoke('mkt:add', sym),
  remove: (sym) => ipcRenderer.invoke('mkt:remove', sym),
  move: (sym, index) => ipcRenderer.invoke('mkt:move', sym, index),
  currency: (cur) => ipcRenderer.invoke('mkt:currency', cur),
  refresh: () => ipcRenderer.invoke('mkt:refresh'),
  active: (on) => ipcRenderer.send('mkt:active', on),
  onEvent: (cb) => ipcRenderer.on('mkt:event', (e, data) => cb(data)),
});
