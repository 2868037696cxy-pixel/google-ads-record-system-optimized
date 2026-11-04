'use strict';
const assert = require('node:assert/strict');
const { certificate } = require('../tests/pdf-fixture');

// Run only against a disposable test backend after signing into an empty account.
module.exports = async function verifyLicensePools(page, shot = async () => {}) {
  const open = async () => {
    await page.locator('#nav [data-page="licenses"]').click();
    await page.locator('[data-action="open-import"][data-kind="licenses"]').click();
  };
  const fill = async fields => { for (const [key, value] of Object.entries(fields)) await page.locator('#license-' + key).fill(value); };
  await page.evaluate(async () => {
    await api('/api/import/licenses', { method: 'POST', body: { intent: 'create', items: [{ name: 'Synthetic Reserved Pool Company', legal_name: 'Synthetic Reserved Pool Company', cvr: '88888888000188', jurisdiction: 'BR', registration_type: 'CNPJ' }] } });
    await refresh();
  });
  await open();
  await fill({ name: 'Different input name', legal_name: 'Different input legal', jurisdiction: 'Brasil', registration_type: 'CNPJ', cvr: '88.888.888/0001-88' });
  await page.locator('#license-duplicate-status[data-state="duplicate"]').waitFor();
  assert.equal(await page.locator('#license-import').isDisabled(), true);
  assert.equal(await page.locator('#license-cvr').getAttribute('aria-invalid'), 'true');
  console.log('PASS live duplicate check includes own records before saving');

  let delayedStarted, release;
  const started = new Promise(resolve => { delayedStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const delayed = async route => {
    const body = route.request().postDataJSON();
    if (body.item.cvr === '99999999000199') {
      delayedStarted(); await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'duplicate', conflict: { field: 'cvr', label: 'STALE RESULT' } }) }).catch(() => {});
    } else await route.continue();
  };
  await page.route('**/api/licenses/check-duplicate', delayed);
  await page.locator('#license-cvr').fill('99999999000199'); await started;
  await page.locator('#license-cvr').fill('99123456000199');
  await page.locator('#license-duplicate-status[data-state="clear"]').waitFor();
  release(); await page.unroute('**/api/licenses/check-duplicate', delayed);
  assert.ok(!(await page.locator('#license-duplicate-status').innerText()).includes('STALE'));
  const unavailable = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic outage"}' });
  await page.route('**/api/licenses/check-duplicate', unavailable);
  await page.locator('#license-cvr').fill('99123456000198');
  await page.locator('#license-duplicate-status[data-state="error"]').waitFor();
  assert.equal(await page.locator('#license-cvr').inputValue(), '99123456000198');
  await page.unroute('**/api/licenses/check-duplicate', unavailable);
  await page.locator('#license-import').click(); await page.locator('#license-form').waitFor({ state: 'detached' });
  console.log('PASS stale lookup cannot overwrite new input; temporary failure preserves fields and retries before commit');

  const pdf = (name, lines) => ({ name, mimeType: 'application/pdf', buffer: certificate(lines) });
  const brazil = pdf('synthetic-brazil.pdf', ['NOME EMPRESARIAL', 'Synthetic Brazil Pool Ltda', 'CNPJ: 91.234.567/0001-91', 'LOGRADOURO', 'Rua Brazil Pool 1', 'MUNICIPIO', 'Sao Paulo', 'UF', 'SP', 'CEP', '01000-000']);
  const croatia = pdf('synthetic-croatia.pdf', ['Company name: Synthetic Croatia Pool doo', 'OIB: 09123456789', 'Street address: Croatia Pool Street 2', 'City: Zagreb', 'Postal code: 10000']);
  const unknown = pdf('synthetic-unrecognised.pdf', ['SYNTHETIC UNLABELLED BUSINESS DOCUMENT', 'Needs manual review']);
  await open(); await page.locator('#license-file').setInputFiles([brazil, croatia, unknown]);
  await page.waitForFunction(() => document.getElementById('batch-summary')?.textContent.includes('识别完成'));
  assert.equal(await page.locator('.batch-file[data-phase="ready"]').count(), 2);
  assert.equal(await page.locator('.batch-file[data-phase="saved"]').count(), 0);
  await page.locator('[data-review="2"]').click();
  for (const [key, value] of Object.entries({ name: 'Synthetic Manual Registry GmbH', legal_name: 'Synthetic Manual Registry GmbH', jurisdiction: 'DE', registration_type: 'HRB', cvr: 'MANUAL123456', address: 'Manual Registry Street 3', city: 'Berlin' })) await page.locator('#batch-' + key).fill(value);
  await page.locator('#batch-save-one:not([disabled])').waitFor();
  await page.locator('#batch-save-one').click();
  await page.locator('.batch-file[data-phase="saved"]').waitFor();
  await page.locator('#batch-save-ready').click();
  await page.waitForFunction(() => document.querySelectorAll('.batch-file[data-phase="saved"]').length === 3);
  await page.locator('#modal-root .modal-body').evaluate(element => { element.scrollTop = 0; });
  await shot('batch-reviewed');
  for (const size of [{width:390,height:844},{width:320,height:568}]) {
    await page.setViewportSize(size); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot('batch-' + size.width);
  }
  await page.setViewportSize({width:1440,height:900});
  await page.locator('#batch-done').click(); await page.waitForFunction(() => state.pools.licenses.some(item => item.name === 'Synthetic Brazil Pool Ltda'));
  console.log('PASS multiple countries and unknown layouts enter a per-document review queue; manual and selected batch saves remain independent');

  await open(); await page.locator('#license-file').setInputFiles([brazil, croatia]);
  await page.waitForFunction(() => document.querySelectorAll('.batch-file[data-phase="duplicate"]').length === 2);
  assert.equal(await page.locator('#batch-save-ready').isDisabled(), true);
  await page.locator('#batch-done').click();

  const autoOne = pdf('synthetic-auto-one.pdf', ['Company name: Synthetic Auto One', 'OIB: 07123456789', 'Address: Auto Pool Street 4', 'City: Split', 'Postal code: 21000']);
  const autoTwo = pdf('synthetic-auto-two.pdf', ['Company name: Synthetic Auto Two', 'OIB: 06123456789', 'Address: Auto Pool Street 5', 'City: Rijeka', 'Postal code: 51000']);
  await open(); await page.locator('#license-file').setInputFiles([autoOne, autoTwo]);
  await page.locator('#batch-auto-save').check();
  await page.waitForFunction(() => document.querySelectorAll('.batch-file[data-phase="saved"]').length === 2);
  await page.locator('#batch-done').click(); await page.waitForFunction(() => state.pools.licenses.some(item => item.name === 'Synthetic Auto Two'));
  console.log('PASS explicitly enabled automatic save admits complete files and repeated PDFs stay blocked');

  await page.evaluate(async () => {
    await api('/api/import/emails', { method: 'POST', body: { items: [1,2].map(n => ({ user: `pool-workflow-${n}@example.test`, pass: 'SYNTHETIC-MUST-NOT-COPY' })) } });
    await api('/api/import/proxies', { method: 'POST', body: { items: [1,2].map(n => ({ host: `192.0.2.${20+n}`, port: '1080', pass: 'SYNTHETIC-PROXY-MUST-NOT-COPY' })) } });
    await api('/api/import/cards', { method: 'POST', body: { items: [1,2].map(n => ({ number: 'Pool-Card-' + n, last4: '001' + n, expiry: '12/29' })) } });
    await refresh();
  });
  await page.locator('#nav [data-page="create"]').click();
  await page.locator('#f-country').fill('Italy'); await page.locator('#f-product').fill('Synthetic workflow');
  await page.locator('#f-domains').fill('pool-one.example\npool-two.example');
  await page.locator('#f-proxy-mode').selectOption('auto'); await page.locator('#f-require-complete').check();
  for (const kind of ['licenses', 'proxies']) {
    const ids = await page.evaluate(kind => kind === 'licenses' ? state.pools.licenses.filter(item => ['Synthetic Brazil Pool Ltda','Synthetic Croatia Pool doo'].includes(item.name)).map(item => item.id) : state.pools.proxies.map(item => item.id).reverse(), kind);
    await page.locator(`[data-action="open-picker"][data-kind="${kind}"]`).click();
    for (const id of ids) await page.locator(`.picker-item[data-val="${id}"] input`).check();
    await page.locator('#picker-ok').click();
  }
  await page.locator('[data-action="create"]').click(); await page.locator('#create-confirm:not([disabled])').waitFor();
  assert.match(await page.locator('#resource-preview').innerText(), /Synthetic Brazil Pool/);
  assert.match(await page.locator('#resource-preview').innerText(), /192\.0\.2\.22/);
  assert.equal(await page.evaluate(() => state.records.length), 0, 'preview has not created records');
  await shot('actual-combination-preview');
  await page.locator('#create-confirm').click(); await page.locator('[data-action="created-records"]').waitFor(); await page.locator('[data-action="created-records"]').click();
  await page.waitForFunction(() => state.records.length === 2);
  await page.locator('[data-action="record-setup"]').first().click(); await page.locator('#setup-copy-all:not([disabled])').waitFor();
  await page.evaluate(() => { navigator.clipboard.writeText = async text => { globalThis.__syntheticCopied = text; }; });
  await page.locator('#setup-copy-all').click();
  const copied = await page.evaluate(() => globalThis.__syntheticCopied);
  assert.match(copied, /Zagreb|Sao Paulo/); assert.match(copied, /pool-workflow/); assert.ok(!copied.includes('MUST-NOT-COPY'));
  await page.getByRole('button', { name: '复制 城市 / City', exact: true }).click(); assert.match(await page.evaluate(() => globalThis.__syntheticCopied), /^(?:Zagreb|Sao Paulo)$/);
  await page.waitForFunction(() => !document.querySelector('#toast-root .toast'));
  for (const size of [{width:1440,height:900},{width:390,height:844},{width:320,height:568}]) {
    await page.setViewportSize(size);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot('setup-' + size.width);
  }
  await page.locator('#modal-root .modal-close').click(); await page.setViewportSize({width:1440,height:900});
  console.log('PASS full four-pool combination, manual IP/document selection, real preview, original-address copying and narrow-screen setup panel');
  const original = await page.evaluate(() => state.pools.licenses.find(item => item.name === 'Synthetic Croatia Pool doo'));
  await page.locator('#nav [data-page="licenses"]').click();
  await page.locator(`[data-action="view-license"][data-id="${original.id}"]`).first().click(); await page.locator('#license-edit-fields').click();
  assert.equal(await page.locator('#license-cvr').evaluate(element => element.readOnly), true);
  await page.locator('#license-name').fill('Synthetic Croatia Pool doo corrected');
  await page.locator('#license-address').fill('Corrected Croatia Pool Street 2');
  await page.locator('#license-duplicate-status[data-state="clear"]').waitFor();
  await page.locator('#license-import').click(); await page.locator('#license-form').waitFor({state:'detached'});
  await page.waitForFunction(id => state.pools.licenses.find(item => item.id === id)?.name.endsWith('corrected'), original.id);
  const updated = await page.evaluate(id => ({license:state.pools.licenses.find(item => item.id === id),records:state.records.filter(item => item.license_id === id)}), original.id);
  assert.equal(updated.license.document_id, original.document_id); assert.equal(updated.license.cvr, original.cvr);
  assert.equal(updated.records.length, 1); assert.equal(updated.records[0].license_name, 'Synthetic Croatia Pool doo corrected');
  console.log('PASS explicit metadata correction preserves original PDF, identifier and assigned record');
};
