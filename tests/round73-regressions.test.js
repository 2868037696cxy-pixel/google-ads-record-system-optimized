'use strict';
// Synthetic fixtures only. All probes use the public HTTP boundary and a fresh DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { certificate } = require('./pdf-fixture');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-round73-'));
Object.assign(process.env, {NODE_ENV:'test',DATA_DIR:root,DB_FILE:path.join(root,'test.sqlite'),DATA_FILE:path.join(root,'absent.json'),REGISTRATION:'open',SESSION_SECURE:'0',LOG_LEVEL:'silent',DEDUP_ADDRESS_MODE:'warn'});
delete process.env.ADS_SECRETS_KEY_FILE;
delete process.env.PUBLIC_ORIGIN;
delete process.env.PDF_PARSE_CONCURRENCY;
const service = require('../server');
let origin;
const cookies = {};
async function api(user, method, route, body) {
  const response = await fetch(origin + route, {method,headers:{'content-type':'application/json','x-workbench':'1',...(cookies[user]?{cookie:cookies[user]}:{})},...(body === undefined?{}:{body:JSON.stringify(body)})});
  const data = await response.json();
  return {status:response.status,data};
}
async function parse(text) {
  const result = await api('a','POST','/api/parse/licenses',{text});
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.ok(Array.isArray(result.data.items));
  return result.data.items;
}
function pdfFor(label) { return certificate(['CERTIFICATE OF REGISTRATION',label,'Example street 1','1234 City']); }
async function upload(user, name, cvr, pdf, extra={}) {
  return api(user,'POST','/api/import/licenses',{filename:'synthetic.pdf',pdf:pdf.toString('base64'),items:[{name,legal_name:name,cvr,...extra}]});
}
test.before(async () => {
  origin = await service.start({port:0});
  for (const user of ['a','b']) {
    const r = await fetch(origin+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json','x-workbench':'1'},body:JSON.stringify({username:'round73_'+user,password:'Synthetic-test-only-73!'})});
    assert.equal(r.status,201);
    cookies[user]=r.headers.get('set-cookie').split(';')[0];
  }
});
test.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});

test('F08: CVR after city is a registration field, not part of the city',async()=>{
  const [row]=await parse('组织名称：Orchid Seven ApS\n城市：Copenhagen\nCVR: 00123456');
  assert.equal(row.city,'Copenhagen');
  assert.equal(row.cvr,'00123456');
  assert.equal(row.name,'Orchid Seven ApS');
});
test('F08: Chinese and English registration labels work in either field order',async()=>{
  for(const label of ['注册号','公司注册号','登记号','CVR','CVR number','CVR-nr.','Registration number','Business registration no.']) {
    const [row]=await parse(`${label}：AB-001234\n公司名称：Orchid Eight\n城市：上海`);
    assert.equal(row.cvr,'AB-001234',label);
    assert.equal(row.city,'上海',label);
    assert.equal(row.name,'Orchid Eight',label);
  }
});
test('F08: inline labels stop correctly without treating suffixes inside a word as labels',async()=>{
  const [row]=await parse('Company name: Electricity: North; City: Berlin; CVR=AB001234; Address: Street 8');
  assert.equal(row.name,'Electricity: North');
  assert.equal(row.city,'Berlin');
  assert.equal(row.cvr,'AB001234');
  assert.equal(row.address,'Street 8');
});
test('F08: legacy company-name lines and absent registration remain compatible',async()=>{
  assert.deepEqual((await parse('Alpha ApS\nBeta GmbH')).map(r=>r.name),['Alpha ApS','Beta GmbH']);
  const [row]=await parse('公司名称：Gamma ApS\n城市：Aarhus');
  assert.equal(row.city,'Aarhus');
  assert.equal(row.cvr || '','');
});
test('F08: parser output reaches global registration dedup through actual import API',async()=>{
  const rows=await parse('公司名称：Unique Registration Probe\n城市：City\nCVR: ZX0019273');
  assert.equal((await api('a','POST','/api/import/licenses',{items:rows})).status,200);
  const other=await api('b','POST','/api/import/licenses',{items:[{name:'Completely Other Label',cvr:'ZX0019273'}]});
  assert.equal(other.status,409);
  assert.equal(other.data.conflicts[0].field,'cvr');
  assert.ok(!('owner' in other.data.conflicts[0]));
});
test('F13: structured field objects cannot be stringified and saved',async()=>{
  const before=service.db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n;
  for(const value of [{nested:'bad'},['bad'],true]) {
    const r=await api('a','POST','/api/import/licenses',{items:[{name:value,cvr:'S7399900'}]});
    assert.equal(r.status,400,JSON.stringify(r));
  }
  assert.equal((await api('a','POST','/api/parse/licenses',{text:{nested:'bad'}})).status,400);
  assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n,before);
});
test('F13: duplicated paging values, scientific notation and whitespace are rejected',async()=>{
  for(const query of ['limit=1&limit=2','limit=1e2','limit=%20','offset=0x10','offset=1&offset=2']) {
    assert.equal((await api('a','GET','/api/records?'+query)).status,400,query);
  }
  assert.equal((await api('a','GET','/api/records?limit=1&offset=0')).status,200);
});
test('F04-PDF: direct PDF upload cannot overwrite an existing company with a different registration',async()=>{
  const one=await upload('a','Same Name Pdf Probe','PDF730001',pdfFor('first pdf'));
  assert.equal(one.status,200,JSON.stringify(one));
  const before=service.db.prepare('SELECT cvr,document_id FROM licenses WHERE id=?').get(one.data.license_id);
  const second=await upload('a','Same Name Pdf Probe','PDF730002',pdfFor('second pdf'));
  assert.equal(second.status,409,JSON.stringify(second));
  assert.deepEqual(service.db.prepare('SELECT cvr,document_id FROM licenses WHERE id=?').get(one.data.license_id),before);
});
test('F04: incomplete import enriches an existing record without clearing address or legal name',async()=>{
  const item={name:'Sparse Fields Probe',legal_name:'Sparse Fields Registered Name',cvr:'SP730001',address:'Keep Street 7',city:'Keep City'};
  assert.equal((await api('a','POST','/api/import/licenses',{items:[item]})).status,200);
  const update=await api('a','POST','/api/import/licenses',{items:[{name:item.name,cvr:item.cvr}]});
  assert.equal(update.status,200,JSON.stringify(update));
  const row=service.db.prepare('SELECT name,legal_name,address,city FROM licenses WHERE cvr=?').get(item.cvr);
  assert.equal(row.address,item.address);
  assert.equal(row.city,item.city);
  assert.equal(row.legal_name,item.legal_name);
});
test('F09-STRUCTURE: forged header and EOF do not establish a valid PDF',async()=>{
  const before=service.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;
  const invalid=Buffer.from('%PDF-1.7\nnot a document, no pages or catalog\n%%EOF\n');
  const result=await upload('a','Invalid Structure Probe','BAD730001',invalid);
  assert.equal(result.status,400,JSON.stringify(result));
  assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n,before);
  assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM licenses WHERE cvr=?').get('BAD730001').n,0);
});
test('F23: successful PDF import/read/replace are audited without contents or another owner',async()=>{
  const first=await upload('a','Audit Original Probe','AUD730001',pdfFor('audit original'));
  assert.equal(first.status,200,JSON.stringify(first));
  const id=first.data.license_id;
  const read=await fetch(origin+`/api/licenses/${id}/pdf`,{headers:{'x-workbench':'1',cookie:cookies.a}});
  assert.equal(read.status,200);await read.arrayBuffer();
  const foreign=await fetch(origin+`/api/licenses/${id}/pdf`,{headers:{'x-workbench':'1',cookie:cookies.b}});
  assert.equal(foreign.status,404);await foreign.arrayBuffer();
  const replacement=await upload('a','Audit Original Probe','AUD730001',pdfFor('audit replacement'));
  assert.equal(replacement.status,200,JSON.stringify(replacement));
  const events=(await api('a','GET','/api/audit')).data.events.filter(e=>e.subject===String(id));
  for(const action of ['pdf.import','pdf.read','pdf.replace']) assert.ok(events.some(e=>e.action===action),action);
  assert.ok(!(await api('b','GET','/api/audit')).data.events.some(e=>e.action==='pdf.read'&&e.subject===String(id)));
});
