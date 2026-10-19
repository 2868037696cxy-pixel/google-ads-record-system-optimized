'use strict';
// 审计 F14（P2）的前置：给行拆分逻辑补一份**现状记录**用例。
//
// server.js:158-168 把整行按十种分隔符切开，再机械取 parts[0]/[1]/[2] 当
// user/pass/fakey。第 68 轮定位到这里后没有直接改实现，因为 tests/ 里此前
// **没有任何用例覆盖这段切分** —— 改对没有证据，改错没有护栏。
//
// 本文件不改变任何行为，只把现状固定下来。其中第 3 组是**缺陷本身**：
// 密码里含分隔符会被截断，碎片落到 fakey（2FA 被密码污染）。
// 将来修 F14 时，第 3 组的期望要改成新行为 —— 那是这份用例存在的意义。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-f14-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');
let origin, cookie;

const parseEmails = async (text) => {
  const r = await fetch(`${origin}/api/parse/emails`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench': '1', cookie },
    body: JSON.stringify({ text }),
  });
  const t = await r.text();
  let v; try { v = JSON.parse(t); } catch { v = t.slice(0, 160); }
  assert.equal(r.status, 200, `解析接口返回 ${r.status}：${JSON.stringify(v)}`);
  assert.ok(Array.isArray(v.items), `返回结构不对，拿不到 items 数组：${JSON.stringify(v)}`);
  return v.items;
};

test.before(async () => {
  origin = await service.start({ port: 0 });
  const r = await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: 'f14', password: 'Secure-Test-1234' }),
  });
  assert.equal(r.status, 201);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('规范的 user / pass / 2FA 三列能正确拆开', async () => {
  const rows = await parseEmails('ok1@example.test Secret123 JBSWY3DPEHPK3PXP');
  assert.equal(rows.length, 1, `应解析出 1 行，实际 ${rows.length}`);
  assert.equal(rows[0].user, 'ok1@example.test');
  assert.equal(rows[0].pass, 'Secret123');
  assert.equal(rows[0].fakey, 'JBSWY3DPEHPK3PXP');
});

test('只有两列时 2FA 必须留空，不能把空串当成密钥', async () => {
  const rows = await parseEmails('ok2@example.test Secret123');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pass, 'Secret123');
  assert.equal(rows[0].fakey, '', `无 2FA 时 fakey 应为空串，实际 ${JSON.stringify(rows[0].fakey)}`);
});

test('密码含分隔符时不得截断，也不得污染 2FA（F14 修复目标）', async () => {
  // 第 69 轮这条记为"现状记录"（当时 pass="pa"、fakey="ss"）。第 70 轮修好实现后
  // 期望翻转为完整密码 —— 这个翻转就是 F14 闭环的证据。
  const rows = await parseEmails('ok3@example.test pa:ss');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user, 'ok3@example.test');
  assert.equal(rows[0].pass, 'pa:ss',
    `密码被截断成 ${JSON.stringify(rows[0].pass)}，应保留完整的 "pa:ss"（审计 F14）`);
  assert.equal(rows[0].fakey, '',
    `2FA 被密码碎片污染成 ${JSON.stringify(rows[0].fakey)}，应为空串`);
});

test('密码含分隔符、同时确有 2FA 时，两者都要正确', async () => {
  const rows = await parseEmails('ok4@example.test pa ss:word JBSWY3DPEHPK3PXP');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pass, 'pa ss:word', `密码应为 "pa ss:word"，实际 ${JSON.stringify(rows[0].pass)}`);
  assert.equal(rows[0].fakey, 'JBSWY3DPEHPK3PXP', `2FA 应被识别出来，实际 ${JSON.stringify(rows[0].fakey)}`);
});
