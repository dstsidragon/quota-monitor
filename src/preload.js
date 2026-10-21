const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quota', {
  getState: () => ipcRenderer.invoke('get-state'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  refresh: () => ipcRenderer.invoke('refresh'),
  hide: () => ipcRenderer.invoke('hide'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  setCompact: (c) => ipcRenderer.invoke('set-compact', c),
  fitCompact: (w) => ipcRenderer.invoke('fit-compact', w),
  claudeLogin: () => ipcRenderer.invoke('claude-login'),
  claudeLogout: () => ipcRenderer.invoke('claude-logout'),
  onMode: (cb) => ipcRenderer.on('mode', (_e, c) => cb(c)),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, v) => cb(v)),
  onHover: (cb) => ipcRenderer.on('hover', (_e, h) => cb(h)),
  onLook: (cb) => ipcRenderer.on('look', (_e, l) => cb(l)),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});
