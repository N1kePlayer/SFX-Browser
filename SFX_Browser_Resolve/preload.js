'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('sfx', {
  platform: process.platform,
  sep: process.platform === 'win32' ? '\\' : '/',
  loadState: invoke('state:load'),
  saveState: invoke('state:save'),
  list: invoke('fs:list'),
  search: invoke('fs:search'),
  stat: invoke('fs:stat'),
  read: invoke('fs:read'),
  existing: invoke('fs:existing'),
  chooseFolder: invoke('ui:chooseFolder'),
  reveal: invoke('ui:reveal'),
  copy: invoke('ui:copy'),
  resolveStatus: invoke('resolve:status'),
  insert: invoke('resolve:insert'),
  startDrag: (p) => ipcRenderer.send('drag:start', p)
});
