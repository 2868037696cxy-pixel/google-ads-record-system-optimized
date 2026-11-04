'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');const {fork}=require('node:child_process');const {once}=require('node:events');

test('server restart retains ready downloads and acknowledged upload offsets, truncates uncommitted bytes and permits a verified restore',{timeout:60000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-package-resume-'));
  let child,origin,cookie;
  const start=async()=>{
    child=fork(path.join(__dirname,'fixtures/package-server.cjs'),[],{stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,DATA_DIR:root,DB_FILE:path.join(root,'workbench.sqlite'),DATA_FILE:path.join(root,'absent.json'),REGISTRATION:'open',SESSION_SECURE:'0',LOG_LEVEL:'silent'}});
    origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture startup timed out')),10000);child.once('message',message=>{clearTimeout(timer);resolve(message.origin);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('fixture exited before ready'));});});
  };
  const stop=async()=>{
    if(!child||child.exitCode!==null)return;
    const exited=once(child,'exit');child.send('close');
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await exited;}finally{clearTimeout(timer);}
  };
  const raw=(method,url,body,headers={})=>fetch(origin+url,{method,headers:{'x-workbench':'1',...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
  const api=async(method,url,body)=>{const r=await raw(method,url,body);assert.equal(r.status,200,await r.clone().text());return r.json();};
  const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  const wait=async(id,status)=>{for(let i=0;i<600;i++){const job=await api('GET',`/api/backup-jobs/${id}`);if(job.status===status)return job;assert.notEqual(job.status,'failed',job.error);await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('task timeout');};
  try{
    await start();const registered=await raw('POST','/api/auth/register',{username:'resume-test',password:'Resume-123456'});assert.equal(registered.status,201);cookie=registered.headers.get('set-cookie').split(';')[0];
    await api('POST','/api/records',{domains:['resume.example'],proxy_mode:'none',email_ids:[],card_ids:[],license_ids:[]});await api('POST','/api/security/unlock',{password:'Resume-123456'});
    const exported=await api('POST','/api/backup-jobs',{kind:'export'});await wait(exported.id,'ready');const bytes=Buffer.from(await(await raw('GET',`/api/backup-jobs/${exported.id}/file`)).arrayBuffer());
    const uploaded=await api('POST','/api/backup-jobs',{kind:'restore',size:bytes.length,source_tag:hash(bytes)});const first=bytes.subarray(0,512);
    let response=await raw('PUT',`/api/backup-jobs/${uploaded.id}/chunk?offset=0`,first,{'content-type':'application/octet-stream','x-chunk-sha256':hash(first)});assert.equal(response.status,200);assert.equal((await response.json()).offset,512);
    await stop();const uploadPath=path.join(root,'backup-tasks',uploaded.id,'upload.awbp');fs.appendFileSync(uploadPath,Buffer.from('UNACKNOWLEDGED-CRASH-TAIL'));assert.ok(fs.statSync(uploadPath).size>512);
    await start();assert.equal((await api('GET',`/api/backup-jobs/${uploaded.id}`)).offset,512);assert.equal(fs.statSync(uploadPath).size,512);
    await api('POST','/api/security/unlock',{password:'Resume-123456'});const resumed=await raw('GET',`/api/backup-jobs/${exported.id}/file`,undefined,{range:'bytes=512-'});assert.equal(resumed.status,206);assert.deepEqual(Buffer.from(await resumed.arrayBuffer()),bytes.subarray(512));
    for(let offset=512;offset<bytes.length;offset+=1024*1024){const part=bytes.subarray(offset,offset+1024*1024);response=await raw('PUT',`/api/backup-jobs/${uploaded.id}/chunk?offset=${offset}`,part,{'content-type':'application/octet-stream','x-chunk-sha256':hash(part)});assert.equal(response.status,200);}
    await api('POST',`/api/backup-jobs/${uploaded.id}/verify`,{});const review=await wait(uploaded.id,'review');assert.equal(review.counts.records,1);
    const restored=await api('POST',`/api/backup-jobs/${uploaded.id}/apply`,{revision:review.revision});assert.equal(restored.status,'complete');assert.equal((await api('GET','/api/records?limit=10&offset=0')).items[0].domain,'resume.example');
  }finally{await stop();fs.rmSync(root,{recursive:true,force:true});}
});
