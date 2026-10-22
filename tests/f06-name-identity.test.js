'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-f06-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';
process.env.DEDUP_ADDRESS_MODE = 'warn';

const service = require('../server');
const dedup = require('../lib/dedup');
const dbm = require('../lib/db');
let origin;
const cookies = {};

async function register(who) {
  const response = await fetch(origin + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: who, password: 'Secure-Test-1234' }),
  });
  assert.equal(response.status, 201);
  cookies[who] = response.headers.get('set-cookie').split(';')[0];
}

async function api(who, method, route, body) {
  const response = await fetch(origin + route, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-workbench': '1',
      cookie: cookies[who],
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
  await register('unicode-a');
  await register('unicode-b');
});

test.after(async () => {
  await service.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('F06: company-name normalization preserves non-Latin scripts', () => {
  assert.equal(
    dedup.normalizeCompanyName('北京 星河-科技（有限公司）'),
    dedup.normalizeCompanyName('北京星河科技有限公司'),
  );
  assert.ok(dedup.normalizeCompanyName('東京未来株式会社'));
  assert.ok(dedup.normalizeCompanyName('Αθήνα Τεχνολογία'));
  assert.ok(dedup.normalizeCompanyName('Ромашка Технологии'));
});

test('F06: same Unicode company name is globally rejected even without registration number', async () => {
  const first = await api('unicode-a', 'POST', '/api/import/licenses', {
    items: [{ name: '北京星河科技有限公司', legal_name: '北京星河科技有限公司' }],
  });
  assert.equal(first.status, 200);
  assert.equal(first.value.added, 1);

  const second = await api('unicode-b', 'POST', '/api/import/licenses', {
    items: [{ name: '北京 星河 科技 有限公司', legal_name: '北京 星河 科技 有限公司' }],
  });
  assert.equal(second.status, 409, '非拉丁名称不能再因归一化为 null 而绕过全局判重');
});

test('F06: display name and legal name match across fields', async () => {
  const first = await api('unicode-a', 'POST', '/api/import/licenses', {
    items: [{ name: '展示名称甲', legal_name: '深圳未来技术有限公司' }],
  });
  assert.equal(first.status, 200);

  const second = await api('unicode-b', 'POST', '/api/import/licenses', {
    items: [{ name: '深圳未来技术有限公司', legal_name: '展示名称乙' }],
  });
  assert.equal(second.status, 409, '已有 legal_name 必须能命中新提交的 name');
});

test('F06: historical NULL Unicode keys are backfilled and become visible to dedup', async () => {
  const owner = service.db.prepare('SELECT id FROM users WHERE username = ?').get('unicode-a').id;
  service.db.prepare(`
    INSERT INTO licenses (owner_id,status,created_at,name,legal_name,address,cvr,dup_name,dup_legal)
    VALUES (?,'未使用','2026-01-01 00:00:00','東京未来株式会社','東京未来株式会社','','',NULL,NULL)
  `).run(owner);

  const changed = dbm.migrateNameKeys(service.db);
  assert.equal(changed, 1);
  const row = service.db.prepare("SELECT dup_name,dup_legal FROM licenses WHERE name='東京未来株式会社'").get();
  assert.ok(row.dup_name);
  assert.equal(row.dup_name, row.dup_legal);

  const duplicate = await api('unicode-b', 'POST', '/api/import/licenses', {
    items: [{ name: '東京 未来 株式会社', legal_name: '東京未来株式会社' }],
  });
  assert.equal(duplicate.status, 409);
});

test('F06: internal duplicate audit groups cross-field name identities', () => {
  const a = service.db.prepare('SELECT id FROM users WHERE username = ?').get('unicode-a').id;
  const b = service.db.prepare('SELECT id FROM users WHERE username = ?').get('unicode-b').id;
  const key = 'crossfieldidentity';
  service.db.prepare(`
    INSERT INTO licenses (owner_id,status,created_at,name,legal_name,dup_name,dup_legal)
    VALUES (?,'未使用','2026-01-02 00:00:00','Audit Display A','Cross Field Identity','auditdisplaya',?)
  `).run(a, key);
  service.db.prepare(`
    INSERT INTO licenses (owner_id,status,created_at,name,legal_name,dup_name,dup_legal)
    VALUES (?,'未使用','2026-01-02 00:00:01','Cross Field Identity','Audit Display B',?,'auditdisplayb')
  `).run(b, key);

  const report = dedup.auditLicenses(service.db, { addressMode: 'warn' });
  const group = report.groups.find((item) => item.field === 'name' && item.key === key);
  assert.ok(group, '内部审计必须识别 name ↔ legal_name 的交叉重复');
  assert.equal(group.members.length, 2);
});
