'use strict';

/**
 * 仓储层：所有数据访问都经过这里，并且**一律带 owner_id**。
 *
 * 这是数据隔离的唯一收口点 —— 只要不绕过它，任何一个用户都不可能读到别人的资源或记录。
 * 唯一的例外是 licenses 的 dup_* 判重键，它需要跨用户查询（见 lib/dedup.js）。
 */

const { licenseKeys } = require('./dedup');

const POOL_TYPES = ['emails', 'proxies', 'cards', 'licenses'];
const POOL_PREFIX = { emails: 'email', proxies: 'proxy', cards: 'card', licenses: 'license' };
const STATUSES = ['未使用', '已使用', '停用'];
const RECORD_STATUSES = ['正常', '异常', '停用'];

const POOL_FIELDS = {
  emails: ['user', 'pass', 'fakey'],
  proxies: ['sn', 'type', 'host', 'port', 'user', 'pass', 'country', 'ip'],
  cards: ['number', 'expiry', 'cvv'],
  licenses: ['name', 'legal_name', 'address', 'apt', 'zip', 'city', 'type', 'cvr'],
};

// 供 client 使用前剥离的内部列
const INTERNAL_COLUMNS = new Set(['owner_id', 'dup_name', 'dup_legal', 'dup_cvr', 'dup_addr']);

const RECORD_FIELDS = [
  'seq', 'fingerprint', 'country', 'product', 'domain', 'name',
  'email_id', 'email_user', 'email_pass', 'email_fakey',
  'proxy_id', 'proxy_sn', 'proxy_type', 'proxy_host', 'proxy_port',
  'proxy_user', 'proxy_pass', 'proxy_country', 'proxy_ip',
  'card_id', 'card_number', 'card_expiry', 'card_cvv',
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

/* ---------------- 资源池读数 ---------------- */

function listPool(db, ownerId, kind) {
  if (!POOL_TYPES.includes(kind)) throw new Error(`未知资源类型 ${kind}`);
  return toPublicList(db.prepare(`SELECT * FROM ${kind} WHERE owner_id = ? ORDER BY id`).all(ownerId));
}

function listAllPools(db, ownerId) {
  const pools = {};
  for (const kind of POOL_TYPES) pools[kind] = listPool(db, ownerId, kind);
  return pools;
}

function findPoolItem(db, ownerId, kind, id) {
  if (!POOL_TYPES.includes(kind)) return undefined;
  return db.prepare(`SELECT * FROM ${kind} WHERE owner_id = ? AND id = ?`).get(ownerId, id);
}

function getRecord(db, ownerId, id) {
  return db.prepare('SELECT * FROM records WHERE owner_id = ? AND id = ?').get(ownerId, id);
}

function listRecords(db, ownerId) {
  return toPublicList(db.prepare('SELECT * FROM records WHERE owner_id = ? ORDER BY id DESC').all(ownerId));
}

/* ---------------- 资源池写入 ---------------- */

function isUniqueViolation(error) {
  return !!error && typeof error.message === 'string' && error.message.includes('UNIQUE constraint failed');
}

/** 组装一行资源池数据（含 licenses 的判重键）。 */
function buildPoolRow(kind, item) {
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
  const values = [ownerId, '未使用', createdAt, ...POOL_FIELDS[kind].map((f) => row[f])];
  if (kind === 'licenses') {
    const keys = licenseKeys(item);
    columns.push('dup_name', 'dup_legal', 'dup_cvr', 'dup_addr');
    values.push(keys.dup_name, keys.dup_legal, keys.dup_cvr, keys.dup_addr);
  }
  const sql = `INSERT INTO ${kind} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  const info = db.prepare(sql).run(...values);
  return findPoolItem(db, ownerId, kind, Number(info.lastInsertRowid));
}

function updatePoolRow(db, ownerId, kind, id, item) {
  const row = buildPoolRow(kind, item);
  const sets = POOL_FIELDS[kind].map((f) => `${f} = ?`);
  const values = POOL_FIELDS[kind].map((f) => row[f]);
  if (kind === 'licenses') {
    const keys = licenseKeys(item);
    sets.push('dup_name = ?', 'dup_legal = ?', 'dup_cvr = ?', 'dup_addr = ?');
    values.push(keys.dup_name, keys.dup_legal, keys.dup_cvr, keys.dup_addr);
  }
  values.push(ownerId, id);
  const info = db.prepare(`UPDATE ${kind} SET ${sets.join(', ')} WHERE owner_id = ? AND id = ?`).run(...values);
  return info.changes ? findPoolItem(db, ownerId, kind, id) : undefined;
}

function setPoolStatus(db, ownerId, kind, id, status) {
  const info = db.prepare(`UPDATE ${kind} SET status = ? WHERE owner_id = ? AND id = ?`).run(status, ownerId, id);
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
  const columns = ['owner_id', ...RECORD_FIELDS];
  const values = [ownerId, ...RECORD_FIELDS.map((f) => {
    const value = record[f];
    if (value === null || value === undefined) return RECORD_FIELDS.includes(f) && (f.endsWith('_id')) ? null : '';
    return value;
  })];
  const info = db.prepare(`INSERT INTO records (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...values);
  return Number(info.lastInsertRowid);
}

function updateRecordColumns(db, ownerId, id, patch) {
  const keys = Object.keys(patch).filter((k) => RECORD_FIELDS.includes(k));
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`);
  db.prepare(`UPDATE records SET ${sets.join(', ')} WHERE owner_id = ? AND id = ?`)
    .run(...keys.map((k) => patch[k]), ownerId, id);
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
  return db.prepare('SELECT * FROM records WHERE owner_id = ? ORDER BY id DESC LIMIT 1').get(ownerId);
}

function findLicenseByDocument(db, ownerId, documentId) {
  return db.prepare('SELECT * FROM licenses WHERE owner_id = ? AND document_id = ?').get(ownerId, documentId);
}

function listLicenses(db, ownerId) {
  return db.prepare('SELECT * FROM licenses WHERE owner_id = ? ORDER BY id').all(ownerId);
}

/* ---------------- 附件（原件 PDF） ---------------- */

function putDocument(db, ownerId, { sha256, filename, bytes, createdAt }) {
  // 同一份 PDF 全库只存一份，但绝不去改写已存在的那一行：
  // 它可能属于别人，跨账号写别人的行既不必要也会泄漏文件名。
  db.prepare(`
    INSERT INTO documents (sha256, owner_id, filename, size, bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(sha256) DO NOTHING
  `).run(sha256, ownerId, filename, bytes.length, bytes, createdAt);
}

function getDocument(db, sha256) {
  return db.prepare('SELECT sha256, filename, size, bytes FROM documents WHERE sha256 = ?').get(sha256);
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
  const stats = { emails: 0, proxies: 0, cards: 0, licenses: 0, records: 0, documents: 0, skipped: 0 };

  for (const kind of POOL_TYPES) {
    for (const item of snapshot[kind] || []) {
      const predicate = poolDuplicatePredicate(kind, item);
      let existing = null;
      if (kind === 'licenses') {
        existing = db.prepare('SELECT id FROM licenses WHERE dup_name IS NOT NULL AND dup_name = ? OR dup_cvr IS NOT NULL AND dup_cvr = ?')
          .get(licenseKeys(item).dup_name, licenseKeys(item).dup_cvr);
      } else if (predicate) {
        existing = db.prepare(`SELECT id FROM ${kind} WHERE owner_id = ? AND ${predicate.sql}`).get(ownerId, ...predicate.params);
      }
      if (existing) { stats.skipped += 1; continue; }
      const row = insertPoolRow(db, ownerId, kind, item, { createdAt });
      if (item.status && STATUSES.includes(item.status)) setPoolStatus(db, ownerId, kind, row.id, item.status);
      // 旧版迁移/本人恢复时保留原 PDF 的关联，不能只恢复组织字段而丢失附件。
      if (kind === 'licenses' && item.document_id) {
        db.prepare('UPDATE licenses SET document_id = ?, document_name = ?, document_size = ? WHERE owner_id = ? AND id = ?')
          .run(item.document_id, item.document_name || '营业执照.pdf', Number(item.document_size) || 0, ownerId, row.id);
      }
      stats[kind] += 1;
    }
  }

  const idMap = {};
  for (const kind of POOL_TYPES) {
    const rows = db.prepare(`SELECT id FROM ${kind} WHERE owner_id = ? ORDER BY id`).all(ownerId);
    idMap[kind] = rows.map((r) => r.id);
  }

  for (const item of snapshot.records || []) {
    if (fingerprintExists(db, ownerId, item.fingerprint || '')) { stats.skipped += 1; continue; }
    const record = { ...item };
    // 旧 id 通过同序号映射到新 id，保持资源关联关系
    for (const [kind, prefix] of Object.entries(POOL_PREFIX)) {
      const oldId = item[`${prefix}_id`];
      if (oldId == null) { record[`${prefix}_id`] = null; continue; }
      const position = (snapshot[kind] || []).findIndex((row) => row.id === oldId);
      record[`${prefix}_id`] = position >= 0 ? idMap[kind][position] ?? null : null;
    }
    record.created_at = item.created_at || createdAt;
    insertRecord(db, ownerId, record);
    stats.records += 1;
  }

  for (const [sha, document] of Object.entries(snapshot.documents || {})) {
    if (!document || typeof document.base64 !== 'string') continue;
    const bytes = Buffer.from(document.base64, 'base64');
    if (!bytes.length) continue;
    putDocument(db, ownerId, {
      sha256: sha,
      filename: document.filename || '营业执照.pdf',
      bytes,
      createdAt,
    });
    stats.documents += 1;
  }

  return stats;
}

module.exports = {
  POOL_TYPES, POOL_PREFIX, POOL_FIELDS, STATUSES, RECORD_STATUSES, RECORD_FIELDS,
  toPublic, toPublicList, isUniqueViolation,
  listPool, listAllPools, findPoolItem, listRecords, getRecord,
  buildPoolRow, poolDuplicatePredicate, insertPoolRow, updatePoolRow, setPoolStatus,
  deletePoolRow, countPoolByStatus,
  nextSeq, fingerprintExists, insertRecord, updateRecordColumns, deleteRecordRows,
  recordsUsingResource, latestRecord, findLicenseByDocument, listLicenses,
  putDocument, getDocument, pruneDocuments,
  findUserByUsername, findUserById, countUsers, insertUser, touchLogin,
  adoptLegacySnapshot,
};
