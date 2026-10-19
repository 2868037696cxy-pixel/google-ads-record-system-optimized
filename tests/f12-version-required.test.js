'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-f12-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');
let origin, cookie;

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
    body: JSON.stringify({ username: 'f12-user', password: 'Secure-Test-1234' }),
  });
  assert.equal(registered.status, 201);
  cookie = registered.headers.get('set-cookie').split(';')[0];
});

test.after(async () => {
  await service.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('F12: record PATCH requires an exact numeric version and cannot be bypassed by omission', async () => {
  const made = await api('POST', '/api/records', { domains: ['f12.example'], proxy_mode: 'none' });
  assert.equal(made.status, 200);
  const id = made.value.created[0].id;

  const before = (await api('GET', '/api/bootstrap')).value.records.find((row) => row.id === id);
  assert.ok(Number.isSafeInteger(before.version));

  for (const bad of [
    { country: 'NO-VERSION' },
    { country: 'NULL-VERSION', version: null },
    { country: 'STRING-VERSION', version: String(before.version) },
    { country: 'FLOAT-VERSION', version: before.version + 0.5 },
    { country: 'NEGATIVE-VERSION', version: -1 },
  ]) {
    const blocked = await api('PATCH', `/api/records/${id}`, bad);
    assert.equal(blocked.status, 428, JSON.stringify(bad));
  }

  const unchanged = (await api('GET', '/api/bootstrap')).value.records.find((row) => row.id === id);
  assert.equal(unchanged.country, before.country);
  assert.equal(unchanged.version, before.version);

  const ok = await api('PATCH', `/api/records/${id}`, { country: 'VERSIONED', version: before.version });
  assert.equal(ok.status, 200);
  const after = (await api('GET', '/api/bootstrap')).value.records.find((row) => row.id === id);
  assert.equal(after.country, 'VERSIONED');
  assert.equal(after.version, before.version + 1);

  const stale = await api('PATCH', `/api/records/${id}`, { country: 'STALE', version: before.version });
  assert.equal(stale.status, 409);
});

test('F12: resource PATCH also requires version, including status-only changes', async () => {
  const imported = await api('POST', '/api/import/emails', { items: [{ user: 'f12@example.test', pass: 'secret' }] });
  assert.equal(imported.status, 200);

  const before = (await api('GET', '/api/bootstrap')).value.pools.emails.find((row) => row.user === 'f12@example.test');
  assert.ok(Number.isSafeInteger(before.version));

  const missing = await api('PATCH', `/api/pool/emails/${before.id}`, { status: '停用' });
  assert.equal(missing.status, 428);

  const stringVersion = await api('PATCH', `/api/pool/emails/${before.id}`, { status: '停用', version: String(before.version) });
  assert.equal(stringVersion.status, 428);

  const unchanged = (await api('GET', '/api/bootstrap')).value.pools.emails.find((row) => row.id === before.id);
  assert.equal(unchanged.status, before.status);
  assert.equal(unchanged.version, before.version);

  const ok = await api('PATCH', `/api/pool/emails/${before.id}`, { status: '停用', version: before.version });
  assert.equal(ok.status, 200);

  const after = (await api('GET', '/api/bootstrap')).value.pools.emails.find((row) => row.id === before.id);
  assert.equal(after.status, '停用');
  assert.equal(after.version, before.version + 1);
});
