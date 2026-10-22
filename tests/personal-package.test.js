'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {certificate}=require('./pdf-fixture');
const largePdf=require('./large-pdf-fixture');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-personal-package-'));
Object.assign(process.env,{DATA_DIR:root,DB_FILE:path.join(root,'workbench.sqlite'),DATA_FILE:path.join(root,'absent.json'),REGISTRATION:'open',SESSION_SECURE:'0',LOG_LEVEL:'silent'});
const service=require('../server');const {CHUNK_BYTES}=require('../lib/personal-package');
let origin,sequence=0;
test.before(async()=>{origin=await service.start({port:0});});
test.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(){
  const n=++sequence,password='Package-Test-1234';
  const r=await fetch(origin+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json','x-workbench':'1'},body:JSON.stringify({username:`package-${n}`,password})});assert.equal(r.status,201);
  const cookie=r.headers.get('set-cookie').split(';')[0];const owner=service.db.prepare('SELECT id FROM users WHERE username=?').get(`package-${n}`).id;
  const raw=(method,url,body,headers={})=>fetch(origin+url,{method,headers:{cookie,'x-workbench':'1',...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body)});
  const api=async(method,url,body)=>{const res=await raw(method,url,body);return {status:res.status,data:await res.json()};};
  const unlock=()=>api('POST','/api/security/unlock',{password});
  const wait=async(id,status)=>{for(let i=0;i<1200;i++){const r=await api('GET',`/api/backup-jobs/${id}`);assert.equal(r.status,200);if(r.data.status===status)return r.data;if(r.data.status==='failed')throw new Error('Job failed: '+JSON.stringify(r.data));await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Task did not reach '+status);};
  const upload=async(bytes,options={})=>{const job=await api('POST','/api/backup-jobs',{kind:'restore',size:bytes.length,source_tag:digest(bytes.subarray(0,Math.min(bytes.length,65536)))});assert.equal(job.status,200,JSON.stringify(job.data));for(let offset=0;offset<bytes.length;offset+=CHUNK_BYTES){const chunk=bytes.subarray(offset,offset+CHUNK_BYTES);const res=await raw('PUT',`/api/backup-jobs/${job.data.id}/chunk?offset=${offset}`,chunk,{'content-type':'application/octet-stream','x-chunk-sha256':digest(chunk)});assert.equal(res.status,200,await res.text());}return job.data;};
  return {n,password,cookie,owner,raw,api,unlock,wait,upload};
}
async function seed(f){
  for(const [kind,items]of Object.entries({emails:[{user:`package-${f.n}@example.test`,pass:'SYNTHETIC-PACKAGE-SECRET'}],proxies:[{usage_limit:5,host:'192.0.2.25',port:'1080',pass:'SYNTHETIC-PROXY-SECRET'}],cards:[{number:`Package-${f.n}`,last4:'0123',expiry:'12/30'}]}))assert.equal((await f.api('POST',`/api/import/${kind}`,{items})).status,200);
  const pdf=certificate([`Personal package ${f.n}`]);
  assert.equal((await f.api('POST','/api/import/licenses',{pdf:pdf.toString('base64'),filename:'certificate.pdf',items:[{name:`Package company ${f.n}`}]})).status,200);
  const made=await f.api('POST','/api/records',{domains:[`package-${f.n}.example`],proxy_mode:'auto'});assert.equal(made.status,200);
  return {pdf,record:made.data.created[0]};
}

test('personal package exports owner-only ciphertext, restores exact resources/PDF and commits once',async()=>{
  const f=await fixture(),foreign=await fixture();const seeded=await seed(f);await seed(foreign);await f.unlock();
  const orphan=certificate(['SYNTHETIC foreign unreferenced document']);service.store.putDocument(service.db,foreign.owner,{sha256:digest(orphan),filename:'foreign-unreferenced.pdf',bytes:orphan,createdAt:new Date().toISOString()});
  const create=await f.api('POST','/api/backup-jobs',{kind:'export'});assert.equal(create.status,200);
  const ready=await f.wait(create.data.id,'ready');assert.equal(ready.counts.records,1);assert.equal(ready.counts.documents,1);
  const downloaded=await f.raw('GET',`/api/backup-jobs/${ready.id}/file`);assert.equal(downloaded.status,200);const bytes=Buffer.from(await downloaded.arrayBuffer());assert.equal(digest(bytes),ready.sha256);assert.ok(!bytes.includes(Buffer.from('SYNTHETIC-PACKAGE-SECRET')));
  const archive=path.join(root,'inspect.awbp'),personalFile=path.join(root,'inspect.sqlite');fs.writeFileSync(archive,bytes);
  await require('../lib/vault').getVault(service.db).openFile(archive,personalFile,f.owner);
  const personal=new(require('node:sqlite').DatabaseSync)(personalFile,{readOnly:true});try{assert.equal(personal.prepare('SELECT COUNT(*) n FROM users').get().n,1);assert.equal(personal.prepare('SELECT COUNT(*) n FROM records WHERE owner_id<>?').get(f.owner).n,0);assert.equal(personal.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);assert.equal(personal.prepare('SELECT COUNT(*) n FROM audit_events').get().n,0);}finally{personal.close();}assert.ok(!fs.readFileSync(personalFile).includes(Buffer.from('SYNTHETIC-PACKAGE-SECRET')));
  const upload=await f.upload(bytes);assert.equal((await f.api('POST',`/api/backup-jobs/${upload.id}/verify`,{})).status,200);const review=await f.wait(upload.id,'review');assert.equal(review.counts.records,1);
  const beforeForeign=JSON.stringify(service.store.listRecords(service.db,foreign.owner));
  const result=await f.api('POST',`/api/backup-jobs/${upload.id}/apply`,{revision:review.revision});assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.status,'complete');
  assert.ok(service.store.getDocument(service.db,digest(orphan)),'restore must not prune another owner’s unreferenced files');
  const records=service.store.listRecords(service.db,f.owner);assert.equal(records.length,1);assert.equal(records[0].domain,seeded.record.domain);assert.equal(records[0].email_pass,'SYNTHETIC-PACKAGE-SECRET');
  for(const [kind,prefix]of Object.entries(service.store.POOL_PREFIX)){const item=service.store.findPoolItem(service.db,f.owner,kind,records[0][`${prefix}_id`]);assert.ok(item);assert.equal(item.status,'已使用');if(kind==='proxies')assert.equal(item.usage_limit,5);}
  const sha=digest(seeded.pdf);assert.deepEqual(service.store.getDocument(service.db,sha).bytes,seeded.pdf);assert.equal(JSON.stringify(service.store.listRecords(service.db,foreign.owner)),beforeForeign);
  assert.equal((await f.api('POST',`/api/backup-jobs/${upload.id}/apply`,{revision:review.revision})).data.status,'complete');
  assert.equal(service.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE owner_id=? AND action='backup.package.restore'").get(f.owner).n,1);
});

test('chunk replay, hash mismatch, wrong offsets, ownership and HTTP ranges are enforced',async()=>{
  const f=await fixture(),other=await fixture();await seed(f);await f.unlock();
  const id=(await f.api('POST','/api/backup-jobs',{kind:'export'})).data.id,ready=await f.wait(id,'ready');
  assert.equal((await other.api('GET',`/api/backup-jobs/${id}`)).status,404);
  assert.equal((await other.raw('GET',`/api/backup-jobs/${id}/file`)).status,403);
  const full=Buffer.from(await(await f.raw('GET',`/api/backup-jobs/${id}/file`)).arrayBuffer());
  const range=await f.raw('GET',`/api/backup-jobs/${id}/file`,undefined,{range:'bytes=10-99'});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),full.subarray(10,100));
  assert.equal((await f.raw('GET',`/api/backup-jobs/${id}/file`,undefined,{range:'bytes=999999999-'})).status,416);
  assert.equal((await f.raw('GET',`/api/backup-jobs/${id}/file`,undefined,{range:'bytes=0-9,20-30'})).status,416);
  const job=(await f.api('POST','/api/backup-jobs',{kind:'restore',size:full.length,source_tag:digest(full)})).data;
  const first=full.subarray(0,Math.min(4096,full.length)),url=`/api/backup-jobs/${job.id}/chunk?offset=0`,headers={'content-type':'application/octet-stream','x-chunk-sha256':digest(first)};
  assert.equal((await f.raw('PUT',url,first,headers)).status,200);assert.equal((await f.raw('PUT',url,first,headers)).status,200);
  assert.equal((await f.api('GET',`/api/backup-jobs/${job.id}`)).data.offset,first.length);
  assert.equal((await f.raw('PUT',url,Buffer.alloc(first.length,1),headers)).status,400);
  assert.equal((await f.raw('PUT',`/api/backup-jobs/${job.id}/chunk?offset=${first.length+1}`,first,headers)).status,409);
  await other.unlock();assert.equal((await other.raw('PUT',url,first,headers)).status,404);assert.equal((await other.api('GET','/api/backup-jobs')).data.jobs.length,0);
  const foreign=await other.upload(full);await other.api('POST',`/api/backup-jobs/${foreign.id}/verify`,{});for(let i=0;i<1200;i++){const status=(await other.api('GET',`/api/backup-jobs/${foreign.id}`)).data.status;if(status==='failed')break;assert.notEqual(status,'review');await new Promise(r=>setTimeout(r,25));}assert.equal((await other.api('GET',`/api/backup-jobs/${foreign.id}`)).data.status,'failed');
  assert.equal((await f.api('POST',`/api/backup-jobs/${job.id}/verify`,{})).status,409);
});

test('five 8 MiB PDFs rejected by legacy JSON can round-trip through bounded binary chunks', {timeout:180000},async()=>{
  const f=await fixture(),hashes=[];
  for(let i=0;i<5;i++){
    const bytes=largePdf(i+10);hashes.push(digest(bytes));
    const result=await f.api('POST','/api/import/licenses',{pdf:bytes.toString('base64'),filename:`large-package-${i}.pdf`,items:[{name:`Large package organization ${f.n}-${i}`}]});assert.equal(result.status,200,JSON.stringify(result.data));
  }
  await f.unlock();assert.equal((await f.raw('GET','/api/backup')).status,409);
  const create=await f.api('POST','/api/backup-jobs',{kind:'export'});assert.equal(create.status,200);const ready=await f.wait(create.data.id,'ready');assert.equal(ready.counts.documents,5);assert.ok(ready.size>40*1024*1024);
  const bytes=Buffer.from(await(await f.raw('GET',`/api/backup-jobs/${ready.id}/file`)).arrayBuffer());assert.equal(digest(bytes),ready.sha256);
  const upload=await f.upload(bytes);await f.api('POST',`/api/backup-jobs/${upload.id}/verify`,{});const review=await f.wait(upload.id,'review');await f.unlock();
  const result=await f.api('POST',`/api/backup-jobs/${upload.id}/apply`,{revision:review.revision});assert.equal(result.status,200,JSON.stringify(result.data));
  for(const sha of hashes){const doc=service.store.getDocument(service.db,sha);assert.equal(digest(doc.bytes),sha);}
  assert.equal(service.store.listPool(service.db,f.owner,'licenses').length,5);
});

test('tampered archives fail verification, stale workspace review refuses overwrite and audit failure rolls back',async()=>{
  const f=await fixture();await seed(f);await f.unlock();
  const id=(await f.api('POST','/api/backup-jobs',{kind:'export'})).data.id;await f.wait(id,'ready');const bytes=Buffer.from(await(await f.raw('GET',`/api/backup-jobs/${id}/file`)).arrayBuffer());await f.api('DELETE',`/api/backup-jobs/${id}`);
  const corrupted=Buffer.from(bytes);corrupted[corrupted.length-18]^=1;const bad=await f.upload(corrupted);await f.api('POST',`/api/backup-jobs/${bad.id}/verify`,{});
  for(let i=0;i<1200;i++){const status=(await f.api('GET',`/api/backup-jobs/${bad.id}`)).data.status;if(status==='failed')break;assert.notEqual(status,'review');await new Promise(r=>setTimeout(r,25));}
  assert.equal((await f.api('GET',`/api/backup-jobs/${bad.id}`)).data.status,'failed');
  const job=await f.upload(bytes);await f.api('POST',`/api/backup-jobs/${job.id}/verify`,{});let review=await f.wait(job.id,'review');
  const old=service.store.listRecords(service.db,f.owner)[0];await f.api('PATCH',`/api/records/${old.id}`,{version:old.version,product:'new live edit'});
  assert.equal((await f.api('POST',`/api/backup-jobs/${job.id}/apply`,{revision:review.revision})).status,409);assert.equal(service.store.getRecord(service.db,f.owner,old.id).product,'new live edit');
  review=(await f.api('POST',`/api/backup-jobs/${job.id}/review`,{})).data;
  const license=service.store.listPool(service.db,f.owner,'licenses')[0];
  service.db.prepare('UPDATE licenses SET document_name=? WHERE id=?').run('new attachment name.pdf',license.id);
  assert.equal((await f.api('POST',`/api/backup-jobs/${job.id}/apply`,{revision:review.revision})).status,409,'attachment mutation without version increment invalidates the review');
  review=(await f.api('POST',`/api/backup-jobs/${job.id}/review`,{})).data;
  const before=JSON.stringify(service.snapshot(f.owner));
  service.db.exec("CREATE TRIGGER fail_package_audit BEFORE INSERT ON audit_events WHEN NEW.action='backup.package.restore' BEGIN SELECT RAISE(ABORT,'synthetic package audit failure'); END");
  try{assert.equal((await f.api('POST',`/api/backup-jobs/${job.id}/apply`,{revision:review.revision})).status,500);}finally{service.db.exec('DROP TRIGGER fail_package_audit');}
  assert.equal(JSON.stringify(service.snapshot(f.owner)),before);assert.equal((await f.api('GET',`/api/backup-jobs/${job.id}`)).data.status,'review');
});

test('temporary task quota, expiry, source protection and cross-owner restore conflicts preserve live data',async()=>{
  const f=await fixture(),other=await fixture();await seed(f);
  assert.equal((await f.api('POST','/api/backup-jobs',{kind:'export'})).status,403);
  await f.unlock();
  assert.equal((await f.api('POST','/api/backup-jobs',{kind:'export',source_tag:{unexpected:true}})).status,400);
  const exported=(await f.api('POST','/api/backup-jobs',{kind:'export'})).data;
  const ready=await f.wait(exported.id,'ready');
  const bytes=Buffer.from(await(await f.raw('GET',`/api/backup-jobs/${ready.id}/file`)).arrayBuffer());
  const uploaded=await f.upload(bytes);
  assert.equal((await f.api('POST','/api/backup-jobs',{kind:'export'})).status,409,'two active tasks consume the owner quota');
  const tooLarge=await f.raw('PUT',`/api/backup-jobs/${uploaded.id}/chunk?offset=0`,Buffer.alloc(CHUNK_BYTES+1),{'content-type':'application/octet-stream','x-chunk-sha256':'a'.repeat(64)});assert.equal(tooLarge.status,413);
  const missingSource=await fetch(origin+`/api/backup-jobs/${uploaded.id}/chunk?offset=0`,{method:'PUT',headers:{cookie:f.cookie,'content-type':'application/octet-stream','x-chunk-sha256':digest(bytes.subarray(0,10))},body:bytes.subarray(0,10)});assert.equal(missingSource.status,403);
  await f.api('POST',`/api/backup-jobs/${uploaded.id}/verify`,{});const review=await f.wait(uploaded.id,'review');
  service.db.prepare('DELETE FROM records WHERE owner_id=?').run(f.owner);service.db.prepare('DELETE FROM licenses WHERE owner_id=?').run(f.owner);
  assert.equal((await other.api('POST','/api/import/licenses',{items:[{name:`Package company ${f.n}`}]})).status,200);
  const checked=(await f.api('POST',`/api/backup-jobs/${uploaded.id}/review`,{})).data;
  const before=JSON.stringify(service.snapshot(f.owner));
  const applied=await f.api('POST',`/api/backup-jobs/${uploaded.id}/apply`,{revision:checked.revision});assert.equal(applied.status,409);assert.equal(JSON.stringify(service.snapshot(f.owner)),before);
  service.db.prepare('UPDATE personal_backup_jobs SET expires_at=? WHERE id=?').run(Date.now()-1,exported.id);
  assert.equal((await f.api('GET',`/api/backup-jobs/${exported.id}`)).status,410);
  assert.equal((await f.api('GET','/api/backup-jobs')).data.jobs.some(job=>job.id===exported.id),false);
  assert.equal((await f.api('POST','/api/backup-jobs',{kind:'restore',size:128,source_tag:'0'.repeat(64)})).status,409,'expired but not yet deleted files still consume reserved space');
  await f.api('POST','/api/security/lock',{});assert.equal((await f.api('POST',`/api/backup-jobs/${uploaded.id}/apply`,{revision:review.revision})).status,403);
});


test('deleting temporary tasks cannot bypass the persisted hourly creation limit',async()=>{
  const f=await fixture();await f.unlock();
  for(let i=0;i<20;i++){
    const job=await f.api('POST','/api/backup-jobs',{kind:'restore',size:128,source_tag:'0'.repeat(64)});assert.equal(job.status,200);
    assert.equal((await f.api('DELETE',`/api/backup-jobs/${job.data.id}`)).status,200);
  }
  assert.equal((await f.api('POST','/api/backup-jobs',{kind:'restore',size:128,source_tag:'0'.repeat(64)})).status,429);
});
