'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {pathToFileURL}=require('node:url');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-ipc-origin-'));const offline=path.join(root,'offline page.html');fs.writeFileSync(offline,'synthetic trusted offline page');fs.writeFileSync(path.join(root,'other.html'),'other file');
const mainFrame={processId:7,routingId:1,url:'https://workbench.example/records'};const contents={id:11,mainFrame};
const trusted=require('../desktop/trusted-sender');
const call=(frame=mainFrame,extra={},sender=contents)=>trusted({sender,senderFrame:frame},{webContents:contents,origin:'https://workbench.example',offlineFile:offline,...extra});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('native frame coordinates remain authoritative across different JavaScript wrappers',()=>{
  assert.equal(call({...mainFrame}, {}, {...contents}),true);
});
test('only the app window main frame and configured origin can invoke IPC',()=>{
  assert.equal(call(),true);assert.equal(call(mainFrame,{}, {...contents,id:12}),false);assert.equal(call({...mainFrame,routingId:2}),false);assert.equal(call({...mainFrame,processId:8}),false);assert.equal(call({...mainFrame,url:'https://workbench.example.evil.test/'}),false);assert.equal(call({...mainFrame,url:'http://workbench.example/'}),false);
  assert.equal(call({...mainFrame,processId:undefined}),false);assert.equal(call(null),false);assert.equal(call({...mainFrame,detached:true}),false);assert.equal(call({...mainFrame,url:'not a URL'}),false);
});
test('offline capabilities require the exact canonical local resource and explicit opt-in',()=>{
  const url=pathToFileURL(offline).href;
  assert.equal(call({...mainFrame,url},{allowOffline:true}),true);
  assert.equal(call({...mainFrame,url}),false);
  for(const candidate of [pathToFileURL(path.join(root,'other.html')).href,url+'?source=other',url+'#other','file://untrusted-server/share/offline.html'])assert.equal(call({...mainFrame,url:candidate},{allowOffline:true}),false);
  const alias=path.join(root,'alias');fs.mkdirSync(alias);
  const normalized=pathToFileURL(alias).href+'/../'+encodeURIComponent(path.basename(offline));
  assert.equal(call({...mainFrame,url:normalized},{allowOffline:true}),true);
});
