'use strict';
const assert = require('node:assert/strict');

// Disposable backend only. Search/navigation cannot create records or reveal data.
module.exports = async function verifyWorkspaceExperience(page, shot = async () => {}) {
  const nav = async key => { await page.locator(`#nav [data-page="${key}"]`).click(); };
  await nav('overview');
  assert.match(await page.locator('#inventory-title').innerText(), /准备资源/);
  await page.keyboard.press('Control+Shift+k');
  await page.locator('#command-query').waitFor();
  assert.equal(await page.locator('#command-query').evaluate(element => element === document.activeElement), true);
  await page.locator('#command-query').fill('不存在的页面');
  assert.equal(await page.locator('#command-results [role="option"]').count(), 0);
  await page.keyboard.press('Enter'); assert.equal(await page.locator('#command-query').isVisible(), true);
  await page.locator('#command-query').fill('导入 邮箱');
  assert.equal(await page.locator('#command-results [role="option"]').count(), 1);
  await page.locator('#command-query').evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  assert.equal(await page.locator('#command-query').isVisible(), true, 'confirming Chinese composition must not run a command');
  await page.keyboard.press('Tab'); assert.equal(await page.locator('.command-heading .modal-close').evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Shift+Tab'); assert.equal(await page.locator('#command-query').evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Enter'); await page.locator('#import-text').waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    await api('/api/import/emails', { method: 'POST', body: { items: [1, 2].map(n => ({ user: `experience-${n}@example.test` })) } });
    await api('/api/import/proxies', { method: 'POST', body: { items: [1, 2].map(n => ({ host: `192.0.2.${180 + n}`, port: '1080' })) } });
    await api('/api/import/cards', { method: 'POST', body: { items: [1, 2].map(n => ({ number: `Design-Card-${n}`, last4: `003${n}`, expiry: '12/29' })) } });
    for (const n of [1, 2]) await api('/api/import/licenses', { method: 'POST', body: { intent: 'create', items: [{ name: `Experience Company ${n}`, legal_name: `Experience Company ${n}`, cvr: `0212345678${n}`, jurisdiction: 'HR', registration_type: 'OIB', address: `Experience Street ${n}`, city: 'Zagreb' }] } });
    await refresh();
  });
  await nav('overview');
  assert.match(await page.locator('#inventory-title').innerText(), /2 组/);
  await shot('overview');
  await nav('create');
  await page.locator('#f-country').fill('克罗地亚'); await page.locator('#f-product').fill('影像设备');
  await page.locator('#f-domains').fill('experience-one.example\nexperience-two.example\nexperience-three.example');
  await page.locator('#f-require-complete').check();
  assert.equal(await page.locator('.creation-resource-check[data-tone="warning"]').count(), 4);
  assert.equal(await page.locator('.creation-steps [aria-current="step"]').getAttribute('data-target'), 'creation-resources');
  await page.locator('#f-domains').fill('experience-one.example');
  assert.equal(await page.locator('.creation-resource-check[data-tone="warning"]').count(), 0);
  assert.equal(await page.locator('.creation-steps [aria-current="step"]').getAttribute('data-target'), 'creation-check');
  await page.locator('#createAdvanced > summary').click(); await page.locator('#f-idcard').fill('Synthetic note');
  await page.locator('[data-action="create-section"][data-target="creation-basics"]').click();
  assert.equal(await page.locator('#f-country').evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Control+Shift+k'); await page.locator('#command-query').fill('设置'); await page.keyboard.press('Enter');
  await page.locator('#settings-tab-general').waitFor(); await nav('create');
  assert.equal(await page.locator('#f-domains').inputValue(), 'experience-one.example');
  assert.equal(await page.locator('#createAdvanced').evaluate(element => element.open), true);
  assert.equal(await page.locator('#f-idcard').inputValue(), 'Synthetic note');
  await page.locator('[data-action="create"]').click(); await page.locator('#create-confirm:not([disabled])').waitFor();
  assert.equal(await page.evaluate(() => state.recordStats.total), 0);
  await page.keyboard.press('Control+Shift+k'); assert.equal(await page.locator('#command-query').count(), 0, 'shortcut must not replace a review dialog');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#f-domains').inputValue(), 'experience-one.example');
  await page.locator('#createAdvanced > summary').click();
  for (const key of ['create', 'records', 'emails', 'proxies', 'cards', 'licenses', 'settings']) { await nav(key); await shot(key); }
  await nav('records'); await page.keyboard.press('Control+k');
  assert.equal(await page.locator('#rec-q').evaluate(element => element === document.activeElement), true);
  for (const size of [{ width: 1280, height: 720 }, { width: 800, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(size);
    for (const key of ['overview', 'create', 'licenses', 'settings']) {
      if (size.width <= 700) { await page.locator('#mobileNavToggle').click(); await nav(key); }
      else await nav(key);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no document overflow on ${key} at ${size.width}`);
      assert.equal(await page.evaluate(() => document.getElementById('main').scrollWidth <= document.getElementById('main').clientWidth + 1), true, `no main overflow on ${key} at ${size.width}`);
      await shot(`${key}-${size.width}`);
    }
    if (size.width <= 700) await page.locator('#mobileNavToggle').click();
    await page.locator('.workspace-command-trigger').click();
    await page.locator('#command-query').fill('营业执照'); await shot(`commands-${size.width}`); await page.keyboard.press('Escape');
    if (size.width <= 700) await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.workspace-command-trigger').click();
  assert.equal(await page.locator('.modal').evaluate(element => getComputedStyle(element).animationName), 'none');
  await page.keyboard.press('Escape'); await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await page.evaluate(() => state.recordStats.total), 0, 'readiness, navigation and review never commit records');
  console.log('PASS command IME-safe search/navigation, focus loop, retained drafts, four-pool readiness, review without commit, all pages, 320–1440px and reduced motion');
};
