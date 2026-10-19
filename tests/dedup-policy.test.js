'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-dedup-policy-'));
process.env.DATA_DIR=root;process.env.DB_FILE=path.join(root,'test.sqlite');process.env.DATA_FILE=path.join(root,'absent.json');process.env.REGISTRATION='open';process.env.LOG_LEVEL='silent';process.env.DEDUP_ADDRESS_MODE='warn';
const service=require('../server'),dedup=require('../lib/dedup');let origin,cookie;
test.before(async()=>{origin=await service.start({port:0});const r=await fetch(origin+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json','x-workbench':'1'},body:JSON.stringify({username:'policy-user',password:'Policy-Test-1234'})});assert.equal(r.status,201);cookie=r.headers.get('set-cookie').split(';')[0];});
test.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
async function request(method,route,body){const r=await fetch(origin+route,{method,headers:{'content-type':'application/json','x-workbench':'1',cookie},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
test('two distinct companies at the same address never overwrite one another',async()=>{
  const first={name:'Amber Tools ApS',legal_name:'Amber Tools ApS',cvr:'12121212',address:'Shared Street 100'};
  const second={name:'Blue Films ApS',legal_name:'Blue Films ApS',cvr:'34343434',address:'Shared Street 100'};
  assert.equal((await request('POST','/api/import/licenses',{items:[first]})).status,200);
  const result=await request('POST','/api/import/licenses',{items:[second]});assert.equal(result.status,200);assert.equal(result.data.added,1);assert.equal(result.data.updated,0);
  const boot=await request('GET','/api/bootstrap');assert.equal(boot.data.pools.licenses.length,2);assert.ok(boot.data.pools.licenses.some(l=>l.name===first.name));
  const row=service.db.prepare('SELECT * FROM licenses WHERE cvr=?').get(first.cvr);
  assert.equal(dedup.rowMatchesKeys(row,dedup.licenseKeys(second)),false);
});
test('address-only matches block only in explicit reject mode; internal audit still flags them',()=>{
  const keys=dedup.licenseKeys({name:'Cedar Studio ApS',cvr:'56565656',address:'Shared Street 100'});
  assert.equal(dedup.findLicenseConflict(service.db,keys,{addressMode:'warn'}),null);
  assert.equal(dedup.findLicenseConflict(service.db,keys,{addressMode:'reject'}).field,'address');
  assert.ok(dedup.auditLicenses(service.db,{addressMode:'warn'}).groups.some(g=>g.field==='address'));
});
test('strong business identity still rejects duplicates irrespective of address policy',()=>{
  const keys=dedup.licenseKeys({name:'Alternate Name',cvr:'12121212',address:'Different Street 9'});
  assert.equal(dedup.findLicenseConflict(service.db,keys,{addressMode:'off'}).field,'cvr');
});
test('编号内部的字母是身份的一部分，不得因丢弃非数字字符把不同企业折成同一家',async()=>{
  // 方案工作包 03 点名的缺陷：旧实现 replace(/\D+/g,'') 会把 AB123456 与 CD123456 都
  // 折成 123456，两家不同公司被判成同一家 —— uq_licenses_dup_cvr 是全局唯一索引，
  // 第二家直接录不进来，或在编辑路径上被误当作同一企业而合并归属。
  assert.notEqual(dedup.normalizeRegistrationNumber('AB123456'),dedup.normalizeRegistrationNumber('CD123456'));
  assert.equal(dedup.normalizeRegistrationNumber('AB123456'),'AB123456');
  assert.equal(dedup.normalizeRegistrationNumber('CD123456'),'CD123456');
  // 反过来，开头的国家/地区前缀只是地区标记，不是企业身份：
  // DK-11111111 与 11111111 是同一家公司的同一个 CVR，必须判为同一键。
  assert.equal(dedup.normalizeRegistrationNumber('DK-11111111'),'11111111');
  assert.equal(dedup.normalizeRegistrationNumber('dk 11 11 11 11'),'11111111');
  // 前导零属于编号本身，必须保留
  assert.equal(dedup.normalizeRegistrationNumber('00123456'),'00123456');
  // 规范长度不足 6 位仍视为无效编号
  assert.equal(dedup.normalizeRegistrationNumber('D-1234'),null);
  // 端到端：两家字母编号不同的公司都应能录入。旧实现下二者都被折成 123456，
  // 第二家会被 uq_licenses_dup_cvr 拦成 409。
  assert.equal((await request('POST','/api/import/licenses',{items:[{name:'Alpha Letter ApS',cvr:'XY123456'}]})).status,200);
  assert.equal((await request('POST','/api/import/licenses',{items:[{name:'Bravo Letter ApS',cvr:'ZW123456'}]})).status,200);
  const both=await request('GET','/api/bootstrap');
  assert.ok(both.data.pools.licenses.some(l=>l.cvr==='XY123456')&&both.data.pools.licenses.some(l=>l.cvr==='ZW123456'));
});
test('历史行的 dup_cvr 会从旧口径迁移到新口径，不会因键不一致而漏检真重复',()=>{
  // 改规范化口径必须配套迁移：老行的 dup_cvr 是纯数字键（AB123456 记成 123456），
  // 不迁移就会与新键不再相等 —— 真正重复的两行不受 uq_licenses_dup_cvr 约束，
  // 反而漏检。这里直接模拟一行旧数据并验证迁移结果。
  const dbm=require('../lib/db'),db=service.db;
  const owner=db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  db.prepare(`INSERT INTO licenses (owner_id,status,created_at,name,legal_name,address,cvr,dup_cvr)
              VALUES (?,'未使用','2026-01-01 00:00:00','Legacy Letter ApS','Legacy Letter ApS','Legacy Road 9','AB123456','123456')`).run(owner);
  assert.ok(dbm.migrateRegistrationKeys(db)>=1,'应当改写了旧口径的键');
  assert.equal(db.prepare("SELECT dup_cvr FROM licenses WHERE cvr='AB123456'").get().dup_cvr,'AB123456');
  // 幂等：再跑一次不应再改动
  assert.equal(dbm.migrateRegistrationKeys(db),0);
});
