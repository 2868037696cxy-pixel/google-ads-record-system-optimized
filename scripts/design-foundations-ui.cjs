'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-visual-foundations-'));
  let electron, page;
  try {
    electron = await _electron.launch({
      executablePath: require('electron'),
      args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '.'],
      env: {
        ...process.env,
        ADS_WORKBENCH_MODE: 'local',
        ADS_DESKTOP_DATA_DIR: path.join(directory, 'userdata'),
      },
    });
    page = await electron.firstWindow();
    await page.getByText('已连接', { exact: true }).waitFor();

    const styles = await page.evaluate(() => {
      const numeric = (selector, property) => Number.parseFloat(getComputedStyle(document.querySelector(selector))[property]);
      const sheetPresent = [...document.styleSheets].some(sheet => sheet.href?.includes('/ui-foundations.css'));
      return {
        sheetPresent,
        bodySize: numeric('body', 'fontSize'),
        bodyLineHeight: numeric('body', 'lineHeight'),
        titleSize: numeric('.page-head h1', 'fontSize'),
        navHeight: numeric('#nav .nav-item', 'height'),
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        mainScroll: getComputedStyle(document.querySelector('#main')).overflowY,
      };
    });

    assert.ok(styles.sheetPresent, 'UI foundations stylesheet must actually load');
    assert.ok(styles.bodySize >= 14, 'long-session body text must be legible');
    assert.ok(styles.bodyLineHeight / styles.bodySize >= 1.45);
    assert.ok(styles.titleSize >= 24 && styles.titleSize <= 32);
    assert.ok(styles.navHeight >= 40, 'desktop navigation must have a stable click target');
    assert.equal(styles.accent, '#88bcff');
    assert.equal(styles.mainScroll, 'auto');
    console.log('PASS desktop visual foundations: typography, density, color and navigation');

    await page.locator('#nav [data-page="create"]').click();
    const form = await page.evaluate(() => {
      const field = document.querySelector('#f-country');
      const label = field.closest('.field').querySelector('label');
      const button = document.querySelector('[data-action="create"]');
      return {
        inputHeight: field.getBoundingClientRect().height,
        font: Number.parseFloat(getComputedStyle(field).fontSize),
        labelFont: Number.parseFloat(getComputedStyle(label).fontSize),
        buttonHeight: button.getBoundingClientRect().height,
        labelText: label.textContent.trim(),
      };
    });
    assert.ok(form.inputHeight >= 38, 'form input must not be microscopically short');
    assert.ok(form.font >= 14);
    assert.ok(form.labelFont >= 13);
    assert.ok(form.buttonHeight >= 38);
    assert.match(form.labelText, /国家/);
    console.log('PASS desktop form anatomy: readable labels and actionable controls');

    await page.locator('#nav [data-page="records"]').click();
    const horizontal = await page.evaluate(() => {
      const wrap = document.querySelector('#recordsPanel .table-wrap');
      return wrap ? { width: wrap.clientWidth, scrollWidth: wrap.scrollWidth, scrollable: getComputedStyle(wrap).overflowX } : null;
    });
    // Empty data can be rendered without a table: this check only applies when a table is present.
    if (horizontal) {
      assert.ok(['auto', 'scroll'].includes(horizontal.scrollable));
      assert.ok(horizontal.width > 0);
    }
    if (process.env.UI_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, 'design-foundations-records.png') });
      await page.locator('#nav [data-page="overview"]').click();
      await page.screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, 'design-foundations-overview.png') });
    }
    console.log('PASS desktop screenshot and table overflow smoke');
  } finally {
    if (electron) await electron.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
