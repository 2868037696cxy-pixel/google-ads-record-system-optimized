'use strict';

/**
 * 营业执照判重：归一化 + 跨用户全局查重。
 *
 * 判重口径（用户指定）：组织名称 / 法定名称 / CVR 注册号 / 街道地址，任一命中即视为重复。
 * 查重范围是**全体用户**，不是当前用户 —— 谁先导入谁占住这家公司。
 *
 * 名称、法定名称、CVR 三项在数据库层有全局唯一索引兜底；地址只做应用层判断，
 * 因为同一地址可能真实存在多家公司（共用注册地址很常见），需要留出豁免余地。
 */

const ADDRESS_MODE = ['reject', 'warn', 'off'].includes(process.env.DEDUP_ADDRESS_MODE)
  ? process.env.DEDUP_ADDRESS_MODE
  : 'reject';

// 常见公司后缀，判重时忽略（ApS / A/S / IVS / Ltd / GmbH ...）
const SUFFIXES = new Set([
  'aps', 'as', 'ivs', 'is', 'ks', 'ab', 'oy', 'oyj', 'ltd', 'limited', 'llc', 'inc',
  'incorporated', 'gmbh', 'bv', 'nv', 'pte', 'srl', 'sarl', 'sa', 'ag', 'spa', 'plc',
  'corp', 'corporation', 'co', 'company', 'holding', 'holdings', 'group', 'gruppen',
  'dk', 'denmark', 'danmark', 'apsdk',
]);

// 丹麦语等特殊字母先做等价替换（NFKD 不会拆开 ø / æ / å）
const LETTER_MAP = { 'æ': 'ae', 'ø': 'o', 'å': 'a', 'ä': 'a', 'ö': 'o', 'ü': 'u', 'ß': 'ss', 'þ': 'th', 'ð': 'd' };

function fold(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[æøåäöüßþð]/g, (ch) => LETTER_MAP[ch] ?? ch)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** 公司名归一化：去标点、去公司后缀、连成一体，用于容错比对。 */
function normalizeCompanyName(value) {
  const folded = fold(value)
    // 先把同一后缀的不同写法收敛成连写形式，否则 "A/S" 会被标点拆成 "a s" 而漏判
    .replace(/\ba\s*\.?\s*p\s*\.?\s*s\s*\.?/g, 'aps')
    .replace(/\bi\s*\.?\s*v\s*\.?\s*s\s*\.?/g, 'ivs')
    .replace(/\b([a-z])\s*\/\s*([a-z])\b/g, '$1$2')
    .replace(/\b([a-z])\.([a-z])\.([a-z])\.?/g, '$1$2$3')
    // 缩写里的点统一去掉（A.B.C. -> abc）
    .replace(/([a-z])\.(?=[a-z])/g, '$1');
  const words = folded.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  const joined = words.join('');
  return joined.length >= 2 ? joined : null;
}

/** CVR / 注册号：只保留数字。 */
function normalizeRegistrationNumber(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  return digits.length >= 6 ? digits : null;
}

/** 地址归一化：去标点、压空白、去掉国家前缀。 */
function normalizeAddress(value) {
  const text = fold(value)
    .replace(/\b(denmark|danmark|dk)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return text.length >= 6 ? text : null;
}

/** 从一条营业执照数据算出四个判重键（空值一律为 null，以便唯一索引允许多行空值）。 */
function licenseKeys(item) {
  const name = String(item?.name ?? '').trim();
  const legal = String(item?.legal_name ?? '').trim() || name;
  return {
    dup_name: normalizeCompanyName(name),
    dup_legal: normalizeCompanyName(legal),
    dup_cvr: normalizeRegistrationNumber(item?.cvr),
    dup_addr: normalizeAddress(item?.address),
  };
}

const FIELD_LABEL = { cvr: 'CVR 注册号', name: '组织名称', legal: '法定名称', address: '街道地址' };
const WEAKEST = ['cvr', 'name', 'legal', 'address']; // 越靠前证据越强

/**
 * 在全体用户的营业执照里查找与 keys 冲突的记录。
 * @returns {null | { field: string, label: string, license: object, owner: object, weak: boolean }}
 */
function findLicenseConflict(db, keys, { excludeId = null, addressMode = ADDRESS_MODE } = {}) {
  if (!keys.dup_name && !keys.dup_legal && !keys.dup_cvr && !(addressMode !== 'off' && keys.dup_addr)) return null;
  const params = [
    keys.dup_cvr, keys.dup_name, keys.dup_legal, keys.dup_addr,
    keys.dup_cvr, keys.dup_name, keys.dup_legal, keys.dup_addr,
  ];
  const rows = db.prepare(`
    SELECT l.id, l.name, l.legal_name, l.cvr, l.address, l.created_at, l.owner_id,
           u.username, u.display_name,
           (l.dup_cvr  IS NOT NULL AND l.dup_cvr  = ?) AS m_cvr,
           (l.dup_name IS NOT NULL AND l.dup_name = ?) AS m_name,
           (l.dup_legal IS NOT NULL AND l.dup_legal = ?) AS m_legal,
           (l.dup_addr IS NOT NULL AND l.dup_addr = ?) AS m_addr
      FROM licenses l
      JOIN users u ON u.id = l.owner_id
     WHERE (l.dup_cvr   IS NOT NULL AND l.dup_cvr   = ?)
        OR (l.dup_name  IS NOT NULL AND l.dup_name  = ?)
        OR (l.dup_legal IS NOT NULL AND l.dup_legal = ?)
        OR (l.dup_addr  IS NOT NULL AND l.dup_addr  = ?)
  `).all(...params);

  if (!rows.length) return null;
  const candidates = rows.filter((row) => row.id !== excludeId);
  if (!candidates.length) return null;

  const pick = (flag) => candidates.find((row) => row[flag] === 1);
  const chosen =
    (keys.dup_cvr && pick('m_cvr')) ||
    (keys.dup_name && pick('m_name')) ||
    (keys.dup_legal && pick('m_legal')) ||
    (addressMode !== 'off' && keys.dup_addr && pick('m_addr')) ||
    null;
  if (!chosen) return null;

  const field = chosen.m_cvr ? 'cvr' : chosen.m_name ? 'name' : chosen.m_legal ? 'legal' : 'address';
  return {
    field,
    label: FIELD_LABEL[field],
    weak: field === 'address' && addressMode === 'warn',
    license: {
      id: chosen.id, name: chosen.name, legal_name: chosen.legal_name,
      cvr: chosen.cvr, address: chosen.address, created_at: chosen.created_at,
    },
    owner: { id: chosen.owner_id, username: chosen.username, display_name: chosen.display_name || chosen.username },
  };
}

/** 把冲突信息拼成给用户看的中文提示。 */
function conflictMessage(conflict, { includePdf = false } = {}) {
  const who = conflict.owner.display_name || conflict.owner.username;
  const when = String(conflict.license.created_at || '').slice(0, 16);
  const head = conflict.field === 'address'
    ? `该地址已被占用：${conflict.license.name}`
    : `该公司资料已存在：${conflict.license.name}`;
  const tail = includePdf && conflict.license.cvr ? `（CVR ${conflict.license.cvr}）` : '';
  return `${head}${tail}，已由 ${who} 于 ${when} 导入（判重依据：${conflict.label}）。如确认不冲突，请联系对方核对。`;
}

/**
 * 全局重复体检：扫描**所有用户**的营业执照，找出任何形式的重复。
 * 用于发现历史遗留数据里的重复（数据库唯一索引只能挡住新增的重复）。
 */
function auditLicenses(db, { addressMode = ADDRESS_MODE } = {}) {
  const owner = new Map(
    db.prepare('SELECT id, username, display_name FROM users').all()
      .map((row) => [row.id, { username: row.username, display_name: row.display_name || row.username }]),
  );
  const all = db.prepare(`
    SELECT id, owner_id, name, legal_name, cvr, address, zip, city, status,
           document_id, created_at, dup_name, dup_legal, dup_cvr, dup_addr
      FROM licenses ORDER BY id
  `).all();

  const groups = [];
  const seenGroupKeys = new Set();
  const dimensions = [
    ['cvr', 'dup_cvr', 'CVR 注册号'],
    ['name', 'dup_name', '组织名称'],
    ['legal', 'dup_legal', '法定名称'],
    ...(addressMode === 'off' ? [] : [['address', 'dup_addr', '街道地址']]),
  ];

  for (const [field, column, label] of dimensions) {
    const buckets = new Map();
    for (const row of all) {
      const key = row[column];
      if (!key) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    for (const [key, members] of buckets) {
      if (members.length < 2) continue;
      const groupKey = `${field}:${key}`;
      if (seenGroupKeys.has(groupKey)) continue;
      seenGroupKeys.add(groupKey);
      groups.push({
        field,
        label,
        key,
        members: members.map((row) => ({
          id: row.id,
          name: row.name,
          legal_name: row.legal_name,
          cvr: row.cvr,
          address: row.address,
          status: row.status,
          has_pdf: !!row.document_id,
          created_at: row.created_at,
          owner: owner.get(row.owner_id) || { username: '未知', display_name: '未知' },
        })),
      });
    }
  }

  // 同一份原件 PDF 被多条营业执照引用（跨用户也算）
  const shared = db.prepare(`
    SELECT document_id, COUNT(*) AS n FROM licenses
     WHERE document_id IS NOT NULL GROUP BY document_id HAVING n > 1
  `).all();
  const sharedDocuments = shared.map((row) => ({
    document_id: row.document_id,
    count: row.n,
    members: all.filter((l) => l.document_id === row.document_id).map((l) => ({
      id: l.id, name: l.name, created_at: l.created_at,
      owner: owner.get(l.owner_id) || { username: '未知', display_name: '未知' },
    })),
  }));

  return {
    scanned: all.length,
    users: owner.size,
    groups,
    shared_documents: sharedDocuments,
    duplicate_licenses: new Set(groups.flatMap((g) => g.members.map((m) => m.id))).size,
  };
}

/**
 * 数据库里的一行是否与给定判重键命中（任一项非空且相等）。
 * 用来判断「这家公司其实是我自己已经导入过的」，从而走更新而不是判为重复。
 */
function rowMatchesKeys(row, keys) {
  return ['dup_cvr', 'dup_name', 'dup_legal', 'dup_addr'].some(
    (field) => keys[field] != null && row[field] != null && row[field] === keys[field],
  );
}

module.exports = {
  ADDRESS_MODE,
  licenseKeys,
  normalizeCompanyName,
  normalizeRegistrationNumber,
  normalizeAddress,
  rowMatchesKeys,
  findLicenseConflict,
  conflictMessage,
  auditLicenses,
};
