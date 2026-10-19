'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-security-'));
process.env.DATA_DIR=root;process.env.DB_FILE=path.join(root,'test.sqlite');process.env.DATA_FILE=path.join(root,'absent.json');process.env.REGISTRATION='open';process.env.LOG_LEVEL='silent';
const service=require('../server');const {getVault}=require('../lib/vault');const {certificate}=require('./pdf-fixture');
let url;const cookie={};
test.before(async()=>{url=await service.start({port:0});for(const who of ['alice','bob','carol']){const r=await fetch(url+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json','x-workbench':'1'},body:JSON.stringify({username:who,password:'Secure-Test-1234'})});cookie[who]=r.headers.get('set-cookie').split(';')[0];assert.equal(r.status,201);}});
test.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
async function api(who,method,route,body,headers={}) {const r=await fetch(url+route,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),'x-workbench':'1',cookie:cookie[who],...headers},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:r.status,value,text};}
const unlock=who=>api(who,'POST','/api/security/unlock',{password:'Secure-Test-1234'});
let email,pdfLicense;
test('vault encrypts imported credentials, default bootstrap never returns plaintext',async()=>{
  const imported=await api('alice','POST','/api/import/emails',{items:[{user:'secure@example.test',pass:'SENSITIVE_MARKER_PASSWORD',fakey:'SENSITIVE_MARKER_2FA'}]});assert.equal(imported.status,200);
  const boot=await api('alice','GET','/api/bootstrap');email=boot.value.pools.emails[0];
  assert.equal(email.pass,'[protected]');assert.equal(email.fakey,'[protected]');assert.ok(!boot.text.includes('SENSITIVE_MARKER'));
  const row=service.db.prepare('SELECT pass,fakey FROM emails WHERE id=?').get(email.id);assert.ok(row.pass.startsWith('wbenc1:'));assert.ok(!row.pass.includes('SENSITIVE_MARKER'));
});
test('secrets require current password, authorization expires and is session-scoped',async()=>{
  assert.equal((await api('alice','GET','/api/bootstrap?reveal=1')).status,403);
  assert.equal((await api('alice','POST','/api/security/unlock',{password:'wrong'})).status,403);
  assert.equal((await unlock('alice')).status,200);
  assert.equal((await api('alice','GET','/api/bootstrap?reveal=1')).value.pools.emails[0].pass,'SENSITIVE_MARKER_PASSWORD');
  assert.equal((await api('bob','GET','/api/bootstrap?reveal=1')).status,403);
  await api('alice','POST','/api/security/lock');assert.equal((await api('alice','GET','/api/bootstrap?reveal=1')).status,403);
  await unlock('alice');service.db.prepare('UPDATE sessions SET secrets_until=0').run();assert.equal((await api('alice','GET','/api/bootstrap?reveal=1')).status,403);
});
test('payment endpoints reject CVV and full PAN but accept references and last four digits',async()=>{
  assert.equal((await api('alice','POST','/api/import/cards',{items:[{number:'finance-a',cvv:'123'}]})).status,400);
  assert.equal((await api('alice','POST','/api/import/cards',{items:[{number:'4111111111111111'}]})).status,400);
  assert.equal((await api('alice','POST','/api/parse/cards',{text:'4111111111111111 12/28 123'})).status,400);
  const ok=await api('alice','POST','/api/import/cards',{items:[{number:'finance-a',last4:'1111',expiry:'12/28'}]});assert.equal(ok.status,200);
  const cards=(await api('alice','GET','/api/bootstrap')).value.pools.cards;assert.equal(cards[0].last4,'1111');assert.ok(!('cvv' in cards[0]));
  assert.throws(()=>service.db.prepare("UPDATE cards SET cvv='456'").run(),/prohibited/);
});
test('same PDF concurrent uploads produce one winner and preserve encrypted original bytes',async()=>{
  const bytes=certificate(['TEST CERTIFICATE','Original document']);
  const result=await Promise.all(['alice','bob','carol'].map((who,i)=>api(who,'POST','/api/import/licenses',{pdf:bytes.toString('base64'),filename:'same.pdf',items:[{name:'Concurrent Company '+i,cvr:String(81111000+i)}]})));
  assert.deepEqual(result.map(r=>r.status).sort(),[200,409,409]);
  const winner=result.findIndex(r=>r.status===200);pdfLicense=result[winner].value.license_id;
  const owner=['alice','bob','carol'][winner];
  const doc=service.db.prepare('SELECT bytes,sha256 FROM documents').get();assert.equal(Buffer.from(doc.bytes).subarray(0,5).toString(),'WBPD1');
  const restored=service.store.getDocument(service.db,doc.sha256);assert.deepEqual(Buffer.from(restored.bytes),bytes);
  assert.equal((await api(owner,'GET',`/api/licenses/${pdfLicense}/pdf`)).status,200);
  for(const other of ['alice','bob','carol'].filter(w=>w!==owner))assert.equal((await api(other,'GET',`/api/licenses/${pdfLicense}/pdf`)).status,404);
  await api(owner,'DELETE',`/api/pool/licenses/${pdfLicense}`);
  assert.equal((await api('carol','POST','/api/import/licenses',{pdf:bytes.toString('base64'),items:[{name:'Rename To Evade'}]})).status,409,'Deleting records must not release global fingerprint');
});
test('同一幂等键换内容必须冲突，而不是重放旧结果或重复创建',async()=>{
  // 方案 WP07 验收标准「重复点击都有确定结果」。既有用例只覆盖了同键同内容的重放，
  // 而「按键复用但表单已改」是重复点击里最危险的一种：既不能重放旧结果，
  // 也不能把新内容当新请求落库。
  //
  // 本用例自带账号与资源，不借 alice 做实验：备份用例会对 alice 的记录做精确断言，
  // 幂等用例会消耗 alice 的资源池。实测中这两条先后被我撞坏过 —— 只加断言、
  // 共用夹具就会产生这种顺序耦合。
  const who='idem';
  const reg=await fetch(url+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json','x-workbench':'1'},body:JSON.stringify({username:who,password:'Secure-Test-1234'})});
  assert.equal(reg.status,201);
  cookie[who]=reg.headers.get('set-cookie').split(';')[0];
  await api(who,'POST','/api/import/emails',{items:[{user:'idem@example.test',pass:'Idem-Pass-1234'}]});
  await api(who,'POST','/api/import/cards',{items:[{number:'idem-card',last4:'4242',expiry:'12/29'}]});
  const headers={'idempotency-key':'request-abcdefghijklmnop'};
  const body={domains:['idem-one.shop'],proxy_mode:'none'};
  const first=await api(who,'POST','/api/records',body,headers);
  assert.equal(first.status,200);
  const replay=await api(who,'POST','/api/records',body,headers);
  assert.equal(replay.status,200);
  assert.equal(replay.value.replayed,true);
  assert.equal(replay.value.created[0].id,first.value.created[0].id);
  const changed=await api(who,'POST','/api/records',{...body,domains:['idem-two.shop']},headers);
  assert.equal(changed.status,409);
  const list=await api(who,'GET','/api/records?limit=200');
  const domains=list.value.items.map((r)=>r.domain);
  assert.equal(domains.filter((d)=>d==='idem-one.shop').length,1,'同键重放不得重复创建');
  assert.equal(domains.filter((d)=>d==='idem-two.shop').length,0,'换内容后必须拒绝，不得落库');
});

test('API idempotency prevents network retries creating extra records',async()=>{
  const body={domains:['secure-operation.example'],proxy_mode:'none'};
  const headers={'idempotency-key':'request-1234567890123456'};
  const first=await api('alice','POST','/api/records',body,headers);assert.equal(first.status,200);
  const second=await api('alice','POST','/api/records',body,headers);assert.equal(second.status,200);assert.equal(second.value.replayed,true);assert.equal(first.value.created[0].id,second.value.created[0].id);
  assert.equal((await api('alice','POST','/api/records',{...body,domains:['changed.example']},headers)).status,409);
  assert.ok(!first.text.includes('SENSITIVE_MARKER'));
  const row=service.db.prepare('SELECT email_pass FROM records WHERE id=?').get(first.value.created[0].id);assert.ok(row.email_pass.startsWith('wbenc1:'));
});
test('credential export requires explicit reauthentication while CSV stays redacted',async()=>{
  const denied=await api('alice','POST','/api/export/adspower',{});assert.equal(denied.status,403);
  const csv=await api('alice','POST','/api/export/csv',{});assert.equal(csv.status,200);assert.ok(!csv.text.includes('SENSITIVE_MARKER'));assert.ok(!csv.value.text.includes('CVV'));
  await unlock('alice');const allowed=await api('alice','POST','/api/export/adspower',{});assert.equal(allowed.status,200);assert.ok(allowed.value.text.includes('SENSITIVE_MARKER_PASSWORD'));
  const audit=await api('alice','GET','/api/audit');assert.ok(audit.value.events.some(e=>e.action==='export.credentials'));assert.ok(!audit.text.includes('SENSITIVE_MARKER'));
  assert.deepEqual((await api('carol','GET','/api/audit')).value.events,[]);
});
test('encrypted backups authenticate owner, key and contents and restore exact associations',async()=>{
  await unlock('alice');const backup=await api('alice','GET','/api/backup');assert.equal(backup.status,200);assert.equal(backup.value.version,2);assert.ok(!backup.text.includes('secure@example.test'));
  const before=(await api('alice','GET','/api/bootstrap')).value;
  const bad={...backup.value,payload:backup.value.payload.slice(0,-5)+'ABCD='};
  assert.equal((await api('alice','POST','/api/backup/restore',bad)).status,400);
  await unlock('bob');assert.equal((await api('bob','POST','/api/backup/restore',backup.value)).status,400);
  assert.equal((await api('alice','POST','/api/backup/restore',backup.value)).status,200);
  const after=(await api('alice','GET','/api/bootstrap')).value;assert.equal(after.records.length,before.records.length);assert.equal(after.records[0].email_id,after.pools.emails[0].id);
  const decoded=service.store.getRecord(service.db,after.user.id,after.records[0].id);assert.equal(decoded.email_pass,'SENSITIVE_MARKER_PASSWORD');
});
test('other accounts cannot change, export or read owner data',async()=>{
  const a=(await api('alice','GET','/api/bootstrap')).value,record=a.records[0];
  assert.equal((await api('carol','PATCH',`/api/records/${record.id}`,{country:'tampered'})).status,400);
  assert.equal((await api('carol','POST','/api/export/csv',{ids:[record.id]})).status,400);
  assert.equal((await api('carol','GET','/api/licenses/duplicates')).status,403);
  assert.equal((await api('carol','GET','/api/bootstrap')).value.records.length,0);
});
test('stale version update returns conflict without overwriting newer changes',async()=>{
  const a=(await api('alice','GET','/api/bootstrap')).value,record=a.records[0];
  assert.equal((await api('alice','PATCH',`/api/records/${record.id}`,{country:'fresh',version:record.version})).status,200);
  assert.equal((await api('alice','PATCH',`/api/records/${record.id}`,{country:'stale',version:record.version})).status,409);
  assert.equal((await api('alice','GET','/api/bootstrap')).value.records[0].country,'fresh');
});
test('static server never serves source, encryption keys or encoded API paths',async()=>{
  for(const route of ['/server.js','/.secrets.key','/lib/db.js','/api%2fbootstrap','/..%2fserver.js']) {
    const res=await fetch(url+route);assert.ok([400,401,404].includes(res.status),route+' '+res.status);
  }
});
test('vault fails closed on ciphertext context mismatch and wrong key',()=>{
  const v=getVault(service.db),cipher=v.seal('SECRET','owner:a');assert.throws(()=>v.open(cipher,'owner:b'),/authentication/);
  const other=require('node:sqlite').DatabaseSync;const tmp=new other(':memory:');tmp.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');tmp.prepare("INSERT INTO meta VALUES('vault_key_id',?)").run('wrong');assert.throws(()=>require('../lib/vault').openVault(tmp,':memory:'),/Wrong/);tmp.close();
});
test('changing password invalidates existing sessions immediately',async()=>{
  const changed=await api('carol','POST','/api/account/password',{current_password:'Secure-Test-1234',new_password:'New-Secure-Test-123'});assert.equal(changed.status,200);assert.equal((await api('carol','GET','/api/bootstrap')).status,401);
});
// 原始 socket：只有这样才能构造绝对形式请求行。fetch 发不出绝对形式，且 URL 解析会
// 改写百分号编码，所以下面这两类绕过用 fetch 写的用例天生测不到。
function rawGet(requestLine){return new Promise((resolve,reject)=>{const net=require('node:net');const port=new URL(url).port;const s=net.connect(Number(port),'127.0.0.1');let buf='';s.setTimeout(8000);s.on('connect',()=>s.write(requestLine+'\r\nHost: 127.0.0.1:'+port+'\r\nConnection: close\r\n\r\n'));s.on('data',d=>{buf+=d.toString('utf8');});s.on('end',()=>resolve(buf.split('\r\n')[0]||''));s.on('timeout',()=>{s.destroy();reject(new Error('原始请求超时'));});s.on('error',reject);});}
test('鉴权判断不得与被路由的路径分歧：编码路径与绝对形式都不得跳过整个钩子',async()=>{
  const port=new URL(url).port;
  assert.match(await rawGet('GET /api/bootstrap HTTP/1.1'),/401/,'基线：未登录访问受保护接口必须 401');
  // %61='a'、%69='i'：find-my-way 会解码，把 /%61pi/bootstrap 路由到 /api/bootstrap 的
  // handler，而未解码的 req.url 不以 /api/ 开头。修复前这里返回 200（钩子被整体跳过，
  // 桌面令牌、来源校验、CSRF、限速、会话鉴权全部失效）。
  for(const target of ['/%61pi/bootstrap','/%61p%69/bootstrap','/%61pi/backup','/%61pi/pool/emails']){
    const line=await rawGet('GET '+target+' HTTP/1.1');
    assert.match(line,/401|404/,'编码路径 '+target+' 不应绕过鉴权，实际：'+line);
  }
  // 绝对形式请求行是合法 HTTP/1.1，会使 req.url 以 http:// 开头
  const abs=await rawGet('GET http://127.0.0.1:'+port+'/api/bootstrap HTTP/1.1');
  assert.match(abs,/400|401/,'绝对形式请求目标不应绕过鉴权，实际：'+abs);
  // 畸形百分号序列必须 400，不能进入路由
  assert.match(await rawGet('GET /%zz/api/bootstrap HTTP/1.1'),/400/,'畸形编码应 400');
});
