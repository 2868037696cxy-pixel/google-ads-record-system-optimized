'use strict';
const {app,BrowserWindow,Menu,dialog,ipcMain,session,shell,screen}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {resolveConfiguration}=require('./config');
app.setName('AdsWorkbench');
const dataDirectory=process.env.ADS_DESKTOP_DATA_DIR||path.join(app.getPath('appData'),'AdsWorkbench');
app.setPath('userData',dataDirectory);
let window,service,origin,configuration,quitting=false,busy=false;
const offlineFile=path.join(__dirname,'offline.html');
const offlineUrl=pathToFileURL(offlineFile).href;
function validSender(event,allowOffline=false) {
  if(!window || event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame) return false;
  try {return new URL(event.senderFrame.url).origin===origin || (allowOffline && event.senderFrame.url===offlineUrl);}catch{return false;}
}
function nativeAction(fn) {
  return async()=>{
    if(busy)return {canceled:true};busy=true;
    try{return await fn();}catch(error){await dialog.showMessageBox(window,{type:'error',message:'\u64cd\u4f5c\u672a\u5b8c\u6210',detail:error.message});return {error:'Operation failed'};}finally{busy=false;}
  };
}
async function backup() {
  const chosen=await dialog.showSaveDialog(window,{title:'\u5bfc\u51fa\u52a0\u5bc6\u5907\u4efd',defaultPath:`AdsWorkbench-${new Date().toISOString().slice(0,10)}.json`,filters:[{name:'Encrypted backup',extensions:['json']}]});
  if(chosen.canceled)return {canceled:true};
  fs.writeFileSync(chosen.filePath,JSON.stringify(service.encryptedSnapshot()),{mode:0o600});return {success:true};
}
async function restore() {
  const chosen=await dialog.showOpenDialog(window,{title:'\u9009\u62e9\u52a0\u5bc6\u5907\u4efd',properties:['openFile'],defaultPath:path.join(dataDirectory,'backups'),filters:[{name:'Encrypted backup',extensions:['json']}]});
  if(chosen.canceled)return {canceled:true};
  if(fs.statSync(chosen.filePaths[0]).size>64*1024*1024)throw new Error('Backup exceeds 64 MB');
  const envelope=JSON.parse(fs.readFileSync(chosen.filePaths[0],'utf8'));
  const value=service.decryptSnapshot(envelope);
  const answer=await dialog.showMessageBox(window,{type:'warning',title:'\u6062\u590d\u5907\u4efd',message:`\u6062\u590d ${value.records.length} \u6761\u8bb0\u5f55\u53ca\u8d44\u6e90\uff1f`,detail:'\u4ec5\u66ff\u6362\u5f53\u524d\u8d26\u53f7\u6570\u636e\uff1b\u66ff\u6362\u524d\u4fdd\u5b58\u52a0\u5bc6\u5feb\u7167\u3002',buttons:['\u53d6\u6d88','\u6062\u590d\u5907\u4efd'],defaultId:0,cancelId:0});
  if(answer.response!==1)return {canceled:true};
  const directory=path.join(dataDirectory,'backups');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(directory,`before-restore-${Date.now()}.json`),JSON.stringify(service.encryptedSnapshot()),{mode:0o600});
  service.restoreEncrypted(envelope);window.reload();return {success:true};
}
function windowBounds() {
  try {
    const b=JSON.parse(fs.readFileSync(path.join(dataDirectory,'window.json'),'utf8'));
    if(!['x','y','width','height'].every(k=>Number.isFinite(b[k])))throw new Error();
    if(!screen.getAllDisplays().some(({workArea:r})=>b.x<r.x+r.width&&b.x+b.width>r.x&&b.y<r.y+r.height&&b.y+b.height>r.y))throw new Error();
    return {...b,width:Math.max(1024,b.width),height:Math.max(720,b.height)};
  }catch{return {width:1440,height:960};}
}
async function loadOrigin() {
  if(!window||window.isDestroyed())return;
  try{await window.loadURL(origin);}
  catch{if(window&&!window.isDestroyed()) await window.loadFile(offlineFile);}
  if(window&&!window.isDestroyed())window.show();
}
async function openWindow() {
  configuration=resolveConfiguration({isPackaged:app.isPackaged});
  const remote=configuration.mode==='remote';
  const partition=session.fromPartition(remote?'ads-remote':'ads-desktop',{cache:false});
  const token=remote?'':crypto.randomBytes(32).toString('hex');
  if(remote) origin=configuration.origin;
  else {
    process.env.DATA_FILE=path.join(dataDirectory,'data.json');
    service=require('../server');origin=await service.start({port:0,host:'127.0.0.1',token});
    partition.webRequest.onBeforeSendHeaders({urls:[origin+'/*']},(details,callback)=>callback({requestHeaders:{...details.requestHeaders,'x-desktop-token':token}}));
  }
  // Test-only trust: one exact local certificate, never in a packaged build.
  if(!app.isPackaged && process.env.NODE_ENV==='test' && new URL(origin).hostname==='127.0.0.1' && process.env.ADS_TEST_CERT_FINGERPRINT) {
    partition.setCertificateVerifyProc((request,callback)=>callback(request.hostname==='127.0.0.1' && new crypto.X509Certificate(request.certificate.data).fingerprint256===process.env.ADS_TEST_CERT_FINGERPRINT ? 0 : -3));
  }
  window=new BrowserWindow({...windowBounds(),minWidth:1024,minHeight:720,show:false,title:'\u8d26\u53f7\u5de5\u4f5c\u53f0',backgroundColor:'#090c11',icon:path.join(__dirname,'../build/icon.ico'),webPreferences:{
    preload:path.join(__dirname,'preload.js'),session:partition,additionalArguments:remote?['--ads-workbench-remote']:[],nodeIntegration:false,contextIsolation:true,sandbox:true,
  }});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const blockNavigation=(event,url)=>{try{if(new URL(url).origin!==origin)event.preventDefault();}catch{event.preventDefault();}};
  window.webContents.on('will-navigate',blockNavigation);
  window.webContents.on('will-redirect',blockNavigation);
  partition.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  partition.setPermissionCheckHandler(()=>false);
  partition.on('will-download',(event,item,wc)=>{
    const url=item.getURL();
    if(wc!==window.webContents||!(url.startsWith(origin+'/')||url.startsWith('blob:'+origin+'/'))) {event.preventDefault();return;}
    const name=path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
    if(!/\.(pdf|json|csv|txt)$/i.test(name)){event.preventDefault();return;}
    item.setSaveDialogOptions({title:'\u4fdd\u5b58\u5de5\u4f5c\u53f0\u6587\u4ef6',defaultPath:path.join(app.getPath('downloads'),name)});
    item.once('done',(_event,status)=>{if(status==='interrupted' && window && !window.isDestroyed())dialog.showMessageBox(window,{type:'error',message:'\u6587\u4ef6\u4e0b\u8f7d\u672a\u5b8c\u6210\uff0c\u8bf7\u91cd\u8bd5'});});
  });
  ipcMain.handle('shell:info',event=>{if(!validSender(event,true))throw new Error('Invalid caller');return {version:app.getVersion(),mode:configuration.mode,origin};});
  ipcMain.handle('shell:retry',async event=>{if(!validSender(event,true))throw new Error('Invalid caller');await loadOrigin();return {ok:true};});
  if(!remote) {
    const documentPath=id=>{
      if(!Number.isSafeInteger(id)||id<1)throw new Error('Invalid document');
      const doc=service.licenseDocument(id),dir=path.join(dataDirectory,'documents');fs.mkdirSync(dir,{recursive:true,mode:0o700});
      const file=path.join(dir,doc.id+'.pdf');fs.writeFileSync(file,Buffer.from(doc.base64,'base64'),{mode:0o600});return file;
    };
    const ops={info:async()=>({version:app.getVersion(),platform:process.platform,dataDirectory}),backup,restore,'open-data-folder':async()=>{const e=await shell.openPath(dataDirectory);if(e)throw new Error(e);return {success:true};}};
    for(const op of ['open','reveal'])ops[`${op}-license-pdf`]=async id=>{const file=documentPath(id);if(op==='reveal')shell.showItemInFolder(file);else{const e=await shell.openPath(file);if(e)throw new Error(e);}return {success:true};};
    for(const [name,fn] of Object.entries(ops))ipcMain.handle('desktop:'+name,(event,...args)=>{if(!validSender(event))throw new Error('Invalid caller');return nativeAction(()=>fn(...args))();});
  }
  window.on('close',()=>{try{fs.writeFileSync(path.join(dataDirectory,'window.json'),JSON.stringify(window.getNormalBounds()));}catch{}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'\u6587\u4ef6',submenu:[...(!remote?[{label:'\u5bfc\u51fa\u52a0\u5bc6\u5907\u4efd',click:nativeAction(backup)},{label:'\u6062\u590d\u5907\u4efd',click:nativeAction(restore)}]:[]),{label:'\u91cd\u65b0\u8fde\u63a5',click:()=>loadOrigin()},{type:'separator'},{label:'\u9000\u51fa',role:'quit'}]},
    {label:'\u7f16\u8f91',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'\u89c6\u56fe',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},
  ]));
  await loadOrigin();
}
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
  app.whenReady().then(()=>{fs.mkdirSync(dataDirectory,{recursive:true,mode:0o700});return openWindow();}).catch(async error=>{await dialog.showMessageBox({type:'error',message:'\u5de5\u4f5c\u53f0\u542f\u52a8\u5931\u8d25',detail:error.message});app.quit();});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{if(quitting||!service)return;event.preventDefault();quitting=true;service.close().finally(()=>app.quit());});
}
