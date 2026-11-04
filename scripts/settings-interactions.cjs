'use strict';
const assert = require('node:assert/strict');

// Shared by the native desktop UX run and the isolated web UI verification.
module.exports = async function settingsInteractions(page, shot = async () => {}) {
  const ready = () => page.locator('#main[data-connection="ready"]').waitFor();
  const settings = () => page.locator('#nav [data-page="settings"]').click();
  await ready();
  assert.equal(await page.locator('#connectionNotice').isVisible(), false, 'opening the app connects automatically without a persistent prompt');
  assert.match(await page.locator('#nav [data-page="cards"]').innerText(), /信用卡/);
  assert.equal(await page.locator('#nav .nav-label').filter({ hasText: '工作空间' }).count(), 0);
  await settings();
  assert.equal(await page.locator('#main h1').innerText(), '设置');

  await page.locator('#settings-tab-general').focus();
  await page.keyboard.press('End');
  assert.equal(await page.locator('#settings-tab-data').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#settings-tab-data').evaluate(element => element === document.activeElement), true);
  assert.equal(await page.locator('.settings-content:visible').count(), 1);
  assert.equal(await page.locator('#settingsAdvanced').getAttribute('open'), null, 'legacy restore starts collapsed');
  await page.locator('#settingsAdvanced > summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#settingsLegacyRestore').isVisible(), true);
  await shot('settings-data');
  await page.keyboard.press('Enter');
  await page.locator('#settings-tab-data').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#settings-tab-security').getAttribute('aria-selected'), 'true');
  await shot('settings-security');
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#settings-tab-general').getAttribute('aria-selected'), 'true');

  const comfortableHeight = await page.locator('.density-preview-row').first().evaluate(element => element.getBoundingClientRect().height);
  await page.locator('input[name="settings-density"][value="comfortable"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('input[name="settings-density"][value="compact"]').isChecked(), true);
  const compactHeight = await page.locator('.density-preview-row').first().evaluate(element => element.getBoundingClientRect().height);
  assert.ok(compactHeight < comfortableHeight, 'the preview visibly follows the actual choice');
  assert.match(await page.locator('#densitySaveStatus').innerText(), /已保存/);
  assert.equal(await page.evaluate(() => document.body.classList.contains('table-compact')), true);
  await page.reload();
  await ready();
  await settings();
  assert.equal(await page.locator('input[name="settings-density"][value="compact"]').isChecked(), true, 'preference survives reopening the app');
  await page.locator('input[name="settings-density"][value="comfortable"]').check();

  await page.evaluate(() => {
    globalThis.settingsOriginalStorageWrite = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException('storage unavailable', 'QuotaExceededError'); };
  });
  try {
    await page.locator('input[name="settings-density"][value="compact"]').check();
    assert.match(await page.locator('#densitySaveStatus').innerText(), /已应用.*无法保存/);
    assert.equal(await page.evaluate(() => document.body.classList.contains('table-compact')), true, 'storage failure does not prevent applying the preference');
  } finally {
    await page.evaluate(() => { Storage.prototype.setItem = settingsOriginalStorageWrite; delete globalThis.settingsOriginalStorageWrite; });
  }
  await page.locator('input[name="settings-density"][value="comfortable"]').check();

  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { started = resolve; });
  let requests = 0;
  const slowRefresh = async route => { requests++; started(); await gate; await route.continue(); };
  await page.route('**/api/bootstrap?*', slowRefresh);
  await page.locator('#settingsRefresh').focus();
  await page.keyboard.press('Enter');
  await pending;
  assert.equal(await page.locator('#settingsRefresh').isDisabled(), true);
  assert.equal(await page.locator('#settingsRefresh').innerText(), '正在刷新…');
  await page.locator('#settingsRefresh').evaluate(element => element.click());
  assert.equal(requests, 1, 'a pending refresh cannot start a duplicate request');
  release();
  await ready();
  await page.unroute('**/api/bootstrap?*', slowRefresh);
  assert.equal(await page.locator('#settingsRefresh').innerText(), '刷新数据', 'busy state restores each action\'s own label');
  assert.equal(await page.locator('#settingsRefresh').evaluate(element => element === document.activeElement), true, 'keyboard focus returns after refreshing');
  assert.equal(await page.locator('#connectionNotice').isVisible(), false);

  const total = await page.evaluate(() => state.recordStats.total);
  const failRefresh = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法更新，请重试' }) });
  await page.route('**/api/bootstrap?*', failRefresh);
  await page.locator('#settingsRefresh').click();
  await page.locator('#main[data-connection="error"]').waitFor();
  assert.equal(await page.locator('#connectionNotice').isVisible(), true, 'a real failure exposes recovery');
  assert.equal(await page.locator('#syncNotice').isVisible(), true);
  assert.equal(await page.evaluate(() => state.recordStats.total), total, 'failed refresh retains previously loaded data');
  assert.equal(await page.locator('#settingsRefresh').innerText(), '刷新数据');
  await shot('settings-refresh-error');
  await page.unroute('**/api/bootstrap?*', failRefresh);
  await page.locator('#connectionNotice [data-action="retry-load"]').click();
  await ready();
  assert.equal(await page.locator('#connectionNotice').isVisible(), false);
  assert.equal(await page.locator('#syncNotice').count(), 0);

  let finishBackground, backgroundStarted;
  const backgroundGate = new Promise(resolve => { finishBackground = resolve; });
  const backgroundPending = new Promise(resolve => { backgroundStarted = resolve; });
  const backgroundRefresh = async route => { backgroundStarted(); await backgroundGate; await route.continue(); };
  await page.route('**/api/bootstrap?*', backgroundRefresh);
  await page.locator('#settingsRefresh').click();
  await backgroundPending;
  await page.locator('#settings-tab-security').click();
  finishBackground();
  await ready();
  await page.unroute('**/api/bootstrap?*', backgroundRefresh);
  assert.equal(await page.locator('#settings-tab-security').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#settings-tab-security').evaluate(element => element === document.activeElement), true, 'late refresh preserves the user\'s current task and focus');

  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.locator('#main[data-connection="error"]').waitFor();
  assert.match(await page.locator('#syncNotice').innerText(), /恢复网络后会自动更新/);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await ready();
  assert.equal(await page.locator('#connectionNotice').isVisible(), false, 'network recovery reconnects automatically');
  await page.locator('#settings-tab-general').click();
  await shot('settings-general');
  await page.locator('#nav [data-page="records"]').click();
  console.log('PASS settings keyboard tabs, live density and persistence, refresh progress, failure recovery, focus and automatic reconnection');
};
