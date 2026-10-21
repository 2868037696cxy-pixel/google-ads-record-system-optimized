'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-license-workflow-'));
Object.assign(process.env, { DATA_DIR: directory, DB_FILE: path.join(directory, 'test.sqlite'), DATA_FILE: path.join(directory, 'absent.json'), REGISTRATION: 'open', LOG_LEVEL: 'silent', DEDUP_ADDRESS_MODE: 'warn' });
const service = require('../server'), dedup = require('../lib/dedup');
const identifiers = require('../lib/license-identifiers');
const setup = require('../public/account-setup');
const { certificate } = require('./pdf-fixture');
let origin; const cookies = {};
async function api(who, route, body, method = 'POST') {
  const response = await fetch(origin + route, { method, headers: { 'x-workbench': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookies[who] ? { cookie: cookies[who] } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
const item = (name, cvr, extra = {}) => ({ name, legal_name: name, cvr, jurisdiction: 'BR', registration_type: 'CNPJ', ...extra });
test.before(async () => {
  origin = await service.start({ port: 0, host: '127.0.0.1' });
  for (const who of ['wf-owner', 'wf-other', 'wf-race-a', 'wf-race-b', 'wf-bundle']) {
    const response = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' }, body: JSON.stringify({ username: who, password: 'Synthetic-Pools-2026!' }) });
    assert.equal(response.status, 201); cookies[who] = response.headers.get('set-cookie').split(';')[0];
  }
});
test.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('country aliases, separators, Unicode width and alphanumeric CNPJ identity are canonical', () => {
  const a = dedup.licenseKeys(item('A', '12.ABC.345/0001-90', { jurisdiction: '巴西' }));
  const b = dedup.licenseKeys(item('B', '１２ａｂｃ３４５０００１９０', { jurisdiction: 'Brasil', registration_type: 'CNPJ / MF' }));
  assert.equal(a.dup_reg, b.dup_reg);
  assert.equal(dedup.licenseKeys(item('Prefix', 'BRABC345000190')).dup_cvr, 'BRABC345000190');
  assert.notEqual(dedup.licenseKeys(item('Prefix', 'DKABC345000190')).dup_cvr, 'BRABC345000190');
  assert.equal(dedup.licenseKeys({ cvr: '00123456789', registration_type: 'OIB' }).dup_reg, 'S|HR|OIB|00123456789');
});

test('country adapters keep labelled company fields and refuse to guess among multiple OIBs', () => {
  for (const [text, type, country] of [['CNPJ: 12.ABC.345/0001-90', 'CNPJ', 'BR'], ['OIB: 00123456789', 'OIB', 'HR'], ['CVR number: 12345678', 'CVR', 'DK'], ['KRS: 0000123456', 'KRS', 'PL'], ['SIREN: 123 456 789', 'SIREN', 'FR'], ['UEN: 202612345A', 'UEN', 'SG'], ['ABN: 12 345 678 901', 'ABN', 'AU'], ['COMPANIES HOUSE\nCompany number: AB123456', 'CRN', 'GB']]) {
    const result = identifiers.businessIdentifier(text); assert.equal(result.identity.registration_type, type); assert.equal(result.identity.jurisdiction, country);
  }
  assert.equal(identifiers.businessIdentifier('OIB: 00123456789\nOIB: 00987654321').ambiguous, true);
  const fields = identifiers.businessFields('NOME EMPRESARIAL\nSynthetic Comercio Ltda\nLOGRADOURO\nRua Exemplo\nNUMERO\n12\nMUNICIPIO\nSao Paulo\nCEP\n01000-000\nUF\nSP');
  assert.equal(fields.name, 'Synthetic Comercio Ltda'); assert.equal(fields.address, 'Rua Exemplo, 12'); assert.equal(fields.city, 'Sao Paulo'); assert.equal(fields.region, 'SP');
});

test('PDF parsing returns original business fields and review metadata, including partial documents', async () => {
  const lines = ['NOME EMPRESARIAL', 'Synthetic PDF Brazil Ltda', 'CNPJ: 12.ABC.345/0001-90', 'LOGRADOURO', 'Rua Teste', 'MUNICIPIO', 'Sao Paulo', 'UF', 'SP', 'CEP', '01000-000'];
  const result = await api('wf-owner', '/api/parse/licenses-pdf', { pdf: certificate(lines).toString('base64') });
  assert.equal(result.status, 200); assert.equal(result.data.items[0].cvr, '12ABC345000190'); assert.equal(result.data.items[0].jurisdiction, 'BR'); assert.equal(result.data.items[0].address, 'Rua Teste'); assert.equal(result.data.items[0].region, 'SP');
  assert.deepEqual(result.data.extraction.missing_fields, []);
  const partial = await api('wf-owner', '/api/parse/licenses-pdf', { pdf: certificate(['OIB: 00123456789']).toString('base64') });
  assert.equal(partial.data.items[0].cvr, '00123456789'); assert.ok(partial.data.extraction.missing_fields.includes('name'));
});

test('live duplicate checks are authenticated, read-only and private across every account', async () => {
  const original = item('Synthetic Reserved Owner Name', '33.333.333/0001-33');
  assert.equal((await api('wf-owner', '/api/import/licenses', { intent: 'create', items: [original] })).status, 200);
  assert.equal((await api('nobody', '/api/licenses/check-duplicate', { item: original })).status, 401);
  for (const who of ['wf-owner', 'wf-other']) {
    const check = await api(who, '/api/licenses/check-duplicate', { item: item('Unrelated Typed Name', '33333333000133', { jurisdiction: 'Brasil' }) });
    assert.equal(check.data.state, 'duplicate');
    const encoded = JSON.stringify(check.data);
    for (const secret of ['Synthetic Reserved Owner Name', 'wf-owner', 'owner_id', 'created_at', 'document_id']) assert.ok(!encoded.includes(secret), secret);
  }
  const incomplete = await api('wf-other', '/api/licenses/check-duplicate', { item: item('Short input', '123') });
  assert.equal(incomplete.data.state, 'incomplete');
  assert.equal((await api('wf-other', '/api/bootstrap', undefined, 'GET')).data.pools.licenses.length, 0);
  assert.equal((await api('wf-owner', '/api/import/licenses', { intent: 'create', items: [original] })).status, 409, 'new entry cannot silently overwrite its own existing company');
});

test('two accounts may both preview clear, but only one concurrent save can claim the identifier', async () => {
  const first = item('Synthetic Race First', '44.444.444/0001-44'), second = item('Synthetic Race Second', '44444444000144');
  for (const [who, value] of [['wf-race-a', first], ['wf-race-b', second]]) assert.equal((await api(who, '/api/licenses/check-duplicate', { item: value })).data.state, 'clear');
  const saved = await Promise.all([api('wf-race-a', '/api/import/licenses', { intent: 'create', items: [first] }), api('wf-race-b', '/api/import/licenses', { intent: 'create', items: [second] })]);
  assert.deepEqual(saved.map(result => result.status).sort(), [200, 409]);
});

test('a re-exported PDF still conflicts by business identity and edited numbers cannot bypass its original identity', async () => {
  const firstPdf = certificate(['Company name: Synthetic Source First', 'CNPJ: 55.555.555/0001-55']);
  assert.equal((await api('wf-owner', '/api/import/licenses', { intent: 'create', items: [item('Synthetic Source First', '55555555000155')], pdf: firstPdf.toString('base64') })).status, 200);
  const differentBytes = certificate(['Company name: Synthetic Source Second', 'CNPJ: 55.555.555/0001-55', 'Re-export marker']);
  const reexport = await api('wf-other', '/api/import/licenses', { intent: 'create', items: [item('Synthetic Source Second', '55555555000155')], pdf: differentBytes.toString('base64') });
  assert.equal(reexport.status, 409);
  const changed = await api('wf-other', '/api/import/licenses', { intent: 'create', items: [item('Synthetic Source Altered', '66666666000166')], pdf: differentBytes.toString('base64') });
  assert.equal(changed.status, 400); assert.match(changed.data.error, /不一致/);
});

test('resource previews do not occupy pools; complete combinations preserve manual order and prevent reuse', async () => {
  const who = 'wf-bundle';
  await api(who, '/api/import/emails', { items: [1, 2].map(n => ({ user: `bundle-${n}@example.test`, pass: 'SYNTHETIC-NEVER-IN-PREVIEW' })) });
  await api(who, '/api/import/proxies', { items: [1, 2].map(n => ({ host: `192.0.2.${n}`, port: '1080', pass: 'SYNTHETIC-PROXY-SECRET' })) });
  await api(who, '/api/import/cards', { items: [1, 2].map(n => ({ number: `Bundle-${n}`, last4: `000${n}`, expiry: '12/29' })) });
  await api(who, '/api/import/licenses', { items: [1, 2].map(n => item(`Synthetic Bundle Company ${n}`, `7777777700017${n}`, { address: `Test Street ${n}`, city: 'Sao Paulo', region: 'SP' })) });
  let boot = (await api(who, '/api/bootstrap', undefined, 'GET')).data;
  const body = { domains: ['bundle-1.example', 'bundle-2.example'], proxy_mode: 'auto', require_complete: true, email_ids: boot.pools.emails.map(x => x.id).reverse(), proxy_ids: boot.pools.proxies.map(x => x.id).reverse() };
  const preview = await api(who, '/api/records/preview', body);
  assert.equal(preview.status, 200); assert.equal(preview.data.items[0].email_user, 'bundle-2@example.test'); assert.equal(preview.data.items[0].proxy_host, '192.0.2.2');
  assert.ok(!JSON.stringify(preview.data).includes('SECRET')); assert.ok(!JSON.stringify(preview.data).includes('NEVER-IN-PREVIEW'));
  assert.equal((await api(who, '/api/bootstrap', undefined, 'GET')).data.records.length, 0);
  const planOf = items => items.map(item => Object.fromEntries(['email','card','license','proxy'].flatMap(prefix => [[prefix + '_id', item[prefix + '_id']], [prefix + '_version', item[prefix + '_version']]])));
  service.db.prepare('UPDATE emails SET version=version+1 WHERE id=?').run(preview.data.items[0].email_id);
  const stale = await api(who, '/api/records', { ...body, resource_plan: planOf(preview.data.items) });
  assert.equal(stale.status, 400); assert.match(stale.data.error, /预览中的资源已/);
  assert.equal((await api(who, '/api/bootstrap', undefined, 'GET')).data.records.length, 0, 'a changed reviewed resource cannot silently change the combination');
  body.resource_plan = planOf((await api(who, '/api/records/preview', body)).data.items);
  const created = await api(who, '/api/records', body); assert.equal(created.status, 200); assert.equal(created.data.created.length, 2);
  assert.equal(new Set(created.data.created.map(x => x.license_id)).size, 2);
  assert.equal(new Set(created.data.created.map(x => x.proxy_id)).size, 2);
  const record = created.data.created[0];
  const details = await api(who, `/api/records/${record.id}/setup`, undefined, 'GET');
  assert.equal(details.status, 200); assert.equal(details.data.license.region, 'SP');
  assert.ok(!JSON.stringify(details.data).includes('SYNTHETIC-NEVER')); assert.ok(!Object.hasOwn(details.data.record, 'email_pass'));
  assert.equal((await api('wf-other', `/api/records/${record.id}/setup`, undefined, 'GET')).status, 404);
  // A manually reset status must not make an already linked resource reusable.
  service.db.prepare("UPDATE emails SET status='未使用'").run();
  const retry = await api(who, '/api/records', { domains: ['bundle-3.example'], proxy_mode: 'auto', require_complete: true });
  assert.equal(retry.status, 400); assert.equal((await api(who, '/api/bootstrap', undefined, 'GET')).data.records.length, 2);
});

test('account setup copies exact originals, omits empty values and never invents billing settings or passwords', () => {
  const result = setup.build({ email_user: 'account@example.test', country: 'Italy', proxy_pass: 'HIDDEN', email_pass: 'HIDDEN' }, { name: 'Original d.o.o.', legal_name: 'Original Legal d.o.o.', address: 'Original Street 1', city: 'Zagreb', jurisdiction: 'HR', cvr: '00123456789', registration_type: 'OIB' });
  assert.ok(result.text.includes('Original Legal d.o.o.')); assert.ok(result.text.includes('Zagreb')); assert.ok(!result.text.includes('HIDDEN')); assert.ok(!result.text.includes('待补充'));
  assert.equal(result.business.find(x => x.key === 'jurisdiction').value, 'HR'); assert.equal(result.resources.find(x => x.key === 'target_country').value, 'Italy');
});
