'use strict';
// 日志里不得出现明文凭据（方案工作包 09「监控日志和运维」）。
// 后端不把明文返回给前端已有测试覆盖，但日志是另一条出口，此前没人检查过。
// 关键：结尾有一道反空转断言 —— 若本次根本没捕获到日志，说明用例没有验证任何东西，
// 必须失败而不是通过。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-log-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'debug';

// pino 直接写流，不经过 console，所以要替掉流而不是替掉 console
const captured = [];
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return origOut(chunk, ...rest); };
process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return origErr(chunk, ...rest); };

const service = require('../server');

const MARK = { 邮箱密码: 'LOGMARK_PASSWORD_9f2c', '2FA': 'LOGMARK_2FA_9f2c', 卡号: 'LOGMARK_CARD_9f2c' };
const ACCOUNT_PASSWORD = 'Log-Test-Password-1234';
let origin, cookie;

test.before(async () => {
  origin = await service.start({ port: 0 });
  const r = await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: 'loguser', password: ACCOUNT_PASSWORD }),
  });
  assert.equal(r.status, 201);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(async () => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  await service.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const api = async (method, route, body) => {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-workbench': '1', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.status;
};

test('日志里不得出现明文密码、2FA 或卡号', async () => {
  await api('POST', '/api/import/emails', { items: [{ user: 'logmark@example.test', pass: MARK['邮箱密码'], fakey: MARK['2FA'] }] });
  await api('POST', '/api/import/cards', { items: [{ number: MARK['卡号'], last4: '4242', expiry: '12/29' }] });
  await api('POST', '/api/records', { domains: ['logmark.shop'], proxy_mode: 'none' });
  // 走过所有会把凭据「拿出来」的路径：解锁、明文校验、导出、审计
  await api('POST', '/api/security/unlock', { password: ACCOUNT_PASSWORD });
  await api('GET', '/api/bootstrap?reveal=1');
  await api('POST', '/api/export/adspower', {});
  await api('GET', '/api/audit');
  await new Promise((resolve) => setTimeout(resolve, 300)); // 等异步日志落地

  const all = captured.join('');
  assert.ok(all.length > 0, '本次没有捕获到任何日志：这条用例将失去意义，必须失败而不是静默通过（检查 LOG_LEVEL 是否生效）');

  for (const [kind, mark] of Object.entries(MARK)) {
    assert.ok(!all.includes(mark), `日志里出现了明文${kind}：${mark}`);
  }
  assert.ok(!all.includes(ACCOUNT_PASSWORD), '日志里出现了账号登录口令');
});
