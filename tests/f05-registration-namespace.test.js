'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-f05-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';
process.env.DEDUP_ADDRESS_MODE = 'warn';

const service = require('../server');
const dbm = require('../lib/db');
const dedup = require('../lib/dedup');

let origin;
const cookies = {};

async function register(who) {
  const response = await fetch(origin + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: who, password: 'F05-Secure-Test-1234' }),
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

async function importLicense(who, item) {
  return api(who, 'POST', '/api/import/licenses', { items: [item] });
}

test.before(async () => {
  origin = await service.start({ port: 0 });
  await register('f05-a');
  await register('f05-b');
  await register('f05-c');
});

test.after(async () => {
  await service.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('F05: namespace key requires jurisdiction + registration type and keeps bare number separately', () => {
  const dk = dedup.licenseKeys({ cvr: 'DK-00123456', jurisdiction: 'Denmark', registration_type: 'CVR' });
  assert.equal(dk.dup_cvr, '00123456');
  assert.equal(dk.jurisdiction, 'DK');
  assert.equal(dk.registration_type, 'CVR');
  assert.equal(dk.dup_reg, 'S|DK|CVR|00123456');
  assert.equal(dk.registration_scoped, true);

  const pl = dedup.licenseKeys({ cvr: '00123456', jurisdiction: 'Poland', registration_type: 'KRS' });
  assert.equal(pl.dup_reg, 'S|PL|KRS|00123456');
  assert.notEqual(dk.dup_reg, pl.dup_reg);

  const legacy = dedup.licenseKeys({ cvr: '00123456' });
  assert.equal(legacy.dup_reg, 'L|00123456');
  assert.equal(legacy.registration_scoped, false);
});

test('F05: same bare number may coexist in different complete namespaces, exact namespace still conflicts', async () => {
  const dk = await importLicense('f05-a', {
    name: 'Nordic Scoped Identity A',
    legal_name: 'Nordic Scoped Identity A',
    cvr: '55667788',
    jurisdiction: 'DK',
    registration_type: 'CVR',
    registration_authority: 'CVR',
  });
  assert.equal(dk.status, 200, JSON.stringify(dk.value));

  const pl = await importLicense('f05-b', {
    name: 'Polish Scoped Identity B',
    legal_name: 'Polish Scoped Identity B',
    cvr: '55667788',
    jurisdiction: 'PL',
    registration_type: 'KRS',
    registration_authority: 'KRS',
  });
  assert.equal(pl.status, 200, '不同完整命名空间的同裸号应允许共存');

  const sameDk = await importLicense('f05-c', {
    name: 'Different Display Name C',
    legal_name: 'Different Display Name C',
    cvr: 'DK 55667788',
    jurisdiction: 'Denmark',
    registration_type: 'CVR number',
    registration_authority: 'Different registry text',
  });
  assert.equal(sameDk.status, 409, '同 DK/CVR/号码必须全员判重');
  assert.ok(Array.isArray(sameDk.value.conflicts));
  assert.equal('owner' in sameDk.value.conflicts[0], false, '冲突响应不得泄露所属成员');
  assert.equal('cvr' in sameDk.value.conflicts[0], false, '冲突响应不得回显另一成员注册号');
});

test('F05: unscoped registration number cannot bypass a scoped record and vice versa', async () => {
  const scoped = await importLicense('f05-a', {
    name: 'Scoped Guard Company',
    cvr: '66778899',
    jurisdiction: 'IT',
    registration_type: 'VAT',
  });
  assert.equal(scoped.status, 200);

  const unscoped = await importLicense('f05-b', {
    name: 'Unscoped Guard Different Name',
    cvr: '66778899',
  });
  assert.equal(unscoped.status, 409, '省略国家/类型不能绕过已分域注册号');

  const legacy = await importLicense('f05-a', {
    name: 'Legacy Guard Company',
    cvr: '77889900',
  });
  assert.equal(legacy.status, 200);

  const laterScoped = await importLicense('f05-c', {
    name: 'Later Scoped Different Name',
    cvr: '77889900',
    jurisdiction: 'PL',
    registration_type: 'KRS',
  });
  assert.equal(laterScoped.status, 409, '历史裸号存在时不能靠补一个范围直接绕开');
  assert.match(laterScoped.value.error, /注册号/);
});

test('F05: same user cannot silently rename/overwrite an unscoped company merely because the bare number matches', async () => {
  const first = await importLicense('f05-c', {
    name: 'Legacy Same User Original',
    legal_name: 'Legacy Same User Original',
    cvr: '88112233',
  });
  assert.equal(first.status, 200);

  const second = await importLicense('f05-c', {
    name: 'Completely Different Legacy Company',
    legal_name: 'Completely Different Legacy Company',
    cvr: '88112233',
  });
  assert.equal(second.status, 409, '历史裸号相同但名称不同不能自动覆盖本人旧资料');

  const boot = await api('f05-c', 'GET', '/api/bootstrap');
  const originals = boot.value.pools.licenses.filter((item) => item.cvr === '88112233');
  assert.equal(originals.length, 1);
  assert.equal(originals[0].name, 'Legacy Same User Original');
});

test('F05: historical unscoped row can be explicitly enriched, then a different namespace with same bare number is allowed', async () => {
  const owner = service.db.prepare("SELECT id FROM users WHERE username='f05-a'").get().id;
  service.db.prepare(`
    INSERT INTO licenses(owner_id,status,created_at,name,legal_name,cvr,dup_name,dup_legal,dup_cvr,dup_reg)
    VALUES(?,'未使用','2026-01-01 00:00:00','Historical Namespace Company','Historical Namespace Company',
           '88990011','historicalnamespacecompany','historicalnamespacecompany','88990011',NULL)
  `).run(owner);

  const changed = dbm.migrateRegistrationNamespace(service.db);
  assert.equal(changed, 1);
  let row = service.db.prepare("SELECT * FROM licenses WHERE name='Historical Namespace Company'").get();
  assert.equal(row.dup_reg, 'L|88990011');

  const boot = await api('f05-a', 'GET', '/api/bootstrap');
  const visible = boot.value.pools.licenses.find((item) => item.name === 'Historical Namespace Company');
  assert.ok(visible);

  const enriched = await api('f05-a', 'PATCH', `/api/pool/licenses/${visible.id}`, {
    version: visible.version,
    jurisdiction: 'DK',
    registration_type: 'CVR',
    registration_authority: 'Danish Business Authority',
  });
  assert.equal(enriched.status, 200, JSON.stringify(enriched.value));
  row = service.db.prepare('SELECT jurisdiction,registration_type,dup_reg FROM licenses WHERE id=?').get(visible.id);
  assert.equal(row.jurisdiction, 'DK');
  assert.equal(row.registration_type, 'CVR');
  assert.equal(row.dup_reg, 'S|DK|CVR|88990011');

  const differentScope = await importLicense('f05-b', {
    name: 'Same Bare But Polish Identity',
    cvr: '88990011',
    jurisdiction: 'PL',
    registration_type: 'KRS',
  });
  assert.equal(differentScope.status, 200, '历史记录被明确补齐后，不同命名空间应能合法共存');
});

test('F05: CVR parser infers DK/CVR while generic registration number remains unscoped', async () => {
  const parsedCvr = await api('f05-a', 'POST', '/api/parse/licenses', {
    text: '组织名称：Parser CVR Company\nCVR: 99001122\n城市：Aalborg',
  });
  assert.equal(parsedCvr.status, 200);
  assert.equal(parsedCvr.value.items[0].jurisdiction, 'DK');
  assert.equal(parsedCvr.value.items[0].registration_type, 'CVR');
  assert.equal(parsedCvr.value.items[0].cvr, '99001122');

  const generic = await api('f05-a', 'POST', '/api/parse/licenses', {
    text: '组织名称：Generic Registration Company\n注册号：AA990011\n城市：Warsaw',
  });
  assert.equal(generic.status, 200);
  assert.equal(generic.value.items[0].jurisdiction, '');
  assert.equal(generic.value.items[0].registration_type, '');
  assert.equal(generic.value.items[0].cvr, 'AA990011');
});

test('F05: concurrent exact-scope and legacy-vs-scoped submissions still produce a single winner', async () => {
  const exact = await Promise.all([
    importLicense('f05-b', {
      name: 'Concurrent Exact One', cvr: '99223344', jurisdiction: 'DK', registration_type: 'CVR',
    }),
    importLicense('f05-c', {
      name: 'Concurrent Exact Two', cvr: '99223344', jurisdiction: 'DK', registration_type: 'CVR',
    }),
  ]);
  assert.deepEqual(exact.map((item) => item.status).sort(), [200, 409]);

  const ambiguous = await Promise.all([
    importLicense('f05-b', {
      name: 'Concurrent Legacy Number', cvr: '99334455',
    }),
    importLicense('f05-c', {
      name: 'Concurrent Scoped Number', cvr: '99334455', jurisdiction: 'PL', registration_type: 'KRS',
    }),
  ]);
  assert.deepEqual(ambiguous.map((item) => item.status).sort(), [200, 409],
    '裸号与已分域同号并发时也只能有一个进入数据库');
});

test('F05: database no longer has global unique bare-number index and has unique namespaced key', () => {
  const indexes = service.db.prepare("PRAGMA index_list('licenses')").all();
  const old = indexes.find((item) => item.name === 'uq_licenses_dup_cvr');
  const scoped = indexes.find((item) => item.name === 'uq_licenses_dup_reg');
  const bare = indexes.find((item) => item.name === 'idx_licenses_dup_cvr');
  assert.equal(old, undefined);
  assert.ok(scoped);
  assert.equal(scoped.unique, 1);
  assert.ok(bare);
  assert.equal(bare.unique, 0);
});
