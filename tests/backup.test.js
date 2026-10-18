'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');const {DatabaseSync}=require('node:sqlite');const {createBackup,decryptBackup,verifyBackup}=require('../scripts/backup.cjs');
test('full database backup restores to a new file and rejects wrong key or tampering',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-backup-'));const original=path.join(dir,'original.sqlite');const key=crypto.randomBytes(32);const db=new DatabaseSync(original);db.exec("CREATE TABLE test(value TEXT);INSERT INTO test VALUES('private-metadata-marker')");db.close();
  try{
    const file=await createBackup(original,path.join(dir,'backups'),key);assert.ok(!fs.readFileSync(file).includes(Buffer.from('private-metadata-marker')));assert.equal(await verifyBackup(file,key),true);
    const restored=path.join(dir,'restored.sqlite');await decryptBackup(file,restored,key);const check=new DatabaseSync(restored,{readOnly:true});assert.equal(check.prepare('SELECT value FROM test').get().value,'private-metadata-marker');check.close();
    await assert.rejects(decryptBackup(file,restored,key),/overwrite/);await assert.rejects(verifyBackup(file,crypto.randomBytes(32)));
    const corrupt=fs.readFileSync(file);corrupt[30]^=1;fs.writeFileSync(path.join(dir,'bad.awbdb'),corrupt);await assert.rejects(verifyBackup(path.join(dir,'bad.awbdb'),key));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
