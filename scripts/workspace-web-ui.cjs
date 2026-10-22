'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('playwright');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-workspace-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', REGISTRATION: 'open', SESSION_SECURE: '0', DATA_DIR: temp, DB_FILE: path.join(temp, 'test.sqlite'), DATA_FILE: path.join(temp, 'absent.json'), LOG_LEVEL: 'silent' });
delete process.env.PUBLIC_ORIGIN; delete process.env.ADS_SECRETS_KEY_FILE;
const service = require('../server');
const output = process.env.UI_SCREENSHOT_DIR || path.join(temp, 'screenshots');
fs.mkdirSync(output, { recursive: true });
let browser, page;
const watchdog = setTimeout(() => { console.error('Workspace UI verification timed out'); process.exit(1); }, 240000);
(async () => {
  const origin = await service.start({ port: 0, host: '127.0.0.1' });
  browser = await _electron.launch({ executablePath: process.env.WORKBENCH_UI_EXECUTABLE || require('electron'), args: [...(process.platform === 'linux' ? ['--no-sandbox', '--headless', '--ozone-platform=headless', '--disable-gpu'] : []), path.join(__dirname, 'ui-browser-window.cjs')] });
  page = await browser.firstWindow();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const [suite, username] of [['workspace-experience-ui', 'space-qa'], ['license-pools-ui', 'pool-qa'], ['document-viewer-ui', 'document-qa']]) {
    if (suite !== 'workspace-experience-ui') await page.evaluate(() => api('/api/auth/logout', { method: 'POST' }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(origin + '/login');
    await page.locator('#tabRegister').click(); await page.locator('#regUsername').fill(username);
    await page.locator('#regPassword').fill('Synthetic-UI-Test-2026!'); await page.locator('#regConfirm').fill('Synthetic-UI-Test-2026!');
    await page.locator('#regSubmit').click(); await page.locator('#main[data-connection="ready"]').waitFor();
    if (process.platform === 'linux') await page.addStyleTag({ content: '@import url("/vendor/file-viewer/cjk/wght.css"); :root { --sans: "Noto Sans SC Variable", sans-serif; } body { font-family: var(--sans); }' });
    await require('./' + suite + '.cjs')(page, async name => { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: path.join(output, `${suite}-${name}.png`), animations: 'disabled' }); });
  }
  assert.deepEqual(errors, []);
  console.log('PASS all workspace, independent pool and original-document UI flows; no JavaScript errors');
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, 'workspace-failure.png'), animations: 'disabled' }).catch(() => {});
}).finally(async () => { if (browser) await browser.close(); await service.close(); fs.rmSync(temp, { recursive: true, force: true }); clearTimeout(watchdog); });
