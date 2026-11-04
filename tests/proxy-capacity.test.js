'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ip-quota-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, DB_FILE: path.join(directory, 'test.sqlite'), DATA_FILE: path.join(directory, 'absent.json'), REGISTRATION: 'open', LOG_LEVEL: 'silent' });
const service = require('../server'), policy = require('../public/proxy-capacity');
const { validateSnapshot } = require('../lib/storage');
let origin, serial = 0; const cookies = {};
async function api(who, route, body, method = 'POST') {
  const response = await fetch(origin + route, { method, headers: { 'x-workbench': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookies[who] ? { cookie: cookies[who] } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
const pools = async () => (await api('owner', '/api/bootstrap', undefined, 'GET')).data.pools;
async function add(limit = 1) {
  const host = `192.0.2.${++serial}`;
  const response = await api('owner', '/api/import/proxies', { items: [{ host, port: '1080', usage_limit: limit }] });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return (await pools()).proxies.find(item => item.host === host);
}
const set = (items, usage_limit, who = 'owner') => api(who, '/api/proxies/usage-limits', { items: items.map(({ id, version }) => ({ id, version })), usage_limit });
const make = (proxy, count, mode = 'auto', extra = {}) => api('owner', '/api/records', { count, fp_prefix: `quota-${++serial}-`, proxy_mode: mode, ...(mode === 'auto' ? { proxy_ids: [proxy.id] } : { proxy_id: proxy.id }), ...extra });
test.before(async () => {
  origin = await service.start({ port: 0, host: '127.0.0.1' });
  for (const who of ['owner', 'other']) {
    const response = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' }, body: JSON.stringify({ username: `quota-${who}`, password: 'Synthetic-IP-Test-2026!' }) });
    assert.equal(response.status, 201); cookies[who] = response.headers.get('set-cookie').split(';')[0];
  }
});
test.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('IP policy distributes selected items first and repeats only within remaining capacity', () => {
  const p = (id, limit, used = 0, status = used ? '已使用' : '未使用') => ({ id, usage_limit: limit, linked_record_count: used, status });
  const list = [p(1, 3, 1), p(2, 5), p(3, 9, 0, '停用'), p(4, 5, 0, '已使用')];
  assert.deepEqual(policy.allocate(list, [2, 1], 7).items.map(item => item.id), [2, 1, 2, 2, 2, 2, 1]);
  assert.ok(policy.allocate(list, [], 8).error);
  assert.equal(policy.remaining(list[2]), 0); assert.equal(policy.remaining(list[3]), 0);
  assert.ok(policy.allocate(list, [999], 1).error);
});

test('one IP supports three auto allocations, previews are read-only, and deletion frees a slot', async () => {
  const proxy = await add(3), body = { count: 3, proxy_mode: 'auto', proxy_ids: [proxy.id], fp_prefix: 'preview-quota-' };
  const preview = await api('owner', '/api/records/preview', body);
  assert.equal(preview.status, 200); assert.deepEqual(preview.data.items.map(item => item.proxy_id), [proxy.id, proxy.id, proxy.id]);
  assert.equal((await pools()).proxies.find(item => item.id === proxy.id).linked_record_count, 0);
  const created = await api('owner', '/api/records', { ...body, resource_plan: preview.data.items });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal((await make(proxy, 1, 'shared')).status, 400);
  const record = created.data.created[0];
  assert.equal((await api('owner', `/api/records/${record.id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await make(proxy, 1, 'shared')).status, 200);
  const current = (await pools()).proxies.find(item => item.id === proxy.id);
  assert.equal(current.linked_record_count, 3); assert.equal(policy.remaining(current), 0);
  assert.equal((await set([current], 2)).status, 400);
  assert.equal((await api('owner', `/api/pool/proxies/${current.id}`, { version: current.version, usage_limit: 2 }, 'PATCH')).status, 400);
});

test('shared batches and record reassignment enforce the same limit; bulk writes are atomic and owner scoped', async () => {
  const proxy = await add(3), spare = await add(5);
  const created = await make(proxy, 2, 'shared'); assert.equal(created.status, 200);
  assert.equal((await make(proxy, 2, 'shared')).status, 400);
  const latest = (await pools()).proxies.find(item => item.id === proxy.id);
  assert.equal((await set([spare, latest], 1)).status, 400);
  assert.equal((await pools()).proxies.find(item => item.id === spare.id).usage_limit, 5, 'invalid second row must not update first row');
  assert.equal((await set([spare], 3, 'other')).status, 400);
  assert.equal((await set([spare], 3)).status, 200);
  assert.equal((await set([spare], 5)).status, 409, 'stale versions reject');
  assert.equal((await make(proxy, 1, 'shared')).status, 200);
  const unrelated = await make(spare, 1, 'shared'); assert.equal(unrelated.status, 200);
  const record = unrelated.data.created[0];
  assert.equal((await api('owner', `/api/records/${record.id}`, { version: record.version, proxy_id: proxy.id }, 'PATCH')).status, 400);
});

test('custom integer limits reject malformed values without modifying resources', async () => {
  const proxy = await add();
  for (const bad of [0, -1, 1.5, true, '3', 100001, null]) assert.equal((await set([proxy], bad)).status, 400, String(bad));
  assert.equal((await set([proxy], 7)).status, 200);
  const current = (await pools()).proxies.find(item => item.id === proxy.id);
  assert.equal(current.usage_limit, 7);
  const body = { count: 1, proxy_mode: 'auto', proxy_ids: [proxy.id], fp_prefix: 'stale-quota-' };
  const preview = await api('owner', '/api/records/preview', body);
  assert.equal((await set([current], 5)).status, 200);
  assert.equal((await api('owner', '/api/records', { ...body, resource_plan: preview.data.items })).status, 400);
});

test('JSON backups preserve explicit limits, infer legacy sharing and reject over-capacity snapshots', () => {
  const snapshot = { emails: [], cards: [], licenses: [], proxies: [{ id: 1, status: '已使用' }], records: [{ id: 1, proxy_id: 1 }, { id: 2, proxy_id: 1 }] };
  assert.equal(validateSnapshot(snapshot).proxies[0].usage_limit, 2);
  snapshot.proxies[0].usage_limit = 5;
  assert.equal(validateSnapshot(snapshot).proxies[0].usage_limit, 5);
  snapshot.proxies[0].usage_limit = 1;
  assert.throws(() => validateSnapshot(snapshot), /IP/);
});

test('legacy schema migration retains shared associations once and never raises an explicit limit on restart', () => {
  const { openDatabase } = require('../lib/db');
  const file = path.join(directory, 'legacy.sqlite'); let db = openDatabase(file);
  db.exec('ALTER TABLE proxies DROP COLUMN usage_limit');
  db.prepare('INSERT INTO users(id,username,password_hash,created_at) VALUES(1,?,?,?)').run('legacy-quota', 'synthetic', '2026-10-22');
  db.prepare('INSERT INTO proxies(id,owner_id,created_at) VALUES(1,1,?)').run('2026-10-22');
  for (let i = 1; i <= 3; i++) db.prepare('INSERT INTO records(owner_id,seq,fingerprint,proxy_id,created_at) VALUES(1,?,?,1,?)').run(i, `legacy-${i}`, '2026-10-22');
  db.close(); db = openDatabase(file);
  assert.equal(db.prepare('SELECT usage_limit FROM proxies').get().usage_limit, 3);
  db.exec('UPDATE proxies SET usage_limit=2'); db.close(); db = openDatabase(file);
  assert.equal(db.prepare('SELECT usage_limit FROM proxies').get().usage_limit, 2); db.close();
});

test('concurrent shared batches cannot consume the same remaining slots twice', async () => {
  const proxy = await add(3);
  const results = await Promise.all([make(proxy, 2, 'shared'), make(proxy, 2, 'shared')]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assert.equal((await pools()).proxies.find(item => item.id === proxy.id).linked_record_count, 2);
});
