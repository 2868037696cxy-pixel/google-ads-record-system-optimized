'use strict';
// 非对象请求体不得变成 5xx，也不得静默写入「空记录」（方案工作包 07「不吞错误」）。
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-input-'));
process.env.DATA_DIR=root;process.env.DB_FILE=path.join(root,'test.sqlite');process.env.DATA_FILE=path.join(root,'absent.json');process.env.REGISTRATION='open';process.env.LOG_LEVEL='silent';
const service=require('../server');let origin,cookie;
test.before(async()=>{origin=await service.start({port:0});const r=await fetch(origin+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json','x-workbench':'1'},body:JSON.stringify({username:'input',password:'Input-Test-1234'})});assert.equal(r.status,201);cookie=r.headers.get('set-cookie').split(';')[0];});
test.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
const post=async(route,raw)=>{const r=await fetch(origin+route,{method:'POST',headers:{'content-type':'application/json','x-workbench':'1',cookie},body:raw});return r.status;};
const boot=async()=>(await (await fetch(origin+'/api/bootstrap',{headers:{cookie}})).json());

const ROUTES=['/api/records','/api/import/emails','/api/import/licenses','/api/import/cards','/api/import/auto','/api/parse/auto'];
const BODIES=['null','"a string"','123','[1,2]','true','{}'];

test('畸形请求体一律给 4xx，不得 5xx，也不得静默写入数据',async()=>{
  const before=await boot();
  for(const route of ROUTES){
    for(const raw of BODIES){
      const status=await post(route,raw);
      assert.ok(status<500,`${route} 收到 ${raw} 返回 ${status}，应给 4xx（5xx 会把「你给的数据有问题」误报成「服务器坏了」）`);
    }
  }
  const after=await boot();
  assert.equal(after.records.length,before.records.length,'畸形请求体不得悄悄写入记录');
  assert.equal(after.pools.emails.length,before.pools.emails.length,'畸形请求体不得悄悄写入邮箱');
  assert.equal(after.pools.licenses.length,before.pools.licenses.length,'畸形请求体不得悄悄写入营业执照');
});

test('数组体不得被当成单条记录写入空壳',async()=>{
  // 数组是合法 JSON，最容易被 readBody 之后直接取字段而写出一条全空记录
  for(const raw of ['[]','[{}]','[{"name":"x"}]']){
    assert.ok((await post('/api/records',raw))<500,`/api/records 收到 ${raw} 不应 5xx`);
  }
  const after=await boot();
  assert.ok(after.records.every((r)=>String(r.fingerprint||'').length>0),'不应存在没有指纹的空壳记录');
});
