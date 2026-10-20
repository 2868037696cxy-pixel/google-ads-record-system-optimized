'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {Worker}=require('node:worker_threads');
const pack=require('./personal-package');
const {getVault,openVault}=require('./vault');
const {transaction}=require('./db');
const {audit}=require('./hardening');
const TTL=24*60*60*1000;
const MAX_WORKERS=2;
const OWNER_RESERVE=2*1024*1024*1024,GLOBAL_RESERVE=8*1024*1024*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

module.exports=function createJobs({db,databaseFile,directory}){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  db.exec(`CREATE TABLE IF NOT EXISTS personal_backup_jobs(
    id TEXT PRIMARY KEY,owner_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,status TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,offset INTEGER NOT NULL DEFAULT 0,reserved INTEGER NOT NULL DEFAULT 0,
    source_tag TEXT NOT NULL DEFAULT '',sha256 TEXT NOT NULL DEFAULT '',stage_digest TEXT NOT NULL DEFAULT '',
    counts TEXT NOT NULL DEFAULT '{}',current_counts TEXT NOT NULL DEFAULT '{}',revision TEXT NOT NULL DEFAULT '',
    progress TEXT NOT NULL DEFAULT '{}',error TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL
  );CREATE INDEX IF NOT EXISTS ix_personal_jobs_owner ON personal_backup_jobs(owner_id,created_at DESC)`);
  const workers=new Map(),applying=new Set();let closing=false;
  const folder=id=>path.join(directory,id);
  const update=(id,values)=>{const keys=Object.keys(values);db.prepare(`UPDATE personal_backup_jobs SET ${keys.map(key=>`${key}=?`).join(',')} WHERE id=?`).run(...keys.map(key=>values[key]),id);};
  const clean=id=>fs.rmSync(folder(id),{recursive:true,force:true,maxRetries:2,retryDelay:50});
  const get=(owner,id)=>{
    if(typeof id!=='string'||!UUID.test(id))pack.error(404,'备份任务不存在');
    const job=db.prepare('SELECT * FROM personal_backup_jobs WHERE owner_id=? AND id=?').get(owner,id);
    if(!job)pack.error(404,'备份任务不存在');
    if(job.expires_at<=Date.now())pack.error(410,'临时备份任务已过期，请重新创建');
    return job;
  };
  const publicJob=job=>({id:job.id,kind:job.kind,status:job.status,size:job.size,offset:job.offset,source_tag:job.source_tag,sha256:job.sha256,
    counts:JSON.parse(job.counts),current_counts:JSON.parse(job.current_counts),revision:job.revision,progress:JSON.parse(job.progress),error:job.error,
    created_at:job.created_at,expires_at:job.expires_at,chunk_bytes:pack.CHUNK_BYTES,max_bytes:pack.MAX_BYTES});
  // Metadata is the upload commit point. A process crash may leave an uncommitted
  // file tail; truncate it, never trust it as an acknowledged upload.
  for(const job of db.prepare('SELECT * FROM personal_backup_jobs').all()){
    try{
      if(job.expires_at<=Date.now()||['complete','failed'].includes(job.status)){clean(job.id);update(job.id,{reserved:0});if(job.expires_at<=Date.now())db.prepare('DELETE FROM personal_backup_jobs WHERE id=?').run(job.id);continue;}
      if(job.status==='building'){clean(job.id);update(job.id,{status:'failed',reserved:0,error:'打包被中断，请重新创建任务'});}
      else if(['uploading','checking'].includes(job.status)){
        const file=path.join(folder(job.id),'upload.awbp');
        if(!fs.existsSync(file)||fs.statSync(file).size<job.offset)throw new Error('missing');
        fs.truncateSync(file,job.offset);update(job.id,{status:'uploading'});
        fs.rmSync(path.join(folder(job.id),'payload.sqlite'),{force:true});fs.rmSync(path.join(folder(job.id),'payload.sqlite.partial'),{force:true});
      }else if(job.status==='ready'&&!fs.existsSync(path.join(folder(job.id),'archive.awbp')))throw new Error('missing');
      else if(job.status==='review'&&!fs.existsSync(path.join(folder(job.id),'payload.sqlite')))throw new Error('missing');
    }catch{update(job.id,{status:'failed',error:'临时文件不完整，请重新创建任务'});try{clean(job.id);update(job.id,{reserved:0});}catch{}}
  }
  for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(UUID.test(entry.name)&&!db.prepare('SELECT 1 FROM personal_backup_jobs WHERE id=?').get(entry.name))clean(entry.name);
  const fail=(id,message)=>{update(id,{status:'failed',error:message});try{clean(id);update(id,{reserved:0});}catch{}};
  function run(job,operation){
    let worker;
    try{worker=new Worker(path.join(__dirname,'personal-backup-worker.js'),{workerData:{operation,sourceFile:path.resolve(databaseFile),keyFile:getVault(db).keyFile,owner:job.owner_id,id:job.id,folder:folder(job.id)},resourceLimits:{maxOldGenerationSizeMb:256}});}
    catch{fail(job.id,'无法启动备份工作进程，请稍后重新创建任务');return;}
    workers.set(job.id,worker);let finished=false;
    const timeout=setTimeout(()=>{if(!finished){finished=true;void worker.terminate().then(()=>fail(job.id,'任务超过 10 分钟，请稍后重新创建'));}},10*60*1000);timeout.unref();
    worker.on('message',message=>{
      if(finished)return;
      if(message.progress){update(job.id,{progress:JSON.stringify(message.progress)});return;}
      finished=true;clearTimeout(timeout);
      if(message.error){fail(job.id,message.error);return;}
      if(message.result){const result=message.result;
        if(operation==='build')update(job.id,{status:'ready',counts:JSON.stringify(result.counts),size:result.size,sha256:result.sha256,reserved:result.size,progress:'{}'});
        else update(job.id,{status:'review',counts:JSON.stringify(result.counts),stage_digest:result.sha256,current_counts:JSON.stringify(pack.counts(db,job.owner_id)),revision:pack.revision(db,job.owner_id),progress:'{}'});
      }
    });
    worker.on('error',()=>{if(!finished){finished=true;clearTimeout(timeout);fail(job.id,'备份工作进程未完成，请重新创建任务');}});
    worker.on('exit',code=>{workers.delete(job.id);clearTimeout(timeout);if(!finished){if(closing&&operation==='inspect')update(job.id,{status:'uploading',error:''});else fail(job.id,'任务被中断，请重新检查或创建任务');}});
  }
  function create(owner,body){
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['kind','size','source_tag'].includes(key))||!['export','restore'].includes(body.kind))pack.error(400,'备份任务参数无效');
    if(body.kind==='export'&&Object.keys(body).some(key=>key!=='kind'))pack.error(400,'导出任务参数无效');
    if(databaseFile===':memory:'||!getVault(db).keyFile)pack.error(409,'此运行方式暂不支持文件备份任务');
    if(body.kind==='export'&&workers.size>=MAX_WORKERS)pack.error(429,'后台备份任务繁忙，请稍后重试');
    let size=0;
    if(body.kind==='restore'){
      if(!Number.isSafeInteger(body.size)||body.size<128||body.size>pack.MAX_BYTES||typeof body.source_tag!=='string'||!/^[a-f0-9]{64}$/.test(body.source_tag))pack.error(400,'请选择不超过 512 MiB 的有效分块备份文件');
      size=body.size;
    }
    const active="reserved>0 AND expires_at>?";
    const held=db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(reserved),0) bytes FROM personal_backup_jobs WHERE owner_id=? AND ${active}`).get(owner,Date.now());
    const global=db.prepare(`SELECT COALESCE(SUM(reserved),0) bytes FROM personal_backup_jobs WHERE ${active}`).get(Date.now()).bytes;
    const reserved=body.kind==='export'?2*pack.MAX_BYTES:2*size;
    if(held.n>=2||held.bytes+reserved>OWNER_RESERVE||global+reserved>GLOBAL_RESERVE)pack.error(409,'临时任务或空间额度已满，请先下载并删除旧任务');
    if(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE owner_id=? AND action IN ('backup.package.create','backup.package.upload') AND created_at>?").get(owner,new Date(Date.now()-3600000).toISOString()).n>=20)pack.error(429,'创建任务过于频繁，请稍后再试');
    const disk=fs.statfsSync(directory);if(disk.bavail*disk.bsize<reserved+128*1024*1024)pack.error(409,'服务器临时空间不足，请清理后重试');
    const id=crypto.randomUUID(),now=Date.now();fs.mkdirSync(folder(id),{mode:0o700});
    if(body.kind==='restore')fs.writeFileSync(path.join(folder(id),'upload.awbp'),Buffer.alloc(0),{flag:'wx',mode:0o600});
    try{transaction(db,()=>{
      db.prepare('INSERT INTO personal_backup_jobs(id,owner_id,kind,status,size,reserved,source_tag,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,owner,body.kind,body.kind==='export'?'building':'uploading',size,reserved,body.source_tag||'',now,now+TTL);
      audit(db,owner,body.kind==='export'?'backup.package.create':'backup.package.upload',id);
    });}catch(error){clean(id);throw error;}
    const job=get(owner,id);if(body.kind==='export')run(job,'build');return publicJob(job);
  }
  function chunk(owner,id,offset,bytes,hash){
    const job=get(owner,id);
    if(job.kind!=='restore'||job.status!=='uploading')pack.error(409,'任务目前不可上传');
    if(!Number.isSafeInteger(offset)||offset<0||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>pack.CHUNK_BYTES||offset+bytes.length>job.size||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)||crypto.createHash('sha256').update(bytes).digest('hex')!==hash)pack.error(400,'分块大小、位置或校验值无效');
    const file=path.join(folder(id),'upload.awbp'),fd=fs.openSync(file,'r+');
    try{
      if(offset<job.offset){const prior=Buffer.alloc(bytes.length);if(offset+bytes.length>job.offset||fs.readSync(fd,prior,0,prior.length,offset)!==prior.length||!prior.equals(bytes))pack.error(409,'重传内容不一致，请重新核对文件');return {offset:job.offset};}
      if(offset!==job.offset)pack.error(409,'上传进度已变化，请重新读取任务后继续');
      fs.ftruncateSync(fd,offset);
      let written=0;while(written<bytes.length){const n=fs.writeSync(fd,bytes,written,bytes.length-written,offset+written);if(!n)throw new Error('Unable to persist upload chunk');written+=n;}
      fs.fsyncSync(fd);
      update(id,{offset:offset+bytes.length});return {offset:offset+bytes.length};
    }finally{fs.closeSync(fd);}
  }
  function verify(owner,id){const job=get(owner,id);if(job.status==='checking'||job.status==='review')return publicJob(job);if(job.kind!=='restore'||job.status!=='uploading'||job.offset!==job.size)pack.error(409,'文件尚未上传完整');if(workers.size>=MAX_WORKERS)pack.error(429,'后台备份任务繁忙，请稍后重试');update(id,{status:'checking',error:''});run(get(owner,id),'inspect');return publicJob(get(owner,id));}
  function review(owner,id){const job=get(owner,id);if(job.status!=='review')pack.error(409,'备份尚未校验完成');update(id,{revision:pack.revision(db,owner),current_counts:JSON.stringify(pack.counts(db,owner))});return publicJob(get(owner,id));}
  async function apply(owner,id,expected){
    let job=get(owner,id);if(job.status==='complete')return publicJob(job);
    if(job.status!=='review'||applying.has(id)||typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))pack.error(409,'请先完成文件校验与覆盖核对');
    applying.add(id);let personal;
    try{
      const file=path.join(folder(id),'payload.sqlite');if(await pack.fileHash(file)!==job.stage_digest)pack.error(409,'校验后的临时文件已变化，恢复已取消');
      personal=pack.openRead(file);openVault(personal,file,{readOnly:true,keyFile:getVault(db).keyFile});
      transaction(db,()=>{
        job=get(owner,id);if(job.status!=='review'||job.revision!==expected||pack.revision(db,owner)!==expected)pack.error(409,'核对后当前数据已变化；请重新核对覆盖范围');
        pack.apply(db,personal,owner,new Date().toISOString());
        audit(db,owner,'backup.package.restore',id);
        update(id,{status:'complete',error:''});
      });
      return publicJob(get(owner,id));
    }finally{if(personal)personal.close();applying.delete(id);if(db.prepare('SELECT status FROM personal_backup_jobs WHERE id=?').get(id)?.status==='complete'){try{clean(id);update(id,{reserved:0});}catch{}}}
  }
  async function remove(owner,id){get(owner,id);if(applying.has(id))pack.error(409,'正在提交恢复，请等待结果');const worker=workers.get(id);if(worker)await worker.terminate();try{clean(id);}catch{pack.error(409,'临时文件正在使用，请稍后重试删除');}db.prepare('DELETE FROM personal_backup_jobs WHERE id=? AND owner_id=?').run(id,owner);return {deleted:true};}
  const timer=setInterval(()=>{for(const job of db.prepare('SELECT id,owner_id FROM personal_backup_jobs WHERE expires_at<=?').all(Date.now())){if(applying.has(job.id))continue;const worker=workers.get(job.id);if(worker){void worker.terminate();continue;}try{clean(job.id);db.prepare('DELETE FROM personal_backup_jobs WHERE id=?').run(job.id);}catch{}}db.prepare("DELETE FROM personal_backup_jobs WHERE status IN ('failed','complete') AND reserved=0 AND created_at<?").run(Date.now()-7*TTL);},60000);timer.unref();
  return {create,chunk,verify,review,apply,remove,
    list:owner=>db.prepare('SELECT * FROM personal_backup_jobs WHERE owner_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 20').all(owner,Date.now()).map(publicJob),
    get:(owner,id)=>publicJob(get(owner,id)),
    download:(owner,id)=>{const job=get(owner,id);if(job.kind!=='export'||job.status!=='ready')pack.error(409,'备份尚未准备完成');return {file:path.join(folder(id),'archive.awbp'),size:job.size,sha256:job.sha256};},
    close:async()=>{closing=true;clearInterval(timer);await Promise.all([...workers.values()].map(worker=>worker.terminate()));},
  };
};
