'use strict';
// 审计留痕（方案 WP09「监控日志和运维」）：修改与删除必须可追溯。
//
// 多人共用同一份数据时，「这条记录是谁删的 / 谁改的」是必然会被问到的问题，
// 而删除是不可逆的。此前创建、导出、备份、解锁都有审计，唯独删除是空白。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-audit-'));
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
    body: JSON.stringify({ username: 'auditor', password: 'Secure-Test-1234' }),
  });
  assert.equal(r.status, 201);
  cookie = r.headers.get('set-cookie').split(';')[0];
  // 每条记录会消耗一个邮箱与一张卡；本用例要建两条记录，所以各备两份。
  // （第 10 轮在另一个用例上踩过这个坑，当时猜了两轮才定位。）
  await api('POST', '/api/import/emails', { items: [
    { user: 'auditor1@example.test', pass: 'Auditor-Pass-1234' },
    { user: 'auditor2@example.test', pass: 'Auditor-Pass-5678' },
  ] });
  await api('POST', '/api/import/cards', { items: [
    { number: 'auditor-card-1', last4: '4242', expiry: '12/29' },
    { number: 'auditor-card-2', last4: '4243', expiry: '12/29' },
  ] });
});
test.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('修改与删除都必须留下审计记录', async () => {
  const a = await api('POST', '/api/records', { domains: ['audit-a.shop'], proxy_mode: 'none' });
  const b = await api('POST', '/api/records', { domains: ['audit-b.shop'], proxy_mode: 'none' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200, '前提：应能创建两条记录');
  const idA = a.value.created[0].id;
  const idB = b.value.created[0].id;

  // 三种改动路径各自走一遍：修改、单条删除、批量删除
  const beforeEdit = (await api('GET', '/api/bootstrap')).value.records.find((row) => row.id === idA);
  assert.equal((await api('PATCH', `/api/records/${idA}`, { product: '审计测试产品', version: beforeEdit.version })).status, 200, '前提：修改应成功');
  assert.equal((await api('DELETE', `/api/records/${idA}`)).status, 200, '前提：删除应成功');
  assert.equal((await api('POST', '/api/records/batch-delete', { ids: [idB] })).status, 200, '前提：批量删除应成功');

  const events = (await api('GET', '/api/audit')).value.events;
  const actions = events.map((e) => e.action);
  assert.ok(actions.includes('records.update'),
    `审计里没有 records.update，实际有：${[...new Set(actions)].join(', ')}`);
  assert.equal(actions.filter((x) => x === 'records.delete').length, 2,
    `应有 2 条 records.delete（单条 + 批量各一），实际 ${actions.filter((x) => x === 'records.delete').length} 条`);

  // 删除记录不应被审计的敏感值污染
  const text = JSON.stringify(events);
  assert.ok(!text.includes('Auditor-Pass-1234'), '审计内容里出现了账号口令');
});
