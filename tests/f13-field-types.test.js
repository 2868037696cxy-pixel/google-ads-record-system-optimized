'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-f13-types-'));
process.env.DATA_DIR=root;
process.env.DB_FILE=path.join(root,'test.sqlite');
process.env.DATA_FILE=path.join(root,'absent.json');
process.env.REGISTRATION='open';
process.env.LOG_LEVEL='silent';

const service=require('../server');
let origin,cookie;

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
    body:JSON.stringify({username:'f13-types',password:'Secure-Test-1234'}),
  });
  assert.equal(reg.status,201);
  cookie=reg.headers.get('set-cookie').split(';')[0];
});

test.after(async()=>{
  await service.close();
  fs.rmSync(root,{recursive:true,force:true});
});

async function total(){
  return (await api('GET','/api/records?limit=50&offset=0')).data.total;
}

test('F13: record creation rejects ambiguous text/container types without writing junk rows',async()=>{
  const before=await total();
  const badBodies=[
    {domains:{bad:true}},
    {domains:[{bad:true}]},
    {domains:['valid.example'],country:{bad:true}},
    {domains:['valid.example'],product:['bad']},
    {domains:['valid.example'],ip_reg_time:false},
    {domains:['valid.example'],id_card:123},
    {domains:['valid.example'],proxy_mode:'mystery'},
  ];
  for(const body of badBodies){
    const r=await api('POST','/api/records',body);
    assert.equal(r.status,400,`body=${JSON.stringify(body)} should fail`);
  }
  assert.equal(await total(),before,'invalid create requests must not write records');

  const good=await api('POST','/api/records',{domains:['good-f13.example'],country:'PL',product:'正常文本',proxy_mode:'none'});
  assert.equal(good.status,200);
  assert.equal(await total(),before+1);
});

test('F13: record patch rejects invalid text types and invalid status without silent normalization',async()=>{
  const page=(await api('GET','/api/records?limit=50&offset=0')).data;
  const row=page.items.find(x=>x.domain==='good-f13.example');
  assert.ok(row);

  for(const patch of [
    {country:{bad:true},version:row.version},
    {product:['bad'],version:row.version},
    {status:'完全不存在的状态',version:row.version},
  ]){
    const r=await api('PATCH',`/api/records/${row.id}`,patch);
    assert.equal(r.status,400,`patch=${JSON.stringify(patch)} should fail`);
  }

  const after=(await api('GET','/api/records?limit=50&offset=0')).data.items.find(x=>x.id===row.id);
  assert.equal(after.country,'PL');
  assert.equal(after.product,'正常文本');
  assert.equal(after.status,'正常','invalid status must not silently become/overwrite 正常');
  assert.equal(after.version,row.version,'failed patches must not bump version');
});

test('F13: parser endpoints reject object/array text instead of coercing it',async()=>{
  assert.equal((await api('POST','/api/parse/emails',{text:{x:1}})).status,400);
  assert.equal((await api('POST','/api/parse/proxies',{text:['x']})).status,400);
  assert.equal((await api('POST','/api/parse/auto',{text:{x:1}})).status,400);

  const ok=await api('POST','/api/parse/emails',{text:'hello@example.test——pw——ABC'});
  assert.equal(ok.status,200);
  assert.ok(Array.isArray(ok.data.items));
});

test('F13: structured auto-import preserves raw types so normalizeImport can reject them atomically',async()=>{
  const before=(await api('GET','/api/bootstrap?summary=1')).data.pools.emails.length;
  const bad=await api('POST','/api/import/auto',{
    emails:[{user:{not:'text'},pass:'pw'}],
    proxies:[],
  });
  assert.equal(bad.status,400);
  const after=(await api('GET','/api/bootstrap?summary=1')).data.pools.emails.length;
  assert.equal(after,before,'invalid structured auto-import must not stringify object fields or partially write');
});
