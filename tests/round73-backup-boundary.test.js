'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {certificate}=require('./pdf-fixture');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-backup-boundary-'));
Object.assign(process.env,{NODE_ENV:'test',DATA_DIR:root,DB_FILE:path.join(root,'db.sqlite'),DATA_FILE:path.join(root,'absent.json'),REGISTRATION:'open',SESSION_SECURE:'0',LOG_LEVEL:'silent',DEDUP_ADDRESS_MODE:'warn'});
delete process.env.ADS_SECRETS_KEY_FILE;delete process.env.PUBLIC_ORIGIN;delete process.env.PDF_PARSE_CONCURRENCY;
const service=require('../server');
const {MAX_ENVELOPE_BYTES}=require('../lib/personal-backup-policy');
let origin,cookie;
const hashes=[];
async function request(method,route,body){return fetch(origin+route,{method,headers:{'content-type':'application/json','x-workbench':'1',...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function unlock(){assert.equal((await request('POST','/api/security/unlock',{password:'Synthetic-backup-73!'})).status,200);}
// A standards-shaped, one-page PDF with a large unused stream. PDF.js reads the
// catalog/page successfully without rendering millions of filler characters.
function largePdf(index){
  const stream=Buffer.alloc(8*1024*1024,65+index);
  const pieces=[Buffer.from('%PDF-1.7\n')],offsets=[0];
  let length=pieces[0].length;
  function object(id,body){offsets[id]=length;const bytes=Buffer.concat([Buffer.from(`${id} 0 obj\n`),Buffer.isBuffer(body)?body:Buffer.from(body),Buffer.from('\nendobj\n')]);pieces.push(bytes);length+=bytes.length;}
  object(1,'<< /Type /Catalog /Pages 2 0 R >>');
  object(2,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>');
  object(4,'<< /Length 4 >>\nstream\nq Q\nendstream');
  object(5,Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),stream,Buffer.from('\nendstream')]));
  const xref=length;
  pieces.push(Buffer.from('xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(pieces);
}
test.before(async()=>{origin=await service.start({port:0});const r=await request('POST','/api/auth/register',{username:'backup_boundary',password:'Synthetic-backup-73!'});assert.equal(r.status,201);cookie=r.headers.get('set-cookie').split(';')[0];});
test.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});

test('F11-SMALL: successfully exported personal backups restore and preserve original bytes',async()=>{
  const bytes=certificate(['Synthetic small backup','No production information']);
  const imported=await request('POST','/api/import/licenses',{pdf:bytes.toString('base64'),filename:'small.pdf',items:[{name:'Small Boundary Probe',cvr:'SB731001'}]});
  assert.equal(imported.status,200,await imported.text());
  await unlock();
  const out=await request('GET','/api/backup');assert.equal(out.status,200);
  const raw=await out.text();assert.ok(Buffer.byteLength(raw)<MAX_ENVELOPE_BYTES);
  const restored=await request('POST','/api/backup/restore',JSON.parse(raw));
  assert.equal(restored.status,200,await restored.text());
  const sha=crypto.createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(Buffer.from(service.store.getDocument(service.db,sha).bytes),bytes);
});

test('F11-LARGE: five 8MiB PDFs must not produce a successful but unrestorable JSON backup', {timeout:180000},async()=>{
  const before=service.db.prepare('SELECT COUNT(*) n FROM licenses').get().n;
  for(let i=0;i<5;i++){
    const bytes=largePdf(i);
    assert.ok(bytes.length>8*1024*1024 && bytes.length<10*1024*1024);
    hashes.push(crypto.createHash('sha256').update(bytes).digest('hex'));
    const r=await request('POST','/api/import/licenses',{pdf:bytes.toString('base64'),filename:`large-${i}.pdf`,items:[{name:`Large Boundary Probe ${i}`,cvr:`LB73100${i}`}]});
    assert.equal(r.status,200,await r.text());
  }
  await unlock();
  const exported=await request('GET','/api/backup');
  const raw=await exported.text();
  if(exported.status===200){
    const size=Buffer.byteLength(raw);
    assert.ok(size>64*1024*1024,'Baseline must really exceed the restore limit, not test an unrelated failure');
    let restoreStatus;
    try {const restored=await fetch(origin+'/api/backup/restore',{method:'POST',headers:{'content-type':'application/json','x-workbench':'1',cookie},body:raw});restoreStatus=restored.status;await restored.arrayBuffer();}
    catch(error){restoreStatus=error.cause?.code||error.code||'CONNECTION_REJECTED';}
    assert.notEqual(restoreStatus,200,'Baseline restore must actually fail at the size boundary');
    assert.fail(`F11 reproduced: export returned 200 with ${size} bytes, but restore returned ${restoreStatus}`);
  }
  assert.equal(exported.status,409,raw.slice(0,500));
  assert.match(raw,/备份|上限/);
  assert.equal(exported.headers.get('content-disposition'),null,'An error must not masquerade as a downloadable backup');
  assert.ok(!raw.includes('"payload"'));
  assert.equal(service.db.prepare('SELECT COUNT(*) n FROM licenses').get().n,before+5);
  for(const sha of hashes)assert.ok(service.db.prepare('SELECT 1 FROM documents WHERE sha256=?').get(sha),'Rejected export must not lose original files');
});
