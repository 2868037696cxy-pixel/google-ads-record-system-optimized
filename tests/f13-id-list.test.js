'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-f13-ids-'));
process.env.DATA_DIR=root;
process.env.DB_FILE=path.join(root,'test.sqlite');
process.env.DATA_FILE=path.join(root,'absent.json');
process.env.REGISTRATION='open';
process.env.LOG_LEVEL='silent';

const service=require('../server');
let origin,cookie;
const password='F13-Secure-Test-1234';

async function api(method,route,body){
  const r=await fetch(origin+route,{
    method,
    headers:{...(body===undefined?{}:{'content-type':'application/json'}),'x-workbench':'1',cookie},
    body:body===undefined?undefined:JSON.stringify(body),
  });
  const text=await r.text();
  let data=null;
  try{data=JSON.parse(text);}catch{}
  return {status:r.status,data,text};
}

test.before(async()=>{
  origin=await service.start({port:0});
  const reg=await fetch(origin+'/api/auth/register',{
    method:'POST',
    headers:{'content-type':'application/json','x-workbench':'1'},
    body:JSON.stringify({username:'f13-ids',password}),
  });
  assert.equal(reg.status,201);
  cookie=reg.headers.get('set-cookie').split(';')[0];

  const made=await api('POST','/api/records',{
    domains:['f13-a.example','f13-b.example'],
    proxy_mode:'none',
    email_ids:[],card_ids:[],license_ids:[],
  });
  assert.equal(made.status,200);
  assert.equal(made.data.created.length,2);
});

test.after(async()=>{
  await service.close();
  fs.rmSync(root,{recursive:true,force:true});
});

async function records(){
  return (await api('GET','/api/records?limit=50&offset=0')).data.items;
}

test('F13: malformed export ids never widen to all records or silently narrow to a subset',async()=>{
  const rows=await records();
  assert.equal(rows.length,2);
  const first=rows[0].id;

  for(const ids of [['not-a-number'],[first,'bad'],[0],[1.5],[true],[{}],['1']]){
    const csv=await api('POST','/api/export/csv',{ids});
    assert.equal(csv.status,400,`CSV ids=${JSON.stringify(ids)} must be rejected`);
    assert.ok(!csv.data?.text,'rejected export must not return any CSV body');
  }

  const all=await api('POST','/api/export/csv',{ids:[]});
  assert.equal(all.status,200,'explicit empty selection keeps the existing UI contract: export all');
  assert.equal(all.data.count,2);

  const one=await api('POST','/api/export/csv',{ids:[first]});
  assert.equal(one.status,200);
  assert.equal(one.data.count,1);

  assert.equal((await api('POST','/api/security/unlock',{password})).status,200);
  const secretBad=await api('POST','/api/export/adspower',{ids:[first,'bad']});
  assert.equal(secretBad.status,400,'credential export must reject a mixed valid/invalid id list');
  assert.ok(!secretBad.data?.text);
});

test('F13: malformed batch-delete ids reject the whole request without partial deletion',async()=>{
  const before=await records();
  assert.equal(before.length,2);
  const first=before[0].id;

  const bad=await api('POST','/api/records/batch-delete',{ids:[first,'bad']});
  assert.equal(bad.status,400);

  const after=await records();
  assert.deepEqual(after.map(r=>r.id).sort((a,b)=>a-b),before.map(r=>r.id).sort((a,b)=>a-b),
    'valid ids in a malformed batch must not be deleted');

  const invalidPath=await api('DELETE','/api/records/not-a-number');
  assert.equal(invalidPath.status,400);
  assert.equal((await records()).length,2);
});

test('F13: valid duplicate ids are deduplicated safely rather than deleting twice',async()=>{
  const before=await records();
  const id=before[0].id;
  const deleted=await api('POST','/api/records/batch-delete',{ids:[id,id]});
  assert.equal(deleted.status,200);
  assert.equal(deleted.data.deleted,1);
  assert.equal((await records()).length,1);
});
