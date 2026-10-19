'use strict';
// 审计 F07：判重键为 NULL 的历史行对整套查重是隐形的。
//
// 根因是 lib/db.js 里一个有意的守卫：迁移原先只处理 `WHERE dup_cvr IS NOT NULL`，
// 当初跳过 NULL 行正是为了不撞唯一索引 —— 代价是这些行永远不会被处理，
// 而 SQLite 的唯一索引不管 NULL，findLicenseConflict 的 WHERE 也匹配不上，
// 于是同一注册号可以再次被导入。
//
// 现在迁移分三种处理，本用例逐一钉住：
//   ① 能算出键且未被占用      → 补算写入
//   ② 能算出键但已被占用      → **不写入**，留给人工核对
//   ③ 算不出键（注册号空/过短）→ 保持原状
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-migrate-null-'));
const dbFile = path.join(root, 'test.sqlite');
process.env.DATA_DIR = root;
process.env.DB_FILE = dbFile;
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.LOG_LEVEL = 'silent';

const { openDatabase } = require('../lib/db');

test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('判重键为 NULL 的历史行会被补算，撞键与不可计算的行保持原状', () => {
  // ① 造出 legacy 状态：一行正常，三行 dup_* 全为 NULL
  const first = openDatabase(dbFile);
  // 外键是连接级开关；这里只需要造历史数据，不涉及用户表
  first.exec('PRAGMA foreign_keys = OFF');
  const ins = first.prepare(`INSERT INTO licenses
    (owner_id, name, cvr, dup_cvr, dup_name, dup_legal, dup_addr, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run(1, 'Alpha', 'DK11111111', '11111111', 'alpha', 'alpha', 'first', '2026-01-01');
  ins.run(1, 'Beta', 'DK22222222', null, null, null, null, '2026-01-02');
  ins.run(1, 'Gamma', 'DK11111111', null, null, null, null, '2026-01-03');
  ins.run(1, 'Delta', '', null, null, null, null, '2026-01-04');
  first.close();

  // ② 重新打开：迁移在 openDatabase 内部自动运行
  const db = openDatabase(dbFile);
  const rows = db.prepare('SELECT id, name, dup_cvr FROM licenses ORDER BY id').all();
  const indexed = db.prepare("SELECT COUNT(*) AS n FROM licenses WHERE dup_cvr = '11111111'").get().n;
  db.close();

  assert.equal(rows.length, 4, `前提：应有 4 行历史数据，实际 ${rows.length}`);
  assert.equal(rows[0].dup_cvr, '11111111', '已有键不应被改动');
  assert.equal(rows[1].dup_cvr, '22222222',
    `可补算的行没有拿到键（得到 ${JSON.stringify(rows[1].dup_cvr)}）—— 它仍然对查重隐形`);
  assert.equal(rows[2].dup_cvr, null,
    '与既有键冲突的行被写入了 —— 迁移无权判断哪一条是真实企业，必须留给人工核对');
  assert.equal(rows[3].dup_cvr, null,
    '注册号为空的行被写入了键 —— 新口径不接受该值，应保持原状');
  assert.equal(indexed, 1,
    `dup_cvr='11111111' 的行有 ${indexed} 行，应为 1 —— 冲突行若被写入会直接撞唯一索引`);
});

test('迁移是幂等的：重复打开不会反复改动', () => {
  const read = () => {
    const db = openDatabase(dbFile);
    const v = JSON.stringify(db.prepare('SELECT id, dup_cvr FROM licenses ORDER BY id').all());
    db.close();
    return v;
  };
  const before = read();
  const after = read();
  assert.equal(after, before, '第二次打开后数据发生了变化 —— 迁移不幂等，重启会反复改写');
});
