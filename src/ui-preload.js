'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['level', 'view-state', 'settings']);

contextBridge.exposeInMainWorld('ear', {
  getState: () => ipcRenderer.invoke('ui:state'),
  setBounds: (rects) => ipcRenderer.send('ui:bounds', rects),
  set: (slot, patch) => ipcRenderer.send('ui:set', slot, patch),
  swap: () => ipcRenderer.send('ui:swap'),
  setGlobal: (patch) => ipcRenderer.send('ui:global', patch),
  nav: (slot, action, arg) => ipcRenderer.send('ui:nav', slot, action, arg),
  on: (channel, fn) => {
    if (EVENTS.has(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
