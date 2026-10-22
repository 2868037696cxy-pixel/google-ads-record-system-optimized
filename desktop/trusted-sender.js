'use strict';
const fs=require('node:fs');
const {fileURLToPath,pathToFileURL}=require('node:url');

// Electron may expose different JS wrappers for the same native frame. Trust
// browser-assigned window/frame coordinates and the URL, never wrapper identity.
module.exports=function trustedSender(event,{webContents,origin,offlineFile,allowOffline=false}){
  try{
    const frame=event?.senderFrame,main=webContents?.mainFrame;
    if(!frame||!main||frame.detached||main.detached)return false;
    if(!Number.isSafeInteger(webContents.id)||webContents.id<1||event.sender?.id!==webContents.id)return false;
    for(const key of ['processId','routingId'])if(!Number.isSafeInteger(frame[key])||frame[key]<0||frame[key]!==main[key])return false;
    const url=new URL(frame.url);
    if(url.origin===origin)return true;
    if(!allowOffline||url.protocol!=='file:'||url.search||url.hash)return false;
    const expected=pathToFileURL(offlineFile);
    if(url.host!==expected.host)return false;
    return fs.realpathSync(fileURLToPath(url))===fs.realpathSync(offlineFile);
  }catch{return false;}
};
