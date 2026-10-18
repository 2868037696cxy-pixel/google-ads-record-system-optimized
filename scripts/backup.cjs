'use strict';
// Authenticated, streaming full-database backup. No network calls and no key logging.
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');const {pipeline}=require('node:stream/promises');const {DatabaseSync,backup}=require('node:sqlite');
function envFile(file='/etc/adsworkbench.env') {
  // systemd has already read the private root-only EnvironmentFile.
  if(process.env.ADS_SECRETS_KEY_FILE && (process.env.DB_FILE || process.env.DATA_DIR)) return;
  if(!fs.existsSync(file))return;
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
    const match=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(!match||process.env[match[1]]!==undefined)continue;
    let value=match[2].trim();if(/^(['"]).*\1$/.test(value))value=value.slice(1,-1);process.env[match[1]]=value;
  }
}
function readKey(){const file=process.env.ADS_SECRETS_KEY_FILE;if(!file)throw new Error('ADS_SECRETS_KEY_FILE is required');const key=fs.readFileSync(file,'utf8').trim();if(!/^[a-f0-9]{64}$/i.test(key))throw new Error('Invalid backup key');return Buffer.from(key,'hex');}
async function createBackup(dbFile,outDir,key) {
  fs.mkdirSync(outDir,{recursive:true,mode:0o700});
  const usage=fs.statfsSync(outDir);
  if(usage.bavail*usage.bsize < fs.statSync(dbFile).size*3+128*1024*1024) throw new Error('Insufficient disk space for a verified backup; free space or use another volume.');
  const temporary=fs.mkdtempSync(path.join(outDir,'.snapshot-'));const tempDb=path.join(temporary,'snapshot.sqlite');
  const name='adsworkbench-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex')+'.awbdb';
  const out=path.join(outDir,name),partial=out+'.partial';let db;
  try {
    db=new DatabaseSync(dbFile,{readOnly:true});await backup(db,tempDb);db.close();db=null;
    const check=new DatabaseSync(tempDb,{readOnly:true});try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Snapshot integrity failed');}finally{check.close();}
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('AdsWorkbench full backup v1'));
    fs.writeFileSync(partial,Buffer.concat([Buffer.from('WBDB1'),iv]),{mode:0o600,flag:'wx'});
    await pipeline(fs.createReadStream(tempDb),cipher,fs.createWriteStream(partial,{flags:'a'}));fs.appendFileSync(partial,cipher.getAuthTag());
    fs.renameSync(partial,out);return out;
  }finally{if(db)db.close();fs.rmSync(temporary,{recursive:true,force:true});fs.rmSync(partial,{force:true});}
}
async function decryptBackup(file,destination,key) {
  if(fs.existsSync(destination))throw new Error('Refusing to overwrite an existing database');
  const size=fs.statSync(file).size;if(size<33)throw new Error('Invalid backup');
  const fd=fs.openSync(file,'r'),head=Buffer.alloc(17),tag=Buffer.alloc(16);try{fs.readSync(fd,head,0,17,0);fs.readSync(fd,tag,0,16,size-16);}finally{fs.closeSync(fd);}
  if(head.subarray(0,5).toString()!=='WBDB1')throw new Error('Invalid backup format');
  const partial=destination+'.partial';
  try {
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,head.subarray(5));decipher.setAAD(Buffer.from('AdsWorkbench full backup v1'));decipher.setAuthTag(tag);
    await pipeline(fs.createReadStream(file,{start:17,end:size-17}),decipher,fs.createWriteStream(partial,{mode:0o600,flags:'wx'}));
    const db=new DatabaseSync(partial,{readOnly:true});try{if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Restored database integrity failed');}finally{db.close();}
    fs.renameSync(partial,destination);
  }catch(error){fs.rmSync(partial,{force:true});throw error;}
}
async function verifyBackup(file,key) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-verify-'));try{await decryptBackup(file,path.join(dir,'verify.sqlite'),key);return true;}finally{fs.rmSync(dir,{recursive:true,force:true});}}
function pruneBackups(directory,keep=7) {
  if(!Number.isSafeInteger(keep)||keep<2||keep>365)throw new Error('Backup retention must be between 2 and 365');
  const files=fs.readdirSync(directory).filter(n=>/^adsworkbench-.*\.awbdb$/.test(n)).map(n=>({name:n,time:fs.statSync(path.join(directory,n)).mtimeMs})).sort((a,b)=>b.time-a.time);
  for(const item of files.slice(keep))fs.unlinkSync(path.join(directory,item.name));
}
async function main(){envFile();const key=readKey();const [action,input,output]=process.argv.slice(2);
  if(action==='create'){const db=process.env.DB_FILE||path.join(process.env.DATA_DIR||'/var/lib/adsworkbench','workbench.sqlite');const out=await createBackup(db,input||process.env.BACKUP_DIR||'/var/backups/adsworkbench',key);await verifyBackup(out,key);if(process.env.BACKUP_KEEP)pruneBackups(path.dirname(out),Number(process.env.BACKUP_KEEP));console.log(JSON.stringify({backup:out,verified:true}));}
  else if(action==='verify'&&input){await verifyBackup(input,key);console.log('Backup authentication and SQLite integrity: OK');}
  else if(action==='restore'&&input&&output){await decryptBackup(input,output,key);console.log('Restored to new file: '+output);}
  else throw new Error('Usage: backup.cjs create [directory] | verify FILE | restore FILE NEW_DATABASE');
}
if(require.main===module)main().catch(e=>{console.error('Backup operation failed: '+e.message);process.exitCode=1;});
module.exports={createBackup,decryptBackup,verifyBackup,envFile,pruneBackups};
