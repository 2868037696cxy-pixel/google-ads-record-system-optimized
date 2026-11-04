'use strict';
// AEAD encryption at rest. The key is a separate, private file, never a DB value.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const PREFIX = 'wbenc1:';
const SECRET_FIELDS = new Set(['pass', 'fakey', 'email_pass', 'email_fakey', 'proxy_pass', 'id_card']);
const PROTECTED = '[protected]';
const instances = new WeakMap();
function openVault(db, databaseFile, { readOnly = false, keyFile: suppliedKeyFile } = {}) {
  const configured = suppliedKeyFile || process.env.ADS_SECRETS_KEY_FILE;
  const keyFile = configured || (databaseFile === ':memory:' ? null : path.join(path.dirname(databaseFile), '.secrets.key'));
  let key;
  if (!keyFile) key = crypto.randomBytes(32);
  else {
    if (!fs.existsSync(keyFile)) {
      if (readOnly) throw new Error('Encryption key missing.');
      if (configured) throw new Error('Secret key file is missing; restore the original key or run the installer.');
      // Do not replace a lost key for an already encrypted database.
      const encrypted = db.prepare("SELECT value FROM meta WHERE key='vault_key_id'").get();
      if (encrypted) throw new Error('Encryption key missing. Refusing to create a replacement.');
      fs.mkdirSync(path.dirname(keyFile), {recursive:true, mode:0o700});
      fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex')+'\n', {mode:0o600, flag:'wx'});
    }
    if (process.platform !== 'win32' && (fs.statSync(keyFile).mode & 0o007)) throw new Error('Secret key must not be accessible to other users.');
    const raw = fs.readFileSync(keyFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error('Invalid encryption key file (expected 32-byte hex).');
    key = Buffer.from(raw,'hex');
  }
  const keyId = crypto.createHash('sha256').update(key).digest('hex');
  const previous = db.prepare("SELECT value FROM meta WHERE key='vault_key_id'").get();
  if (readOnly && !previous) throw new Error('Vault metadata missing.');
  if (previous && previous.value !== keyId) throw new Error('Wrong encryption key. Startup cancelled; data unchanged.');
  if (!readOnly) db.prepare("INSERT INTO meta(key,value) VALUES('vault_key_id',?) ON CONFLICT(key) DO NOTHING").run(keyId);
  const vault = {
    keyFile, keyId,
    seal(value, context) {
      if (value == null || value === '') return '';
      if (value === PROTECTED) throw new Error('Protected placeholder cannot be saved as a secret.');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm',key,iv);
      cipher.setAAD(Buffer.from(context));
      const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
      return PREFIX+Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
    },
    open(value, context) {
      if (value == null || value === '') return '';
      if (!String(value).startsWith(PREFIX)) throw new Error('Unencrypted secret encountered; migration required.');
      try {
        const bytes=Buffer.from(value.slice(PREFIX.length),'base64');
        if(bytes.length<28) throw new Error('short');
        const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
        decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(bytes.subarray(12,28));
        return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
      } catch { throw new Error('Encrypted data authentication failed.'); }
    },
  };
  vault.sealBytes=(value,context)=>{
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted=Buffer.concat([cipher.update(Buffer.from(value)),cipher.final()]);
    return Buffer.concat([Buffer.from('WBPD1'),iv,cipher.getAuthTag(),encrypted]);
  };
  vault.openBytes=(value,context)=>{
    try {
      const bytes=Buffer.from(value);
      if(bytes.length<33 || bytes.subarray(0,5).toString()!=='WBPD1') throw new Error('format');
      const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(5,17));
      decipher.setAAD(Buffer.from(context));decipher.setAuthTag(bytes.subarray(17,33));
      return Buffer.concat([decipher.update(bytes.subarray(33)),decipher.final()]);
    }catch {throw new Error('PDF authentication failed.');}
  };
  // Streaming personal archives authenticate their complete public header. Keys
  // remain inside the vault; neither workers nor HTTP responses receive them.
  vault.sealFile=async(source,destination,metadata)=>{
    const {pipeline}=require('node:stream/promises');
    const header=Buffer.from(JSON.stringify({format:'adsworkbench-personal',version:3,owner_id:metadata.owner_id,package_id:metadata.package_id,key_id:keyId,created_at:new Date().toISOString()}));
    const length=Buffer.alloc(4);length.writeUInt32BE(header.length);
    const prefix=Buffer.concat([Buffer.from('WBPK3'),length,header]);
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(prefix);
    fs.writeFileSync(destination,Buffer.concat([prefix,iv]),{flag:'wx',mode:0o600});
    try{await pipeline(fs.createReadStream(source),cipher,fs.createWriteStream(destination,{flags:'a'}));fs.appendFileSync(destination,cipher.getAuthTag());return JSON.parse(header);}
    catch(error){fs.rmSync(destination,{force:true});throw error;}
  };
  vault.openFile=async(source,destination,owner)=>{
    const {pipeline}=require('node:stream/promises');
    const size=fs.statSync(source).size,fd=fs.openSync(source,'r');
    let prefix,iv,tag,header;
    try{
      const start=Buffer.alloc(9);if(fs.readSync(fd,start,0,9,0)!==9||start.subarray(0,5).toString()!=='WBPK3')throw new Error('Invalid archive');
      const n=start.readUInt32BE(5);if(n<1||n>4096||size<9+n+12+16+1)throw new Error('Invalid archive');
      const bytes=Buffer.alloc(n);fs.readSync(fd,bytes,0,n,9);header=JSON.parse(bytes.toString('utf8'));
      if(header.format!=='adsworkbench-personal'||header.version!==3||header.owner_id!==owner||header.key_id!==keyId||typeof header.package_id!=='string'||!/^[a-f0-9-]{36}$/.test(header.package_id))throw new Error('Wrong archive owner or key');
      prefix=Buffer.concat([start,bytes]);iv=Buffer.alloc(12);tag=Buffer.alloc(16);fs.readSync(fd,iv,0,12,prefix.length);fs.readSync(fd,tag,0,16,size-16);
    }finally{fs.closeSync(fd);}
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(prefix);decipher.setAuthTag(tag);
    const partial=destination+'.partial';
    try{await pipeline(fs.createReadStream(source,{start:prefix.length+12,end:size-17}),decipher,fs.createWriteStream(partial,{flags:'wx',mode:0o600}));fs.renameSync(partial,destination);return header;}
    catch(error){fs.rmSync(partial,{force:true});throw new Error('Archive authentication failed');}
  };
  instances.set(db,vault); return vault;
}
function getVault(db) { const v=instances.get(db); if(!v) throw new Error('Vault not initialized'); return v; }
function encode(db, table, owner, field, value) {
  return SECRET_FIELDS.has(field) ? getVault(db).seal(value, `${table}:${owner}:${field}`) : value;
}
function decodeRow(db, table, row) {
  if(!row) return row;
  return Object.fromEntries(Object.entries(row).map(([k,v]) => [k, SECRET_FIELDS.has(k) ? getVault(db).open(v, `${table}:${row.owner_id}:${k}`) : v]));
}
function redact(value) {
  if(Array.isArray(value)) return value.map(redact);
  if(!value || typeof value!=='object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k])=>!['cvv','card_cvv'].includes(k)).map(([k,v]) => [k, SECRET_FIELDS.has(k) ? (v ? PROTECTED : '') : redact(v)]));
}
/**
 * 把「可能被分隔符拆开的号码」压成一串。
 *
 * 审计 F03：原先只 `replace(/[ -]/g,'')`，所以用 Tab 分组的
 * `4111\t1111\t1111\t1111` 能绕过 —— 组间的制表符打断了连续数字，
 * `\d{12,19}` 匹配不到，完整卡号就被当作「付款工具别名」存了下来。
 *
 * 现在先做 NFKC 归一（全角数字 ４→4、表意空格 → 普通空格），
 * 再去掉所有空白、标点与符号类字符，再检测 12–19 位连续数字。
 * 空格、Tab、全角空格、连字符、竖线、逗号、中点等都无法拆开号码。
 *
 * 取舍：这也会拒绝 12 位以上的纯数字引用编号（例如很长的订单号）。
 * 这是有意的 —— 付款工具别名只需要短引用，而漏放一个完整卡号的代价更高。
 * 这不是支付合规方案，只是把一条已知的泄漏路径收窄。
 */
const SEPARATORS = /[\s\p{P}\p{S}]/gu;
function compactDigits(value) {
  return String(value ?? '').normalize('NFKC').replace(SEPARATORS, '');
}
function assertNoCardSecrets(item) {
  for(const field of ['cvv','card_cvv','cvc','cvc2']) {
    if(item?.[field] != null && String(item[field]).trim()) {
      const e=new Error('\u4e0d\u63a5\u6536\u6216\u4fdd\u5b58 CVV/CVC\u3002\u8bf7\u4ec5\u5f55\u5165\u4ed8\u6b3e\u5de5\u5177\u522b\u540d\u548c\u672b\u56db\u4f4d\u3002'); e.statusCode=400; throw e;
    }
  }
  for(const field of ['number','card_number']) {
    if(item?.[field] && /\d{12,19}/.test(compactDigits(item[field]))) {
      const e=new Error('\u4e0d\u63a5\u6536\u5b8c\u6574\u5361\u53f7\u3002\u8bf7\u4f7f\u7528\u4ed8\u6b3e\u670d\u52a1\u5546\u7684\u5de5\u5177\u522b\u540d\u6216\u5f15\u7528\u7f16\u53f7\u3002'); e.statusCode=400; throw e;
    }
  }
}
module.exports={openVault,getVault,encode,decodeRow,redact,assertNoCardSecrets,compactDigits,SECRET_FIELDS,PREFIX,PROTECTED};
