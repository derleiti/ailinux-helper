'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ailinuxHelper', Object.freeze({
  getCapabilities: () => ipcRenderer.invoke('ailinux-helper:get-capabilities'),
  getShareProfile: () => ipcRenderer.invoke('ailinux-helper:get-share-profile'),
  setShareProfile: (patch) => ipcRenderer.invoke('ailinux-helper:set-share-profile', patch || {}),
  getResourceInventory: () => ipcRenderer.invoke('ailinux-helper:get-resource-inventory'),
  dockerStatus: () => ipcRenderer.invoke('ailinux-helper:docker-status'),
  dockerService: (action) => ipcRenderer.invoke('ailinux-helper:docker-service', String(action || '')),
  dockerInstall: () => ipcRenderer.invoke('ailinux-helper:docker-install'),
  dockerTest: () => ipcRenderer.invoke('ailinux-helper:docker-test'),
  runCompute: (payload) => ipcRenderer.invoke('ailinux:shell-run', payload || {}),
  onShareProfileChanged: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('ailinux:share-profile-changed', (_event, profile) => callback(profile));
  },
  uiClipboardWrite: (text) => ipcRenderer.invoke('ailinux-helper:ui-clipboard-write', String(text ?? '')),
  clipboardRead: () => ipcRenderer.invoke('ailinux-helper:clipboard-read'),
  clipboardWrite: (text) => ipcRenderer.invoke('ailinux-helper:clipboard-write', String(text ?? '')),
  screenshot: () => ipcRenderer.invoke('ailinux-helper:screenshot'),
}));


contextBridge.exposeInMainWorld('ailinuxNative', Object.freeze({
  host: 'electron',
  platform: process.platform,
  version: process.env.AILINUX_HELPER_VERSION || '',
  shellStatus: () => ipcRenderer.invoke('ailinux:shell-status'),
  setShellBackend: (name) => ipcRenderer.invoke('ailinux:shell-backend', String(name || '')),
  releaseShell: () => ipcRenderer.invoke('ailinux:shell-release'),
  revokeShell: () => ipcRenderer.invoke('ailinux:shell-revoke'),
  runShell: (payload) => ipcRenderer.invoke('ailinux:shell-run', payload || {}),
  onShellChanged: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('ailinux:shell-changed', (_event, state) => callback(state));
  },
}));
