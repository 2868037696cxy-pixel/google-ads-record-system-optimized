'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createStorage, validateSnapshot } = require('../lib/storage');

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
