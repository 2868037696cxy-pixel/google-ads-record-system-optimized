'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

app.setName('AdsWorkbench');
const dataDirectory = process.env.ADS_DESKTOP_DATA_DIR || path.join(app.getPath('appData'), 'AdsWorkbench');
app.setPath('userData', dataDirectory);
let window;
let service;
let origin;
let quitting = false;
let busy = false;

// Remote desktop mode uses only an explicitly configured HTTPS backend.
// Never silently fall back to employee-local data when the server is unavailable.
function remoteServerUrl() {
  const configured = String(process.env.ADS_WORKBENCH_SERVER_URL || '').trim();
  if (!configured) return '';
  const url = new URL(configured);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || url.origin !== configured.replace(/\/$/, '')) {
    throw new Error('ADS_WORKBENCH_SERVER_URL 必须是 HTTPS 根地址，例如 https://ads.example.com');
  }
  return url.origin;
}
const remoteOrigin = remoteServerUrl();

async function backup() {
  const result = await dialog.showSaveDialog(window, {
    title: '导出完整备份',
    defaultPath: `账号工作台备份-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: '工作台备份', extensions: ['json'] }],
  });
  if (result.canceled) return { canceled: true };
  fs.writeFileSync(result.filePath, JSON.stringify(service.snapshot(), null, 2), { mode: 0o600 });
  return { success: true };
}

async function chooseSnapshot() {
  const result = await dialog.showOpenDialog(window, {
    title: '选择完整备份', properties: ['openFile'],
    defaultPath: path.join(dataDirectory, 'backups'),
    filters: [{ name: '工作台备份', extensions: ['json'] }],
  });
  if (result.canceled) return null;
  return validateSnapshot(JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8')));
}

async function restore() {
  const value = await chooseSnapshot();
  if (!value) return { canceled: true };
  const answer = await dialog.showMessageBox(window, {
    type: 'warning', title: '恢复备份',
    message: `将恢复 ${value.records.length} 条记录及全部资源。`,
    detail: '当前数据将在替换前自动备份。恢复会覆盖当前工作台，请确认没有未完成的编辑。',
    buttons: ['取消', '恢复备份'], defaultId: 0, cancelId: 0,
  });
  if (answer.response !== 1) return { canceled: true };
  service.restore(value);
  window.reload();
  return { success: true };
}

function nativeAction(operation) {
  return async () => {
    if (busy) return { canceled: true };
    busy = true;
    try { return await operation(); }
    catch (error) {
      await dialog.showMessageBox(window, { type: 'error', message: '操作未完成', detail: error.message });
      return { error: '操作未完成，请查看提示后重试' };
    } finally { busy = false; }
  };
}

function documentPath(id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('无效营业执照编号');
  const document = service.licenseDocument(id);
  const directory = path.join(dataDirectory, 'documents');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, document.id + '.pdf');
  fs.writeFileSync(filename, Buffer.from(document.base64, 'base64'), { mode: 0o600 });
  return filename;
}

function windowBounds() {
  const fallback = { width: 1440, height: 960 };
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'window.json'), 'utf8'));
    if (![value.x, value.y, value.width, value.height].every(Number.isFinite)) return fallback;
    const visible = screen.getAllDisplays().some(({ workArea: r }) =>
      value.x < r.x + r.width && value.x + value.width > r.x && value.y < r.y + r.height && value.y + value.height > r.y);
    return visible ? { ...value, width: Math.max(1024, value.width), height: Math.max(720, value.height) } : fallback;
  } catch { return fallback; }
}

async function openWindow() {
  const partition = session.fromPartition('ads-desktop');
  const token = remoteOrigin ? '' : crypto.randomBytes(32).toString('hex');
  if (!remoteOrigin) process.env.DATA_FILE = path.join(dataDirectory, 'data.json');
  try { if (!remoteOrigin) service = require('../server'); }
  catch (error) {
    // 服务器版的数据在 SQLite 里，data.json 只在首次启动时用于迁移。
    // 所以恢复手段是把损坏的库改名保留、让服务器重建空库，再从侧栏「恢复」导入备份。
    const database = path.join(dataDirectory, 'workbench.sqlite');
    const answer = await dialog.showMessageBox({
      type: 'error', message: '无法打开工作台数据库',
      detail: `${database} 可能已损坏。原文件会被改名保留，重建后请在侧栏用「恢复」导入备份。`,
      buttons: ['退出', '保留原文件并重建'], defaultId: 0, cancelId: 0,
    });
    if (answer.response !== 1) throw error;
    const stamp = Date.now();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${database}${suffix}`;
      try { if (fs.existsSync(file)) fs.renameSync(file, `${file}.corrupt-${stamp}`); }
      catch { /* 改名失败时继续尝试打开，让原始错误照常抛出 */ }
    }
    service = require('../server');
  }
  origin = remoteOrigin || await service.start({ port: 0, host: '127.0.0.1', token });
  if (!remoteOrigin) partition.webRequest.onBeforeSendHeaders({ urls: [origin + '/*'] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'x-desktop-token': token } });
  });
  window = new BrowserWindow({
    ...windowBounds(), minWidth: 1024, minHeight: 720, show: false,
    title: '账号工作台', backgroundColor: '#090c11', icon: path.join(__dirname, '../build/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), session: partition,
      additionalArguments: remoteOrigin ? ['--ads-workbench-remote'] : [],
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  window.on('close', () => {
    try { fs.writeFileSync(path.join(dataDirectory, 'window.json'), JSON.stringify(window.getNormalBounds())); }
    catch { /* Window preferences must never block shutdown. */ }
  });
  if (!remoteOrigin) for (const [name, operation] of Object.entries({
    info: async () => ({ version: app.getVersion(), platform: 'windows', dataDirectory }),
    backup, restore, 'open-data-folder': async () => {
      const error = await shell.openPath(dataDirectory);
      if (error) throw new Error(error);
      return { success: true };
    },
  })) {
    ipcMain.handle('desktop:' + name, (event) => {
      if (event.sender !== window.webContents || new URL(event.senderFrame.url).origin !== origin) throw new Error('无效调用');
      return nativeAction(operation)();
    });
  }
  if (!remoteOrigin) for (const operation of ['open', 'reveal']) {
    ipcMain.handle(`desktop:${operation}-license-pdf`, (event, id) => {
      if (event.sender !== window.webContents || new URL(event.senderFrame.url).origin !== origin) throw new Error('无效调用');
      return nativeAction(async () => {
        const filename = documentPath(id);
        if (operation === 'reveal') shell.showItemInFolder(filename);
        else {
          const error = await shell.openPath(filename);
          if (error) throw new Error(error);
        }
        return { success: true, path: filename };
      })();
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: remoteOrigin ? [{ label: '退出', role: 'quit' }] : [
      { label: '导出完整备份', accelerator: 'Ctrl+Shift+S', click: nativeAction(backup) },
      { label: '恢复完整备份', accelerator: 'Ctrl+Shift+O', click: nativeAction(restore) },
      { type: 'separator' }, { label: '退出', role: 'quit' },
    ] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '视图', submenu: [{ role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' }] },
  ]));
  await window.loadURL(origin);
  window.show();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(() => {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    return openWindow();
  }).catch(async (error) => {
    await dialog.showMessageBox({ type: 'error', message: '账号工作台启动失败', detail: error.message });
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting || !service) return;
    event.preventDefault();
    quitting = true;
    service.close().finally(() => app.quit());
  });
}
