'use strict';
/** Global business identity matching. Shared addresses are not identities. */
const ADDRESS_MODE=['reject','warn','off'].includes(process.env.DEDUP_ADDRESS_MODE)?process.env.DEDUP_ADDRESS_MODE:'reject';
const SUFFIXES=new Set(['aps','as','ivs','is','ks','ab','oy','oyj','ltd','limited','llc','inc','incorporated','gmbh','bv','nv','pte','srl','sarl','sa','ag','spa','plc','corp','corporation','co','company','holding','holdings','group','gruppen','dk','denmark','danmark','apsdk']);
const LETTER_MAP={'æ':'ae','ø':'o','å':'a','ä':'a','ö':'o','ü':'u','ß':'ss','þ':'th','ð':'d'};
function fold(value){return String(value??'').toLowerCase().replace(/[æøåäöüßþð]/g,ch=>LETTER_MAP[ch]??ch).replace(/[\uFF01-\uFF5E]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-0xfee0)).normalize('NFKD').replace(/[\u0300-\u036f]/g,'');}
function normalizeCompanyName(value){
  const folded=fold(value).replace(/\ba\s*\.?\s*p\s*\.?\s*s\s*\.?/g,'aps').replace(/\bi\s*\.?\s*v\s*\.?\s*s\s*\.?/g,'ivs').replace(/\b([a-z])\s*\/\s*([a-z])\b/g,'$1$2').replace(/\b([a-z])\.([a-z])\.([a-z])\.?/g,'$1$2$3').replace(/([a-z])\.(?=[a-z])/g,'$1');
  const words=folded.replace(/[^a-z0-9]+/g,' ').trim().split(' ').filter(Boolean);
  while(words.length>1&&SUFFIXES.has(words[words.length-1]))words.pop();
  const joined=words.join('');return joined.length>=2?joined:null;
}
function normalizeRegistrationNumber(value){const digits=String(value??'').replace(/\D+/g,'');return digits.length>=6?digits:null;}
function normalizeAddress(value){const text=fold(value).replace(/\b(denmark|danmark|dk)\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');return text.length>=6?text:null;}
function licenseKeys(item){const name=String(item?.name??'').trim(),legal=String(item?.legal_name??'').trim()||name;return {dup_name:normalizeCompanyName(name),dup_legal:normalizeCompanyName(legal),dup_cvr:normalizeRegistrationNumber(item?.cvr),dup_addr:normalizeAddress(item?.address)};}
const FIELD_LABEL={cvr:'CVR 注册号',name:'组织名称',legal:'法定名称',address:'街道地址'};
/** Returns blocking conflicts only. warn mode leaves address matches to internal audit. */
function findLicenseConflict(db,keys,{excludeId=null,excludeOwnerId=null,addressMode=ADDRESS_MODE}={}){
  if(!keys.dup_name&&!keys.dup_legal&&!keys.dup_cvr&&!(addressMode==='reject'&&keys.dup_addr))return null;
  const params=[keys.dup_cvr,keys.dup_name,keys.dup_legal,keys.dup_addr,keys.dup_cvr,keys.dup_name,keys.dup_legal,keys.dup_addr];
  const rows=db.prepare(`SELECT l.id,l.name,l.legal_name,l.cvr,l.address,l.created_at,l.owner_id,u.username,u.display_name,
    (l.dup_cvr IS NOT NULL AND l.dup_cvr=?) AS m_cvr,(l.dup_name IS NOT NULL AND l.dup_name=?) AS m_name,
    (l.dup_legal IS NOT NULL AND l.dup_legal=?) AS m_legal,(l.dup_addr IS NOT NULL AND l.dup_addr=?) AS m_addr
    FROM licenses l JOIN users u ON u.id=l.owner_id
    WHERE (l.dup_cvr IS NOT NULL AND l.dup_cvr=?) OR (l.dup_name IS NOT NULL AND l.dup_name=?) OR (l.dup_legal IS NOT NULL AND l.dup_legal=?) OR (l.dup_addr IS NOT NULL AND l.dup_addr=?)`).all(...params);
  const candidates=rows.filter(row=>row.id!==excludeId&&row.owner_id!==excludeOwnerId),pick=flag=>candidates.find(row=>row[flag]===1);
  const chosen=(keys.dup_cvr&&pick('m_cvr'))||(keys.dup_name&&pick('m_name'))||(keys.dup_legal&&pick('m_legal'))||(addressMode==='reject'&&keys.dup_addr&&pick('m_addr'))||null;
  if(!chosen)return null;
  const field=chosen.m_cvr?'cvr':chosen.m_name?'name':chosen.m_legal?'legal':'address';
  return {field,label:FIELD_LABEL[field],weak:false,license:{id:chosen.id,name:chosen.name,legal_name:chosen.legal_name,cvr:chosen.cvr,address:chosen.address,created_at:chosen.created_at},owner:{id:chosen.owner_id,username:chosen.username,display_name:chosen.display_name||chosen.username}};
}
/** Safe to display: never disclose another member's identity or original values. */
function conflictMessage(conflict){return `该资料已存在，不能重复保存（判重依据：${conflict.label}）。`;}
/** Internal operator-only audit; no public API exposes these member details. */
function auditLicenses(db,{addressMode=ADDRESS_MODE}={}){
  const owner=new Map(db.prepare('SELECT id,username,display_name FROM users').all().map(row=>[row.id,{username:row.username,display_name:row.display_name||row.username}]));
  const all=db.prepare('SELECT id,owner_id,name,legal_name,cvr,address,zip,city,status,document_id,created_at,dup_name,dup_legal,dup_cvr,dup_addr FROM licenses ORDER BY id').all();
  const groups=[],seenGroupKeys=new Set();
  const dimensions=[['cvr','dup_cvr','CVR 注册号'],['name','dup_name','组织名称'],['legal','dup_legal','法定名称'],...(addressMode==='off'?[]:[['address','dup_addr','街道地址']])];
  for(const [field,column,label] of dimensions){
    const buckets=new Map();
    for(const row of all){const key=row[column];if(!key)continue;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(row);}
    for(const [key,members] of buckets){
      if(members.length<2)continue;const groupKey=`${field}:${key}`;if(seenGroupKeys.has(groupKey))continue;seenGroupKeys.add(groupKey);
      groups.push({field,label,key,members:members.map(row=>({id:row.id,name:row.name,legal_name:row.legal_name,cvr:row.cvr,address:row.address,status:row.status,has_pdf:!!row.document_id,created_at:row.created_at,owner:owner.get(row.owner_id)||{username:'未知',display_name:'未知'}}))});
    }
  }
  const shared=db.prepare('SELECT document_id,COUNT(*) AS n FROM licenses WHERE document_id IS NOT NULL GROUP BY document_id HAVING n>1').all();
  const sharedDocuments=shared.map(row=>({document_id:row.document_id,count:row.n,members:all.filter(l=>l.document_id===row.document_id).map(l=>({id:l.id,name:l.name,created_at:l.created_at,owner:owner.get(l.owner_id)||{username:'未知',display_name:'未知'}}))}));
  return {scanned:all.length,users:owner.size,groups,shared_documents:sharedDocuments,duplicate_licenses:new Set(groups.flatMap(g=>g.members.map(m=>m.id))).size};
}
/** An address match must never turn a distinct company into an update of an existing one. */
function rowMatchesKeys(row,keys){return ['dup_cvr','dup_name','dup_legal'].some(field=>keys[field]!=null&&row[field]!=null&&row[field]===keys[field]);}
module.exports={ADDRESS_MODE,licenseKeys,normalizeCompanyName,normalizeRegistrationNumber,normalizeAddress,rowMatchesKeys,findLicenseConflict,conflictMessage,auditLicenses};
