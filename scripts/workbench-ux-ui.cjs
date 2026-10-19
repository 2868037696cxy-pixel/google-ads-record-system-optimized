'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ux-system-'));
  const shots = process.env.UI_SCREENSHOT_DIR;
  let electron, page;
  const shot = async name => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `ux-${name}.png`) });
  };
  const ready = () => page.waitForFunction(() => state.recordsPhase === 'ready');
  const nav = async key => { await page.locator(`#nav [data-page="${key}"]`).click(); };
  try {
    electron = await _electron.launch({
      executablePath: require('electron'),
      args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '.'],
      env: { ...process.env, ADS_WORKBENCH_MODE: 'local', ADS_DESKTOP_DATA_DIR: path.join(directory, 'userdata') },
    });
    page = await electron.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByText('已连接', { exact: true }).waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });

    const system = await page.evaluate(() => ({
      tokens: [...document.styleSheets].some(sheet => sheet.href?.includes('design-tokens.css')),
      components: [...document.styleSheets].some(sheet => sheet.href?.includes('ui-components.css')),
      body: parseFloat(getComputedStyle(document.body).fontSize),
      button: document.querySelector('.page-head .btn-primary').getBoundingClientRect().height,
      color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    }));
    assert.ok(system.tokens && system.components);
    assert.ok(system.body >= 14 && system.button >= 40);
    assert.equal(system.color, '#88bcff');
    await shot('empty-records');

    await page.evaluate(async () => {
      await api('/api/records', { method: 'POST', body: { country: '波兰', product: '跨语言企业资料与长名称回归', domains: Array.from({ length: 123 }, (_, i) => `ux-${i + 1}.example`), proxy_mode: 'none' } });
      await api('/api/import/emails', { method: 'POST', body: { items: [{ user: 'ux-one@example.test' }, { user: 'ux-two@example.test' }] } });
      await api('/api/import/proxies', { method: 'POST', body: { items: [{ host: '192.0.2.20', port: '1080', type: 'socks5', country: 'PL' }] } });
      await api('/api/import/cards', { method: 'POST', body: { items: [{ number: 'Finance-UX', last4: '1234', expiry: '12/29' }] } });
      await api('/api/import/licenses', { method: 'POST', body: { items: [{ name: '欧洲跨语言企业 Łódź Ελληνικά 中文資料', legal_name: '欧洲跨语言企业 Łódź Ελληνικά 中文資料', city: 'Łódź' }] } });
      await refresh();
    });
    await ready();
    assert.equal(await page.evaluate(() => Number(state.form.start_seq)), 124, 'automatic start number follows the newly synchronized server sequence');

    await page.locator('#rec-sort').selectOption('id_asc');
    await page.waitForFunction(() => state.records.length === 50 && state.records[0].id < state.records.at(-1).id);
    await page.locator('#rec-limit').selectOption('100');
    await page.waitForFunction(() => state.records.length === 100 && state.recordsPhase === 'ready');
    await page.locator('#rec-limit').selectOption('50');
    await page.waitForFunction(() => state.records.length === 50 && state.recordsPhase === 'ready');
    await page.locator('#recordsPanel [data-action="sel-row"]').first().check();
    await page.locator('#recordsPanel [data-action="table-page"]').filter({ hasText: '下一页' }).click();
    await page.waitForFunction(() => state.recordPage === 2 && state.recordsPhase === 'ready');
    await page.locator('#recordsPanel [data-action="sel-row"]').first().check();
    assert.match(await page.locator('#selectionBar').innerText(), /本页 1 条.*其他页或筛选外 1 条/);
    await page.locator('[data-action="delete-selected"]').click();
    assert.match(await page.locator('.modal-body').innerText(), /本页 1 条.*其他页或筛选外 1 条/s);
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), '取消');
    assert.equal(await page.evaluate(() => document.querySelector('.app').inert), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-action="delete-selected"]').evaluate(element => element === document.activeElement), true);

    // Capture exports in memory, never open a native save dialog or write credentials.
    await page.evaluate(() => { globalThis.originalDownload = download; download = (filename, text) => { globalThis.exportResult = { filename, text }; }; });
    await page.locator('[data-action="export-csv"]').click();
    await page.locator('#export-confirm').click();
    await page.waitForFunction(() => globalThis.exportResult?.text);
    assert.equal(await page.evaluate(() => exportResult.text.trim().split(/\r?\n/).length), 3, 'CSV selection includes exactly two rows across pages');
    await page.evaluate(() => { globalThis.exportResult = null; });
    await page.locator('[data-action="export-csv"]').click();
    await page.locator('[name="export-scope"][value="all"]').check();
    await shot('export-scope');
    await page.locator('#export-confirm').click();
    await page.waitForFunction(() => globalThis.exportResult?.text);
    assert.equal(await page.evaluate(() => exportResult.text.trim().split(/\r?\n/).length), 124);
    await page.evaluate(() => { download = originalDownload; });
    console.log('PASS sorting, page size, cross-page selection, delete scope and export scope');

    const search = page.locator('#rec-q');
    await page.keyboard.press('Control+k');
    assert.equal(await search.evaluate(element => element === document.activeElement), true);
    await page.route('**/api/records?*', async route => {
      if (new URL(route.request().url()).searchParams.get('q') === 'ux-failure') await route.fulfill({ status: 503, contentType: 'text/html', body: '<html>maintenance</html>' });
      else await route.continue();
    });
    await search.fill('ux-failure');
    await page.waitForFunction(() => state.recordsPhase === 'error');
    assert.equal(await search.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('#recordsPanel .table-wrap').evaluate(element => element.inert), true);
    assert.equal(await page.locator('[data-action="export-csv"]').isDisabled(), true);
    assert.match(await page.locator('#recordsFeedback').innerText(), /查询失败.*上次结果/s);
    await shot('query-error');
    await page.unroute('**/api/records?*');
    await page.locator('[data-action="retry-records"]').click();
    await ready();
    await page.getByText('没有匹配的记录', { exact: true }).waitFor();
    await page.locator('[data-action="reset-record-search"]').click();
    await ready();

    // A superseded response is released inside the next search's debounce interval.
    const sample = await page.evaluate(() => ({ ...state.records[0] }));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let intercepted;
    const started = new Promise(resolve => { intercepted = resolve; });
    await page.route('**/api/records?*', async route => {
      if (new URL(route.request().url()).searchParams.get('q') === 'delayed-old') {
        intercepted(); await gate;
        await route.fulfill({ json: { items: [sample], total: 999, limit: 50, offset: 0 } }).catch(() => {});
      } else await route.continue();
    });
    await search.fill('delayed-old');
    await started;
    await search.fill('ux-123.example');
    release();
    await page.waitForFunction(() => state.recordsPhase === 'ready' && state.recordFilteredTotal === 1);
    assert.equal(await page.locator('#recordsPanel tbody tr[data-id]').count(), 1);
    assert.match(await page.locator('#recordsPanel tbody').innerText(), /ux-123.example/);
    assert.equal(await page.evaluate(() => state.recordFilteredTotal), 1);
    await page.unroute('**/api/records?*');
    console.log('PASS persistent query failure, retry, focus preservation and stale-response isolation');

    await nav('create');
    await page.locator('#f-domains').fill('https://same.example/path\nSAME.EXAMPLE');
    await page.locator('[data-action="create"]').click();
    assert.equal(await page.locator('#modal-root .modal').count(), 0);
    assert.equal(await page.locator('#f-domains').getAttribute('aria-invalid'), 'true');
    await page.locator('#f-country').fill('奥地利');
    await page.locator('#f-product').fill('设计系统验收');
    await page.locator('#f-domains').fill('https://new-ux.example/path');
    await page.locator('[data-action="create"]').click();
    assert.match(await page.locator('.modal-body').innerText(), /new-ux.example/);
    await shot('create-review');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#f-domains').inputValue(), 'https://new-ux.example/path');
    let creates = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/records') ++creates; });
    await page.locator('[data-action="create"]').click();
    await page.locator('#create-confirm').evaluate(button => { button.click(); button.click(); });
    await page.getByRole('heading', { name: '已创建 1 条记录', exact: true }).waitFor();
    assert.equal(creates, 1);
    assert.equal(await page.evaluate(() => state.recordStats.total), 124);
    await page.locator('[data-action="created-records"]').click();
    await ready();
    assert.equal(await page.locator('#rec-q').inputValue(), '');
    await page.locator('[data-action="clear-selection"]').click();
    console.log('PASS normalized validation, review cancellation, single submission and success navigation');

    // A committed update must remain distinguishable from a failed refresh.
    let failBootstrap = true;
    await page.route('**/api/bootstrap*', async route => {
      if (failBootstrap) { failBootstrap = false; await route.fulfill({ status: 503, contentType: 'text/html', body: 'maintenance' }); }
      else await route.continue();
    });
    await page.locator('#recordsPanel [data-action="rec-status"]').first().selectOption('异常');
    await page.locator('#syncNotice').waitFor();
    assert.match(await page.locator('#syncNotice').innerText(), /状态已更新.*刷新失败/s);
    await shot('saved-refresh-warning');
    await page.locator('#syncNotice [data-action="retry-load"]').click();
    await ready();
    await page.waitForFunction(() => !state.syncError && !document.getElementById('syncNotice'));
    await page.unroute('**/api/bootstrap*');

    // Keyboard loop and reachable footer on the longest existing form.
    await nav('licenses');
    await page.locator('[data-action="open-import"][data-kind="licenses"]').click();
    await page.setViewportSize({ width: 1280, height: 720 });
    const bounds = await page.locator('.modal-foot').boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 721);
    assert.equal(await page.locator('.modal-body').evaluate(element => getComputedStyle(element).overflowY), 'auto');
    const focusables = page.locator('.modal button:not([disabled])');
    await focusables.last().focus();
    await page.keyboard.press('Tab');
    assert.equal(await focusables.first().evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focusables.last().evaluate(element => document.activeElement === element), true);
    await shot('license-dialog-1280');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.querySelector('.app').inert), false);

    for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(viewport);
      for (const key of ['records','create','overview','emails','proxies','cards','licenses','settings']) {
        await nav(key);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || document.getElementById('main').scrollWidth > document.getElementById('main').clientWidth + 1);
        assert.equal(overflow, false, `${key} must not overflow the viewport at ${viewport.width}`);
        if (viewport.width === 1440 || key === 'records') await shot(`${key}-${viewport.width}`);
      }
    }
    await nav('records');
    await page.setViewportSize({ width: 1280, height: 720 });
    const sticky = await page.evaluate(() => {
      const wrap = document.querySelector('#recordsPanel .table-wrap');
      wrap.scrollLeft = 1000;
      const first = wrap.querySelector('tbody td:first-child').getBoundingClientRect();
      const second = wrap.querySelector('tbody td:nth-child(2)').getBoundingClientRect();
      return { firstRight: first.right, secondLeft: second.left };
    });
    assert.ok(Math.abs(sticky.firstRight - sticky.secondLeft) <= 1, 'frozen columns must meet without overlapping');
    await shot('frozen-columns');

    for (const zoom of [1.25, 1.5]) {
      await electron.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom);
      await nav('licenses');
      await page.locator('[data-action="open-import"][data-kind="licenses"]').click();
      const visible = await page.locator('.modal-foot').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight + 1);
      assert.equal(visible, true, `dialog footer remains reachable at ${zoom * 100}% Electron zoom`);
      await shot(`dialog-zoom-${zoom * 100}`);
      await page.keyboard.press('Escape');
    }
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    assert.deepEqual(errors, []);
    console.log('PASS eight pages, three desktop sizes, sticky columns, dialog keyboard loop and 125/150% zoom');
  } catch (error) {
    if (page) console.error('UX failure state:', await page.evaluate(() => ({ phase: state.recordsPhase, queryError: state.recordError, syncError: state.syncError, modalTitle: document.querySelector('.modal h3')?.textContent, submitError: document.getElementById('create-submit-error')?.textContent })).catch(() => ({})));
    if (page) await shot('failure').catch(() => {});
    throw error;
  } finally {
    if (electron) await electron.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
