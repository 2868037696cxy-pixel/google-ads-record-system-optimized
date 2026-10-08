'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

const { certificate } = require('../tests/pdf-fixture');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-desktop-test-'));
  const pdfFile = process.env.LICENSE_PDF_FIXTURE || path.join(directory, 'certificate.pdf');
  if (!process.env.LICENSE_PDF_FIXTURE) fs.writeFileSync(pdfFile, certificate(undefined, 3));
  const name = process.env.PDF_EXPECTED_NAME || 'Example ApS';
  const address = process.env.PDF_EXPECTED_ADDRESS || 'Examplevej 1';
  const backupFile = path.join(directory, 'export.json');
  let electron;
  try {
    electron = await _electron.launch({
      executablePath: require('electron'),
      // CI container has no setuid sandbox helper; production Windows keeps sandbox:true.
      args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '.'],
      env: { ...process.env, ADS_DESKTOP_DATA_DIR: path.join(directory, 'userdata') },
    });
    await electron.evaluate(({ dialog, shell }, filename) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
      dialog.showMessageBox = async () => ({ response: 1 });
      globalThis.openedPdf = '';
      shell.openPath = async (file) => { globalThis.openedPdf = file; return ''; };
    }, backupFile);
    const page = await electron.firstWindow();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.getByText('本地服务已连接', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal((await fetch(new URL('/api/bootstrap', page.url()))).status, 401);
    console.log('PASS desktop startup, isolated renderer and API access restriction');

    await page.evaluate(async () => {
      await api('/api/records', { method: 'POST', body: { domains: Array.from({ length: 51 }, (_, i) => `scale${i}.example`) } });
      await refresh();
    });
    assert.equal(await page.locator('#main tbody tr').count(), 50);
    await page.locator('[data-action="sel-all"]').check();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await page.locator('#main tbody tr').count(), 1);
    await page.locator('[data-action="sel-all"]').check();
    assert.ok((await page.locator('[data-action="export-csv"]').innerText()).includes('所选 51 条'));
    await page.locator('#rec-q').fill('scale50.example');
    assert.equal(await page.locator('#main tbody tr').count(), 1);
    await page.locator('#rec-q').fill('');
    assert.equal(await page.locator('#main tbody tr').count(), 50);
    await page.locator('[data-action="delete-selected"]').click();
    await page.locator('#confirm-ok-btn').evaluate((button) => { button.click(); button.click(); });
    await page.getByRole('heading', { name: '还没有创建记录', exact: true }).waitFor();
    console.log('PASS record pagination, search, cross-page selection and batch deletion');

    await page.evaluate(async () => {
      await api('/api/import/emails', { method: 'POST', body: { items: Array.from({ length: 51 }, (_, i) => ({ user: `scale${i}@example.com` })) } });
      await refresh();
    });
    await page.locator('[data-action="nav"][data-page="emails"]').first().click();
    assert.equal(await page.locator('#main tbody tr').count(), 50);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await page.locator('#main tbody tr').count(), 1);
    await page.locator('#pool-q').fill('scale50@example.com');
    assert.equal(await page.locator('#main tbody tr').count(), 1);
    assert.equal(await page.locator('#main table.pool-table col').count(), 7);
    await page.locator('#pool-q').fill('no match');
    await page.getByRole('heading', { name: '没有匹配的资源', exact: true }).waitFor();
    await page.evaluate(async () => {
      const data = await api('/api/bootstrap');
      await Promise.all(data.pools.emails.map((email) => api(`/api/pool/emails/${email.id}`, { method: 'DELETE' })));
      await refresh();
    });
    console.log('PASS resource pagination, search layout and empty results');

    let releaseOld; let markOldStarted;
    const oldStarted = new Promise((resolve) => { markOldStarted = resolve; });
    const oldRelease = new Promise((resolve) => { releaseOld = resolve; });
    await page.route('**/api/parse/emails', async (route) => {
      if (route.request().postDataJSON().text.startsWith('old@example.com')) {
        markOldStarted(); await oldRelease;
        try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ user: 'old@example.com', pass: 'old' }] }) }); } catch { /* A stale preview is intentionally aborted. */ }
      } else await route.continue();
    });
    await page.locator('[data-action="open-import"][data-kind="emails"]').click();
    await page.locator('#import-text').fill('old@example.com|old');
    await oldStarted;
    await page.locator('#import-text').fill('new@example.com|new-password|JBSWY3DPEHPK3PXP');
    assert.equal(await page.locator('#import-ok').isDisabled(), true);
    await page.waitForFunction(() => !document.querySelector('#import-ok').disabled);
    releaseOld();
    assert.ok((await page.locator('#parse-result').innerText()).includes('new@example.com'));
    assert.ok(!(await page.locator('#parse-result').innerText()).includes('old@example.com'));
    const closeButton = page.locator('.modal-close');
    await closeButton.focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('#import-ok').evaluate((button) => button === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await closeButton.evaluate((button) => button === document.activeElement), true);
    let imports = 0;
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/import/emails') imports++; });
    await page.locator('#import-ok').evaluate((button) => { button.click(); button.click(); });
    await page.waitForFunction(() => !document.querySelector('#import-ok'));
    assert.equal(imports, 1);
    assert.equal((await page.evaluate(() => api('/api/bootstrap'))).pools.emails.length, 1);
    await page.unroute('**/api/parse/emails');
    console.log('PASS latest import preview, keyboard focus and duplicate-submit protection');

    await page.locator('[data-action="open-auto-import"]').first().click();
    await page.locator('#auto-file').setInputFiles({ name: 'resources.txt', mimeType: 'text/plain', buffer: Buffer.from('second@example.com|password|JBSWY3DPEHPK3PXP\nsocks5://user:secret@proxy.example:1080') });
    await page.waitForFunction(() => !document.querySelector('#auto-ok').disabled);
    assert.ok((await page.locator('#auto-ok').innerText()).includes('邮箱 1 · 代理 1'));
    await page.locator('#auto-ok').click();
    await page.waitForFunction(() => !document.querySelector('#auto-ok'));
    await page.locator('[data-action="nav"][data-page="cards"]').click();
    await page.locator('[data-action="open-import"][data-kind="cards"]').click();
    await page.locator('#import-text').fill('4367970152619097 06/29 007');
    await page.waitForFunction(() => !document.querySelector('#import-ok').disabled);
    await page.locator('#import-ok').click();
    await page.waitForFunction(() => !document.querySelector('#import-ok'));
    console.log('PASS mixed email/proxy import and credit-card import');

    await page.locator('[data-action="nav"][data-page="licenses"]').first().click();
    await page.locator('[data-action="open-import"][data-kind="licenses"]').click();
    await page.locator('#license-file').setInputFiles(pdfFile);
    await page.getByText('已提取信息，请核对后保存。原 PDF 将一并保存。', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => api('/api/bootstrap'))).pools.licenses.length, 0);
    await page.keyboard.press('Escape');
    assert.equal((await page.evaluate(() => api('/api/bootstrap'))).pools.licenses.length, 0);
    await page.locator('[data-action="open-import"][data-kind="licenses"]').click();
    await page.locator('#license-file').setInputFiles(pdfFile);
    await page.getByText('已提取信息，请核对后保存。原 PDF 将一并保存。', { exact: true }).waitFor();
    await page.locator('#license-file').setInputFiles([]);
    assert.equal(await page.locator('#license-import').isDisabled(), false);
    await page.locator('#license-file').setInputFiles(pdfFile);
    await page.getByText('已提取信息，请核对后保存。原 PDF 将一并保存。', { exact: true }).waitFor();
    assert.equal(await page.locator('#license-name').inputValue(), name);
    assert.equal(await page.locator('#license-legal_name').inputValue(), name);
    assert.equal(await page.locator('#license-address').inputValue(), address);
    assert.equal(await page.locator('#license-apt').inputValue(), '');
    await page.locator('#license-import').click();
    await page.locator('[data-action="view-license"]').first().waitFor();
    assert.equal(await page.locator('#main [data-action="view-license"]').count(), 1);
    await page.locator('[data-action="view-license"]').first().click();
    await page.getByRole('button', { name: '打开原 PDF', exact: true }).click();
    const cachedPdf = await electron.evaluate(() => globalThis.openedPdf);
    assert.deepEqual(fs.readFileSync(cachedPdf), fs.readFileSync(pdfFile));
    if (process.env.LICENSE_SCREENSHOT) await page.screenshot({ path: process.env.LICENSE_SCREENSHOT, animations: 'disabled' });
    console.log('PASS PDF recognition, review, detail panel and exact original file');
    await page.getByRole('button', { name: '关闭', exact: true }).last().click();
    await page.locator('[data-action="desktop-backup"]').click();
    await page.waitForFunction(() => document.querySelector('#toast-root').innerText.includes('完整备份已导出'));
    const snapshot = JSON.parse(fs.readFileSync(backupFile));
    assert.equal(Object.keys(snapshot.documents).length, 1);
    console.log('PASS native complete backup includes original PDF');

    await page.locator('[data-action="nav"][data-page="workbench"]').first().click();
    await page.locator('#f-country').fill('丹麦');
    await page.locator('#f-product').fill('测试产品');
    await page.locator('#f-domains').fill('test.example');
    await page.locator('#f-proxy').selectOption('1');
    assert.equal(await page.locator('.create-preview span > b').first().innerText(), '1');
    await page.locator('[data-action="create"]').evaluate((button) => { button.click(); button.click(); });
    await page.waitForFunction(() => document.querySelector('#toast-root').innerText.includes('已创建 1 条记录'));
    const stored = JSON.parse(fs.readFileSync(path.join(directory, 'userdata', 'data.json')));
    assert.equal(stored.records.length, 1);
    assert.equal(stored.licenses[0].status, '已使用');
    console.log('PASS create record assigns imported business license');

    await page.locator('[data-sensitive="true"]').click();
    await page.getByText('请先显示敏感信息，再复制该字段', { exact: true }).waitFor();
    await page.locator('[data-action="open-picker"][data-kind="cards"]').click();
    assert.equal(await page.locator('#picker-list input').first().isDisabled(), true);
    await page.keyboard.press('Escape');
    await page.locator('[data-action="edit-record"]').first().click();
    assert.equal(await page.locator('[name="card_id"]').inputValue(), '1');
    await page.locator('[name="country"]').fill('优化验收');
    await page.locator('#edit-ok').click();
    await page.waitForFunction(() => !document.querySelector('#edit-ok'));
    assert.equal((await page.evaluate(() => api('/api/bootstrap'))).records[0].country, '优化验收');
    console.log('PASS sensitive proxy-copy protection, occupied picker and record edit');

    await page.locator('[data-action="nav"][data-page="licenses"]').click();
    await page.locator('[data-action="open-import"][data-kind="licenses"]').click();
    await page.locator('#license-file').setInputFiles(pdfFile);
    await page.getByText('已提取信息，请核对后保存。原 PDF 将一并保存。', { exact: true }).waitFor();
    await page.locator('#license-name').fill(name + ' corrected');
    await page.locator('#license-import').click();
    await page.waitForFunction(() => !document.querySelector('#license-import'));
    const corrected = await page.evaluate(() => api('/api/bootstrap'));
    assert.equal(corrected.pools.licenses.length, 1); assert.equal(corrected.pools.licenses[0].id, 1);
    assert.equal(corrected.records[0].license_name, name + ' corrected');
    assert.equal(await page.locator('[data-action="del-pool"]').isDisabled(), true);
    console.log('PASS same-PDF corrected reimport updates one assigned license');

    await page.locator('[data-action="desktop-restore"]').click();
    await page.getByText('本地服务已连接', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#main').innerText.includes('还没有创建记录'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'userdata', 'data.json'))).records.length, 0);
    assert.ok(fs.readdirSync(path.join(directory, 'userdata', 'backups')).length > 0);
    console.log('PASS backup restore reloads app and preserves previous state');
    let failOnce = true;
    await page.route('**/api/bootstrap', async (route) => {
      if (failOnce) { failOnce = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary outage' }) }); }
      else await route.continue();
    });
    await page.reload();
    await page.getByRole('heading', { name: '暂时无法打开工作台' }).waitFor();
    await page.locator('#main [data-action="retry-load"]').click();
    await page.getByText('本地服务已连接', { exact: true }).waitFor();
    console.log('PASS initial connection failure recovers without restarting desktop');
    assert.deepEqual(errors, []);
    if (process.env.DESKTOP_SCREENSHOT) await page.screenshot({ path: process.env.DESKTOP_SCREENSHOT, animations: 'disabled' });
    await electron.close(); electron = null;
  } finally {
    if (electron) await electron.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
