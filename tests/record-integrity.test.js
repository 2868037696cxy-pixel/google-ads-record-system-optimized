'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-integrity-'));
process.env.DATA_DIR = folder;
process.env.DB_FILE = path.join(folder, 'test.sqlite');
process.env.DATA_FILE = path.join(folder, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';
const service = require('../server');
const { SNAP, LINKS } = require('../lib/resource-snapshots');
let origin, sequence = 0;
test.before(async () => { origin = await service.start({ port: 0 }); });
test.after(async () => { await service.close(); fs.rmSync(folder, { recursive: true, force: true }); });

async function fixture(count = 1) {
  const index = ++sequence;
  const password = 'Integrity-Test-1234';
  const registration = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'x-workbench': '1', 'content-type': 'application/json' }, body: JSON.stringify({ username: `integrity-${index}`, password }) });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const owner = service.db.prepare('SELECT id FROM users WHERE username=?').get(`integrity-${index}`).id;
  const api = async (method, route, body) => {
    const response = await fetch(origin + route, { method, headers: { cookie, 'x-workbench': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cache: response.headers.get('cache-control') };
  };
  const resources = {
    emails: Array.from({ length: count }, (_, i) => ({ user: `integrity-${index}-${i}@example.test`, pass: 'SYNTHETIC-EMAIL-SECRET', fakey: 'SYNTHETIC-2FA' })),
    proxies: [{ host: `192.0.2.${index}`, port: '1080', type: 'socks5', pass: 'SYNTHETIC-PROXY-SECRET' }],
    cards: Array.from({ length: count }, (_, i) => ({ number: `Integrity-${index}-${i}`, last4: '1234', expiry: '12/29' })),
    licenses: Array.from({ length: count }, (_, i) => ({ name: `Integrity organization ${index} number ${i}` })),
  };
  for (const [kind, items] of Object.entries(resources)) assert.equal((await api('POST', `/api/import/${kind}`, { items })).status, 200);
  const proxyId = service.store.listPool(service.db, owner, 'proxies')[0].id;
  const made = await api('POST', '/api/records', { domains: Array.from({ length: count }, (_, i) => `integrity-${index}-${i}.example`), proxy_mode: 'shared', proxy_id: proxyId });
  assert.equal(made.status, 200);
  const row = id => service.store.getRecord(service.db, owner, id);
  const scan = async (query = '') => {
    const result = await api('GET', '/api/data-integrity' + query);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.cache, 'no-store');
    assert.ok(!JSON.stringify(result.data).includes('SYNTHETIC-'), 'diagnostics must never return credential values');
    assert.ok(!JSON.stringify(result.data).includes('wbenc1:'), 'diagnostics must never return ciphertext');
    return result.data;
  };
  const unlock = () => api('POST', '/api/security/unlock', { password });
  return { api, cookie, owner, row, scan, unlock, records: made.data.created };
}
const repairBody = (record, issue) => ({ action: issue.action, prefix: issue.prefix, record_id: record.id, record_version: record.version, resource_id: issue.resource_id, resource_version: issue.resource_version });
const rawOwner = owner => JSON.stringify(Object.fromEntries(['records', 'emails', 'proxies', 'cards', 'licenses', 'audit_events'].map(table => [table, service.db.prepare(`SELECT * FROM ${table} WHERE owner_id=? ORDER BY id`).all(owner)])));

test('read-only diagnosis compares decrypted snapshots, returns bounded metadata and detects all four types', async () => {
  const f = await fixture();
  const initial = rawOwner(f.owner);
  assert.equal((await f.scan()).findings.length, 0, 'independent AEAD ciphertexts of equal values are healthy');
  assert.equal(rawOwner(f.owner), initial, 'a scan must not modify rows, versions or audit');
  service.store.updateRecordColumns(service.db, f.owner, f.records[0].id, { email_user: 'old@example.test', email_pass: 'SYNTHETIC-OLD-PASS', proxy_port: '8080', card_number: 'Old alias', license_name: 'Old name' });
  const before = rawOwner(f.owner);
  const result = await f.scan();
  assert.equal(result.checked, 1);
  assert.deepEqual(result.findings[0].issues.map(issue => issue.prefix).sort(), ['card', 'email', 'license', 'proxy']);
  const email = result.findings[0].issues.find(issue => issue.prefix === 'email');
  assert.ok(email.fields.some(field => field.field === 'email_pass' && field.sensitive));
  assert.equal(rawOwner(f.owner), before);
});

test('explicit repair requires authorization, keeps IDs, repairs snapshots and rejects replay', async () => {
  const f = await fixture();
  const id = f.records[0].id;
  service.store.updateRecordColumns(service.db, f.owner, id, { email_user: 'old@example.test', email_pass: 'SYNTHETIC-OLD-PASS', proxy_port: '8080', card_number: 'Old alias', license_name: 'Old name' });
  let report = await f.scan();
  const first = repairBody(report.findings[0], report.findings[0].issues[0]);
  assert.equal((await f.api('POST', '/api/data-integrity/repair', first)).status, 403);
  await f.unlock();
  for (const prefix of Object.keys(LINKS)) {
    report = await f.scan();
    const finding = report.findings[0], issue = finding.issues.find(item => item.prefix === prefix);
    const body = repairBody(finding, issue);
    const response = await f.api('POST', '/api/data-integrity/repair', body);
    assert.equal(response.status, 200, JSON.stringify({ prefix, body, result: response.data }));
    assert.equal(response.data.changed, true);
    const record = f.row(id);
    assert.equal(record[`${prefix}_id`], f.records[0][`${prefix}_id`]);
    const resource = service.store.findPoolItem(service.db, f.owner, LINKS[prefix].kind, record[`${prefix}_id`]);
    for (const [field, value] of Object.entries(SNAP[prefix](resource))) assert.equal(record[field], value);
    assert.equal((await f.api('POST', '/api/data-integrity/repair', body)).status, 409);
  }
  assert.equal((await f.scan()).findings.length, 0);
  const audit = service.db.prepare("SELECT subject FROM audit_events WHERE owner_id=? AND action='records.integrity.repair'").all(f.owner);
  assert.equal(audit.length, 4);
  assert.ok(!JSON.stringify(audit).includes('SYNTHETIC-'));
});

test('manual cases are reported without guessing identity or disclosing another owner', async () => {
  const f = await fixture(2), other = await fixture();
  const [a, b] = f.records;
  service.db.prepare("UPDATE records SET email_id=NULL, proxy_id='SYNTHETIC-INVALID-ID', license_id=?, card_id=? WHERE owner_id=? AND id=?").run(other.records[0].license_id, b.card_id, f.owner, a.id);
  const report = await f.scan();
  const codes = report.findings.find(row => row.id === a.id).issues.map(issue => issue.code);
  assert.ok(codes.includes('unlinked_snapshot'));
  assert.ok(codes.includes('missing_resource'));
  assert.ok(codes.includes('duplicate_usage'));
  assert.ok(codes.includes('invalid_reference'));
  assert.ok(!report.findings.some(row => row.issues.some(issue => issue.prefix === 'proxy' && issue.code === 'duplicate_usage')), 'shared proxies are valid');
  assert.ok(!JSON.stringify(report).includes('organization ' + sequence + ' number'), 'foreign resource labels never appear');
  assert.equal(report.total, 2);
  const missing = report.findings.find(row => row.id === a.id).issues.find(issue => issue.code === 'missing_resource');
  assert.equal(missing.repairable, false);
  await f.unlock();
  const blocked = await f.api('POST', '/api/data-integrity/repair', { action: 'sync_snapshot', prefix: 'license', record_id: a.id, record_version: f.row(a.id).version, resource_id: other.records[0].license_id, resource_version: 1 });
  assert.equal(blocked.status, 404);
  assert.equal((await other.scan()).findings.length, 0);
  await other.unlock();
  const before = rawOwner(f.owner);
  const foreignWrite = await other.api('POST', '/api/data-integrity/repair', { action: 'sync_snapshot', prefix: 'email', record_id: a.id, record_version: f.row(a.id).version, resource_id: a.email_id, resource_version: 1 });
  assert.equal(foreignWrite.status, 404);
  assert.equal(rawOwner(f.owner), before);
  const privateAttempt = await other.api('GET', '/api/data-integrity?owner_id=' + f.owner);
  assert.equal(privateAttempt.status, 400);
});

test('new maintenance routes keep session and source-header authorization', async () => {
  assert.equal((await fetch(origin + '/api/data-integrity')).status, 401);
  assert.equal((await fetch(origin + '/api/data-integrity/repair', { method: 'POST', headers: { 'x-workbench': '1', 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const f = await fixture();
  // The fixture client always supplies the source header; a raw authenticated
  // request without it must still be rejected before attempting a mutation.
  await f.unlock();
  assert.equal((await fetch(origin + '/api/data-integrity/repair', { method: 'POST', headers: { cookie: f.cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
});

test('versions and relation identity are rechecked; stale repairs never modify data', async () => {
  const f = await fixture();
  service.store.updateRecordColumns(service.db, f.owner, f.records[0].id, { email_user: 'old@example.test' });
  const report = await f.scan(), row = report.findings[0], issue = row.issues[0], body = repairBody(row, issue);
  await f.unlock();
  for (const patch of [{ record_version: body.record_version - 1 }, { resource_version: body.resource_version - 1 }, { resource_id: body.resource_id + 10000 }, { record_id: body.record_id + 10000 }]) {
    const before = rawOwner(f.owner);
    assert.ok([404, 409].includes((await f.api('POST', '/api/data-integrity/repair', { ...body, ...patch })).status));
    assert.equal(rawOwner(f.owner), before);
  }
  for (const version of [null, '1', -1, 1.5]) assert.equal((await f.api('POST', '/api/data-integrity/repair', { ...body, record_version: version })).status, 428);
  assert.equal((await f.api('POST', '/api/data-integrity/repair', { ...body, owner_id: f.owner })).status, 400);
});

test('occupied resource status is explicit and audit failure rolls back the whole repair', async () => {
  const f = await fixture();
  service.db.prepare("UPDATE emails SET status='未使用' WHERE owner_id=?").run(f.owner);
  const report = await f.scan(), row = report.findings[0], issue = row.issues.find(issue => issue.code === 'usage_status');
  assert.ok(issue);
  await f.unlock();
  const body = repairBody(row, issue), before = rawOwner(f.owner);
  service.db.exec("CREATE TRIGGER integrity_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action='records.integrity.repair' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  try { assert.equal((await f.api('POST', '/api/data-integrity/repair', body)).status, 500); }
  finally { service.db.exec('DROP TRIGGER integrity_audit_failure'); }
  assert.equal(rawOwner(f.owner), before);
  assert.equal((await f.api('POST', '/api/data-integrity/repair', body)).status, 200);
  assert.equal((await f.scan()).findings.length, 0);
});

test('keyset batches keep an initial ceiling and validate paging without skipping records', async () => {
  const f = await fixture(3);
  const first = await f.scan('?limit=1');
  assert.equal(first.checked, 1);
  assert.equal(first.total, 3);
  assert.equal(first.has_more, true);
  service.store.insertRecord(service.db, f.owner, { ...f.row(f.records[0].id), seq: 4, fingerprint: 'later-record-4', domain: 'later.example' });
  const second = await f.scan(`?limit=1&after=${first.next_after}&upper_bound=${first.upper_bound}`);
  const third = await f.scan(`?limit=1&after=${second.next_after}&upper_bound=${first.upper_bound}`);
  assert.equal(third.has_more, false);
  assert.equal(third.next_after, null);
  assert.equal(first.checked + second.checked + third.checked, 3);
  assert.equal(third.total, 3, 'a later insertion is excluded until a new check');
  for (const query of ['?limit=0', '?limit=101', '?limit=1&limit=2', '?after=-1', '?after=1e2', '?upper_bound=0&after=1', '?limit=']) assert.equal((await f.api('GET', '/api/data-integrity' + query)).status, 400);
});
