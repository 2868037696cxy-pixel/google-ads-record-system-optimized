'use strict';
/**
 * 记录列表查询的性能基线（方案工作包 07「渐进压测 / 性能基线」）。
 *
 * 在同一个库、同一批数据上对比两条读取路径：
 *   A 全量：store.listRecords()          —— 旧路径：取回本账号全部记录，前端再切片到 50 条
 *   B 分页：store.listRecordsPage()      —— 新路径：LIMIT/OFFSET 只取当前页 + 一次 COUNT
 * 两条路径都不解密敏感列，差别只在「读多少行、传多少字节」。
 *
 * 用法：node scripts/perf-baseline.cjs [记录条数，默认 20000]
 * 输出为可直接引用的 JSON，便于回填验收记录、逐版本对比。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const size = Math.max(Number(process.argv[2]) || 20000, 100);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-perf-'));
process.env.DATA_DIR = dir;
process.env.DB_FILE = path.join(dir, 'perf.sqlite');
process.env.DATA_FILE = path.join(dir, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');
const store = require('../lib/store');

const time = (fn) => { const t = performance.now(); const value = fn(); return { ms: +(performance.now() - t).toFixed(2), value }; };

(async () => {
  const origin = await service.start({ port: 0 });
  const registered = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: 'perf', password: 'Perf-Test-1234' }),
  });
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status}`);

  const db = service.db;
  const ownerId = db.prepare("SELECT id FROM users WHERE username='perf'").get().id;

  const seed = time(() => {
    const insert = db.prepare(`INSERT INTO records(owner_id,seq,fingerprint,country,product,domain,name,status,created_at)
                               VALUES(?,?,?,?,?,?,?,?,?)`);
    db.exec('BEGIN IMMEDIATE');
    for (let i = 1; i <= size; i += 1) {
      insert.run(ownerId, i, `perf${String(i).padStart(8, '0')}`, i % 2 ? '丹麦' : '巴西', `产品${i}`,
        `shop-${i}.example`, `记录 ${i}`, i % 3 === 0 ? '停用' : '正常', `2026-01-01 00:${String(i % 60).padStart(2, '0')}:00`);
    }
    db.exec('COMMIT');
  });

  // 各跑 3 次取中位数，避免单次抖动被当成结论。
  const median = (fn) => { const runs = [time(fn).ms, time(fn).ms, time(fn).ms].sort((a, b) => a - b); return runs[1]; };
  const fullMs = median(() => store.listRecords(db, ownerId));
  const pageMs = median(() => store.listRecordsPage(db, ownerId, { limit: 50, offset: 0 }));
  const deepMs = median(() => store.listRecordsPage(db, ownerId, { limit: 50, offset: Math.max(size - 50, 0) }));
  const filteredMs = median(() => store.listRecordsPage(db, ownerId, { limit: 50, offset: 0, status: '停用' }));

  const fullBytes = JSON.stringify(store.listRecords(db, ownerId)).length;
  const pageBytes = JSON.stringify(store.listRecordsPage(db, ownerId, { limit: 50, offset: 0 })).length;

  const report = {
    records: size,
    seed_ms: seed.ms,
    list_all_ms: fullMs,
    page_first_ms: pageMs,
    page_deep_last_ms: deepMs,
    page_status_filtered_ms: filteredMs,
    speedup_first_page_x: +(fullMs / Math.max(pageMs, 0.01)).toFixed(1),
    response_bytes_full: fullBytes,
    response_bytes_first_page: pageBytes,
    response_reduction_x: +(fullBytes / Math.max(pageBytes, 1)).toFixed(1),
    scan: db.prepare('SELECT COUNT(*) AS n FROM records WHERE owner_id = ?').get(ownerId).n,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  await service.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
