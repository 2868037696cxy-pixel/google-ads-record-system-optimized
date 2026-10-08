'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// A real, portable PDF fixture, with text extraction exercised by PDF.js.
function certificate() {
  const lines = ['CERTIFICATE OF REGISTRATION', 'The Danish Business Authority certifies and attests that:', 'Example ApS', 'Examplevej 1', 'DK-9310 Vodskov', 'with CVR number: 12345678 in the municipality of Aalborg'];
  const stream = 'BT /F1 12 Tf 40 750 Td ' + lines.map((line, i) => `${i ? '0 -20 Td ' : ''}(${line}) Tj`).join('\n') + ' ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-desktop-test-'));
  const pdfFile = process.env.LICENSE_PDF_FIXTURE || path.join(directory, 'certificate.pdf');
  if (!process.env.LICENSE_PDF_FIXTURE) fs.writeFileSync(pdfFile, certificate());
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

    await page.locator('[data-action="nav"][data-page="licenses"]').first().click();
    await page.locator('[data-action="open-import"][data-kind="licenses"]').click();
    await page.locator('#license-file').setInputFiles(pdfFile);
    await page.getByText('已提取信息，请核对后保存。原 PDF 将一并保存。', { exact: true }).waitFor();
    assert.equal(await page.locator('#license-name').inputValue(), name);
    assert.equal(await page.locator('#license-legal_name').inputValue(), name);
    assert.equal(await page.locator('#license-address').inputValue(), address);
    assert.equal(await page.locator('#license-apt').inputValue(), '');
    await page.locator('#license-import').click();
    await page.locator('[data-action="view-license"]').first().waitFor();
    await page.locator('[data-action="view-license"]').first().click();
    await page.getByRole('button', { name: '打开原 PDF', exact: true }).click();
    const cachedPdf = await electron.evaluate(() => globalThis.openedPdf);
    assert.deepEqual(fs.readFileSync(cachedPdf), fs.readFileSync(pdfFile));
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
    await page.locator('[data-action="create"]').click();
    await page.waitForFunction(() => document.querySelector('#toast-root').innerText.includes('已创建 1 条记录'));
    const stored = JSON.parse(fs.readFileSync(path.join(directory, 'userdata', 'data.json')));
    assert.equal(stored.records.length, 1);
    assert.equal(stored.licenses[0].status, '已使用');
    console.log('PASS create record assigns imported business license');
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
