'use strict';
// 审计 F13（P2）：分页参数缺严格语义校验。
//
// 原实现用 `Number(x) || 默认值` 兜底：limit=abc → NaN → 50，limit=-3 → 夹成 1。
// 客户端以为按自己的要求翻了页，实际拿到的是另一页，且没有任何提示。
// 语义错误应当明确 400。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-f13-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');
let origin, cookie;

const get = async (qs) => {
  const r = await fetch(`${origin}/api/records${qs}`, { headers: { 'x-workbench': '1', cookie } });
  const t = await r.text();
  let v; try { v = JSON.parse(t); } catch { v = t.slice(0, 120); }
  return { status: r.status, v };
};

test.before(async () => {
  origin = await service.start({ port: 0 });
  const r = await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: 'f13', password: 'Secure-Test-1234' }),
  });
  assert.equal(r.status, 201);
  cookie = r.headers.get('set-cookie').split(';')[0];
  await fetch(`${origin}/api/records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench': '1', cookie },
    body: JSON.stringify({ domains: ['f13.shop'], proxy_mode: 'none' }),
  });
});
test.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('非法的 limit / offset 必须明确拒绝，不能静默换成默认值', async () => {
  for (const qs of ['?limit=abc', '?limit=-3', '?limit=1.5', '?offset=-1', '?offset=abc', '?limit=99999']) {
    const r = await get(qs);
    assert.equal(r.status, 400, `${qs} 返回 ${r.status} —— 旧实现会静默纠正后返回 200，客户端拿到的可能是另一页（F13）`);
  }
});

test('合法的分页参数仍然正常工作，且回显与实际一致', async () => {
  const r = await get('?limit=10&offset=0');
  assert.equal(r.status, 200, `合法参数被误拒：${r.status} ${JSON.stringify(r.v)}`);
  assert.equal(r.v.limit, 10, `回显 limit=${r.v.limit}，应为 10`);
  assert.equal(r.v.offset, 0, `回显 offset=${r.v.offset}，应为 0`);

  const d = await get('');
  assert.equal(d.status, 200, '不带参数应正常返回');
  assert.equal(d.v.limit, 50, `默认 limit 应为 50，实际 ${d.v.limit}`);
  assert.equal(d.v.offset, 0, `默认 offset 应为 0，实际 ${d.v.offset}`);
});
