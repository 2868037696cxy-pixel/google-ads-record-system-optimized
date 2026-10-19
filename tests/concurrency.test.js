'use strict';
// 乐观并发控制（方案 WP07「并发保存」）。
//
// 既有的 security.test.js 覆盖的是**先后**发生的陈旧版本（改一次，再拿旧 version 改 → 409）。
// 那是不同的失效模式。真正危险的是**同时**：两个请求携带同一个 version 并发修改，
// 若两者都通过校验、都写入，后写的那次就静默覆盖了前一次 —— 也就是 lost update。
//
// 判定不只看返回码：两个都返回 200 才是漏洞，但即使恰好一个 200，
// 也要确认 version 只 +1（+2 说明两次写入都落库了）且最终值是赢家的完整值（不是混合）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-conc-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');
let origin, cookie;
const api = async (method, route, body) => {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-workbench': '1', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let value = null;
  try { value = JSON.parse(await r.text()); } catch { /* 非 JSON */ }
  return { status: r.status, value };
};
test.before(async () => {
  origin = await service.start({ port: 0 });
  const r = await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: 'racer', password: 'Secure-Test-1234' }),
  });
  assert.equal(r.status, 201);
  cookie = r.headers.get('set-cookie').split(';')[0];
  await api('POST', '/api/import/emails', { items: [{ user: 'racer@example.test', pass: 'Racer-Pass-1234' }] });
  await api('POST', '/api/import/cards', { items: [{ number: 'racer-card', last4: '4242', expiry: '12/29' }] });
});
test.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('同一 version 的两个并发修改必须恰好一个生效', async () => {
  const made = await api('POST', '/api/records', { domains: ['race.shop'], proxy_mode: 'none' });
  assert.equal(made.status, 200, '前提：应能创建记录');
  const id = made.value.created[0].id;
  const before = (await api('GET', '/api/bootstrap')).value.records.find((r) => r.id === id);
  assert.ok(before, '前提：应能读回刚创建的记录');

  // 同时发出两个修改，携带同一个 version，写入不同的值
  const [left, right] = await Promise.all([
    api('PATCH', `/api/records/${id}`, { country: 'CONCURRENT-LEFT', version: before.version }),
    api('PATCH', `/api/records/${id}`, { country: 'CONCURRENT-RIGHT', version: before.version }),
  ]);
  const statuses = [left.status, right.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409],
    `并发修改的返回应为 [200,409]，实际 [${statuses}]。两个都成功意味着一次修改被静默覆盖；两个都失败意味着该改的没改上`);

  const after = (await api('GET', '/api/bootstrap')).value.records.find((r) => r.id === id);
  const winner = left.status === 200 ? 'CONCURRENT-LEFT' : 'CONCURRENT-RIGHT';
  assert.equal(after.country, winner,
    `最终值为 ${after.country}，应为赢家写入的 ${winner}。出现其它值说明写入没有串行化`);
  assert.equal(after.version, before.version + 1,
    `version 从 ${before.version} 变为 ${after.version}，应恰好 +1。+2 说明两次写入都落库了（lost update）`);
});
