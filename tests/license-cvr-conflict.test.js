'use strict';
// 审计 F04（P1）：相近公司名覆盖注册号。
//
// 命中既有行的判据只有「名称归一化相同」，但同一名称可能对应两家注册号不同的公司。
// 按「更新」处理时 {...toPublic(mine), ...it} 会让导入项的 cvr 覆盖既有行，
// 静默销毁原公司的注册号，而行数不变、added/updated 计数正常。
//
// 本用例同时钉两种形状——这是第 58 轮的教训：只测一种形状等于没测。
//   ① 注册号相同、名称不同  → 应 409 / 判重，行不变
//   ② 名称归一化相同、注册号不同 → 应判冲突且**整行不变**
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-f04-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');
let origin, cookie;

const call = async (method, route, body) => {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-workbench': '1', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let v; try { v = JSON.parse(t); } catch { v = t.slice(0, 200); }
  return { status: r.status, v };
};
const licences = async () => (await call('GET', '/api/bootstrap')).v.pools.licenses;
const importOne = (item) => call('POST', '/api/import/licenses', { items: [item] });

test.before(async () => {
  origin = await service.start({ port: 0 });
  const r = await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: 'f04', password: 'Secure-Test-1234' }),
  });
  assert.equal(r.status, 201);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('名称归一化相同但注册号不同：不得覆盖既有注册号', async () => {
  const a = await importOne({ name: 'Example Orchid ApS', legal_name: 'Example Orchid ApS', cvr: 'DK11111111', address: 'Nørregade 1' });
  assert.equal(a.v.added, 1, `前提：A 应新增成功，实际 ${JSON.stringify(a.v)}`);

  // 前置断言：确认这两行的名称键确实相同，否则测的就不是 F04 那种形状
  const dedup = require('../lib/dedup');
  assert.equal(dedup.normalizeCompanyName('Example Orchid ApS'), dedup.normalizeCompanyName('Example Orchid Ltd'),
    '前提：两个公司名归一化后必须相同，否则命中不了同一行');
  assert.notEqual(dedup.normalizeRegistrationNumber('DK11111111'), dedup.normalizeRegistrationNumber('DK22222222'),
    '前提：两个注册号必须不同');

  const before = JSON.stringify(await licences());

  const b = await importOne({ name: 'Example Orchid Ltd', legal_name: 'Example Orchid Ltd', cvr: 'DK22222222', address: 'Havnegade 2' });
  const after = await licences();

  // 关键断言：整行不变。不逐个字段挑着断，避免漏掉某个被覆盖的字段。
  assert.equal(JSON.stringify(after), before,
    `注册号不同却被当作更新写入了 —— 既有行被改写。B 的返回：${JSON.stringify(b.v)}`);

  assert.equal(after[0].cvr, 'DK11111111', `A 的注册号被改成了 ${JSON.stringify(after[0].cvr)}（审计 F04）`);
  assert.equal(after.length, 1, `执照行数变为 ${after.length}`);
  // 应当以冲突形式被跳过，而不是"更新成功"
  assert.notEqual(b.v.updated, 1, `B 被计为更新（updated=${b.v.updated}）—— 应判为冲突`);
  assert.equal(b.v.conflicts.length, 1, `应报告 1 条冲突，实际 ${JSON.stringify(b.v.conflicts)}`);
});

test('注册号相同但名称不同：仍按同一家公司处理，注册号不得丢失（修 F04 不能误伤改名）', async () => {
  // 同一注册号 = 同一家公司，改名属于正常业务，允许更新。
  // 这里守的是「不误伤」：修 F04 加的冲突判断只看注册号是否相等，
  // 不能让同号更新也被挡掉，更不能让注册号丢失。
  const r = await importOne({ name: 'Totally Different ApS', legal_name: 'Totally Different ApS', cvr: 'DK11111111' });
  const after = await licences();
  assert.equal(after.length, 1, `同号导入后行数变为 ${after.length}，不该新增行`);
  assert.equal(after[0].cvr, 'DK11111111', `同号更新后注册号变成 ${JSON.stringify(after[0].cvr)}，注册号不该丢失`);
  assert.equal(r.v.added, 0, '同号不应计为新增');
  assert.equal((r.v.conflicts || []).length, 0, `同号不应被判为冲突：${JSON.stringify(r.v.conflicts)}`);
});
