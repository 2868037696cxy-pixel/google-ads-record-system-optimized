'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { DatabaseSync } = require('node:sqlite');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ux-system-'));
  const shots = process.env.UI_SCREENSHOT_DIR;
  let electron, page;
  const shot = async name => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `ux-${name}.png`), animations: 'disabled' });
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
    await page.locator('#rec-limit').focus();
    await page.locator('#rec-limit').selectOption('50');
    await page.waitForFunction(() => state.records.length === 50 && state.recordsPhase === 'ready');
    assert.equal(await page.locator('#rec-limit').evaluate(element => element === document.activeElement), true, 'page size retains keyboard focus after replacing the footer');
    await page.locator('#recordsPanel [data-action="sel-row"]').first().check();
    await page.locator('#recordsPanel [data-action="table-page"]').filter({ hasText: '下一页' }).click();
    await page.waitForFunction(() => state.recordPage === 2 && state.recordsPhase === 'ready');
    assert.equal(await page.locator('#recordsPanel [data-direction="next"]').evaluate(element => element === document.activeElement), true, 'next-page focus keeps its direction');
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
    const compositionRequests = [];
    const observeQuery = request => { if (new URL(request.url()).pathname === '/api/records') compositionRequests.push(request.url()); };
    page.on('request', observeQuery);
    await search.evaluate(input => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.value = 'zhong';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    await page.waitForTimeout(350); // Longer than the production debounce, during composition.
    assert.deepEqual(compositionRequests, []);
    assert.match(await page.locator('#recordsFeedback').innerText(), /确认输入后自动查询/);
    assert.equal(await page.locator('#recordsFeedback').evaluate(element => getComputedStyle(element, '::before').content), 'none');
    await shot('query-composition');
    await search.evaluate(input => {
      input.value = '中文';
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中文' }));
    });
    await page.waitForFunction(() => state.recordsPhase === 'ready' && state.q === '中文');
    assert.equal(compositionRequests.length, 1);
    assert.equal(new URL(compositionRequests[0]).searchParams.get('q'), '中文');
    assert.equal(await search.evaluate(element => element === document.activeElement), true);
    page.off('request', observeQuery);
    await page.locator('[data-action="clear-record-filter"]').click();
    await ready();

    const statusTab = page.locator('#recordsPanel [data-action="rstatus"][data-v="正常"]');
    await statusTab.scrollIntoViewIfNeeded();
    const tabBox = await statusTab.boundingBox();
    await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
    await page.mouse.down();
    assert.equal(await statusTab.evaluate(element => getComputedStyle(element).transform), 'none', 'pressed filter buttons never shrink');
    await page.mouse.up();
    await ready();
    await shot('query-filter-components');
    await page.locator('[data-action="clear-record-filter"]').click();
    await ready();
    console.log('PASS Chinese composition, stable filter buttons and query keyboard focus');
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

    let releaseRevealed, revealStarted;
    const revealGate = new Promise(resolve => { releaseRevealed = resolve; });
    const revealing = new Promise(resolve => { revealStarted = resolve; });
    await page.route('**/api/records?*', async route => {
      if (new URL(route.request().url()).searchParams.get('reveal') === '1') {
        revealStarted(); await revealGate;
        await route.fulfill({ json: { items: [{ ...sample, email_pass: 'SYNTHETIC-LATE-SECRET' }], total: 1 } }).catch(() => {});
      } else await route.continue();
    });
    await page.evaluate(async () => { await ensureSensitive(); state.reveal = true; });
    const pendingRevealed = page.evaluate(() => loadRecordsPage({ renderMode: 'table' }));
    await revealing;
    await page.evaluate(() => lockSensitive());
    releaseRevealed();
    await pendingRevealed;
    assert.equal(await page.evaluate(() => state.reveal), false);
    assert.equal(await page.evaluate(() => JSON.stringify(state.records).includes('SYNTHETIC-LATE-SECRET')), false);
    await page.unroute('**/api/records?*');
    console.log('PASS sensitive lock invalidates in-flight plaintext responses');

    // A response already produced by the server must not escape a later lock.
    let releaseExport, exportStarted, exportFinished;
    const exportGate = new Promise(resolve => { releaseExport = resolve; });
    const exporting = new Promise(resolve => { exportStarted = resolve; });
    const exported = new Promise(resolve => { exportFinished = resolve; });
    await page.evaluate(() => { globalThis.originalDownload = download; globalThis.exportResult = null; download = (filename, text) => { globalThis.exportResult = { filename, text }; }; });
    await page.route('**/api/export/adspower', async route => {
      exportStarted(); await exportGate;
      await route.fulfill({ json: { count: 1, text: 'SYNTHETIC-LATE-EXPORT' } }).catch(() => {});
      exportFinished();
    });
    await page.locator('[data-action="export-adspower"]').click();
    await page.locator('#export-confirm').click();
    await exporting;
    await page.evaluate(() => lockSensitive());
    releaseExport(); await exported;
    assert.equal(await page.evaluate(() => globalThis.exportResult), null);
    assert.equal(await page.locator('#modal-root .modal').count(), 0);
    await page.unroute('**/api/export/adspower');
    await page.evaluate(() => { download = originalDownload; });
    console.log('PASS cancelled sensitive exports cannot download late responses');

    await nav('create');
    await page.locator('#f-domains').fill('https://same.example/path\nSAME.EXAMPLE');
    await page.locator('[data-action="create"]').click();
    assert.equal(await page.locator('#modal-root .modal').count(), 0);
    assert.equal(await page.locator('#f-domains').getAttribute('aria-invalid'), 'true');
    await page.locator('#f-country').fill('奥地利');
    await page.locator('#f-product').fill('设计系统验收');
    await page.locator('#f-domains').fill('https://new-ux.example/path');
    const inputContext = await page.evaluate(async () => {
      const input = document.getElementById('f-product');
      input.focus(); input.setSelectionRange(1, 4);
      await refresh();
      const replacement = document.getElementById('f-product');
      return { focused: replacement === document.activeElement, start: replacement.selectionStart, end: replacement.selectionEnd, value: replacement.value };
    });
    assert.deepEqual(inputContext, { focused: true, start: 1, end: 4, value: '设计系统验收' });
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
    await page.locator('.col-menu summary').click();
    await page.locator('[data-action="toggle-col"][data-col="emailPass"]').uncheck();
    assert.equal(await page.locator('[data-action="reset-cols"]').isEnabled(), true);
    const menuBounds = await page.locator('.col-menu-body').boundingBox();
    assert.ok(menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= 901, 'column picker stays inside the current viewport');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.col-menu').getAttribute('open'), null);
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
    await page.waitForFunction(() => !document.querySelector('#toast-root .toast'));

    // Write dialogs keep their draft and retry control when a request fails.
    let releaseSave, saveStarted;
    const saveGate = new Promise(resolve => { releaseSave = resolve; });
    const saving = new Promise(resolve => { saveStarted = resolve; });
    let writes = 0, backgroundSyncs = 0;
    const countSync = request => { if (new URL(request.url()).pathname === '/api/bootstrap') ++backgroundSyncs; };
    page.on('request', countSync);
    await page.route('**/api/records/*', async route => {
      ++writes; saveStarted(); await saveGate;
      await route.fulfill({ status: 503, json: { message: '合成测试：服务暂不可用，请保留草稿后重试' } });
    });
    await page.locator('#recordsPanel [data-action="edit-record"]').first().click();
    await page.locator('#edit-form [name="product"]').fill('保留的编辑草稿');
    await page.locator('#edit-ok').evaluate(button => { button.click(); button.click(); });
    await saving;
    assert.equal(await page.locator('.modal [data-action="close-modal"]').first().isDisabled(), true);
    assert.equal(await page.locator('#edit-form [name="product"]').isDisabled(), true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+r');
    assert.equal(await page.locator('#edit-ok').count(), 1);
    assert.equal(backgroundSyncs, 0);
    releaseSave();
    await page.locator('.dialog-error').waitFor();
    assert.equal(writes, 1);
    assert.equal(await page.locator('#edit-ok').isEnabled(), true);
    assert.equal(await page.locator('#edit-form [name="product"]').inputValue(), '保留的编辑草稿');
    await shot('edit-retry');
    await page.keyboard.press('Escape');
    await page.unroute('**/api/records/*');
    page.off('request', countSync);

    await page.evaluate(() => openRestoreDialog());
    const restoreFile = name => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'adsworkbench-backup', version: 2, counts: { records: 1 } })) });
    await page.locator('#restore-file').setInputFiles(restoreFile('first.json'));
    await page.waitForFunction(() => !document.getElementById('restore-confirm').disabled);
    assert.equal(await page.locator('#restore-go').isDisabled(), true);
    await page.locator('#restore-confirm').check();
    assert.equal(await page.locator('#restore-go').isEnabled(), true);
    await page.locator('#restore-file').setInputFiles(restoreFile('second.json'));
    await page.waitForFunction(() => document.getElementById('restore-status').textContent.includes('second.json'));
    assert.equal(await page.locator('#restore-confirm').isChecked(), false);
    assert.equal(await page.locator('#restore-go').isDisabled(), true);
    await shot('restore-confirmation');
    await page.keyboard.press('Escape');
    console.log('PASS draft focus after sync, pending writes, inline retry and restore confirmation reset');

    // Corrupt public snapshots only in this disposable test database. The actual
    // production endpoint must diagnose them without guessing new associations.
    const fixtureDb = new DatabaseSync(path.join(directory, 'userdata', 'workbench.sqlite'));
    let integrityFixture;
    try {
      const owner = fixtureDb.prepare("SELECT id FROM users WHERE username='local'").get().id;
      const first = fixtureDb.prepare('SELECT id,fingerprint FROM records WHERE owner_id=? ORDER BY id LIMIT 1').get(owner);
      const last = fixtureDb.prepare('SELECT id,email_id,fingerprint FROM records WHERE owner_id=? ORDER BY id DESC LIMIT 1').get(owner);
      fixtureDb.prepare("UPDATE records SET license_name='独立历史快照核对',version=version+1 WHERE owner_id=? AND id=?").run(owner, first.id);
      fixtureDb.prepare("UPDATE records SET email_user='old-integrity@example.test',version=version+1 WHERE owner_id=? AND id=?").run(owner, last.id);
      integrityFixture = { first, last };
    } finally { fixtureDb.close(); }
    await nav('settings');
    await page.locator('[data-action="check-integrity"]').click();
    await page.getByText('有独立快照但没有关联，可能是历史录入；需人工核对', { exact: true }).waitFor();
    assert.match(await page.locator('#integrity-range').innerText(), /1–100.*124/);
    await shot('integrity-manual');
    await page.locator('[data-integrity-record]').first().click();
    await page.locator('#edit-ok').waitFor();
    assert.match(await page.locator('.modal-head').innerText(), new RegExp(integrityFixture.first.fingerprint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await page.keyboard.press('Escape');
    await nav('settings');
    await page.locator('[data-action="check-integrity"]').click();
    await page.locator('#integrity-next').click();
    await page.getByText('记录快照与当前关联资源不一致', { exact: true }).waitFor();
    assert.match(await page.locator('#integrity-range').innerText(), /101–124.*124/);
    assert.equal((await page.locator('#integrity-results').innerText()).includes('SYNTHETIC-'), false);
    await shot('integrity-diff');
    await page.locator('#integrity-prev').click();
    await page.getByText('有独立快照但没有关联，可能是历史录入；需人工核对', { exact: true }).waitFor();
    await page.locator('#integrity-next').click();
    await page.locator('[data-integrity-repair]').first().click();
    await page.locator('#integrity-consent').waitFor();
    assert.equal(await page.locator('#integrity-apply').isDisabled(), true);
    await page.setViewportSize({ width: 1280, height: 720 });
    assert.equal(await page.locator('.modal-foot').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight + 1), true);
    await shot('integrity-confirm');
    await page.locator('#integrity-back').click();
    await page.locator('[data-integrity-repair]').first().click();
    await page.locator('#integrity-consent').check();
    // A legitimate concurrent edit makes this confirmation stale.
    await page.evaluate(async id => {
      const row = (await api('/api/records?limit=200')).items.find(item => item.id === id);
      await api(`/api/records/${id}`, { method: 'PATCH', body: { version: row.version, product: '版本变化回归' } });
    }, integrityFixture.last.id);
    let repairs = 0;
    const countRepairs = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/data-integrity/repair') ++repairs; };
    page.on('request', countRepairs);
    await page.locator('#integrity-apply').click();
    await page.locator('.dialog-error').waitFor();
    assert.equal(await page.locator('#integrity-apply').isDisabled(), true);
    await shot('integrity-conflict');
    await page.locator('#integrity-back').click();
    await page.locator('[data-integrity-repair]').first().click();
    await page.locator('#integrity-consent').check();
    await page.locator('#integrity-apply').evaluate(button => { button.click(); button.click(); });
    await page.getByRole('heading', { name: '本批未发现关联差异', exact: true }).waitFor();
    assert.equal(repairs, 2, 'one stale rejection and exactly one successful repair');
    page.off('request', countRepairs);
    const repaired = await page.evaluate(async id => (await api('/api/records?limit=200')).items.find(item => item.id === id), integrityFixture.last.id);
    assert.equal(repaired.email_id, integrityFixture.last.email_id);
    assert.equal(repaired.email_user, 'ux-one@example.test');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });

    let failIntegrity = true;
    await page.route('**/api/data-integrity?*', async route => {
      if (failIntegrity) { failIntegrity = false; await route.fulfill({ status: 503, json: { error: '合成检查中断' } }); }
      else await route.continue();
    });
    await page.locator('[data-action="check-integrity"]').click();
    await page.locator('#integrity-retry').click();
    await page.getByText('有独立快照但没有关联，可能是历史录入；需人工核对', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.unroute('**/api/data-integrity?*');
    console.log('PASS owner-only integrity batches, manual route, confirmation, stale version, single repair and retry');

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
        const connectionFits = await page.locator('#connectionStatus').evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().height <= 24);
        assert.equal(connectionFits, true, 'connection status must remain readable on one line beside reconnect');
        const unlabeled = await page.evaluate(() => [...document.querySelectorAll('input, select, textarea')].filter(element => element.getClientRects().length && !element.labels?.length && !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby')).map(element => element.id || element.name));
        assert.deepEqual(unlabeled, [], `${key} inputs must have an accessible label`);
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
