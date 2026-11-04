'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auto-mixed-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');
let origin, cookie;

const parseAuto = async (text) => {
  const response = await fetch(`${origin}/api/parse/auto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench': '1', cookie },
    body: JSON.stringify({ text }),
  });
  assert.equal(response.status, 200);
  return response.json();
};

test.before(async () => {
  origin = await service.start({ port: 0 });
  const response = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: 'auto-mixed', password: 'Secure-Test-1234' }),
  });
  assert.equal(response.status, 201);
  cookie = response.headers.get('set-cookie').split(';')[0];
});
test.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('混合 Tab 记录能识别中间邮箱字段及后面的代理', async () => {
  const result = await parseAuto([
    'account-01', 'example.shop', 'campaign-01',
    'mixed@example.test——mail-pass——ab12cd34ef56gh78ij90kl12mn34op78',
    '198.51.100.24', '22524', 'proxy-user', 'payment-metadata   06/29   ***', '', 'Example ApS',
  ].join('\t'));

  assert.deepEqual(result.emails, [{
    user: 'mixed@example.test',
    pass: 'mail-pass',
    fakey: 'ab12cd34ef56gh78ij90kl12mn34op78',
  }]);
  assert.deepEqual(result.proxies, [{
    sn: '', type: '', country: '', ip: '',
    host: '198.51.100.24', port: '22524', user: 'proxy-user', pass: '',
  }]);
});

test('混合记录不会把整行误作代理，且原有邮箱和代理格式不回归', async () => {
  const mixedWithoutProxy = ['account-02', 'example.shop', 'email-only@example.test——mail-pass——2fa-secret'].join('\t');
  const result = await parseAuto([
    mixedWithoutProxy,
    'plain@example.test——plain-pass——JBSWY3DPEHPK3PXP',
    'tab@example.test\tTab-pass\tJBSWY3DPEHPK3PXP',
    'socks5://proxy-user:proxy-pass@192.0.2.10:1080',
  ].join('\n'));

  assert.deepEqual(result.emails.map((item) => item.user), ['email-only@example.test', 'plain@example.test', 'tab@example.test']);
  assert.equal(result.emails[0].pass, 'mail-pass');
  assert.equal(result.emails[0].fakey, '2fa-secret');
  assert.deepEqual(result.emails[1], {
    user: 'plain@example.test', pass: 'plain-pass', fakey: 'JBSWY3DPEHPK3PXP',
  });
  assert.deepEqual(result.emails[2], {
    user: 'tab@example.test', pass: 'Tab-pass', fakey: 'JBSWY3DPEHPK3PXP',
  });
  assert.deepEqual(result.proxies, [{
    sn: '', type: 'socks5', country: '', ip: '',
    host: '192.0.2.10', port: '1080', user: 'proxy-user', pass: 'proxy-pass',
  }]);
});
