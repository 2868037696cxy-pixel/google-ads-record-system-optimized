'use strict';
// 审计 F01：编码路径绕过 AdsPower 凭据导出的二次授权。
//
// 路由器按**解码后**的路径匹配路由，而 handler 里原先用
// `req.url.split('?')[0] === '/api/export/adspower'` 决定是否 requireUnlocked。
// 于是 POST /%61pi/export/adspower 命中 handler 却跳过解锁，把邮箱密码、2FA、
// 代理密码以 text 字符串返回 —— JSON 脱敏洗不到字符串里的凭据。
//
// 必须用原始 net 套接字：fetch 与 URL 解析会规范化百分号编码，用它测不出真东西。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-exportauthz-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');

const PASSWORD = 'Secure-Test-1234';
const EMAIL_PASS = 'EXPORTLEAK_9f2c';
const TWO_FA = 'TWOFALEAK_9f2c';
let origin, port;

const api = async (method, route, body, cookie) => {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-workbench': '1', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let value = null;
  const text = await r.text();
  try { value = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, value, text };
};

/** 原始套接字发请求，target 原样写进请求行，不受 URL 规范化影响。 */
const rawPost = (target, cookie, body = '{}') => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => {
    const head = [
      `POST ${target} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Content-Type: application/json',
      'X-Workbench: 1',
      cookie ? `Cookie: ${cookie}` : '',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
    ].filter(Boolean).join('\r\n');
    socket.write(`${head}\r\n\r\n${body}`);
  });
  const chunks = [];
  socket.on('data', (c) => chunks.push(c));
  socket.on('end', () => {
    const raw = Buffer.concat(chunks).toString('latin1');
    const status = Number((raw.match(/^HTTP\/1\.1 (\d{3})/) || [])[1] || 0);
    resolve({ status, raw });
  });
  socket.on('error', reject);
});

const register = async (username) => {
  const r = await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(r.status, 201, `注册 ${username} 失败`);
  return r.headers.get('set-cookie').split(';')[0];
};

test.before(async () => {
  origin = await service.start({ port: 0 });
  port = Number(new URL(origin).port);
});
test.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('编码路径不得绕过凭据导出的二次授权', async () => {
  const cookie = await register('exporter');
  await api('POST', '/api/import/emails', { items: [{ user: 'leak@example.test', pass: EMAIL_PASS, fakey: TWO_FA }] }, cookie);
  await api('POST', '/api/import/cards', { items: [{ number: 'leak-card', last4: '4242', expiry: '12/29' }] }, cookie);
  const made = await api('POST', '/api/records', { domains: ['leak.shop'], proxy_mode: 'none' }, cookie);
  assert.equal(made.status, 200, '前提：应能创建一条记录');

  // ① 未解锁：标准路径必须被拒（这是既有的正确行为）
  const standard = await rawPost('/api/export/adspower', cookie);
  assert.equal(standard.status, 403, `未解锁时标准路径返回 ${standard.status}，应为 403`);
  assert.ok(!standard.raw.includes(EMAIL_PASS), '标准路径的 403 响应里出现了邮箱密码');

  // ② 未解锁：各种等价编码路径都必须被拒 —— 这是 F01 的回归点
  const encodedTargets = [
    '/%61pi/export/adspower',
    '/ap%69/export/adspower',
    '/api/%65xport/adspower',
    '/%61pi/export/adspower?x=1',
    '/api/export/adspower/../export/adspower',
  ];
  for (const target of encodedTargets) {
    const res = await rawPost(target, cookie);
    assert.notEqual(res.status, 200, `POST ${target} 返回 200 —— 编码路径绕过了二次授权（审计 F01 复现）`);
    assert.ok(!res.raw.includes(EMAIL_PASS),
      `POST ${target} 的响应里出现了邮箱密码 ${EMAIL_PASS} —— 凭据已泄露`);
    assert.ok(!res.raw.includes(TWO_FA), `POST ${target} 的响应里出现了 2FA 值`);
  }

  // ③ 解锁后必须能导出（否则本用例会因为「一律 403」而假通过）
  const unlocked = await api('POST', '/api/security/unlock', { password: PASSWORD }, cookie);
  assert.equal(unlocked.status, 200, '前提：解锁应成功');
  const afterUnlock = await rawPost('/%61pi/export/adspower', cookie);
  assert.equal(afterUnlock.status, 200, `解锁后编码路径返回 ${afterUnlock.status}，应为 200`);
  assert.ok(afterUnlock.raw.includes(EMAIL_PASS),
    '解锁后导出内容里没有邮箱密码 —— 那么前面「未解锁必须不含密码」就失去了意义');
  assert.ok(afterUnlock.raw.includes(TWO_FA), '解锁后导出内容里没有 2FA 值');

  // ④ 另一个账号的会话不得继承这份解锁
  const other = await register('onlooker');
  await api('POST', '/api/import/emails', { items: [{ user: 'other@example.test', pass: 'OTHER_PASS_9f2c' }] }, other);
  await api('POST', '/api/import/cards', { items: [{ number: 'other-card', last4: '4243', expiry: '12/29' }] }, other);
  assert.equal((await api('POST', '/api/records', { domains: ['other.shop'], proxy_mode: 'none' }, other)).status, 200,
    '前提：另一个账号应能创建记录');
  const crossUser = await rawPost('/%61pi/export/adspower', other);
  assert.equal(crossUser.status, 403,
    `另一个账号未解锁就编码路径导出，返回 ${crossUser.status}，应为 403 —— 解锁不得跨会话继承`);
  assert.ok(!crossUser.raw.includes(EMAIL_PASS), '另一个账号的响应里出现了别人的邮箱密码');
});
