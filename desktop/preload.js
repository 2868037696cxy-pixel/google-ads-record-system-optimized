'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  info: () => ipcRenderer.invoke('desktop:info'),
  backup: () => ipcRenderer.invoke('desktop:backup'),
  restore: () => ipcRenderer.invoke('desktop:restore'),
  openDataFolder: () => ipcRenderer.invoke('desktop:open-data-folder'),
  openLicensePdf: (id) => ipcRenderer.invoke('desktop:open-license-pdf', id),
  revealLicensePdf: (id) => ipcRenderer.invoke('desktop:reveal-license-pdf', id),
}));
