'use strict';
// 审计 F03（P1，已复现·HTTP）：付款工具别名可夹带完整卡号，绕过禁存规则。
//
// 审计的原始复现：number 用 4111 与三组 1111、组间用 Tab 分隔，导入返回 200，
// 原始字符串被存进付款工具 number 字段。原因是旧实现只剥空格和连字符，
// 制表符打断了连续数字，`\d{12,19}` 匹配不到。
//
// 本用例把「分隔符变体」逐个打一遍，并确认合法别名/末四位/有效期仍然可用 ——
// 只堵不疏会把正常业务一起堵死。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertNoCardSecrets } = require('../lib/vault');

const rejects = (value, note) => assert.throws(
  () => assertNoCardSecrets({ number: value }),
  /完整卡号/,
  `应拒绝但放过了：${JSON.stringify(value)}${note ? '（' + note + '）' : ''}`,
);
const accepts = (value) => assert.doesNotThrow(
  () => assertNoCardSecrets({ number: value }),
  `不应拒绝：${JSON.stringify(value)}`,
);

test('任何分隔符都不能把完整卡号拆成「付款工具别名」', () => {
  rejects('4111\t1111\t1111\t1111', '审计 F03 的原始复现：Tab 分组');
  rejects('4111111111111111', '无分隔');
  rejects('4111 1111 1111 1111', '普通空格');
  rejects('4111-1111-1111-1111', '连字符（旧实现已覆盖，防回归）');
  rejects('4111|1111|1111|1111', '竖线');
  rejects('4111,1111,1111,1111', '逗号');
  rejects('4111·1111·1111·1111', '中点');
  rejects('4111\n1111\n1111\n1111', '换行');
  rejects('４１１１　１１１１　１１１１　１１１１', '全角数字 + 表意空格');
  rejects('4111\u00a01111\u00a01111\u00a01111', '不换行空格 NBSP');
  rejects('卡 4111 / 1111 / 1111 / 1111 号', '带中文前后缀');
});

test('合法别名、末四位与有效期仍然可用', () => {
  accepts('Amex Business 0007');
  accepts('Finance-A');
  accepts('0007');
  accepts('4242');
  accepts('AD-0007');
  accepts('');
  // 带字母的引用编号不应被当作卡号
  accepts('PO 2025 9931');
  // 12 位以上但含字母的引用：压缩后数字不足 12 位连续
  accepts('INV-AB1234-CD5678');
});

test('CVV 仍然一律拒绝，且 card_number 字段同样受管', () => {
  for (const field of ['cvv', 'card_cvv', 'cvc', 'cvc2']) {
    assert.throws(() => assertNoCardSecrets({ [field]: '123' }), /CVV/, `${field} 应被拒绝`);
  }
  assert.throws(() => assertNoCardSecrets({ card_number: '4111\t1111\t1111\t1111' }), /完整卡号/,
    'card_number 字段也必须在禁止范围内');
});

test('HTTP 导入层面同样拒绝（审计的证据是接口返回 200）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cardalias-'));
  process.env.DATA_DIR = root;
  process.env.DB_FILE = path.join(root, 'test.sqlite');
  process.env.DATA_FILE = path.join(root, 'absent.json');
  process.env.REGISTRATION = 'open';
  process.env.LOG_LEVEL = 'silent';
  const service = require('../server');
  const origin = await service.start({ port: 0 });
  try {
    const reg = await fetch(`${origin}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' },
      body: JSON.stringify({ username: 'cardalias', password: 'Secure-Test-1234' }),
    });
    assert.equal(reg.status, 201);
    const cookie = reg.headers.get('set-cookie').split(';')[0];
    const post = async (body) => {
      const r = await fetch(`${origin}/api/import/cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-workbench': '1', cookie },
        body: JSON.stringify(body),
      });
      let v = null; try { v = JSON.parse(await r.text()); } catch { /* 非 JSON */ }
      return { status: r.status, value: v };
    };

    const bad = await post({ items: [{ number: '4111\t1111\t1111\t1111' }] });
    assert.equal(bad.status, 400,
      `Tab 分组的完整卡号返回 ${bad.status}（审计 F03 复现时为 200）—— 仍然可以入库`);
    assert.ok(!JSON.stringify(bad.value ?? {}).includes('4111'),
      '拒绝响应里回显了被拒绝的号码，等于把它写进了日志与前端');

    const good = await post({ items: [{ number: 'Amex Business 0007', last4: '0007', expiry: '12/29' }] });
    assert.equal(good.status, 200, `合法别名返回 ${good.status}，应为 200`);
    assert.equal(good.value.added, 1, '合法别名应正常入库');

    // 前提校验：确认库里确实有 1 条，否则上面的 added 断言可能只是空转
    const boot = await fetch(`${origin}/api/bootstrap`, { headers: { cookie, 'x-workbench': '1' } });
    const data = await boot.json();
    assert.equal(data.pools.cards.length, 1, `付款工具数应为 1，实际 ${data.pools.cards.length}`);

    // 编辑路径必须同样拒绝。assertNoCardSecrets 在 PATCH 与 updateRecordColumns
    // 两个边界上都被调用（server.js:1472、lib/store.js:216），这里把整条链路钉住 ——
    // 否则将来有人在某个边界上删掉这个校验，导入侧的测试仍然全绿。
    const patched = await fetch(`${origin}/api/pool/cards/1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-workbench': '1', cookie },
      body: JSON.stringify({ number: '4111\t1111\t1111\t1111' }),
    });
    assert.equal(patched.status, 400,
      `编辑路径返回 ${patched.status}，应拒绝夹带完整卡号的别名`);
    const after = await (await fetch(`${origin}/api/bootstrap`, { headers: { cookie, 'x-workbench': '1' } })).json();
    assert.equal(after.pools.cards[0].number, 'Amex Business 0007',
      `别名被改成了 ${JSON.stringify(after.pools.cards[0].number)} —— 编辑路径把完整卡号存了进去`);
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
