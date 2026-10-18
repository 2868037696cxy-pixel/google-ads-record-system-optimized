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
