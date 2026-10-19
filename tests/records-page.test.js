'use strict';
// 记录列表的服务端分页（方案工作包 07「查询优化」）：分页、排序、筛选与账号隔离。
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-records-page-'));
process.env.DATA_DIR=root;process.env.DB_FILE=path.join(root,'test.sqlite');process.env.DATA_FILE=path.join(root,'absent.json');process.env.REGISTRATION='open';process.env.LOG_LEVEL='silent';
const service=require('../server');
let origin,cookie;
const register=async(username)=>{const r=await fetch(origin+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json','x-workbench':'1'},body:JSON.stringify({username,password:'Page-Test-1234'})});assert.equal(r.status,201);return r.headers.get('set-cookie').split(';')[0];};
test.before(async()=>{
  origin=await service.start({port:0});
  cookie=await register('pager');
  // 直接落库 12 条记录：分页要验证的只是查询层，不必走完整的创建流程。
  const ownerId=service.db.prepare("SELECT id FROM users WHERE username='pager'").get().id;
  const insert=service.db.prepare(`INSERT INTO records(owner_id,seq,fingerprint,country,product,domain,name,status,created_at)
                                   VALUES(?,?,?,?,?,?,?,?,?)`);
  for(let i=1;i<=12;i+=1){
    insert.run(ownerId,i,`pg${String(i).padStart(3,'0')}`,i%2?'丹麦':'巴西',`产品${i}`,`d${i}.shop`,`记录${i}`,i%3===0?'停用':'正常',`2026-01-${String(i).padStart(2,'0')} 00:00:00`);
  }
});
test.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
const get=async(query,session=cookie)=>{const r=await fetch(origin+'/api/records'+query,{headers:{'x-workbench':'1',cookie:session}});return {status:r.status,data:await r.json()};};

test('分页：只取当前页并给出总数，页与页之间不重叠',async()=>{
  const first=await get('?limit=5&offset=0');
  assert.equal(first.status,200);
  assert.equal(first.data.total,12,'总数应来自 COUNT 查询，而不是把全部记录读回来算长度');
  assert.equal(first.data.items.length,5);
  assert.equal(first.data.limit,5);
  const second=await get('?limit=5&offset=5');
  assert.equal(second.data.items.length,5);
  const ids=new Set(first.data.items.map(r=>r.id));
  assert.ok(second.data.items.every(r=>!ids.has(r.id)),'第二页不应与第一页重复');
  const tail=await get('?limit=5&offset=10');
  assert.equal(tail.data.items.length,2);
  assert.equal(tail.data.total,12);
});

test('排序：支持按 id 与创建时间双向，非法值回落到默认而不报错',async()=>{
  const desc=(await get('?limit=4&sort=id_desc')).data.items.map(r=>r.id);
  const asc=(await get('?limit=4&sort=id_asc')).data.items.map(r=>r.id);
  assert.deepEqual(desc,[...desc].sort((a,b)=>b-a));
  assert.deepEqual(asc,[...asc].sort((a,b)=>a-b));
  assert.notDeepEqual(desc,asc);
  const created=(await get('?limit=4&sort=created_desc')).data.items.map(r=>r.created_at);
  assert.deepEqual(created,[...created].sort().reverse());
  const bogus=await get('?sort='+encodeURIComponent('id DESC; DROP TABLE records'));
  assert.equal(bogus.status,200);
  assert.equal(bogus.data.sort,'id_desc','非白名单排序值必须回落到默认');
  assert.equal((await get('?limit=200')).data.total,12,'排序注入不应影响数据');
});

test('筛选：按状态与关键字，并且两者可叠加',async()=>{
  const disabled=await get('?status='+encodeURIComponent('停用')+'&limit=200');
  assert.equal(disabled.data.total,4);
  assert.ok(disabled.data.items.every(r=>r.status==='停用'));
  const keyword=await get('?q='+encodeURIComponent('记录1')+'&limit=200');
  assert.equal(keyword.data.total,4,'记录1/10/11/12 共 4 条');
  assert.ok(keyword.data.items.every(r=>String(r.name).includes('记录1')));
  const both=await get('?status='+encodeURIComponent('停用')+'&q=d3.shop');
  assert.equal(both.data.total,1,'状态与关键字应同时生效');
  assert.equal(both.data.items[0].domain,'d3.shop');
});

test('隔离：分页只能看到自己的记录，未登录一律 401',async()=>{
  assert.equal((await get('?limit=200')).data.total,12);
  const other=await register('other-pager');
  assert.equal((await get('?limit=200',other)).data.total,0,'新账号不应看到别人的记录');
  assert.equal((await fetch(origin+'/api/records')).status,401);
});
