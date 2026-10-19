'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-f15-resource-usage-'));
process.env.DATA_DIR=root;
process.env.DB_FILE=path.join(root,'test.sqlite');
process.env.DATA_FILE=path.join(root,'absent.json');
process.env.REGISTRATION='open';
process.env.LOG_LEVEL='silent';

const service=require('../server');
let origin,cookie,ownerId,emailId;

async function api(route){
  const r=await fetch(origin+route,{headers:{'x-workbench':'1',cookie}});
  return {status:r.status,data:await r.json()};
}

test.before(async()=>{
  origin=await service.start({port:0});
  const reg=await fetch(origin+'/api/auth/register',{
    method:'POST',
    headers:{'content-type':'application/json','x-workbench':'1'},
    body:JSON.stringify({username:'f15-resource-user',password:'Secure-Test-1234'}),
  });
  assert.equal(reg.status,201);
  cookie=reg.headers.get('set-cookie').split(';')[0];
  ownerId=service.db.prepare("SELECT id FROM users WHERE username='f15-resource-user'").get().id;

  const imported=await fetch(origin+'/api/import/emails',{
    method:'POST',
    headers:{'content-type':'application/json','x-workbench':'1',cookie},
    body:JSON.stringify({items:[{user:'offpage-linked@example.test',pass:'secret'}]}),
  });
  assert.equal(imported.status,200);
  emailId=service.db.prepare('SELECT id FROM emails WHERE owner_id=? AND user=?').get(ownerId,'offpage-linked@example.test').id;

  const insert=service.db.prepare(`
    INSERT INTO records(owner_id,seq,fingerprint,country,product,domain,name,email_id,email_user,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `);
  // 第 1 条（最老）引用 email。再插入 60 条，使它不出现在 id_desc 的前 50 条当前页。
  for(let i=1;i<=61;i+=1){
    insert.run(
      ownerId,i,`usage${String(i).padStart(3,'0')}`,'PL','分页资源占用',
      `usage${i}.example`,`记录${i}`,i===1?emailId:null,i===1?'offpage-linked@example.test':'',
      '正常',`2026-03-${String((i%28)+1).padStart(2,'0')} 00:00:00`
    );
  }
});

test.after(async()=>{
  await service.close();
  fs.rmSync(root,{recursive:true,force:true});
});

test('F15/F16: resources stay marked linked even when the owning record is outside the current page',async()=>{
  const page=await api('/api/records?limit=50&offset=0&sort=id_desc');
  assert.equal(page.status,200);
  assert.equal(page.data.total,61);
  assert.equal(page.data.items.length,50);
  assert.equal(page.data.items.some(r=>r.email_id===emailId),false,
    '前提：引用该资源的记录必须不在当前页，否则无法证明跨页占用');

  const summary=await api('/api/bootstrap?summary=1');
  assert.equal(summary.status,200);
  const email=summary.data.pools.emails.find(x=>x.id===emailId);
  assert.ok(email);
  assert.equal(Number(email.linked_record_count),1,
    '资源占用状态必须由服务端扫描本账号全部记录，而不是当前记录页');

  const indexes=service.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='records'").all().map(x=>x.name);
  assert.ok(indexes.includes('idx_records_owner_email'));
  assert.ok(indexes.includes('idx_records_owner_proxy'));
  assert.ok(indexes.includes('idx_records_owner_card'));
  assert.ok(indexes.includes('idx_records_owner_license'));
});


test('F15: PATCH reassigning a resource updates the foreign key, snapshots and usage count atomically',async()=>{
  const imported=await fetch(origin+'/api/import/emails',{
    method:'POST',
    headers:{'content-type':'application/json','x-workbench':'1',cookie},
    body:JSON.stringify({items:[{user:'newly-assigned@example.test',pass:'synthetic-secret'}]}),
  });
  assert.equal(imported.status,200);
  const before=await api('/api/bootstrap?summary=1');
  const email=before.data.pools.emails.find(x=>x.user==='newly-assigned@example.test');
  assert.ok(email);

  const page=await api('/api/records?limit=1&offset=0');
  const record=page.data.items[0];
  assert.equal(record.email_id,null,'fixture starts without an email association');

  const patch=await fetch(origin+`/api/records/${record.id}`,{
    method:'PATCH',
    headers:{'content-type':'application/json','x-workbench':'1',cookie},
    body:JSON.stringify({email_id:email.id,version:record.version}),
  });
  assert.equal(patch.status,200);
  const stored=service.db.prepare('SELECT email_id,email_user,version FROM records WHERE owner_id=? AND id=?').get(ownerId,record.id);
  assert.equal(stored.email_id,email.id,'real records foreign key must be persisted, not just the snapshot');
  assert.equal(stored.email_user,'newly-assigned@example.test');
  assert.equal(stored.version,record.version+1);

  const linked=await api('/api/bootstrap?summary=1');
  const occupied=linked.data.pools.emails.find(x=>x.id===email.id);
  assert.equal(occupied.status,'已使用');
  assert.equal(occupied.linked_record_count,1);

  const unassign=await fetch(origin+`/api/records/${record.id}`,{
    method:'PATCH',
    headers:{'content-type':'application/json','x-workbench':'1',cookie},
    body:JSON.stringify({email_id:null,version:stored.version}),
  });
  assert.equal(unassign.status,200);
  const cleared=service.db.prepare('SELECT email_id,email_user,version FROM records WHERE owner_id=? AND id=?').get(ownerId,record.id);
  assert.equal(cleared.email_id,null,'explicit unassignment must persist NULL');
  assert.equal(cleared.email_user,'');
  assert.equal(cleared.version,stored.version+1);

  const released=await api('/api/bootstrap?summary=1');
  const free=released.data.pools.emails.find(x=>x.id===email.id);
  assert.equal(free.status,'未使用');
  assert.equal(free.linked_record_count,0);
});
