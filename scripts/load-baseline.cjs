'use strict';
/**
 * 并发压测基线（方案工作包 07「渐进压测」）。
 *
 * 方案要求：以模拟数据按 10 / 30 / 50 等并发请求档位逐级增加，记录耗时、错误率和内存峰值；
 * 验收标准是「压力下不串用户、不重复写入、不吞错误」。
 * 因此本脚本不只报耗时，还**在并发压力下校验账号隔离**：两个账号交替发起请求，
 * 每个响应里的记录必须全部属于发起方（用指纹前缀区分），出现一条别人的记录即计一次越界。
 *
 * 口径说明：档位是并发请求数，不是支持人数承诺；单进程内存峰值含服务端与压测端。
 * 用法：node scripts/load-baseline.cjs [每个账号的记录条数，默认 2000]
 * 输出为可直接引用的 JSON，便于回填验收记录、逐版本对比。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const size = Math.max(Number(process.argv[2]) || 2000, 100);
// 1 是基准档：并发 1 的耗时是「单个请求自身成本」，与高并发档位相减即可看出
// 延迟增长里有多少来自排队串行，而不是每请求成本变高。
const LEVELS = [1, 10, 30, 50];
const ROUNDS = 3;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-load-'));
process.env.DATA_DIR = dir;
process.env.DB_FILE = path.join(dir, 'load.sqlite');
process.env.DATA_FILE = path.join(dir, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');

const rssMb = () => +(process.memoryUsage().rss / 1024 / 1024).toFixed(1);
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

(async () => {
  const origin = await service.start({ port: 0 });
  const register = async (username) => {
    const r = await fetch(`${origin}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workbench': '1' },
      body: JSON.stringify({ username, password: 'Load-Test-1234' }),
    });
    if (r.status !== 201) throw new Error(`注册 ${username} 失败：HTTP ${r.status}`);
    return r.headers.get('set-cookie').split(';')[0];
  };
  const sessions = { a: await register('load-a'), b: await register('load-b') };
  const prefix = { a: 'a-', b: 'b-' };

  const db = service.db;
  const insert = db.prepare(`INSERT INTO records(owner_id,seq,fingerprint,country,product,domain,name,status,created_at)
                             VALUES(?,?,?,?,?,?,?,?,?)`);
  db.exec('BEGIN IMMEDIATE');
  for (const who of ['a', 'b']) {
    const ownerId = db.prepare('SELECT id FROM users WHERE username = ?').get(`load-${who}`).id;
    for (let i = 1; i <= size; i += 1) {
      insert.run(ownerId, i, `${prefix[who]}${String(i).padStart(6, '0')}`, '丹麦', `产品${i}`,
        `shop-${i}.example`, `记录 ${i}`, '正常', '2026-01-01 00:00:00');
    }
  }
  db.exec('COMMIT');
  const seeded = db.prepare('SELECT COUNT(*) AS n FROM records').get().n;

  const report = { records_per_user: size, seeded_total: seeded, levels: [], rss_before_mb: rssMb() };

  for (const level of LEVELS) {
    const latencies = [];
    let errors = 0;
    let crossUser = 0;
    let rssPeak = rssMb();

    for (let round = 0; round < ROUNDS; round += 1) {
      const tasks = [];
      for (let i = 0; i < level; i += 1) {
        const who = i % 2 === 0 ? 'a' : 'b';
        tasks.push((async () => {
          const started = performance.now();
          try {
            const res = await fetch(`${origin}/api/records?limit=50`, {
              headers: { 'x-workbench': '1', cookie: sessions[who] },
            });
            const body = await res.json();
            if (res.status !== 200 || !Array.isArray(body.items)) { errors += 1; return; }
            // 「不串用户」：响应里的每一条都必须属于发起方
            if (!body.items.every((row) => String(row.fingerprint).startsWith(prefix[who]))) crossUser += 1;
            if (body.items.length !== 50 || body.total !== size) errors += 1;
          } catch { errors += 1; } finally {
            latencies.push(performance.now() - started);
          }
        })());
      }
      await Promise.all(tasks);
      rssPeak = Math.max(rssPeak, rssMb());
    }

    const sorted = latencies.slice().sort((x, y) => x - y);
    report.levels.push({
      concurrency: level,
      requests: sorted.length,
      errors,
      cross_user_responses: crossUser,
      p50_ms: +pct(sorted, 0.5).toFixed(1),
      p95_ms: +pct(sorted, 0.95).toFixed(1),
      max_ms: +sorted[sorted.length - 1].toFixed(1),
      rss_peak_mb: rssPeak,
    });
  }

  report.rss_after_mb = rssMb();
  report.ok = report.levels.every((l) => l.errors === 0 && l.cross_user_responses === 0);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  await service.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
