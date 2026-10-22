'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-resource-relations-'));
process.env.DATA_DIR = directory;
process.env.DB_FILE = path.join(directory, 'workbench.sqlite');
process.env.DATA_FILE = path.join(directory, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';
const service = require('../server');
const kinds = { emails: 'email', proxies: 'proxy', cards: 'card', licenses: 'license' };
let origin, sequence = 0;
test.before(async () => { origin = await service.start({ port: 0 }); });
test.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });

async function fixture(count = 1) {
  const n = ++sequence;
  const registration = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'x-workbench': '1', 'content-type': 'application/json' }, body: JSON.stringify({ username: `relations-${n}`, password: 'Relations-Test-1234' }) });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const api = async (method, route, body) => {
    const response = await fetch(origin + route, { method, headers: { 'x-workbench': '1', cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const resources = {
    emails: [{ user: `relations-${n}-a@example.test` }, { user: `relations-${n}-b@example.test` }],
    proxies: [{ host: '192.0.2.1', port: '1080', type: 'socks5' }, { host: '192.0.2.2', port: '1080', type: 'socks5' }],
    cards: [{ number: `Relations-${n}-A`, last4: '1234' }, { number: `Relations-${n}-B`, last4: '5678' }],
    licenses: [{ name: `Relations Alpha ${n}`, legal_name: `Relations Alpha ${n}` }, { name: `Relations Beta ${n}`, legal_name: `Relations Beta ${n}` }],
  };
  for (const [kind, items] of Object.entries(resources)) assert.equal((await api('POST', `/api/import/${kind}`, { items })).status, 200);
  const created = await api('POST', '/api/records', { domains: Array.from({ length: count }, (_, i) => `relations-${n}-${i}.example`), proxy_mode: 'auto' });
  assert.equal(created.status, 200);
  const summary = async () => (await api('GET', '/api/bootstrap?summary=1')).data;
  return { api, summary, records: created.data.created, pools: (await summary()).pools };
}

test('PATCH replacement persists all four resource IDs, snapshots and authoritative usage together', async () => {
  const { api, summary, records, pools } = await fixture();
  const before = records[0];
  const patch = Object.fromEntries(Object.entries(kinds).map(([kind, prefix]) => [`${prefix}_id`, pools[kind][1].id]));
  const result = await api('PATCH', `/api/records/${before.id}`, { version: before.version, ...patch });
  assert.equal(result.status, 200);
  for (const key of Object.keys(patch)) assert.equal(result.data.record[key], patch[key], `${key} must be persisted, not just copied into a display snapshot`);
  assert.equal(result.data.record.version, before.version + 1);
  const updated = await summary();
  for (const kind of Object.keys(kinds)) {
    assert.equal(updated.pools[kind][0].status, '未使用');
    assert.equal(updated.pools[kind][0].linked_record_count, 0);
    assert.equal(updated.pools[kind][1].status, '已使用');
    assert.equal(updated.pools[kind][1].linked_record_count, 1);
  }
  const email = updated.pools.emails[1];
  assert.equal((await api('PATCH', `/api/pool/emails/${email.id}`, { user: 'replacement-synchronized@example.test', version: email.version })).status, 200);
  const page = (await api('GET', '/api/records?limit=50')).data;
  assert.equal(page.items[0].email_user, 'replacement-synchronized@example.test', 'future resource edits must follow the actual new foreign key');
});

test('PATCH clearing all four resources persists NULL and releases usage and snapshots', async () => {
  const { api, summary, records } = await fixture();
  const before = records[0];
  const ids = Object.fromEntries(Object.values(kinds).map(prefix => [`${prefix}_id`, null]));
  const response = await api('PATCH', `/api/records/${before.id}`, { version: before.version, ...ids });
  assert.equal(response.status, 200);
  for (const key of Object.keys(ids)) assert.equal(response.data.record[key], null, `${key} must actually be cleared`);
  for (const key of ['email_user', 'proxy_host', 'card_number', 'license_name']) assert.equal(response.data.record[key], '');
  const updated = await summary();
  for (const kind of Object.keys(kinds)) for (const item of updated.pools[kind]) {
    assert.equal(item.status, '未使用');
    assert.equal(item.linked_record_count, 0);
  }
});

test('occupied replacement is rejected without releasing or rewriting either record', async () => {
  const { api, summary, records } = await fixture(2);
  const [left, right] = records;
  const response = await api('PATCH', `/api/records/${right.id}`, { version: right.version, email_id: left.email_id, license_id: left.license_id });
  assert.equal(response.status, 400);
  const page = (await api('GET', '/api/records?limit=50')).data;
  const after = page.items.find(record => record.id === right.id);
  assert.equal(after.email_id, right.email_id);
  assert.equal(after.license_id, right.license_id);
  assert.equal(after.version, right.version);
  const updated = await summary();
  for (const kind of Object.keys(kinds)) for (const item of updated.pools[kind]) {
    assert.equal(item.status, '已使用');
    assert.equal(item.linked_record_count, 1);
  }
});
