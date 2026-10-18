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

const SCHEMA_VERSION = 1;

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
  document_id     TEXT,
  document_name   TEXT NOT NULL DEFAULT '',
  document_size   INTEGER NOT NULL DEFAULT 0,
  dup_name        TEXT,
  dup_legal       TEXT,
  dup_cvr         TEXT,
  dup_addr        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_licenses_dup_name  ON licenses(dup_name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_licenses_dup_legal ON licenses(dup_legal);
CREATE UNIQUE INDEX IF NOT EXISTS uq_licenses_dup_cvr   ON licenses(dup_cvr);
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
  const current = Number(db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value || 0);
  if (current !== SCHEMA_VERSION) {
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));
  }
  require('./hardening').initialize(db, file);
  return db;
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

module.exports = { openDatabase, transaction, SCHEMA_VERSION };
