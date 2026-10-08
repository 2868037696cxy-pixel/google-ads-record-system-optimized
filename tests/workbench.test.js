'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createStorage, validateSnapshot } = require('../lib/storage');
const { certificate } = require('./pdf-fixture');

async function fixture(t, token = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-test-'));
  const filename = path.join(directory, 'data.json');
  const child = fork(path.join(__dirname, 'server-fixture.js'), [], {
    env: { ...process.env, DATA_FILE: filename, TEST_DESKTOP_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(async () => { child.disconnect(); await once(child, 'exit'); fs.rmSync(directory, { recursive: true, force: true }); });
  const [{ origin, error }] = await once(child, 'message');
  assert.ok(origin, error);
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const result = await fetch(origin + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'x-desktop-token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  };
  return { request, filename, directory, origin, child };
}
const email = (user = 'test@example.com') => ({ user, pass: 'fixture-only', fakey: '' });

test('confirmed import persists and sanitizes client IDs and statuses', async (t) => {
  const { request, filename } = await fixture(t);
  assert.equal((await request('/api/import/emails', { items: [{ ...email(), id: 99, status: '已使用' }] })).status, 200);
  const value = JSON.parse(fs.readFileSync(filename));
  assert.equal(value.emails[0].id, 1); assert.equal(value.emails[0].status, '未使用');
});

test('automatic combined import rolls back on invalid proxy and creates no partial file', async (t) => {
  const { request, filename } = await fixture(t);
  const result = await request('/api/import/auto', { emails: [email()], proxies: [{ host: 'proxy.example', port: '70000' }] });
  assert.equal(result.status, 400);
  assert.equal((await request('/api/bootstrap')).body.pools.emails.length, 0);
  assert.equal(fs.existsSync(filename), false);
});

test('duplicate fingerprints reject entire batch without consuming resources', async (t) => {
  const { request } = await fixture(t);
  await request('/api/records', { domains: ['first.example'], fp_prefix: 'test', start_seq: 1, proxy_mode: 'none' });
  await request('/api/import/emails', { items: [email()] });
  assert.equal((await request('/api/records', { domains: ['second.example'], fp_prefix: 'test', start_seq: 1 })).status, 400);
  const data = (await request('/api/bootstrap')).body;
  assert.equal(data.records.length, 1); assert.equal(data.pools.emails[0].status, '未使用');
});

test('rejects batches over 500 and duplicated domains', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/records', { domains: Array.from({ length: 501 }, (_, i) => `a${i}.example`) })).status, 400);
  assert.equal((await request('/api/records', { domains: ['a.example', 'a.example'] })).status, 400);
});

test('invalid reassignment does not release the original resource or alter fields', async (t) => {
  const { request } = await fixture(t);
  await request('/api/import/emails', { items: [email()] });
  await request('/api/records', { domains: ['a.example'], country: '丹麦' });
  assert.equal((await request('/api/records/1', { email_id: 999, country: 'changed' }, 'PATCH')).status, 400);
  const data = (await request('/api/bootstrap')).body;
  assert.equal(data.records[0].country, '丹麦'); assert.equal(data.records[0].email_id, 1);
  assert.equal(data.pools.emails[0].status, '已使用');
});

test('used resources cannot be selected again, deleted, or marked available', async (t) => {
  const { request } = await fixture(t);
  await request('/api/import/emails', { items: [email()] });
  await request('/api/records', { domains: ['a.example'] });
  assert.equal((await request('/api/records', { domains: ['b.example'], email_ids: [1] })).status, 400);
  assert.equal((await request('/api/pool/emails/1', undefined, 'DELETE')).status, 400);
  assert.equal((await request('/api/pool/emails/1', { status: '未使用' }, 'PATCH')).status, 400);
});

test('deleting a record releases resources; stopped proxies cannot be shared', async (t) => {
  const { request } = await fixture(t);
  await request('/api/import/emails', { items: [email()] });
  await request('/api/import/proxies', { items: [{ host: 'proxy.example', port: '1080' }] });
  await request('/api/records', { domains: ['a.example'], proxy_id: 1 });
  await request('/api/records/1', undefined, 'DELETE');
  assert.equal((await request('/api/bootstrap')).body.pools.emails[0].status, '未使用');
  await request('/api/pool/proxies/1', { status: '停用' }, 'PATCH');
  assert.equal((await request('/api/records', { domains: ['b.example'], proxy_id: 1 })).status, 400);
});

test('failed filesystem save rolls back in-memory edits', async (t) => {
  const { request, filename } = await fixture(t);
  await request('/api/import/emails', { items: [email()] });
  fs.renameSync(filename, filename + '.preserved'); fs.mkdirSync(filename);
  assert.equal((await request('/api/import/licenses', { items: [{ name: 'Company' }] })).status, 500);
  assert.equal((await request('/api/bootstrap')).body.pools.licenses.length, 0);
  fs.rmdirSync(filename); fs.renameSync(filename + '.preserved', filename);
});

test('desktop service rejects requests without its session token', async (t) => {
  const { origin, request } = await fixture(t, 'test-session-token');
  assert.equal((await fetch(origin + '/api/bootstrap')).status, 401);
  assert.equal((await request('/api/bootstrap')).status, 200);
});

test('corrupt storage fails closed and never overwrites original bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
  try {
    const filename = path.join(directory, 'data.json'); fs.writeFileSync(filename, '{corrupted');
    assert.throws(() => createStorage(filename).load({}));
    assert.equal(fs.readFileSync(filename, 'utf8'), '{corrupted');
    assert.throws(() => validateSnapshot({ records: [] }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('each save retains previous data and caps automatic backups at 30', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
  try {
    const storage = createStorage(path.join(directory, 'data.json'));
    const value = { counters: {}, emails: [], proxies: [], cards: [], licenses: [], records: [] };
    for (let i = 1; i <= 34; i++) { value.emails = [email()]; value.emails[0].id = i; storage.save(value); }
    const files = fs.readdirSync(path.join(directory, 'backups'));
    assert.equal(files.length, 30);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'data.json'))).emails[0].id, 34);
    assert.ok(files.some((file) => JSON.parse(fs.readFileSync(path.join(directory, 'backups', file))).emails[0].id === 33));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('PDF attachment round-trips byte-for-byte and survives complete backup restore', async (t) => {
  const { request, child, origin, filename } = await fixture(t);
  // A minimal PDF header is sufficient here: parser integration uses a real PDF separately.
  const pdf = Buffer.from('%PDF-1.4\nfixture-only\n%%EOF').toString('base64');
  const metadata = { name: 'PBF Auto ApS', legal_name: 'PBF Auto ApS', address: 'Følfodvej 1', apt: '', zip: '9310', city: 'Vodskov' };
  assert.equal((await request('/api/import/licenses', { items: [metadata], pdf, filename: 'certificate.pdf' })).status, 200);
  const data = (await request('/api/bootstrap')).body;
  assert.equal(data.pools.licenses[0].address, 'Følfodvej 1');
  assert.ok(data.pools.licenses[0].document_id);
  const download = await fetch(origin + '/api/licenses/1/pdf');
  assert.equal(download.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await download.arrayBuffer()).toString('base64'), pdf);
  const snapshot = JSON.parse(fs.readFileSync(filename));
  await request('/api/import/licenses', { items: [{ name: 'Temporary' }] });
  const reply = once(child, 'message'); child.send({ restore: snapshot });
  assert.equal((await reply)[0].restored, true);
  assert.equal((await request('/api/bootstrap')).body.pools.licenses.length, 1);
  assert.equal(Buffer.from(await (await fetch(origin + '/api/licenses/1/pdf')).arrayBuffer()).toString('base64'), pdf);
});

test('multi-page PDF previews one company without saving rows or documents', async (t) => {
  const { request, filename } = await fixture(t);
  const pdf = certificate(undefined, 3).toString('base64');
  const parsed = await request('/api/parse/licenses-pdf', { pdf });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.items.length, 1);
  assert.equal(parsed.body.items[0].name, 'Example ApS');
  assert.equal(parsed.body.items[0].cvr, '12345678');
  assert.equal(fs.existsSync(filename), false);
  const imported = await request('/api/import/licenses', { pdf, items: parsed.body.items });
  assert.equal(imported.body.added, 1);
  const data = JSON.parse(fs.readFileSync(filename));
  assert.equal(data.licenses.length, 1);
  assert.equal(Object.keys(data.documents).length, 1);
});

test('unrecognized PDF text never becomes one company per line', async (t) => {
  const { request, filename } = await fixture(t);
  const pdf = certificate(['REGISTRATION', 'Unrecognized document', 'Street 42', 'Postal details', 'Footer']).toString('base64');
  const parsed = await request('/api/parse/licenses-pdf', { pdf });
  assert.equal(parsed.status, 200); assert.deepEqual(parsed.body.items, []);
  assert.equal(fs.existsSync(filename), false);
});

test('one PDF cannot import several licenses, and invalid attachments save nothing', async (t) => {
  const { request, filename } = await fixture(t);
  const pdf = certificate().toString('base64');
  for (const body of [{ pdf, items: [{ name: 'One' }, { name: 'Two' }] }, { pdf: '', items: [{ name: 'One' }] }, { pdf: 'aW52YWxpZA==', items: [{ name: 'One' }] }]) {
    assert.equal((await request('/api/import/licenses', body)).status, 400);
    assert.equal((await request('/api/bootstrap')).body.pools.licenses.length, 0);
    assert.equal(fs.existsSync(filename), false);
  }
});

test('reimporting the same PDF with corrected metadata updates one row and its linked record', async (t) => {
  const { request, filename, origin } = await fixture(t);
  const pdf = certificate().toString('base64');
  await request('/api/import/licenses', { pdf, items: [{ name: 'Example ApS', address: 'Old address' }] });
  await request('/api/records', { domains: ['test.example'] });
  const result = await request('/api/import/licenses', { pdf, filename: 'renamed.pdf', items: [{ name: 'Corrected ApS', address: 'New address' }] });
  assert.equal(result.status, 200); assert.equal(result.body.added, 0);
  const data = (await request('/api/bootstrap')).body;
  assert.equal(data.pools.licenses.length, 1); assert.equal(data.pools.licenses[0].id, 1);
  assert.equal(data.pools.licenses[0].status, '已使用'); assert.equal(data.records[0].license_id, 1);
  assert.equal(data.records[0].license_name, 'Corrected ApS');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(filename)).documents).length, 1);
  assert.equal(Buffer.from(await (await fetch(origin + '/api/licenses/1/pdf')).arrayBuffer()).toString('base64'), pdf);
});

test('PDF identity conflicting with a different company fails without merging or overwriting', async (t) => {
  const { request, filename } = await fixture(t);
  const pdf = certificate().toString('base64');
  await request('/api/import/licenses', { pdf, items: [{ name: 'First' }] });
  await request('/api/import/licenses', { items: [{ name: 'Other' }] });
  const before = fs.readFileSync(filename, 'utf8');
  assert.equal((await request('/api/import/licenses', { pdf, items: [{ name: 'Other' }] })).status, 400);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
});

test('replacing or deleting a PDF drops only unreferenced attachments; backups retain originals', async (t) => {
  const { request, filename, directory } = await fixture(t);
  const first = certificate().toString('base64');
  const second = certificate(['Updated certificate']).toString('base64');
  await request('/api/import/licenses', { pdf: first, items: [{ name: 'First' }] });
  await request('/api/import/licenses', { pdf: second, items: [{ name: 'First' }] });
  let saved = JSON.parse(fs.readFileSync(filename));
  assert.equal(Object.keys(saved.documents).length, 1);
  assert.equal(Object.values(saved.documents)[0].base64, second);
  assert.ok(fs.readdirSync(path.join(directory, 'backups')).some((name) => Object.values(JSON.parse(fs.readFileSync(path.join(directory, 'backups', name))).documents).some((document) => document.base64 === first)));
  await request('/api/pool/licenses/1', undefined, 'DELETE');
  saved = JSON.parse(fs.readFileSync(filename));
  assert.equal(saved.licenses.length, 0); assert.deepEqual(saved.documents, {});
});

test('pool edits reject duplicates and refresh linked record snapshots used in exports', async (t) => {
  const { request } = await fixture(t);
  await request('/api/import/emails', { items: [email('first@example.com'), email('second@example.com')] });
  await request('/api/import/proxies', { items: [{ host: 'proxy.example', port: '1080', pass: 'old' }] });
  await request('/api/import/cards', { items: [{ number: '4367970152619097', expiry: '06/29', cvv: '123' }] });
  await request('/api/import/licenses', { items: [{ name: 'Company' }] });
  await request('/api/records', { domains: ['one.example'], proxy_id: 1 });
  assert.equal((await request('/api/pool/emails/2', { user: 'FIRST@example.com' }, 'PATCH')).status, 400);
  for (const [type, change] of [['emails', { pass: 'new password' }], ['proxies', { pass: 'new proxy password' }], ['cards', { cvv: '456' }], ['licenses', { name: 'New Company' }]]) {
    assert.equal((await request(`/api/pool/${type}/1`, change, 'PATCH')).status, 200);
  }
  const data = (await request('/api/bootstrap')).body;
  assert.equal(data.records[0].email_pass, 'new password'); assert.equal(data.records[0].proxy_pass, 'new proxy password');
  assert.equal(data.records[0].card_cvv, '456'); assert.equal(data.records[0].license_name, 'New Company');
  const exported = await request('/api/export/adspower', {});
  assert.ok(exported.body.text.includes('password=new password\n'));
});

test('record count and resource references reject malformed values without partial writes', async (t) => {
  const { request } = await fixture(t);
  for (const count of [501, 0, -1, 1.5, '2invalid', true]) {
    assert.equal((await request('/api/records', { count })).status, 400, String(count));
  }
  await request('/api/import/emails', { items: [email()] });
  await request('/api/records', { domains: ['one.example'] });
  for (const email_id of [true, [], {}, '1invalid', 1.5, 0]) {
    assert.equal((await request('/api/records/1', { email_id, country: 'must not change' }, 'PATCH')).status, 400);
  }
  assert.equal((await request('/api/bootstrap')).body.records[0].country, '');
  assert.equal((await request('/api/records', { domains: ['Example.com', 'https://example.com/path'] })).status, 400);
});

test('CSV protects formula values and preserves card numbers; AdsPower has no injected lines', async (t) => {
  const { request } = await fixture(t);
  await request('/api/import/emails', { items: [email()] });
  await request('/api/import/cards', { items: [{ number: '4367970152619097', expiry: '06/29', cvv: '007' }] });
  await request('/api/records', { domains: ['one.example'], country: '=SUM(1)', product: 'product\nname=injected' });
  const csv = (await request('/api/export/csv', {})).body.text;
  assert.ok(csv.includes("'=SUM(1)")); assert.ok(csv.includes("'4367970152619097")); assert.ok(csv.includes("'007"));
  const adspower = (await request('/api/export/adspower', {})).body.text;
  assert.equal(adspower.split('\n').filter((line) => line.startsWith('name=')).length, 1);
});

test('backup validation rejects dangling references, duplicate allocation and missing PDFs', () => {
  const data = { emails: [{ id: 1, ...email(), status: '未使用' }], proxies: [], cards: [], licenses: [], records: [{ id: 1, fingerprint: 'test1', email_id: 1 }] };
  const validated = validateSnapshot(data);
  assert.equal(validated.emails[0].status, '已使用'); assert.equal(data.emails[0].status, '未使用');
  assert.throws(() => validateSnapshot({ ...data, records: [{ id: 1, email_id: 999 }] }), /资源不存在/);
  assert.throws(() => validateSnapshot({ ...data, records: [...data.records, { id: 2, email_id: 1 }] }), /多条记录占用/);
  assert.throws(() => validateSnapshot({ ...data, records: [...data.records, { id: 2, fingerprint: 'test1' }] }), /重复指纹/);
  assert.throws(() => validateSnapshot({ ...data, licenses: [{ id: 1, document_id: 'a'.repeat(64) }] }), /PDF 缺失/);
});

test('invalid restore leaves current records, PDF and disk snapshot intact', async (t) => {
  const { request, child, filename } = await fixture(t);
  await request('/api/import/licenses', { pdf: certificate().toString('base64'), items: [{ name: 'Company' }] });
  await request('/api/records', { domains: ['test.example'] });
  const before = fs.readFileSync(filename, 'utf8');
  const invalid = JSON.parse(before); invalid.records[0].license_id = 999;
  const restored = once(child, 'message'); child.send({ restore: invalid });
  assert.match((await restored)[0].error, /资源不存在/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.equal((await request('/api/bootstrap')).body.records[0].license_id, 1);
});

test('shared proxy stays allocated until its last record is deleted', async (t) => {
  const { request } = await fixture(t);
  await request('/api/import/proxies', { items: [{ host: 'proxy.example', port: '1080' }] });
  assert.equal((await request('/api/records', { domains: ['a.example', 'b.example'], proxy_id: 1 })).status, 200);
  await request('/api/records/1', undefined, 'DELETE');
  assert.equal((await request('/api/bootstrap')).body.pools.proxies[0].status, '已使用');
  await request('/api/records/2', undefined, 'DELETE');
  assert.equal((await request('/api/bootstrap')).body.pools.proxies[0].status, '未使用');
});

test('mixed imports and selected exports preserve resource values and return only requested records', async (t) => {
  const { request } = await fixture(t);
  const parsed = await request('/api/parse/auto', { text: 'first@example.com|password|JBSWY3DPEHPK3PXP\nsocks5://user:secret@proxy.example:1080' });
  assert.equal(parsed.body.emails.length, 1); assert.equal(parsed.body.proxies.length, 1);
  await request('/api/import/auto', parsed.body);
  await request('/api/import/emails', { items: [email('second@example.com')] });
  await request('/api/records', { domains: ['a.example', 'b.example'], proxy_id: 1 });
  const exported = await request('/api/export/adspower', { ids: [2] });
  assert.equal(exported.body.count, 1); assert.ok(exported.body.text.includes('username=second@example.com'));
  assert.ok(!exported.body.text.includes('username=first@example.com'));
  const reimport = await request('/api/parse/auto', { text: exported.body.text });
  assert.deepEqual(reimport.body.emails, [{ user: 'second@example.com', pass: 'fixture-only', fakey: '' }]);
  assert.equal(reimport.body.proxies[0].host, 'proxy.example');
});
