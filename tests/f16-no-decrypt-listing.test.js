'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-f16-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');
const { getVault, PROTECTED } = require('../lib/vault');

let origin, cookie;
const password = 'F16-Secure-Test-1234';

async function api(method, route, body) {
  const response = await fetch(origin + route, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-workbench': '1',
      cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value = null;
  try { value = JSON.parse(text); } catch {}
  return { status: response.status, value };
}

test.before(async () => {
  origin = await service.start({ port: 0 });
  const registered = await fetch(origin + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: 'f16-user', password }),
  });
  assert.equal(registered.status, 201);
  cookie = registered.headers.get('set-cookie').split(';')[0];

  const imported = await api('POST', '/api/import/emails', {
    items: [{ user: 'f16@example.test', pass: 'email-secret', fakey: 'JBSWY3DPEHPK3PXP' }],
  });
  assert.equal(imported.status, 200);

  const created = await api('POST', '/api/records', {
    domains: ['f16.example'],
    proxy_mode: 'none',
  });
  assert.equal(created.status, 200);
});

test.after(async () => {
  await service.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('F16: ordinary bootstrap and paged records never decrypt secrets; reveal does', async () => {
  const vault = getVault(service.db);
  const originalOpen = vault.open;
  let opens = 0;
  vault.open = function countedOpen(...args) {
    opens += 1;
    return originalOpen.apply(this, args);
  };

  try {
    const summary = await api('GET', '/api/bootstrap?summary=1');
    assert.equal(summary.status, 200);
    assert.equal(summary.value.pools.emails[0].pass, PROTECTED);
    assert.equal(opens, 0, '普通 bootstrap 不应为脱敏列表先解密资源凭据');

    const page = await api('GET', '/api/records?limit=50&offset=0');
    assert.equal(page.status, 200);
    assert.equal(page.value.items[0].email_pass, PROTECTED);
    assert.equal(opens, 0, '普通分页列表不应先解密记录凭据');

    const unlocked = await api('POST', '/api/security/unlock', { password });
    assert.equal(unlocked.status, 200);

    const revealedSummary = await api('GET', '/api/bootstrap?summary=1&reveal=1');
    assert.equal(revealedSummary.status, 200);
    assert.equal(revealedSummary.value.pools.emails[0].pass, 'email-secret');
    assert.ok(opens > 0, '二次验证后的 reveal 才允许真正解密');

    const beforeRecords = opens;
    const revealedPage = await api('GET', '/api/records?limit=50&offset=0&reveal=1');
    assert.equal(revealedPage.status, 200);
    assert.equal(revealedPage.value.items[0].email_pass, 'email-secret');
    assert.ok(opens > beforeRecords, 'reveal 当前页应按需解密当前页敏感字段');
  } finally {
    vault.open = originalOpen;
  }
});
