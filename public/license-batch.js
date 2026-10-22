'use strict';

/** Files are read lazily, one at a time. Each document has its own review and commit. */
function openLicenseBatch(files) {
  if (files.length > 100) return toast('每批最多 100 份 PDF，可分批继续添加', 'warn');
  const entries = files.map((file, index) => ({ id: index, file, item: {}, phase: 'queued', message: '等待识别', selected: true, revision: 0 }));
  const labels = Object.fromEntries(LICENSE_FIELDS.map(([key, label]) => [key, label]));
  let currentId = 0, running = true, writing = false, changed = false, timer, checkController;
  openModal(`<div class="modal-head"><div><span class="license-eyebrow">企业文件池</span><h3>批量导入与校对</h3></div><button class="modal-close" data-action="close-modal" aria-label="关闭">✕</button></div>
    <div class="modal-body"><p class="license-help">每份 PDF 独立保存。无法识别、字段不全或重复的文件会留在待校对列表；关闭时未保存项不会入池。</p>
      <label class="batch-auto"><input type="checkbox" id="batch-auto-save">自动保存字段完整且无重复的资料</label>
      <p id="batch-summary" role="status" aria-live="polite"></p>
      <div class="license-batch-layout"><div id="batch-files" class="license-batch-files" aria-label="文件队列"></div>
        <div class="document-review-layout">${WorkbenchDocumentViewer.markup()}<section id="batch-editor" class="document-fields" aria-label="当前文件校对"></section></div></div>
    </div><div class="modal-foot"><button class="btn btn-ghost" id="batch-done">完成并返回资料库</button><span class="grow"></span><button class="btn btn-primary" id="batch-save-ready" disabled>保存完整资料</button></div>`, { large: true });
  const signal = WorkbenchUI.dialog.signal();
  const preview = WorkbenchDocumentViewer.attach(document.querySelector('.document-preview'), signal);
  let previewId = null;
  const list = document.getElementById('batch-files'), editor = document.getElementById('batch-editor');
  const summary = document.getElementById('batch-summary'), saveReady = document.getElementById('batch-save-ready');
  const auto = document.getElementById('batch-auto-save');
  const alive = () => !signal.aborted && list.isConnected;
  const required = ['name', 'legal_name', 'cvr', 'jurisdiction', 'registration_type', 'address', 'city'];
  const missing = entry => required.filter(key => !String(entry.item[key] || '').trim());
  const readPdf = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cancel = () => { reader.abort(); reject(new DOMException('已取消', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
    reader.onload = () => { signal.removeEventListener('abort', cancel); resolve(String(reader.result).split(',')[1]); };
    reader.onerror = () => { signal.removeEventListener('abort', cancel); reject(new Error('文件读取失败')); };
    reader.readAsDataURL(file);
  });
  function paint() {
    if (!alive()) return;
    const saved = entries.filter(entry => entry.phase === 'saved').length;
    const ready = entries.filter(entry => entry.selected && entry.phase === 'ready').length;
    const outstanding = entries.filter(entry => ['queued', 'parsing', 'checking'].includes(entry.phase)).length;
    summary.textContent = `共 ${entries.length} 份 · 已入池 ${saved} 份 · 可保存 ${ready} 份 · ${outstanding ? `正在处理 ${outstanding} 份` : '识别完成，请核对其余文件'}`;
    list.innerHTML = entries.map(entry => `<div class="batch-file ${entry.id === currentId ? 'active' : ''}" data-phase="${entry.phase}">
      <input type="checkbox" aria-label="选择 ${esc(entry.file.name)}" data-select="${entry.id}" ${entry.selected ? 'checked' : ''} ${['saved', 'saving'].includes(entry.phase) ? 'disabled' : ''}>
      <button type="button" data-review="${entry.id}" aria-pressed="${entry.id === currentId}"><strong>${esc(entry.file.name)}</strong><span>${esc(entry.message)}</span></button></div>`).join('');
    saveReady.disabled = writing || running || ready === 0;
    saveReady.textContent = writing ? '正在逐份保存…' : `保存完整资料${ready ? `（${ready}）` : ''}`;
    auto.disabled = writing;
  }
  function showEditor(entry) {
    currentId = entry.id;
    if (previewId !== entry.id) { previewId = entry.id; void preview.show({ file: entry.file, name: entry.file.name }); }
    editor.innerHTML = `<h4>${esc(entry.file.name)}</h4><p class="batch-entry-status" id="batch-entry-status" role="status" aria-live="polite">${esc(entry.message)}</p>
      <form id="batch-fields" class="license-form" autocomplete="off">${LICENSE_FIELDS.map(([key, label, mandatory]) => `<div class="field ${['address', 'cvr'].includes(key) ? 'license-wide' : ''}"><label for="batch-${key}">${label}${mandatory ? ' *' : ''}</label><input id="batch-${key}" name="${key}" maxlength="512" value="${esc(entry.item[key] || '')}" ${['saved','saving','parsing','queued'].includes(entry.phase) ? 'disabled' : ''} aria-describedby="batch-entry-status"></div>`).join('')}</form>
      <button type="button" class="btn btn-primary" id="batch-save-one" ${entry.phase === 'ready' && !writing && !running ? '' : 'disabled'}>保存当前资料</button>`;
    editor.querySelector('form').oninput = event => {
      entry.item[event.target.name] = event.target.value.trim(); entry.revision++;
      clearTimeout(timer); checkController?.abort();
      entry.phase = 'checking'; entry.message = '正在自动查重…'; paint(); updateEditorStatus(entry);
      timer = setTimeout(() => check(entry), 350);
    };
    editor.querySelector('#batch-save-one').onclick = () => saveEntries([entry]);
    paint();
  }
  function updateEditorStatus(entry) {
    if (!alive() || entry.id !== currentId) return;
    editor.querySelector('#batch-entry-status').textContent = entry.message;
    editor.querySelector('#batch-save-one').disabled = writing || running || entry.phase !== 'ready';
  }
  async function check(entry, ownSignal = signal) {
    if (!alive() || ['saved','saving','uncertain'].includes(entry.phase)) return false;
    const revision = entry.revision, item = { ...entry.item };
    entry.phase = 'checking'; entry.message = '正在核对全员记录…'; paint(); updateEditorStatus(entry);
    const controller = new AbortController();
    if (entry.id === currentId) checkController = controller;
    try {
      const result = await api('/api/licenses/check-duplicate', { method: 'POST', body: { item }, signal: AbortSignal.any([ownSignal, controller.signal, AbortSignal.timeout(12000)]) });
      if (!alive() || entry.revision !== revision) return false;
      for (const key of ['jurisdiction', 'registration_type']) if (!entry.item[key] && result.identity?.[key]) {
        entry.item[key] = result.identity[key];
        if (entry.id === currentId && editor.querySelector(`[name="${key}"]`)) editor.querySelector(`[name="${key}"]`).value = entry.item[key];
      }
      const incomplete = missing(entry);
      if (result.state === 'duplicate') { entry.phase = 'duplicate'; entry.message = '已重复：' + (result.conflict?.label || '企业资料'); }
      else if (result.state === 'incomplete') { entry.phase = 'review'; entry.message = result.message; }
      else if (result.state === 'clear') {
        entry.phase = incomplete.length ? 'review' : 'ready';
        entry.message = incomplete.length ? '待补齐：' + incomplete.map(key => labels[key]).join('、') : '未发现重复 · 可保存';
      } else throw new Error('查重响应异常');
    } catch (error) {
      if (!alive() || entry.revision !== revision) return false;
      entry.phase = 'error'; entry.message = '查重未完成，请修改字段后自动重试';
    }
    paint(); updateEditorStatus(entry);
    return entry.phase === 'ready';
  }
  async function saveEntries(candidates) {
    if (writing || !alive()) return;
    writing = true; paint();
    for (const entry of candidates) {
      if (!alive()) break;
      if (!entry.selected || entry.phase !== 'ready' || !await check(entry)) continue;
      entry.phase = 'saving'; entry.message = '正在保存原件与资料…'; paint();
      // Prevent closing or editing while a write has been sent. Other files remain untouched.
      WorkbenchUI.dialog.pending(saveReady, true, '正在保存…');
      try {
        const pdf = await readPdf(entry.file);
        await api('/api/import/licenses', { method: 'POST', body: { intent: 'create', items: [{ ...entry.item }], pdf, filename: entry.file.name } });
        entry.phase = 'saved'; entry.message = '已入池'; changed = true;
      } catch (error) {
        entry.phase = error.status === 409 ? 'duplicate' : error.status && error.status < 500 ? 'review' : 'uncertain';
        entry.message = entry.phase === 'uncertain' ? '保存结果待确认，请返回资料库核对，不要重复提交' : error.message;
      } finally { WorkbenchUI.dialog.pending(saveReady, false); }
      if (alive()) { paint(); if (entry.id === currentId) showEditor(entry); }
    }
    writing = false; paint(); if (alive()) showEditor(entries[currentId]);
  }
  async function parseAll() {
    for (const entry of entries) {
      if (!alive()) return;
      if (!entry.selected) { entry.phase = 'review'; entry.message = '已取消选择'; paint(); continue; }
      entry.phase = 'parsing'; entry.message = '正在识别 PDF…'; paint(); if (entry.id === currentId) showEditor(entry);
      try {
        if (entry.file.size > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，请拆分后重新导入');
        const pdf = await readPdf(entry.file);
        const result = await api('/api/parse/licenses-pdf', { method: 'POST', body: { pdf }, signal });
        if (!alive()) return;
        entry.item = { ...(result.items[0] || {}) }; entry.revision++;
        if (result.extraction?.ambiguous) { entry.phase = 'review'; entry.message = '文件包含多个企业或个人编号，请人工选择企业编号'; }
        else await check(entry);
      } catch (error) {
        if (!alive()) return;
        entry.phase = error.status === 409 ? 'duplicate' : 'error'; entry.message = error.message;
      }
      paint(); if (entry.id === currentId) showEditor(entry);
      if (auto.checked && entry.phase === 'ready') await saveEntries([entry]);
    }
    running = false; paint(); if (alive()) updateEditorStatus(entries[currentId]);
    if (alive() && auto.checked) await saveEntries(entries.filter(entry => entry.phase === 'ready'));
  }
  list.onclick = event => { const button = event.target.closest('[data-review]'); if (button && !writing) showEditor(entries[Number(button.dataset.review)]); };
  list.onchange = event => { const entry = entries[Number(event.target.dataset.select)]; if (entry) { entry.selected = event.target.checked; paint(); } };
  saveReady.onclick = () => saveEntries(entries.filter(entry => entry.phase === 'ready'));
  auto.onchange = () => { if (auto.checked && !running) saveEntries(entries.filter(entry => entry.phase === 'ready')); };
  document.getElementById('batch-done').onclick = () => closeModal();
  signal.addEventListener('abort', () => {
    clearTimeout(timer); checkController?.abort();
    if (changed) refreshAfterCommit('已保存文件需要重新连接后查看').catch(() => {});
  }, { once: true });
  showEditor(entries[0]);
  void parseAll();
}
