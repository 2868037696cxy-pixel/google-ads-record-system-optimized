'use strict';
// A sandboxed browser surface for isolated web UI verification, not the user desktop.
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
