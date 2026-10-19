'use strict';

/**
 * 仓储层：所有数据访问都经过这里，并且**一律带 owner_id**。
 *
 * 这是数据隔离的唯一收口点 —— 只要不绕过它，任何一个用户都不可能读到别人的资源或记录。
 * 唯一的例外是 licenses 的 dup_* 判重键，它需要跨用户查询（见 lib/dedup.js）。
 */

const { licenseKeys, findLicenseConflict } = require('./dedup');
const { encode, decodeRow, assertNoCardSecrets, SECRET_FIELDS, PROTECTED, getVault } = require('./vault');

const POOL_TYPES = ['emails', 'proxies', 'cards', 'licenses'];
const POOL_PREFIX = { emails: 'email', proxies: 'proxy', cards: 'card', licenses: 'license' };
const STATUSES = ['未使用', '已使用', '停用'];
const RECORD_STATUSES = ['正常', '异常', '停用'];

const POOL_FIELDS = {
  emails: ['user', 'pass', 'fakey'],
  proxies: ['sn', 'type', 'host', 'port', 'user', 'pass', 'country', 'ip'],
  cards: ['number', 'expiry', 'last4'],
  licenses: ['name', 'legal_name', 'address', 'apt', 'zip', 'city', 'type', 'cvr', 'jurisdiction', 'registration_type', 'registration_authority'],
};

// 供 client 使用前剥离的内部列
const INTERNAL_COLUMNS = new Set(['owner_id', 'dup_name', 'dup_legal', 'dup_cvr', 'dup_reg', 'dup_addr', 'cvv', 'card_cvv']);

const RECORD_FIELDS = [
  'seq', 'fingerprint', 'country', 'product', 'domain', 'name',
  'email_id', 'email_user', 'email_pass', 'email_fakey',
  'proxy_id', 'proxy_sn', 'proxy_type', 'proxy_host', 'proxy_port',
  'proxy_user', 'proxy_pass', 'proxy_country', 'proxy_ip',
  'card_id', 'card_number', 'card_expiry', 'card_last4',
  'license_id', 'license_name', 'ip_reg_time', 'id_card', 'status', 'created_at',
];

function toPublic(row) {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (!INTERNAL_COLUMNS.has(key)) out[key] = value;
  }
  return out;
}

const toPublicList = (rows) => rows.map(toPublic);

function readRow(db, table, row, { revealSecrets = true } = {}) {
  if (!row) return row;
  if (revealSecrets) return decodeRow(db, table, row);
  // 普通列表只需要知道“这个字段有值”，不需要先解密再由 onSend 脱敏。
  // 直接把密文字段投影成 [protected]，减少 CPU/密钥使用面，也避免把不需要的明文放进进程对象。
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    SECRET_FIELDS.has(key) ? (value ? PROTECTED : '') : value,
  ]));
}

/* ---------------- 资源池读数 ---------------- */

function listPool(db, ownerId, kind, options = {}) {
  if (!POOL_TYPES.includes(kind)) throw new Error(`未知资源类型 ${kind}`);
  return toPublicList(db.prepare(`SELECT * FROM ${kind} WHERE owner_id = ? ORDER BY id`).all(ownerId).map(row=>readRow(db,kind,row,options)));
}

function listAllPools(db, ownerId, options = {}) {
  const pools = {};
  for (const kind of POOL_TYPES) pools[kind] = listPool(db, ownerId, kind, options);
  return pools;
}

function findPoolItem(db, ownerId, kind, id) {
  if (!POOL_TYPES.includes(kind)) return undefined;
  return decodeRow(db,kind,db.prepare(`SELECT * FROM ${kind} WHERE owner_id = ? AND id = ?`).get(ownerId, id));
}

function getRecord(db, ownerId, id) {
  return decodeRow(db,'records',db.prepare('SELECT * FROM records WHERE owner_id = ? AND id = ?').get(ownerId, id));
}

function listRecords(db, ownerId, options = {}) {
  return toPublicList(db.prepare('SELECT * FROM records WHERE owner_id = ? ORDER BY id DESC').all(ownerId).map(row=>readRow(db,'records',row,options)));
}

/* ---------------- 记录列表的服务端分页（方案工作包 07「查询优化」） ---------------- */

/**
 * 记录列表的服务端分页查询。
 *
 * 旧路径 listRecords() 会把本账号的全部记录取回内存、逐行 decodeRow，再交给前端切片到
 * 50 条 —— 记录一多就是「读全部 + 传全部」。这里把分页、筛选与排序下推到 SQL，只取
 * 当前页，并用一次 COUNT 给出总数，供列表视图按需翻页。
 *
 * owner_id 恒定由调用方从会话取得，不接受客户端传入（与文档工作包 02 一致）。
 */
const RECORD_SORTS = {
  id_desc: 'id DESC',
  id_asc: 'id ASC',
  created_desc: 'created_at DESC, id DESC',
  created_asc: 'created_at ASC, id ASC',
};
/** 参与关键字搜索的列：都是用户本就可见的文本列，不含任何敏感字段。 */
const RECORD_SEARCH_COLUMNS = ['name', 'domain', 'country', 'product', 'fingerprint', 'email_user', 'proxy_host', 'proxy_sn', 'card_number', 'license_name'];

function listRecordsPage(db, ownerId, { limit = 50, offset = 0, q = '', status = '', sort = 'id_desc', revealSecrets = true } = {}) {
  const where = ['owner_id = ?'];
  const params = [ownerId];
  if (status) { where.push('status = ?'); params.push(String(status)); }
  const keyword = String(q ?? '').trim();
  if (keyword) {
    // 转义 LIKE 通配符：参数是绑定的，没有注入风险，这里只是为了「%」不被当成模式。
    const like = `%${keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push(`(${RECORD_SEARCH_COLUMNS.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (const _column of RECORD_SEARCH_COLUMNS) params.push(like);
  }
  const clause = where.join(' AND ');
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${clause}`).get(...params)?.n || 0);
  const rows = db.prepare(`SELECT * FROM records WHERE ${clause} ORDER BY ${RECORD_SORTS[sort] || RECORD_SORTS.id_desc} LIMIT ? OFFSET ?`)
    .all(...params, Math.max(Number(limit) || 50, 1), Math.max(Number(offset) || 0, 0));
  return { items: toPublicList(rows.map((row) => readRow(db, 'records', row, { revealSecrets }))), total };
}

function countRecordsByStatus(db, ownerId) {
  const out = { total: 0, 正常: 0, 异常: 0, 停用: 0 };
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM records WHERE owner_id = ? GROUP BY status').all(ownerId);
  for (const row of rows) {
    const n = Number(row.n || 0);
    out.total += n;
    if (Object.hasOwn(out, row.status)) out[row.status] = n;
  }
  return out;
}

function listRecordsForExport(db, ownerId, ids = [], { revealSecrets = true } = {}) {
  const selected = [...new Set((ids || []).map(Number))].filter((id) => Number.isSafeInteger(id) && id > 0);
  let rows;
  if (selected.length) {
    const placeholders = selected.map(() => '?').join(', ');
    rows = db.prepare(`SELECT * FROM records WHERE owner_id = ? AND id IN (${placeholders}) ORDER BY id ASC`).all(ownerId, ...selected);
  } else {
    rows = db.prepare('SELECT * FROM records WHERE owner_id = ? ORDER BY id ASC').all(ownerId);
  }
  return toPublicList(rows.map((row) => readRow(db, 'records', row, { revealSecrets })));
}

/* ---------------- 资源池写入 ---------------- */

function isUniqueViolation(error) {
  if (!error || typeof error.message !== 'string') return false;
  return error.message.includes('UNIQUE constraint failed')
    || error.message.includes('ambiguous registration identity');
}

/** 组装一行资源池数据（含 licenses 的判重键）。 */
function buildPoolRow(kind, item) {
  assertNoCardSecrets(item);
  const row = {};
  for (const field of POOL_FIELDS[kind]) row[field] = String(item?.[field] ?? '').trim();
  if (kind === 'licenses') row.legal_name = row.legal_name || row.name;
  return row;
}

function poolDuplicatePredicate(kind, item) {
  switch (kind) {
    case 'emails': return { sql: 'user = ? COLLATE NOCASE', params: [String(item.user).toLowerCase()] };
    case 'proxies': return { sql: 'host = ? COLLATE NOCASE AND port = ? AND user = ?', params: [item.host, item.port, item.user] };
    case 'cards': return { sql: 'number = ?', params: [item.number] };
    default: return null;
  }
}

/**
 * 插入一条资源。licenses 的判重不在这里（需要跨用户查询并给出归属信息），
 * 由 server.js 先调 dedup.findLicenseConflict 判定。
 */
function insertPoolRow(db, ownerId, kind, item, { createdAt }) {
  const row = buildPoolRow(kind, item);
  const columns = ['owner_id', 'status', 'created_at', ...POOL_FIELDS[kind]];
  const values = [ownerId, '未使用', createdAt, ...POOL_FIELDS[kind].map((f) => encode(db,kind,ownerId,f,row[f]))];
  if (kind === 'licenses') {
    const keys = licenseKeys(item);
    columns.push('dup_name', 'dup_legal', 'dup_cvr', 'dup_reg', 'dup_addr');
    values.push(keys.dup_name, keys.dup_legal, keys.dup_cvr, keys.dup_reg, keys.dup_addr);
  }
  const sql = `INSERT INTO ${kind} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  const info = db.prepare(sql).run(...values);
  return findPoolItem(db, ownerId, kind, Number(info.lastInsertRowid));
}

function updatePoolRow(db, ownerId, kind, id, item) {
  const row = buildPoolRow(kind, item);
  const sets = POOL_FIELDS[kind].map((f) => `${f} = ?`);
  const values = POOL_FIELDS[kind].map((f) => encode(db,kind,ownerId,f,row[f]));
  sets.push('version = version + 1');
  if (kind === 'licenses') {
    const keys = licenseKeys(item);
    sets.push('dup_name = ?', 'dup_legal = ?', 'dup_cvr = ?', 'dup_reg = ?', 'dup_addr = ?');
    values.push(keys.dup_name, keys.dup_legal, keys.dup_cvr, keys.dup_reg, keys.dup_addr);
  }
  values.push(ownerId, id);
  const info = db.prepare(`UPDATE ${kind} SET ${sets.join(', ')} WHERE owner_id = ? AND id = ?`).run(...values);
  return info.changes ? findPoolItem(db, ownerId, kind, id) : undefined;
}

function setPoolStatus(db, ownerId, kind, id, status, { bumpVersion = true } = {}) {
  const versionSql = bumpVersion ? ', version = version + 1' : '';
  const info = db.prepare(`UPDATE ${kind} SET status = ?${versionSql} WHERE owner_id = ? AND id = ?`).run(status, ownerId, id);
  return info.changes ? findPoolItem(db, ownerId, kind, id) : undefined;
}

function deletePoolRow(db, ownerId, kind, id) {
  return db.prepare(`DELETE FROM ${kind} WHERE owner_id = ? AND id = ?`).run(ownerId, id).changes;
}

function countPoolByStatus(db, ownerId) {
  const out = {};
  for (const kind of POOL_TYPES) {
    const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM ${kind} WHERE owner_id = ? GROUP BY status`).all(ownerId);
    out[kind] = { total: 0, 未使用: 0, 已使用: 0, 停用: 0 };
    for (const row of rows) {
      out[kind][row.status] = row.n;
      out[kind].total += row.n;
    }
  }
  return out;
}

/* ---------------- 记录 ---------------- */

function nextSeq(db, ownerId) {
  const row = db.prepare('SELECT MAX(seq) AS max FROM records WHERE owner_id = ?').get(ownerId);
  return Number(row?.max || 0) + 1;
}

function fingerprintExists(db, ownerId, fingerprint) {
  return !!db.prepare('SELECT 1 AS x FROM records WHERE owner_id = ? AND fingerprint = ?').get(ownerId, fingerprint);
}

function insertRecord(db, ownerId, record) {
  assertNoCardSecrets(record);
  const columns = ['owner_id', ...RECORD_FIELDS];
  const values = [ownerId, ...RECORD_FIELDS.map((f) => {
    const value = record[f];
    if (value === null || value === undefined) return RECORD_FIELDS.includes(f) && (f.endsWith('_id')) ? null : '';
    return encode(db,'records',ownerId,f,value);
  })];
  const info = db.prepare(`INSERT INTO records (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...values);
  return Number(info.lastInsertRowid);
}

function updateRecordColumns(db, ownerId, id, patch) {
  assertNoCardSecrets(patch);
  const keys = Object.keys(patch).filter((k) => RECORD_FIELDS.includes(k) && patch[k] !== PROTECTED);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`);
  sets.push('version = version + 1');
  db.prepare(`UPDATE records SET ${sets.join(', ')} WHERE owner_id = ? AND id = ?`)
    .run(...keys.map((k) => encode(db,'records',ownerId,k,patch[k])), ownerId, id);
}

function deleteRecordRows(db, ownerId, ids) {
  const list = [...new Set(ids.map(Number))].filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!list.length) return [];
  const placeholders = list.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT * FROM records WHERE owner_id = ? AND id IN (${placeholders})`).all(ownerId, ...list);
  db.prepare(`DELETE FROM records WHERE owner_id = ? AND id IN (${placeholders})`).run(ownerId, ...list);
  return rows;
}

function recordsUsingResource(db, ownerId, prefix, resourceId, excludeRecordId = null) {
  const column = `${prefix}_id`;
  if (excludeRecordId == null) {
    return db.prepare(`SELECT id FROM records WHERE owner_id = ? AND ${column} = ?`).all(ownerId, resourceId);
  }
  return db.prepare(`SELECT id FROM records WHERE owner_id = ? AND ${column} = ? AND id <> ?`).all(ownerId, resourceId, excludeRecordId);
}

function latestRecord(db, ownerId) {
  return decodeRow(db,'records',db.prepare('SELECT * FROM records WHERE owner_id = ? ORDER BY id DESC LIMIT 1').get(ownerId));
}

function findLicenseByDocument(db, ownerId, documentId) {
  return db.prepare('SELECT * FROM licenses WHERE owner_id = ? AND document_id = ?').get(ownerId, documentId);
}

function listLicenses(db, ownerId) {
  return db.prepare('SELECT * FROM licenses WHERE owner_id = ? ORDER BY id').all(ownerId);
}

/* ---------------- 附件（原件 PDF） ---------------- */

function putDocument(db, ownerId, { sha256, filename, bytes, createdAt }) {
  const prior=db.prepare('SELECT owner_id FROM document_registry WHERE sha256=?').get(sha256);
  if(prior && prior.owner_id!==ownerId) {const e=new Error('PDF already registered');e.statusCode=409;throw e;}
  db.prepare('INSERT INTO document_registry(sha256,owner_id,created_at) VALUES(?,?,?) ON CONFLICT(sha256) DO NOTHING').run(sha256,ownerId,createdAt);
  // 同一份 PDF 全库只存一份，但绝不去改写已存在的那一行：
  // 它可能属于别人，跨账号写别人的行既不必要也会泄漏文件名。
  db.prepare(`
    INSERT INTO documents (sha256, owner_id, filename, size, bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(sha256) DO NOTHING
  `).run(sha256, ownerId, filename, bytes.length, getVault(db).sealBytes(bytes,`pdf:${ownerId}:${sha256}`), createdAt);
}

function getDocument(db, sha256) {
  const row=db.prepare('SELECT sha256, owner_id, filename, size, bytes FROM documents WHERE sha256 = ?').get(sha256);
  return row ? {...row,bytes:getVault(db).openBytes(row.bytes,`pdf:${row.owner_id}:${sha256}`)} : undefined;
}

/**
 * 清理没有被任何营业执照引用的原件。
 * 必须是**全局**判断：只按当前用户来清理会误删其他用户的附件。
 */
function pruneDocuments(db) {
  return db.prepare(`
    DELETE FROM documents
     WHERE sha256 NOT IN (SELECT document_id FROM licenses WHERE document_id IS NOT NULL)
  `).run().changes;
}

/* ---------------- 用户 ---------------- */

function findUserByUsername(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').trim());
}

function findUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function countUsers(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
}

function insertUser(db, { username, displayName, passwordHash, createdAt }) {
  const info = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)
  `).run(username, displayName || '', passwordHash, createdAt);
  return findUserById(db, Number(info.lastInsertRowid));
}

function touchLogin(db, userId, at) {
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(at, userId);
}

/* ---------------- 迁移：把旧 data.json 挂到某个账号名下 ---------------- */

/**
 * 把旧版单机 data.json 的内容整体导入到 ownerId 名下。
 * 已存在的资源与记录会被跳过（按 id 判重），因此可安全重复调用。
 */
function adoptLegacySnapshot(db, ownerId, snapshot, { createdAt }) {
  const stats = { emails:0, proxies:0, cards:0, licenses:0, records:0, documents:0, skipped:0 };
  const maps=Object.fromEntries(POOL_TYPES.map(k=>[k,new Map()]));
  for(const kind of POOL_TYPES) {
    for(const item of snapshot[kind] || []) {
      assertNoCardSecrets(item);
      let existing;
      if(kind==='licenses') {
        const conflict=findLicenseConflict(db,licenseKeys(item),{excludeOwnerId:ownerId});
        if(conflict) { const e=new Error('\u5907\u4efd\u8d44\u6599\u4e0e\u5df2\u767b\u8bb0\u7684\u4f01\u4e1a\u51b2\u7a81\uff0c\u6062\u590d\u5df2\u53d6\u6d88');e.statusCode=409;throw e; }
        const keys=licenseKeys(item);
        existing=db.prepare('SELECT id FROM licenses WHERE owner_id=? AND ((dup_name IS NOT NULL AND dup_name=?) OR (dup_cvr IS NOT NULL AND dup_cvr=?))').get(ownerId,keys.dup_name,keys.dup_cvr);
      } else {
        const predicate=poolDuplicatePredicate(kind,item);
        existing=db.prepare(`SELECT id FROM ${kind} WHERE owner_id=? AND ${predicate.sql}`).get(ownerId,...predicate.params);
      }
      if(existing) { maps[kind].set(item.id,existing.id); stats.skipped++; continue; }
      const row=insertPoolRow(db,ownerId,kind,item,{createdAt}); maps[kind].set(item.id,row.id);
      if(STATUSES.includes(item.status)) setPoolStatus(db,ownerId,kind,row.id,item.status);
      if(kind==='licenses' && item.document_id) {
        db.prepare('UPDATE licenses SET document_id=?, document_name=?, document_size=? WHERE owner_id=? AND id=?').run(item.document_id,item.document_name||'certificate.pdf',Number(item.document_size)||0,ownerId,row.id);
      }
      stats[kind]++;
    }
  }
  for(const item of snapshot.records||[]) {
    if(fingerprintExists(db,ownerId,item.fingerprint||'')) {stats.skipped++;continue;}
    const record={...item};
    for(const [kind,prefix] of Object.entries(POOL_PREFIX)) {
      const id=item[`${prefix}_id`];
      if(id==null) record[`${prefix}_id`]=null;
      else {
        const newId=maps[kind].get(id);
        if(newId==null) throw new Error('Backup resource mapping failed');
        record[`${prefix}_id`]=newId;
      }
    }
    record.created_at=item.created_at||createdAt;
    insertRecord(db,ownerId,record);stats.records++;
  }
  for(const [sha,doc] of Object.entries(snapshot.documents||{})) {
    putDocument(db,ownerId,{sha256:sha,filename:doc.filename||'certificate.pdf',bytes:Buffer.from(doc.base64,'base64'),createdAt});stats.documents++;
  }
  return stats;
}

module.exports = {
  POOL_TYPES, POOL_PREFIX, POOL_FIELDS, STATUSES, RECORD_STATUSES, RECORD_FIELDS,
  toPublic, toPublicList, isUniqueViolation,
  listPool, listAllPools, findPoolItem, listRecords, listRecordsPage, countRecordsByStatus, listRecordsForExport, getRecord,
  RECORD_SORTS,
  buildPoolRow, poolDuplicatePredicate, insertPoolRow, updatePoolRow, setPoolStatus,
  deletePoolRow, countPoolByStatus,
  nextSeq, fingerprintExists, insertRecord, updateRecordColumns, deleteRecordRows,
  recordsUsingResource, latestRecord, findLicenseByDocument, listLicenses,
  putDocument, getDocument, pruneDocuments,
  findUserByUsername, findUserById, countUsers, insertUser, touchLogin,
  adoptLegacySnapshot,
};
