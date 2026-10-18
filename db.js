'use strict';

/**
 * 数据访问层（P0）
 * 所有存储读写都收口到这里，上层（server.js）只调用语义化方法，
 * 不再直接接触内存对象或 SQL。未来要换 PostgreSQL，只需替换本文件的实现。
 */

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'app.db');
const LEGACY_FILE = path.join(ROOT, 'data.json');

const POOL_TYPES = ['emails', 'proxies', 'cards', 'licenses'];
const STATUSES = ['未使用', '已使用', '停用'];
const RECORD_STATUSES = ['正常', '异常', '停用'];
const DEFAULT_SETTINGS = { proxy_user: '437d8679', proxy_pass: '547be5d2' };

// 各资源池可写字段 / 可读字段
const POOL_FIELDS = {
  emails: ['user', 'pass', 'fakey'],
  proxies: ['sn', 'type', 'host', 'port', 'user', 'pass', 'country', 'ip'],
  cards: ['number', 'expiry', 'cvv'],
  licenses: ['name', 'legal_name', 'number', 'address', 'apt', 'zip', 'city', 'type'],
};
const POOL_SELECT = {
  emails: ['id', 'user', 'pass', 'fakey', 'status', 'created_at', 'owner_id'],
  proxies: ['id', 'sn', 'type', 'host', 'port', 'user', 'pass', 'country', 'ip', 'status', 'created_at', 'owner_id'],
  cards: ['id', 'number', 'expiry', 'cvv', 'status', 'created_at', 'owner_id'],
  licenses: ['id', 'name', 'legal_name', 'number', 'address', 'apt', 'zip', 'city', 'type', 'status', 'created_at', 'owner_id'],
};
// 资源池在数据库中的表名与前端 key 一致
const RECORD_FIELDS = [
  'user_id', 'seq', 'fingerprint', 'country', 'product', 'domain', 'name',
  'email_id', 'email_user', 'email_pass', 'email_fakey',
  'proxy_id', 'proxy_sn', 'proxy_type', 'proxy_host', 'proxy_port', 'proxy_user', 'proxy_pass', 'proxy_country', 'proxy_ip',
  'card_id', 'card_number', 'card_expiry', 'card_cvv',
  'license_id', 'license_name', 'ip_reg_time', 'id_card', 'status', 'created_at',
];
const PREFIX_TABLE = { email: 'emails', proxy: 'proxies', card: 'cards', license: 'licenses' };
// 记录里这些列是可空整数（外键 / 归属），NULL 必须保持 NULL，不能写成空字符串
const RECORD_INT_FIELDS = new Set(['user_id', 'email_id', 'proxy_id', 'card_id', 'license_id']);

function recVal(field, rec) {
  const v = rec[field];
  if (RECORD_INT_FIELDS.has(field)) return v == null || v === '' ? null : Number(v);
  return v == null ? '' : v;
}

let db;

/* ---------------- 时间工具 ---------------- */

function nowLocal() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function todayKey() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date());
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${m}.${d}`;
}

/* ---------------- 建表 ---------------- */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feishu_open_id TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER,
  user TEXT NOT NULL DEFAULT '',
  pass TEXT NOT NULL DEFAULT '',
  fakey TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '未使用',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_emails_user ON emails(lower(user));

CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER,
  sn TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  port TEXT NOT NULL DEFAULT '',
  user TEXT NOT NULL DEFAULT '',
  pass TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '未使用',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_proxies_hostport ON proxies(host, port);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER,
  number TEXT NOT NULL DEFAULT '',
  expiry TEXT NOT NULL DEFAULT '',
  cvv TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '未使用',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cards_number ON cards(number);

CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER,
  name TEXT NOT NULL DEFAULT '',
  legal_name TEXT NOT NULL DEFAULT '',
  number TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  apt TEXT NOT NULL DEFAULT '',
  zip TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '未使用',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_licenses_name ON licenses(lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS ux_licenses_number ON licenses(number) WHERE number <> '';

CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  seq INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  product TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  email_id INTEGER, email_user TEXT NOT NULL DEFAULT '', email_pass TEXT NOT NULL DEFAULT '', email_fakey TEXT NOT NULL DEFAULT '',
  proxy_id INTEGER, proxy_sn TEXT NOT NULL DEFAULT '', proxy_type TEXT NOT NULL DEFAULT '', proxy_host TEXT NOT NULL DEFAULT '',
  proxy_port TEXT NOT NULL DEFAULT '', proxy_user TEXT NOT NULL DEFAULT '', proxy_pass TEXT NOT NULL DEFAULT '',
  proxy_country TEXT NOT NULL DEFAULT '', proxy_ip TEXT NOT NULL DEFAULT '',
  card_id INTEGER, card_number TEXT NOT NULL DEFAULT '', card_expiry TEXT NOT NULL DEFAULT '', card_cvv TEXT NOT NULL DEFAULT '',
  license_id INTEGER, license_name TEXT NOT NULL DEFAULT '',
  ip_reg_time TEXT NOT NULL DEFAULT '', id_card TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '正常',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_records_user ON records(user_id);
CREATE INDEX IF NOT EXISTS ix_records_seq ON records(seq);
`;

/* ---------------- 初始化 + 迁移 ---------------- */

function initStorage() {
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings(k, v) VALUES(?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  migrateLegacy();
  pruneSessions();
  return db;
}

// 首次启动时把旧的 data.json 一次性灌入 SQLite（保留原 id，旧数据不丢）
function migrateLegacy() {
  const empty = POOL_TYPES.every((t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c === 0)
    && db.prepare('SELECT COUNT(*) c FROM records').get().c === 0;
  if (!empty || !fs.existsSync(LEGACY_FILE)) return;
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
  } catch (e) {
    console.error('旧数据文件解析失败，跳过迁移:', e.message);
    return;
  }

  const stats = { emails: 0, proxies: 0, cards: 0, licenses: 0, records: 0, dropped: 0 };
  const tx = db.transaction(() => {
    for (const type of POOL_TYPES) {
      const rows = Array.isArray(legacy[type]) ? legacy[type] : [];
      const fields = POOL_FIELDS[type];
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO ${type} (id, owner_id, ${fields.join(', ')}, status, created_at) VALUES (?, NULL, ${fields.map(() => '?').join(', ')}, ?, ?)`
      );
      for (const row of rows) {
        const values = [Number(row.id) || null, ...fields.map((f) => String(row[f] ?? '')), STATUSES.includes(row.status) ? row.status : '未使用', String(row.created_at || nowLocal())];
        const info = stmt.run(...values);
        if (info.changes) stats[type]++;
        else stats.dropped++;
      }
    }
    const rows = Array.isArray(legacy.records) ? legacy.records : [];
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO records (id, ${RECORD_FIELDS.join(', ')}) VALUES (?, ${RECORD_FIELDS.map(() => '?').join(', ')})`
    );
    for (const r of rows) {
      const rec = {
        ...r,
        user_id: null,
        status: RECORD_STATUSES.includes(r.status) ? r.status : '正常',
        created_at: String(r.created_at || nowLocal()),
      };
      const values = [Number(r.id) || null, ...RECORD_FIELDS.map((f) => recVal(f, rec))];
      const info = stmt.run(...values);
      if (info.changes) stats.records++;
      else stats.dropped++;
    }
  });
  tx();
  console.log('旧数据迁移完成:', JSON.stringify(stats));
}

/* ---------------- 设置 ---------------- */

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT k, v FROM settings').all()) out[row.k] = row.v;
  return out;
}

function updateSettings(body) {
  const b = body || {};
  const old = getSettings();
  const now = { ...old };
  if ('proxy_user' in b) now.proxy_user = String(b.proxy_user ?? '');
  if ('proxy_pass' in b) now.proxy_pass = String(b.proxy_pass ?? '');
  let updated = 0;
  let recordsUpdated = 0;

  const tx = db.transaction(() => {
    const setSetting = db.prepare('INSERT INTO settings(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
    setSetting.run('proxy_user', now.proxy_user);
    setSetting.run('proxy_pass', now.proxy_pass);

    if (b.apply_to_existing) {
      // 同步到已有代理：空值、或仍沿用旧默认值的，统一改为新默认值（保留单独改过的）
      const proxies = db.prepare('SELECT id, user, pass FROM proxies').all();
      const updProxy = db.prepare('UPDATE proxies SET user = ?, pass = ? WHERE id = ?');
      for (const p of proxies) {
        let u = p.user;
        let pw = p.pass;
        let changed = false;
        if ((!u || u === old.proxy_user) && u !== now.proxy_user) { u = now.proxy_user; changed = true; }
        if ((!pw || pw === old.proxy_pass) && pw !== now.proxy_pass) { pw = now.proxy_pass; changed = true; }
        if (changed) { updProxy.run(u, pw, p.id); updated++; }
      }
      // 记录中的代理快照同步（避免导出的账号/密码为空）
      const recs = db.prepare(`SELECT id, proxy_host, proxy_user, proxy_pass FROM records WHERE proxy_host <> ''`).all();
      const updRec = db.prepare('UPDATE records SET proxy_user = ?, proxy_pass = ? WHERE id = ?');
      for (const r of recs) {
        let u = r.proxy_user;
        let pw = r.proxy_pass;
        let changed = false;
        if ((!u || u === old.proxy_user) && u !== now.proxy_user) { u = now.proxy_user; changed = true; }
        if ((!pw || pw === old.proxy_pass) && pw !== now.proxy_pass) { pw = now.proxy_pass; changed = true; }
        if (changed) { updRec.run(u, pw, r.id); recordsUpdated++; }
      }
    }
  });
  tx();
  return { settings: getSettings(), updated, records_updated: recordsUpdated };
}

/* ---------------- 资源池 ---------------- */

function listPools() {
  const out = {};
  for (const type of POOL_TYPES) {
    out[type] = db.prepare(`SELECT ${POOL_SELECT[type].join(', ')} FROM ${type} ORDER BY id DESC`).all();
  }
  return out;
}

// 判重的具体值，用于前端提示
function dupLabel(type, it) {
  if (type === 'emails') return it.user;
  if (type === 'cards') return '尾号' + String(it.number || '').slice(-4);
  if (type === 'proxies') return `${it.host}:${it.port}`;
  return [it.name, it.number].filter(Boolean).join('（') + (it.number ? '）' : '');
}

/**
 * 导入资源：重复即不入库。
 * 唯一索引（邮箱账号 / 代理主机:端口 / 卡号 / 执照名称+编号）保证全局唯一，
 * INSERT OR IGNORE 命中的行 changes=0，即视为重复跳过。
 */
function importItems(type, items, ownerId = null) {
  const fields = POOL_FIELDS[type];
  const cols = ['owner_id', ...fields, 'status', 'created_at'];
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${type} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')} )`);
  const s = getSettings();
  const skipped = [];
  let added = 0;

  const tx = db.transaction((list) => {
    for (const raw of list) {
      const it = { ...raw };
      if (type === 'proxies') {
        if (!it.user) it.user = s.proxy_user;
        if (!it.pass) it.pass = s.proxy_pass;
      }
      const values = [ownerId, ...fields.map((f) => String(it[f] ?? '')), '未使用', nowLocal()];
      const info = stmt.run(...values);
      if (info.changes === 0) skipped.push(dupLabel(type, it));
      else added++;
    }
  });
  tx(items || []);
  return { added, skipped: skipped.length, duplicates: skipped };
}

function patchPoolItem(type, id, body) {
  const row = db.prepare(`SELECT * FROM ${type} WHERE id = ?`).get(Number(id));
  if (!row) return { error: '不存在' };
  const sets = [];
  const values = [];
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) return { error: '无效状态' };
    sets.push('status = ?');
    values.push(body.status);
  }
  for (const f of POOL_FIELDS[type]) {
    if (f in body) { sets.push(`${f} = ?`); values.push(String(body[f] ?? '')); }
  }
  if (!sets.length) return { item: row };
  values.push(Number(id));
  try {
    db.prepare(`UPDATE ${type} SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  } catch (e) {
    if (/UNIQUE constraint/i.test(e.message)) return { error: '该值已存在（重复），请检查名称 / 编号 / 主机端口' };
    throw e;
  }
  return { item: db.prepare(`SELECT ${POOL_SELECT[type].join(', ')} FROM ${type} WHERE id = ?`).get(Number(id)) };
}

function deletePoolItem(type, id) {
  const info = db.prepare(`DELETE FROM ${type} WHERE id = ?`).run(Number(id));
  return { deleted: info.changes };
}

/* ---------------- 记录 ---------------- */

// 记录严格按创建者隔离：只返回本人创建的记录，彼此不可见
function listRecords(userId) {
  if (userId == null) return [];
  return db.prepare('SELECT * FROM records WHERE user_id = ? ORDER BY id DESC').all(userId);
}

function canAccess(rec, userId) {
  return !!rec && userId != null && rec.user_id === userId;
}

// 早期单机数据没有归属（user_id 为空）：由首个登录的用户一次性认领，
// 之后记录严格按创建者隔离，避免这些历史数据对所有人可见 / 被他人误删。
function claimLegacyRecords(userId) {
  if (userId == null) return 0;
  return db.prepare('UPDATE records SET user_id = ? WHERE user_id IS NULL').run(userId).changes;
}

function getRecordsByIds(ids, userId) {
  const wanted = (ids || []).map(Number).filter((n) => Number.isFinite(n));
  if (!wanted.length) return listRecords(userId);
  const all = db.prepare(
    `SELECT * FROM records WHERE id IN (${wanted.map(() => '?').join(',')}) ORDER BY id DESC`
  ).all(...wanted);
  return all.filter((r) => canAccess(r, userId));
}

function nextSeq() {
  const row = db.prepare('SELECT MAX(seq) m FROM records').get();
  return (row.m || 0) + 1;
}

function pickPool(type, ids, count, label) {
  const chosen = [];
  const used = new Set();
  for (const id of ids || []) {
    const row = db.prepare(`SELECT * FROM ${type} WHERE id = ?`).get(Number(id));
    if (row && !used.has(row.id) && row.status !== '停用') { chosen.push(row); used.add(row.id); }
  }
  if (chosen.length < count) {
    for (const row of db.prepare(`SELECT * FROM ${type} WHERE status = '未使用' ORDER BY id`).all()) {
      if (chosen.length >= count) break;
      if (!used.has(row.id)) { chosen.push(row); used.add(row.id); }
    }
  }
  const total = db.prepare(`SELECT COUNT(*) c FROM ${type}`).get().c;
  if (chosen.length < count && (total || (ids || []).length)) {
    return { error: `${label}不足：需要 ${count} 个，可用仅 ${chosen.length} 个，请先导入或调整数量` };
  }
  return { items: chosen };
}

function buildName(country, product, domain) {
  const base = String(domain || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .split('.')[0];
  return [country, product, base].filter(Boolean).join('-');
}

const INSERT_RECORD = () => `INSERT INTO records (${RECORD_FIELDS.join(', ')}) VALUES (${RECORD_FIELDS.map(() => '?').join(', ')})`;

function createRecords(body, userId) {
  const country = String(body.country || '').trim();
  const product = String(body.product || '').trim();
  const rawDomains = Array.isArray(body.domains) ? body.domains : String(body.domains || '').split(/\r?\n|[,\s]+/);
  const domains = rawDomains
    .map((s) => String(s).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  const count = domains.length || Math.max(1, Math.min(500, parseInt(body.count, 10) || 1));
  const dateKey = String(body.date_key || '').trim() || todayKey();
  const fpPrefix = String(body.fp_prefix || '').trim() || `${dateKey}ads`;
  const requestedSeq = parseInt(body.start_seq, 10);

  const pickedEmails = pickPool('emails', body.email_ids, count, '可用邮箱');
  if (pickedEmails.error) return { error: pickedEmails.error };
  const pickedCards = pickPool('cards', body.card_ids, count, '可用信用卡');
  if (pickedCards.error) return { error: pickedCards.error };
  const pickedLic = pickPool('licenses', body.license_ids, count, '可用营业执照');
  if (pickedLic.error) return { error: pickedLic.error };

  const proxyMode = ['shared', 'auto', 'none'].includes(body.proxy_mode) ? body.proxy_mode : 'shared';
  let sharedProxy = null;
  if (proxyMode === 'shared') {
    if (body.proxy_id) sharedProxy = db.prepare('SELECT * FROM proxies WHERE id = ?').get(Number(body.proxy_id)) || null;
    if (!sharedProxy) {
      const last = db.prepare('SELECT proxy_id FROM records ORDER BY id DESC LIMIT 1').get();
      if (last && last.proxy_id != null) sharedProxy = db.prepare('SELECT * FROM proxies WHERE id = ?').get(last.proxy_id) || null;
    }
  }
  let autoProxies = [];
  if (proxyMode === 'auto') {
    const pickedProxies = pickPool('proxies', body.proxy_ids, count, '可用代理');
    if (pickedProxies.error) return { error: pickedProxies.error };
    autoProxies = pickedProxies.items;
  }

  const markUsed = db.prepare('UPDATE emails SET status = ? WHERE id = ?');
  const markUsedP = db.prepare('UPDATE proxies SET status = ? WHERE id = ?');
  const markUsedC = db.prepare('UPDATE cards SET status = ? WHERE id = ?');
  const markUsedL = db.prepare('UPDATE licenses SET status = ? WHERE id = ?');
  const created = [];

  const takenFp = db.prepare('SELECT 1 FROM records WHERE fingerprint = ?');
  const tx = db.transaction(() => {
    // 多人共用：前端可能缓存了过期的 next.seq，起点若已被占用则自动顺延，避免指纹重复
    let seq = Number.isFinite(requestedSeq) && requestedSeq >= 1
      ? requestedSeq
      : (db.prepare('SELECT MAX(seq) m FROM records').get().m || 0) + 1;
    for (let i = 0; i < count; i++) {
      while (takenFp.get(`${fpPrefix}${seq}`)) seq++;
      const email = pickedEmails.items[i] || null;
      const card = pickedCards.items[i] || null;
      const lic = pickedLic.items[i] || null;
      const proxy = proxyMode === 'auto' ? autoProxies[i] || null : sharedProxy;
      const domain = domains[i] || '';
      const rec = {
        user_id: userId ?? null,
        seq,
        fingerprint: `${fpPrefix}${seq}`,
        country, product, domain,
        name: buildName(country, product, domain),
        email_id: email ? email.id : null, email_user: email ? email.user : '', email_pass: email ? email.pass : '', email_fakey: email ? email.fakey : '',
        proxy_id: proxy ? proxy.id : null, proxy_sn: proxy ? proxy.sn : '', proxy_type: proxy ? proxy.type : '', proxy_host: proxy ? proxy.host : '',
        proxy_port: proxy ? proxy.port : '', proxy_user: proxy ? proxy.user : '', proxy_pass: proxy ? proxy.pass : '',
        proxy_country: proxy ? proxy.country : '', proxy_ip: proxy ? proxy.ip : '',
        card_id: card ? card.id : null, card_number: card ? card.number : '', card_expiry: card ? card.expiry : '', card_cvv: card ? card.cvv : '',
        license_id: lic ? lic.id : null, license_name: lic ? lic.name : '',
        ip_reg_time: String(body.ip_reg_time || ''), id_card: String(body.id_card || '').trim(),
        status: '正常', created_at: nowLocal(),
      };
      const info = db.prepare(INSERT_RECORD()).run(...RECORD_FIELDS.map((f) => recVal(f, rec)));
      rec.id = Number(info.lastInsertRowid);
      if (email) markUsed.run('已使用', email.id);
      if (proxy) markUsedP.run('已使用', proxy.id);
      if (card) markUsedC.run('已使用', card.id);
      if (lic) markUsedL.run('已使用', lic.id);
      created.push(rec);
      seq++;
    }
  });
  tx();
  return { created };
}

const SNAP = {
  email: (e) => ({ email_user: e.user, email_pass: e.pass, email_fakey: e.fakey }),
  proxy: (p) => ({
    proxy_sn: p.sn, proxy_type: p.type, proxy_host: p.host, proxy_port: p.port,
    proxy_user: p.user, proxy_pass: p.pass, proxy_country: p.country, proxy_ip: p.ip,
  }),
  card: (c) => ({ card_number: c.number, card_expiry: c.expiry, card_cvv: c.cvv }),
  license: (l) => ({ license_name: l.name }),
};

function releaseIfUnused(prefix, oldId, excludeRecId) {
  if (oldId == null) return;
  const still = db.prepare(`SELECT COUNT(*) c FROM records WHERE id <> ? AND ${prefix}_id = ?`).get(excludeRecId, oldId).c;
  if (still) return;
  const table = PREFIX_TABLE[prefix];
  db.prepare(`UPDATE ${table} SET status = '未使用' WHERE id = ? AND status = '已使用'`).run(oldId);
}

function updateRecord(id, body, userId) {
  const rec = db.prepare('SELECT * FROM records WHERE id = ?').get(Number(id));
  if (!rec) return { error: '记录不存在' };
  if (!canAccess(rec, userId)) return { error: '无权操作该记录' };

  for (const k of ['country', 'product', 'domain', 'ip_reg_time', 'id_card', 'status']) {
    if (k in body) rec[k] = String(body[k] ?? '').trim();
  }
  if ('status' in body && !RECORD_STATUSES.includes(rec.status)) rec.status = '正常';

  const reassign = (prefix, table, newId) => {
    if (newId === undefined) return;
    const targetId = newId === null ? null : Number(newId);
    if (rec[`${prefix}_id`] === targetId) return;
    releaseIfUnused(prefix, rec[`${prefix}_id`], rec.id);
    const nu = targetId == null ? null : db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(targetId);
    if (targetId != null && !nu) return;
    rec[`${prefix}_id`] = nu ? nu.id : null;
    for (const key of Object.keys(SNAP[prefix]({}))) rec[key] = '';
    if (nu) {
      const snaps = SNAP[prefix](nu);
      for (const key of Object.keys(snaps)) rec[key] = snaps[key] ?? '';
      db.prepare(`UPDATE ${table} SET status = '已使用' WHERE id = ?`).run(nu.id);
    }
  };

  const tx = db.transaction(() => {
    reassign('email', 'emails', body.email_id);
    reassign('proxy', 'proxies', body.proxy_id);
    reassign('card', 'cards', body.card_id);
    reassign('license', 'licenses', body.license_id);
    rec.name = buildName(rec.country, rec.product, rec.domain);
    const cols = RECORD_FIELDS.filter((f) => f !== 'user_id');
    db.prepare(`UPDATE records SET ${cols.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((f) => recVal(f, rec)), rec.id);
  });
  tx();
  return { record: db.prepare('SELECT * FROM records WHERE id = ?').get(rec.id) };
}

function deleteRecords(ids, userId) {
  const wanted = (ids || []).map(Number).filter((n) => Number.isFinite(n));
  let deleted = 0;
  const tx = db.transaction(() => {
    for (const id of wanted) {
      const rec = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
      if (!rec) continue;
      if (!canAccess(rec, userId)) continue;
      db.prepare('DELETE FROM records WHERE id = ?').run(id);
      deleted++;
      for (const prefix of ['email', 'proxy', 'card', 'license']) releaseIfUnused(prefix, rec[`${prefix}_id`], id);
    }
  });
  tx();
  return { deleted };
}

/* ---------------- 用户 / 会话 ---------------- */

function upsertFeishuUser(profile) {
  const openId = String(profile.open_id || '');
  let user = db.prepare('SELECT * FROM users WHERE feishu_open_id = ?').get(openId);
  if (user) {
    db.prepare('UPDATE users SET name = ?, avatar = ?, last_login_at = ? WHERE id = ?')
      .run(String(profile.name || user.name), String(profile.avatar_url || user.avatar), nowLocal(), user.id);
  } else {
    const info = db.prepare('INSERT INTO users (feishu_open_id, name, avatar, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)')
      .run(openId, String(profile.name || ''), String(profile.avatar_url || ''), nowLocal(), nowLocal());
    user = { id: Number(info.lastInsertRowid) };
  }
  return db.prepare('SELECT id, feishu_open_id, name, avatar FROM users WHERE id = ?').get(user.id);
}

// 开发/联调用：按名字创建或复用本地账号（仅在 AUTH_DEV_LOGIN 打开时由 server 调用）
function devUser(name) {
  const n = String(name || '').trim() || '本地用户';
  const openId = 'dev:' + n;
  let user = db.prepare('SELECT * FROM users WHERE feishu_open_id = ?').get(openId);
  if (!user) {
    const info = db.prepare('INSERT INTO users (feishu_open_id, name, avatar, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)')
      .run(openId, n, '', nowLocal(), nowLocal());
    user = { id: Number(info.lastInsertRowid) };
  }
  return db.prepare('SELECT id, feishu_open_id, name, avatar FROM users WHERE id = ?').get(user.id);
}

function createSession(userId, ttlMs) {
  const token = require('node:crypto').randomBytes(32).toString('hex');
  const created = nowLocal();
  const expires = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, created, expires);
  return { token, expires_at: expires };
}

function getUserByToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT s.expires_at, u.id, u.feishu_open_id, u.name, u.avatar FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, feishu_open_id: row.feishu_open_id, name: row.name, avatar: row.avatar };
}

function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

module.exports = {
  initStorage,
  nowLocal,
  todayKey,
  POOL_TYPES,
  STATUSES,
  RECORD_STATUSES,
  getSettings,
  updateSettings,
  listPools,
  importItems,
  patchPoolItem,
  deletePoolItem,
  listRecords,
  claimLegacyRecords,
  getRecordsByIds,
  createRecords,
  updateRecord,
  deleteRecords,
  nextSeq,
  upsertFeishuUser,
  devUser,
  createSession,
  getUserByToken,
  deleteSession,
};
