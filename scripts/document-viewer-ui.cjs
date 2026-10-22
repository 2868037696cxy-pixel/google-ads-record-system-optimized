'use strict';
const assert = require('node:assert/strict');
const { certificate } = require('../tests/pdf-fixture');

// Disposable backend only; verifies actual Flyfish canvases, not a mocked renderer.
module.exports = async function verifyDocumentViewer(page, shot = async () => {}) {
  const errors = [], external = [];
  const onError = error => errors.push(error.message);
  const origin = new URL(page.url()).origin;
  const onRequest = request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url()); };
  page.on('pageerror', onError); page.on('request', onRequest);
  const pdf = (name, lines, pages = 1) => ({ name, mimeType: 'application/pdf', buffer: certificate(lines, pages) });
  const first = pdf('synthetic-original-two-pages.pdf', ['Company name: Viewer Review Ltd', 'OIB: 04123456789', 'Address: Original Review Street 8', 'City: Zagreb', 'Postal code: 10000'], 2);
  const second = pdf('synthetic-next-file.pdf', ['Company name: Viewer Next Ltd', 'OIB: 03123456789', 'Address: Next Review Street 9', 'City: Split']);
  const ready = async () => {
    await page.locator('.document-preview[data-state="ready"]').waitFor({ timeout: 30000 });
    await page.locator('.document-viewer-host canvas').first().waitFor();
    await page.waitForFunction(() => {
      const root = document.querySelector('.document-viewer-host')?.shadowRoot;
      const canvas = root?.querySelector('canvas');
      return canvas?.width > 0 && canvas?.height > 0;
    });
  };
  await page.locator('#nav [data-page="licenses"]').click();
  await page.locator('[data-action="open-import"][data-kind="licenses"]').click();
  await page.locator('#license-file').setInputFiles(first); await ready();
  assert.match(await page.locator('.document-viewer-host .pdf-page-meter').innerText(), /2/);
  await page.locator('.document-viewer-host .pdf-toolbar-group--zoom button').last().click();
  await page.locator('.document-viewer-host .pdf-toolbar-group').first().locator('button').last().click();
  await page.waitForFunction(() => document.querySelector('.document-viewer-host')?.shadowRoot?.querySelector('.pdf-page-meter strong')?.textContent === '2');
  for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(size);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await shot('document-review-' + size.width);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#license-name').fill('Viewer Review Ltd verified');
  // A failed original fetch must preserve editable metadata and offer retry.
  await page.locator('#license-import:not([disabled])').waitFor();
  await page.locator('#license-import').click(); await page.locator('#license-form').waitFor({ state: 'detached' });
  const license = await page.evaluate(() => state.pools.licenses.find(item => item.cvr === '04123456789'));
  assert.ok(license?.document_id);
  const unavailable = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic outage"}' });
  await page.route('**/api/licenses/' + license.id + '/pdf', unavailable);
  await page.evaluate(id => openLicenseImport(state.pools.licenses.find(item => item.id === id)), license.id);
  await page.locator('.document-preview[data-state="error"]').waitFor();
  await page.locator('#license-address').fill('Edited while original unavailable');
  await page.unroute('**/api/licenses/' + license.id + '/pdf', unavailable);
  await page.locator('.document-retry').click(); await ready();
  assert.equal(await page.locator('#license-address').inputValue(), 'Edited while original unavailable');
  await page.locator('#modal-root .modal-close').click();
  await page.evaluate(id => openLicenseDetails(id), license.id); await ready();
  await page.evaluate(() => { navigator.clipboard.writeText = async text => { globalThis.__viewerCopied = text; }; });
  await page.getByRole('button', { name: '复制 街道地址', exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.__viewerCopied), 'Original Review Street 8');
  await shot('document-details'); await page.locator('#modal-root .modal-close').click();
  await page.locator('[data-action="open-import"][data-kind="licenses"]').click();
  await page.locator('#license-file').setInputFiles([first, second]);
  await page.locator('[data-review="1"]').click(); await ready();
  assert.equal(await page.locator('.document-preview-name').textContent(), second.name);
  await page.waitForFunction(() => document.querySelector('.document-viewer-host')?.shadowRoot?.textContent.includes('Viewer Next Ltd'));
  await page.locator('[data-review="0"]').click(); await page.locator('[data-review="1"]').click(); await ready();
  assert.equal(await page.locator('.document-preview-name').textContent(), second.name);
  await shot('document-batch'); await page.locator('#batch-done').click();
  await page.waitForFunction(() => !document.querySelector('.document-viewer-host'));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  page.off('pageerror', onError); page.off('request', onRequest);
  console.log('PASS real File Viewer PDF canvas, pagination, zoom, saved original, retry retaining edits, clipboard, batch replacement, mobile and self-hosted requests');
};
