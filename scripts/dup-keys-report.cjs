#!/usr/bin/env node
'use strict';
/**
 * 判重键体检（只读，不修改任何数据）。
 *
 * 为什么需要它：审计 F07 指出，`dup_cvr` 为 NULL 的历史行对整套查重是隐形的
 * —— SQLite 的唯一索引不管 NULL，findLicenseConflict 的 WHERE 也匹配不上，
 * 于是同一注册号可以再次被导入（已用探针复现：同号出现 2 行）。
 *
 * 根因是有意的守卫：lib/db.js 的 migrateRegistrationKeys 只处理
 * `WHERE dup_cvr IS NOT NULL`，当初为了避免迁移中途撞唯一索引而跳过这些行。
 *
 * 审计要求「旧数据迁移先出报告」，所以先跑这个把范围量出来，再决定怎么迁。
 *
 * 用法：
 *   DB_FILE=/var/lib/adsworkbench/workbench.sqlite node scripts/dup-keys-report.cjs
 *   node scripts/dup-keys-report.cjs --json        # 机器可读
 *
 * 输出里不含任何姓名、地址、卡号等业务内容，只有 id、计数和键值，
 * 键值本身是归一化后的哈希式短串，不是原文。
 */
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const dbFile = process.env.DB_FILE
  || [path.join(dir, 'workbench.sqlite'), path.join(dir, 'ads-workbench.sqlite')].find(fs.existsSync)
  || path.join(dir, 'workbench.sqlite');
const asJson = process.argv.includes('--json');

if (!fs.existsSync(dbFile)) {
  console.error(`数据库不存在：${dbFile}`);
  console.error('用 DB_FILE 显式指定，或确认 DATA_DIR 是否正确。');
  process.exit(1);
}

const { DatabaseSync } = require('node:sqlite');
const dedup = require('../lib/dedup');
const db = new DatabaseSync(dbFile, { readOnly: true });

const total = db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n;
const nullKeys = db.prepare(`
  SELECT COUNT(*) AS n FROM licenses
  WHERE dup_cvr IS NULL OR dup_name IS NULL OR dup_legal IS NULL`).get().n;
const rows = db.prepare('SELECT id, cvr, dup_cvr FROM licenses WHERE dup_cvr IS NULL ORDER BY id').all();
const taken = new Set(
  db.prepare('SELECT dup_cvr FROM licenses WHERE dup_cvr IS NOT NULL').all().map((r) => r.dup_cvr),
);
db.close();

const fillable = [];      // 能算出键，且不与既有键冲突
const conflicts = [];     // 能算出键，但该键已被别的行占用 → 需人工核对
const uncomputable = [];  // cvr 本身无法生成键（空、或数字不足 6 位）
for (const row of rows) {
  const next = dedup.normalizeRegistrationNumber(row.cvr);
  if (!next) uncomputable.push(row.id);
  else if (taken.has(next)) conflicts.push({ id: row.id, dup_cvr: next });
  else { fillable.push({ id: row.id, dup_cvr: next }); taken.add(next); }
}

const report = {
  database: dbFile,
  licenses_total: total,
  rows_missing_any_key: nullKeys,
  dup_cvr_null: rows.length,
  fillable_count: fillable.length,
  conflict_count: conflicts.length,
  uncomputable_count: uncomputable.length,
  fillable_ids: fillable.map((r) => r.id),
  conflict_ids: conflicts.map((r) => r.id),
  uncomputable_ids: uncomputable,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('判重键体检（只读，未修改任何数据）');
  console.log(`  数据库          ${dbFile}`);
  console.log(`  执照总数        ${total}`);
  console.log(`  有任一键缺失    ${nullKeys}`);
  console.log(`  dup_cvr 为 NULL ${rows.length}`);
  console.log('');
  console.log(`  可直接补算      ${fillable.length}${fillable.length ? '   id: ' + fillable.map((r) => r.id).join(',') : ''}`);
  console.log(`  会撞既有键      ${conflicts.length}${conflicts.length ? '   id: ' + conflicts.map((r) => r.id).join(',') + '（需人工核对，不能自动写入）' : ''}`);
  console.log(`  无法生成键      ${uncomputable.length}${uncomputable.length ? '   id: ' + uncomputable.join(',') + '（注册号为空或太短，保持原状）' : ''}`);
  if (rows.length) {
    console.log('');
    console.log('  这些行当前对全员查重完全隐形：同一注册号可以再次被导入。');
    console.log('  迁移前请先备份；"会撞既有键"的那些行要先人工判断哪一条是真实企业。');
  }
}
