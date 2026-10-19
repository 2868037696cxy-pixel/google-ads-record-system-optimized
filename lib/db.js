'use strict';

/**
 * SQLite 连接与表结构。
 *
 * 使用 Node 内置的 node:sqlite（Node 22.5+ / 24 稳定），避免 better-sqlite3 的
 * 原生编译依赖 —— 这个项目的目标平台是 Windows，原生模块会带来额外的构建负担。
 *
 * 数据隔离模型：资源池与记录都带 owner_id，查询一律按 owner_id 过滤（各人只看自己的）；
 * 但营业执照的判重键是**全局唯一索引**，跨所有用户生效 —— 谁先导入谁占住。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

/* ---------------- 资源池：4 类各自建表，均按 owner_id 隔离 ---------------- */

CREATE TABLE IF NOT EXISTS emails (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT '未使用',
  created_at TEXT NOT NULL,
  user       TEXT NOT NULL,
  pass       TEXT NOT NULL DEFAULT '',
  fakey      TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_emails_owner_user ON emails(owner_id, user COLLATE NOCASE);
CREATE INDEX        IF NOT EXISTS idx_emails_owner     ON emails(owner_id, status);

CREATE TABLE IF NOT EXISTS proxies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT '未使用',
  created_at TEXT NOT NULL,
  sn         TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT '',
  host       TEXT NOT NULL DEFAULT '',
  port       TEXT NOT NULL DEFAULT '',
  user       TEXT NOT NULL DEFAULT '',
  pass       TEXT NOT NULL DEFAULT '',
  country    TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_proxies_owner_endpoint ON proxies(owner_id, host COLLATE NOCASE, port, user);
CREATE INDEX        IF NOT EXISTS idx_proxies_owner         ON proxies(owner_id, status);

CREATE TABLE IF NOT EXISTS cards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT '未使用',
  created_at TEXT NOT NULL,
  number     TEXT NOT NULL,
  expiry     TEXT NOT NULL DEFAULT '',
  cvv        TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cards_owner_number ON cards(owner_id, number);
CREATE INDEX        IF NOT EXISTS idx_cards_owner       ON cards(owner_id, status);

/* 营业执照：dup_* 是归一化后的判重键，NULL 表示该字段为空（SQLite 唯一索引允许多个 NULL）。
   这三个索引**不带 owner_id**，因此是跨用户全局唯一的。 */
CREATE TABLE IF NOT EXISTS licenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT '未使用',
  created_at      TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  legal_name      TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  apt             TEXT NOT NULL DEFAULT '',
  zip             TEXT NOT NULL DEFAULT '',
  city            TEXT NOT NULL DEFAULT '',
  type            TEXT NOT NULL DEFAULT '',
  cvr             TEXT NOT NULL DEFAULT '',
  jurisdiction    TEXT NOT NULL DEFAULT '',
  registration_type TEXT NOT NULL DEFAULT '',
  registration_authority TEXT NOT NULL DEFAULT '',
  document_id     TEXT,
  document_name   TEXT NOT NULL DEFAULT '',
  document_size   INTEGER NOT NULL DEFAULT 0,
  dup_name        TEXT,
  dup_legal       TEXT,
  dup_cvr         TEXT,
  dup_reg         TEXT,
  dup_addr        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_licenses_dup_name  ON licenses(dup_name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_licenses_dup_legal ON licenses(dup_legal);
CREATE INDEX        IF NOT EXISTS idx_licenses_dup_cvr  ON licenses(dup_cvr);
CREATE INDEX        IF NOT EXISTS idx_licenses_dup_addr ON licenses(dup_addr);
CREATE INDEX        IF NOT EXISTS idx_licenses_owner    ON licenses(owner_id, status);
CREATE INDEX        IF NOT EXISTS idx_licenses_document ON licenses(document_id);

/* ---------------- 记录：按 owner_id 隔离，指纹在各自账本内唯一 ---------------- */

CREATE TABLE IF NOT EXISTS records (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  fingerprint  TEXT NOT NULL,
  country      TEXT NOT NULL DEFAULT '',
  product      TEXT NOT NULL DEFAULT '',
  domain       TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  email_id     INTEGER,
  email_user   TEXT NOT NULL DEFAULT '',
  email_pass   TEXT NOT NULL DEFAULT '',
  email_fakey  TEXT NOT NULL DEFAULT '',
  proxy_id     INTEGER,
  proxy_sn     TEXT NOT NULL DEFAULT '',
  proxy_type   TEXT NOT NULL DEFAULT '',
  proxy_host   TEXT NOT NULL DEFAULT '',
  proxy_port   TEXT NOT NULL DEFAULT '',
  proxy_user   TEXT NOT NULL DEFAULT '',
  proxy_pass   TEXT NOT NULL DEFAULT '',
  proxy_country TEXT NOT NULL DEFAULT '',
  proxy_ip     TEXT NOT NULL DEFAULT '',
  card_id      INTEGER,
  card_number  TEXT NOT NULL DEFAULT '',
  card_expiry  TEXT NOT NULL DEFAULT '',
  card_cvv     TEXT NOT NULL DEFAULT '',
  license_id   INTEGER,
  license_name TEXT NOT NULL DEFAULT '',
  ip_reg_time  TEXT NOT NULL DEFAULT '',
  id_card      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT '正常',
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_records_owner_fingerprint ON records(owner_id, fingerprint);
CREATE INDEX        IF NOT EXISTS idx_records_owner            ON records(owner_id, id);
-- 支撑服务端分页的状态筛选（方案工作包 07「查询索引评估」）
CREATE INDEX        IF NOT EXISTS idx_records_owner_status     ON records(owner_id, status);
-- 资源库在记录分页后不能再靠“当前页 records”判断占用；这些索引支撑全账号关联计数。
CREATE INDEX        IF NOT EXISTS idx_records_owner_email      ON records(owner_id, email_id);
CREATE INDEX        IF NOT EXISTS idx_records_owner_proxy      ON records(owner_id, proxy_id);
CREATE INDEX        IF NOT EXISTS idx_records_owner_card       ON records(owner_id, card_id);
CREATE INDEX        IF NOT EXISTS idx_records_owner_license    ON records(owner_id, license_id);

/* ---------------- 原 PDF 附件：哈希即主键，跨用户共享同一份原件 ---------------- */

CREATE TABLE IF NOT EXISTS documents (
  sha256     TEXT PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  size       INTEGER NOT NULL,
  bytes      BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
`;

/** 打开（必要时创建）数据库并建立表结构。 */
function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  // WAL 让读写并发更顺；NORMAL 同步级别在 WAL 下已能保证崩溃安全。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  migrateRegistrationKeys(db);
  migrateNameKeys(db);
  migrateRegistrationNamespace(db);
  require('./hardening').initialize(db, file);
  // 只有所有迁移和安全初始化都成功后才推进版本号；失败启动不会留下“版本已升级”的假状态。
  const current = Number(db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value || 0);
  if (current !== SCHEMA_VERSION) {
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));
  }
  return db;
}

/**
 * 重新计算历史行的 dup_cvr，使旧数据与新口径的 normalizeRegistrationNumber 对齐。
 *
 * 背景：normalizeRegistrationNumber 由「只留数字」改为「保留字母」，历史行的 dup_cvr
 * 是旧口径的纯数字键，与新键不再相等 —— 不迁移会让真重复漏检。
 *
 * 为什么这次改写不可能撞 uq_licenses_dup_cvr（全局唯一索引）：
 *   新键只去掉了非字母数字字符，而数字是字母数字的子集，所以
 *   digits(新键) == digits(原 cvr) == 旧键。
 *   于是「两行新键相同」必然推出「两行旧键相同」，而旧键在写入时就已受唯一索引约束。
 * 因此只会把纯数字键替换成它自己的带字母版本，不会让原本不同的两行变成同一键。
 *
 * 只处理 dup_cvr 非空的行；旧实现下数字部分不足 6 位的行本来就是 NULL（不进索引），
 * 这里保持不动，避免凭空引入新的唯一冲突。整段包在事务里，中断可安全重跑（幂等）。
 */
function migrateRegistrationKeys(db) {
  const dedup = require('./dedup');
  const update = db.prepare('UPDATE licenses SET dup_cvr = ? WHERE id = ?');
  const report = { remapped: 0, filled: 0, conflicts: [], uncomputable: [] };
  transaction(db, () => {
    // ① 旧口径（纯数字键）→ 新口径（保留字母）。
    //    不会制造新冲突的论证见上方注释：数字是字母数字的子集，所以
    //    「两行新键相同」必然推出「两行旧键相同」，而旧键写入时已受唯一索引约束。
    const rows = db.prepare('SELECT id, cvr, dup_cvr FROM licenses WHERE dup_cvr IS NOT NULL').all();
    for (const row of rows) {
      const next = dedup.normalizeRegistrationNumber(row.cvr);
      // next 为空说明新口径不接受这个值（数字不足 6 位），保持原值交给人工核对。
      if (next && next !== row.dup_cvr) { update.run(next, row.id); report.remapped += 1; }
    }

    // ② 审计 F07：判重键为 NULL 的历史行对整套查重是隐形的 —— SQLite 的唯一索引
    //    不管 NULL，findLicenseConflict 的 WHERE 也匹配不上，于是同一注册号可以再次
    //    被导入（已用探针复现：同号出现两行）。
    //    原先 `WHERE dup_cvr IS NOT NULL` 明确跳过这类行，理由是怕重算时撞唯一索引；
    //    代价是它们永远不会被处理。现在补算，但**撞键的行不写入**：
    //    两行同号时没有依据判断哪一条才是真实企业，那属于人工核对，不属于迁移。
    //    原先的 `if (!rows.length) return 0` 也一并去掉 —— 它会让「有旧口径键、
    //    但没有 NULL 行」的库提前返回，使这一步根本没机会执行。
    const taken = new Set(db.prepare('SELECT dup_cvr FROM licenses WHERE dup_cvr IS NOT NULL').all().map((r) => r.dup_cvr));
    const nullRows = db.prepare('SELECT id, cvr FROM licenses WHERE dup_cvr IS NULL').all();
    for (const row of nullRows) {
      const next = dedup.normalizeRegistrationNumber(row.cvr);
      if (!next) { report.uncomputable.push(row.id); continue; }
      if (taken.has(next)) { report.conflicts.push(row.id); continue; }
      update.run(next, row.id);
      taken.add(next);
      report.filled += 1;
    }
  });
  // 只有真的发生改动才输出：全新库每次启动都会走到这里，不该刷日志。只打计数。
  if (report.remapped || report.filled || report.conflicts.length) {
    console.warn(`[dup-keys] 重映射 ${report.remapped} 行、补算 ${report.filled} 行、`
      + `${report.conflicts.length} 行因键冲突待人工核对、${report.uncomputable.length} 行无法生成键`);
  }
  // 返回值保持「改动了多少行」这个原有契约 —— 既有测试断言的就是它，
  // 换成对象会静默破坏它们（上一轮就是这样被自己拦住并退回的）。
  // 分类明细挂在函数上，供运维脚本按需读取。
  migrateRegistrationKeys.last = report;
  return report.remapped + report.filled;
}

/**
 * F06：旧版名称键只接受 ASCII。非拉丁企业名称会得到 NULL，导致历史资料对名称查重完全隐形。
 * 这里只补算 NULL 键；已有非空键沿用，避免无必要地重写成熟数据。
 * 若新键与任何历史组织名/法定名发生交叉冲突，则保留 NULL 并报告，交给人工核对。
 */
function migrateNameKeys(db) {
  const dedup = require('./dedup');
  const update = db.prepare('UPDATE licenses SET dup_name = ?, dup_legal = ? WHERE id = ?');
  const report = { filled: 0, conflicts: [], uncomputable: [] };
  transaction(db, () => {
    const taken = new Set();
    for (const row of db.prepare('SELECT dup_name, dup_legal FROM licenses').all()) {
      if (row.dup_name) taken.add(row.dup_name);
      if (row.dup_legal) taken.add(row.dup_legal);
    }
    const rows = db.prepare('SELECT id, name, legal_name, dup_name, dup_legal FROM licenses WHERE dup_name IS NULL OR dup_legal IS NULL ORDER BY id').all();
    for (const row of rows) {
      const nextName = row.dup_name || dedup.normalizeCompanyName(row.name);
      const nextLegal = row.dup_legal || dedup.normalizeCompanyName(row.legal_name || row.name);
      const candidates = [...new Set([nextName, nextLegal].filter(Boolean))];
      if (!candidates.length) { report.uncomputable.push(row.id); continue; }
      const oldOwn = new Set([row.dup_name, row.dup_legal].filter(Boolean));
      const conflict = candidates.some((key) => taken.has(key) && !oldOwn.has(key));
      if (conflict) { report.conflicts.push(row.id); continue; }
      update.run(nextName, nextLegal, row.id);
      candidates.forEach((key) => taken.add(key));
      report.filled += 1;
    }
  });
  if (report.filled || report.conflicts.length) {
    console.warn(`[dup-name-keys] 补算 ${report.filled} 行、${report.conflicts.length} 行因名称冲突待人工核对、${report.uncomputable.length} 行无法生成键`);
  }
  migrateNameKeys.last = report;
  return report.filled;
}

/**
 * F05：把“裸注册号全库唯一”迁移为“司法辖区 + 编号类型 + 注册号”的命名空间。
 *
 * 历史资料没有国家/类型，不能凭号码前缀擅自猜测归属，因此统一写成 L|<裸号>。
 * 新资料只有同时具备 jurisdiction + registration_type 才生成 S|<地区>|<类型>|<裸号>。
 * L 与任何同裸号 S 都互相阻塞，直到历史行被人工补齐；两个完整 S 只在命名空间完全相同
 * 时冲突，因此不同国家/编号类型可以合法拥有相同号码。
 */
function migrateRegistrationNamespace(db) {
  const dedup = require('./dedup');
  const columns = new Set(db.prepare('PRAGMA table_info(licenses)').all().map((row) => row.name));
  const add = (name, definition) => {
    if (!columns.has(name)) { db.exec(`ALTER TABLE licenses ADD COLUMN ${name} ${definition}`); columns.add(name); }
  };
  const report = { filled: 0, conflicts: [], uncomputable: [] };

  transaction(db, () => {
    add('jurisdiction', "TEXT NOT NULL DEFAULT ''");
    add('registration_type', "TEXT NOT NULL DEFAULT ''");
    add('registration_authority', "TEXT NOT NULL DEFAULT ''");
    add('dup_reg', 'TEXT');

    // 旧唯一索引会错误阻止不同国家使用同一个号码；先换成普通审计索引。
    db.exec('DROP INDEX IF EXISTS uq_licenses_dup_cvr');
    db.exec('CREATE INDEX IF NOT EXISTS idx_licenses_dup_cvr ON licenses(dup_cvr)');

    const rows = db.prepare('SELECT id,cvr,jurisdiction,registration_type,registration_authority,dup_reg FROM licenses ORDER BY id').all();
    const taken = new Set(rows.map((row) => row.dup_reg).filter(Boolean));
    const update = db.prepare('UPDATE licenses SET dup_reg = ? WHERE id = ?');
    for (const row of rows) {
      const next = dedup.registrationIdentity(row).dup_reg;
      if (!next) { report.uncomputable.push(row.id); continue; }
      if (row.dup_reg === next) continue;
      if (taken.has(next)) { report.conflicts.push(row.id); continue; }
      update.run(next, row.id);
      taken.add(next);
      report.filled += 1;
    }

    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_licenses_dup_reg ON licenses(dup_reg)');
    db.exec(`
      DROP TRIGGER IF EXISTS licenses_registration_scope_insert;
      DROP TRIGGER IF EXISTS licenses_registration_scope_update;
      CREATE TRIGGER licenses_registration_scope_insert
      BEFORE INSERT ON licenses
      WHEN NEW.dup_cvr IS NOT NULL AND (
        ((NEW.dup_reg IS NULL OR NEW.dup_reg LIKE 'L|%')
          AND EXISTS(SELECT 1 FROM licenses x WHERE x.dup_cvr = NEW.dup_cvr))
        OR
        (NEW.dup_reg LIKE 'S|%'
          AND EXISTS(SELECT 1 FROM licenses x
                     WHERE x.dup_cvr = NEW.dup_cvr
                       AND (x.dup_reg IS NULL OR x.dup_reg LIKE 'L|%')))
      )
      BEGIN SELECT RAISE(ABORT, 'ambiguous registration identity'); END;

      CREATE TRIGGER licenses_registration_scope_update
      BEFORE UPDATE OF dup_cvr,dup_reg ON licenses
      WHEN NEW.dup_cvr IS NOT NULL AND (
        ((NEW.dup_reg IS NULL OR NEW.dup_reg LIKE 'L|%')
          AND EXISTS(SELECT 1 FROM licenses x WHERE x.id <> OLD.id AND x.dup_cvr = NEW.dup_cvr))
        OR
        (NEW.dup_reg LIKE 'S|%'
          AND EXISTS(SELECT 1 FROM licenses x
                     WHERE x.id <> OLD.id AND x.dup_cvr = NEW.dup_cvr
                       AND (x.dup_reg IS NULL OR x.dup_reg LIKE 'L|%')))
      )
      BEGIN SELECT RAISE(ABORT, 'ambiguous registration identity'); END;
    `);
  });

  if (report.filled || report.conflicts.length) {
    console.warn(`[dup-registration-scope] 补算 ${report.filled} 行、${report.conflicts.length} 行因命名空间冲突待人工核对、${report.uncomputable.length} 行无法生成键`);
  }
  migrateRegistrationNamespace.last = report;
  return report.filled;
}

/** 在一个事务里执行 fn；抛异常即整体回滚。 */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败时保留原始异常 */ }
    throw error;
  }
}

module.exports = { openDatabase, transaction, SCHEMA_VERSION, migrateRegistrationKeys, migrateNameKeys, migrateRegistrationNamespace };
