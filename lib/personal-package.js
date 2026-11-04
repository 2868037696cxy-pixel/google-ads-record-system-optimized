'use strict';
const fs=require('node:fs');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {openDatabase}=require('./db');
const {openVault,getVault,decodeRow,assertNoCardSecrets}=require('./vault');
const store=require('./store');
const dedup=require('./dedup');
const TABLES=[...store.POOL_TYPES,'records'];
const MAX_BYTES=512*1024*1024;
const MAX_ROWS=100000;
const CHUNK_BYTES=1024*1024;
const error=(statusCode,message)=>{const e=new Error(message);e.statusCode=statusCode;throw e;};
async function fileHash(file){const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
function openRead(file){const db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=5000');return db;}
function counts(db,owner){return Object.fromEntries([...TABLES,'documents'].map(table=>[table,Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id=?`).get(owner).n)]));}
function revision(db,owner){
  const hash=crypto.createHash('sha256');
  for(const table of TABLES){
    hash.update(table);
    // Legacy attachment updates do not increment the resource version.
    const columns=table==='licenses'?'id,version,document_id,document_name,document_size':'id,version';
    for(const row of db.prepare(`SELECT ${columns} FROM ${table} WHERE owner_id=? ORDER BY id`).iterate(owner))hash.update(JSON.stringify(row)+';');
  }
  return hash.digest('hex');
}
function schemaCheck(db){
  for(const table of [...TABLES,'documents','document_registry','users','meta']){
    const entry=db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(table);
    if(entry?.type!=='table'||/\bVIRTUAL\b/i.test(entry.sql||''))throw new Error('Invalid personal database schema');
    if(db.prepare(`PRAGMA table_xinfo(${table})`).all().some(column=>column.hidden))throw new Error('Computed backup columns are unsupported');
  }
}
function validate(db,owner,{progress=()=>{}}={}){
  schemaCheck(db);
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Database integrity failed');
  if(db.prepare('SELECT COUNT(*) n FROM users').get().n!==1||!db.prepare('SELECT 1 FROM users WHERE id=?').get(owner))throw new Error('Wrong personal database owner');
  const result=counts(db,owner);
  if(result.documents>MAX_ROWS)throw new Error('Personal document limit exceeded');
  for(const table of [...TABLES,'documents'])if(db.prepare(`SELECT 1 FROM ${table} WHERE owner_id<>? LIMIT 1`).get(owner))throw new Error('Foreign data in personal archive');
  for(const table of TABLES){
    if(result[table]>MAX_ROWS)throw new Error('Personal archive row limit exceeded');
    for(const raw of db.prepare(`SELECT * FROM ${table} WHERE owner_id=? ORDER BY id`).iterate(owner)){
      const row=decodeRow(db,table,raw);assertNoCardSecrets(row);
      if(!Number.isSafeInteger(row.id)||row.id<1||JSON.stringify(row).length>1024*1024)throw new Error('Invalid backup row');
      for(const [key,value] of Object.entries(row))if(typeof value==='string'&&value.length>65536)throw new Error('Backup field too long');
      if(table==='proxies' && row.usage_limit !== undefined && (!require('../public/proxy-capacity').valid(row.usage_limit) || row.usage_limit < db.prepare('SELECT COUNT(*) n FROM records WHERE owner_id=? AND proxy_id=?').get(owner,row.id).n)) throw new Error('Invalid IP usage limit');
      if(table==='records'){
        if(!Number.isSafeInteger(row.seq)||row.seq<1||typeof row.fingerprint!=='string'||!row.fingerprint||!store.RECORD_STATUSES.includes(row.status))throw new Error('Invalid record metadata');
        for(const prefix of Object.values(store.POOL_PREFIX))if(row[`${prefix}_id`]!=null&&(!Number.isSafeInteger(row[`${prefix}_id`])||row[`${prefix}_id`]<1))throw new Error('Invalid resource reference');
      }else if(!store.STATUSES.includes(row.status))throw new Error('Invalid resource status');
    }
    progress({phase:'checking',table});
  }
  if(db.prepare('SELECT fingerprint FROM records WHERE owner_id=? GROUP BY fingerprint HAVING COUNT(*)>1 LIMIT 1').get(owner))throw new Error('Duplicate record fingerprint');
  for(const [kind,prefix] of Object.entries(store.POOL_PREFIX)){
    if(db.prepare(`SELECT 1 FROM records r LEFT JOIN ${kind} p ON p.id=r.${prefix}_id AND p.owner_id=r.owner_id WHERE r.owner_id=? AND r.${prefix}_id IS NOT NULL AND p.id IS NULL LIMIT 1`).get(owner))throw new Error('Missing personal resource; check record integrity first');
    if(prefix!=='proxy'&&db.prepare(`SELECT ${prefix}_id FROM records WHERE owner_id=? AND ${prefix}_id IS NOT NULL GROUP BY ${prefix}_id HAVING COUNT(*)>1 LIMIT 1`).get(owner))throw new Error('Resource assigned more than once; check record integrity first');
  }
  if(db.prepare('SELECT 1 FROM licenses l LEFT JOIN documents d ON d.sha256=l.document_id AND d.owner_id=l.owner_id WHERE l.owner_id=? AND l.document_id IS NOT NULL AND d.sha256 IS NULL LIMIT 1').get(owner))throw new Error('Missing personal PDF');
  if(db.prepare('SELECT document_id FROM licenses WHERE owner_id=? AND document_id IS NOT NULL GROUP BY document_id HAVING COUNT(*)>1 LIMIT 1').get(owner))throw new Error('Duplicate PDF association');
  for(const doc of db.prepare('SELECT * FROM documents WHERE owner_id=? ORDER BY sha256').iterate(owner)){
    const bytes=getVault(db).openBytes(doc.bytes,`pdf:${owner}:${doc.sha256}`);
    if(!/^[a-f0-9]{64}$/.test(doc.sha256)||bytes.length>10*1024*1024||bytes.length!==doc.size||bytes.subarray(0,5).toString()!=='%PDF-'||crypto.createHash('sha256').update(bytes).digest('hex')!==doc.sha256)throw new Error('PDF verification failed');
  }
  return result;
}
function rawInsert(db,table,row){const columns=Object.keys(row);db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?')})`).run(...columns.map(column=>row[column]));}
async function build({sourceFile,keyFile,owner,id,folder,progress=()=>{}}){
  process.env.ADS_SECRETS_KEY_FILE=keyFile;
  const source=openRead(sourceFile);openVault(source,sourceFile,{readOnly:true});
  const payload=folder+'/payload.sqlite',artifact=folder+'/archive.awbp';let target;
  try{
    source.exec('BEGIN');
    target=openDatabase(payload);target.exec('PRAGMA journal_mode=DELETE');
    target.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES(?,'package-owner','backup$disabled',?)").run(owner,new Date().toISOString());
    target.prepare("INSERT INTO meta(key,value) VALUES('personal_package_id',?)").run(id);
    target.exec('BEGIN IMMEDIATE');
    for(const table of TABLES){
      let n=0;
      for(const row of source.prepare(`SELECT * FROM ${table} WHERE owner_id=? ORDER BY id`).iterate(owner)){
        if(++n>MAX_ROWS)throw new Error('Personal archive row limit exceeded');
        rawInsert(target,table,row);
        if(fs.statSync(payload).size>MAX_BYTES-8192)throw new Error('Personal archive exceeds 512 MiB');
        if(n%500===0)progress({phase:'building',table,rows:n});
      }
    }
    for(const doc of source.prepare('SELECT d.* FROM documents d WHERE d.owner_id=? AND d.sha256 IN (SELECT document_id FROM licenses WHERE owner_id=? AND document_id IS NOT NULL)').iterate(owner,owner)){
      target.prepare('INSERT INTO document_registry(sha256,owner_id,created_at) VALUES(?,?,?)').run(doc.sha256,owner,doc.created_at);
      rawInsert(target,'documents',doc);
      if(fs.statSync(payload).size>MAX_BYTES-8192)throw new Error('Personal archive exceeds 512 MiB');
      progress({phase:'building',bytes:fs.statSync(payload).size});
    }
    target.exec('COMMIT');source.exec('COMMIT');
    if(fs.statSync(payload).size>MAX_BYTES-8192)throw new Error('Personal archive exceeds 512 MiB');
    const verified=validate(target,owner,{progress});
    await getVault(target).sealFile(payload,artifact,{owner_id:owner,package_id:id});
    return {counts:verified,size:fs.statSync(artifact).size,sha256:await fileHash(artifact)};
  }finally{try{source.close();}catch{}if(target)target.close();fs.rmSync(payload,{force:true});fs.rmSync(payload+'-wal',{force:true});fs.rmSync(payload+'-shm',{force:true});}
}
async function inspect({sourceFile,keyFile,owner,folder,progress=()=>{}}){
  process.env.ADS_SECRETS_KEY_FILE=keyFile;
  const source=openRead(sourceFile);openVault(source,sourceFile,{readOnly:true});
  const payload=folder+'/payload.sqlite';let personal;
  try{
    fs.rmSync(payload,{force:true});
    fs.rmSync(payload+'.partial',{force:true});
    const header=await getVault(source).openFile(folder+'/upload.awbp',payload,owner);
    personal=openRead(payload);openVault(personal,payload,{readOnly:true});
    if(personal.prepare("SELECT value FROM meta WHERE key='personal_package_id'").get()?.value!==header.package_id)throw new Error('Archive metadata mismatch');
    const verified=validate(personal,owner,{progress});
    return {counts:verified,size:fs.statSync(payload).size,sha256:await fileHash(payload)};
  }finally{source.close();if(personal)personal.close();}
}
function apply(db,personal,owner,createdAt){
  // Called only after authentication, full file verification and workspace
  // revision checks, inside the SAME transaction as job completion and audit.
  for(const row of personal.prepare('SELECT * FROM licenses WHERE owner_id=? ORDER BY id').iterate(owner)){
    if(dedup.findLicenseConflict(db,dedup.licenseKeys(row),{excludeOwnerId:owner}))error(409,'备份资料与其他账号已登记资料冲突；现有数据未改变');
    if(row.document_id&&db.prepare('SELECT 1 FROM document_registry WHERE sha256=? AND owner_id<>?').get(row.document_id,owner))error(409,'备份 PDF 与其他账号已登记文件冲突；现有数据未改变');
  }
  db.exec('CREATE TEMP TABLE IF NOT EXISTS package_restore_map(kind TEXT,old_id INTEGER,new_id INTEGER,PRIMARY KEY(kind,old_id));DELETE FROM package_restore_map');
  db.prepare('DELETE FROM records WHERE owner_id=?').run(owner);
  for(const kind of store.POOL_TYPES)db.prepare(`DELETE FROM ${kind} WHERE owner_id=?`).run(owner);
  for(const kind of store.POOL_TYPES){
    for(const raw of personal.prepare(`SELECT * FROM ${kind} WHERE owner_id=? ORDER BY id`).iterate(owner)){
      const row=decodeRow(personal,kind,raw);
      if(kind==='proxies' && row.usage_limit === undefined) row.usage_limit=Math.max(1,personal.prepare('SELECT COUNT(*) n FROM records WHERE owner_id=? AND proxy_id=?').get(owner,row.id).n);
      if(kind==='licenses'&&dedup.findLicenseConflict(db,dedup.licenseKeys(row)))error(409,'备份内组织资料存在重复，恢复已取消');
      const inserted=store.insertPoolRow(db,owner,kind,row,{createdAt:row.created_at||createdAt});
      const prefix=store.POOL_PREFIX[kind];
      const linked=personal.prepare(`SELECT 1 FROM records WHERE owner_id=? AND ${prefix}_id=? LIMIT 1`).get(owner,row.id);
      store.setPoolStatus(db,owner,kind,inserted.id,row.status==='停用'?'停用':linked?'已使用':row.status);
      if(kind==='licenses'&&row.document_id)db.prepare('UPDATE licenses SET document_id=?,document_name=?,document_size=? WHERE owner_id=? AND id=?').run(row.document_id,row.document_name||'certificate.pdf',row.document_size||0,owner,inserted.id);
      db.prepare('INSERT INTO package_restore_map VALUES(?,?,?)').run(kind,row.id,inserted.id);
    }
  }
  for(const raw of personal.prepare('SELECT * FROM records WHERE owner_id=? ORDER BY id').iterate(owner)){
    const row=decodeRow(personal,'records',raw);
    for(const [kind,prefix] of Object.entries(store.POOL_PREFIX))if(row[`${prefix}_id`]!=null){const mapped=db.prepare('SELECT new_id FROM package_restore_map WHERE kind=? AND old_id=?').get(kind,row[`${prefix}_id`]);if(!mapped)throw new Error('Invalid resource mapping');row[`${prefix}_id`]=mapped.new_id;}
    store.insertRecord(db,owner,row);
  }
  for(const doc of personal.prepare('SELECT * FROM documents WHERE owner_id=? ORDER BY sha256').iterate(owner))store.putDocument(db,owner,{sha256:doc.sha256,filename:doc.filename,bytes:getVault(personal).openBytes(doc.bytes,`pdf:${owner}:${doc.sha256}`),createdAt:doc.created_at||createdAt});
  db.prepare('DELETE FROM documents WHERE owner_id=? AND sha256 NOT IN (SELECT document_id FROM licenses WHERE document_id IS NOT NULL)').run(owner);
  db.exec('DELETE FROM package_restore_map');
}
module.exports={MAX_BYTES,MAX_ROWS,CHUNK_BYTES,TABLES,fileHash,openRead,counts,revision,validate,build,inspect,apply,error};
