'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ailinuxHelper', Object.freeze({
  getCapabilities: () => ipcRenderer.invoke('ailinux-helper:get-capabilities'),
  clipboardRead: () => ipcRenderer.invoke('ailinux-helper:clipboard-read'),
  clipboardWrite: (text) => ipcRenderer.invoke('ailinux-helper:clipboard-write', String(text ?? '')),
  screenshot: () => ipcRenderer.invoke('ailinux-helper:screenshot'),
}));
