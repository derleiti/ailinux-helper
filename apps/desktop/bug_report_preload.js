'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ailinuxBugReport', {
  submit: (message) => ipcRenderer.invoke('ailinux:bug-report-submit', String(message || '').slice(0, 8000)),
  close: () => ipcRenderer.send('ailinux:bug-report-close'),
});
