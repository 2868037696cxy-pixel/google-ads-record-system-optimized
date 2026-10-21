'use strict';

const LICENSE_FIELDS = [
  ['name', '组织名称', true], ['legal_name', '法定名称', true],
  ['jurisdiction', '注册国家 / 地区', true],
  ['registration_type', '企业编号类型', true],
  ['cvr', '企业唯一编号', true],
  ['address', '街道地址', false], ['apt', '公寓或套房门牌号', false],
  ['zip', '邮编', false], ['city', '市 / 区', false],
  ['region', '省 / 州 / 大区', false],
  ['registration_authority', '登记机关', false],
];

function openLicenseDetails(id) {
  const license = state.pools.licenses.find((item) => item.id === id);
  if (!license) return toast('营业执照不存在，请重新连接刷新数据', 'warn');
  const rows = LICENSE_FIELDS.map(([key, label]) => `<tr><th>${label}</th><td><span class="copyable" data-copy="${esc(license[key] || '')}" title="点击复制">${esc(license[key] || '—')}</span></td></tr>`).join('');
  openModal(`
    <div class="modal-head"><div><span class="license-eyebrow">组织资料 · ${esc(license.status)}</span><h3>${esc(license.name)}</h3></div><button class="modal-close" data-action="close-modal" aria-label="关闭">✕</button></div>
    <div class="modal-body">
      <p class="license-help">开户常用资料 · 名称、街道、城市与邮编保留证书原文，点击字段即可复制。未填写的项目显示为「—」。</p>
      <table class="detail-table"><tbody>${rows}</tbody></table>
      <div class="license-document">
        <span class="license-document-icon" aria-hidden="true">PDF</span>
        <div class="grow"><strong>${esc(license.document_name || '原 PDF 未保存')}</strong><p>${license.document_id ? `原始文件已保存到工作台 · ${Math.ceil((license.document_size || 0) / 1024)} KB · 完整备份可恢复` : '可重新导入同名组织的 PDF，补充原文件。'}</p></div>
      </div>
    </div>
    <div class="modal-foot">
      ${license.document_id ? `<button class="btn btn-primary" data-action="open-license-pdf" data-id="${id}">${window.desktop ? '打开原 PDF' : '下载原 PDF'}</button>${window.desktop ? `<button class="btn btn-ghost" data-action="reveal-license-pdf" data-id="${id}">打开文件位置</button>` : ''}` : ''}
      <button class="btn btn-primary" id="license-copy-fields">复制企业资料</button><span class="grow"></span><button class="btn btn-ghost" data-action="close-modal">关闭</button>
    </div>`, { large: true });
  document.getElementById('license-copy-fields').onclick = () => copyText(WorkbenchAccountSetup.build({}, license).business.filter(field => field.value).map(field => `${field.label}：${field.value}`).join('\n'));
}

function openLicenseImport() {
  openModal(`
    <div class="modal-head"><div><span class="license-eyebrow">营业执照资料库</span><h3>导入与校对</h3></div><button class="modal-close" data-action="close-modal" aria-label="关闭">✕</button></div>
    <div class="modal-body">
      <div class="license-upload"><strong>企业文件入池</strong><p>可同时选择多个国家的营业执照或工商 PDF。每份文件独立识别、校对与查重；单份最大 10 MB。</p><input type="file" id="license-file" aria-label="选择营业执照 PDF" aria-describedby="license-file-status" accept=".pdf,application/pdf" multiple><span id="license-file-status" role="status">也可以不上传文件，直接填写资料。</span></div>
      <form id="license-form" class="license-form" autocomplete="off">
        ${LICENSE_FIELDS.map(([key, label, required]) => {
          const placeholder = key === 'zip' ? '9310 或 DK-9310'
            : key === 'jurisdiction' ? '例如 巴西 / 克罗地亚 / DK'
            : key === 'registration_type' ? '例如 CNPJ / OIB / CVR'
            : key === 'cvr' ? '填写证书上的完整企业编号'
            : key === 'registration_authority' ? '例如 CVR / KRS / 商业登记机关'
            : '';
          return `<div class="field ${['address', 'cvr'].includes(key) ? 'license-wide' : ''}"><label for="license-${key}">${label}${required ? ' *' : '（选填）'}</label><input id="license-${key}" name="${key}" maxlength="512" ${required ? 'required' : ''} ${placeholder ? `placeholder="${placeholder}"` : ''} aria-describedby="license-duplicate-status"></div>${key === 'cvr' ? '<div id="license-duplicate-status" class="license-check license-wide" role="status" aria-live="polite" aria-atomic="true" data-state="empty">填写企业编号后自动检查全员记录。</div>' : ''}`;
        }).join('')}
      </form>
      <details class="license-source"><summary>粘贴结构化信息 / 查看识别原文</summary><textarea id="license-text" aria-label="营业执照结构化信息或识别原文" class="mono" rows="7" placeholder="组织名称：PBF Auto ApS\n法定名称：PBF Auto ApS\n注册国家：DK\n注册号类型：CVR\nCVR：12345678\n街道地址：Følfodvej 1\n市/区：Vodskov"></textarea><button class="btn btn-ghost btn-sm" id="license-parse-text">从文本提取</button></details>
      <p class="license-help">输入时自动查重，保存时再次核对。巴西填写 CNPJ，克罗地亚填写企业 OIB；相同编号的空格、分隔符和大小写不影响判重。未识别出编号的 PDF，请手动补齐；扫描图片暂不支持自动识别。其他成员的资料不会显示。</p>
    </div>
    <div class="modal-foot"><span class="grow"></span><button class="btn btn-ghost" data-action="close-modal">取消</button><button class="btn btn-primary" id="license-import">确认保存</button></div>
  `, { large: true });
  const form = document.getElementById('license-form');
  const fileInput = document.getElementById('license-file');
  const status = document.getElementById('license-file-status');
  const submit = document.getElementById('license-import');
  const text = document.getElementById('license-text');
  const parseText = document.getElementById('license-parse-text');
  const checkStatus = document.getElementById('license-duplicate-status');
  let attachment = null;
  let revision = 0;
  let saving = false;
  let parsing = false;
  let checkRevision = 0;
  let checkTimer;
  let checkController;
  let checkState = 'empty';
  const readItem = () => Object.fromEntries(LICENSE_FIELDS.map(([key]) => [key, form.elements[key].value.trim()]));
  const syncSubmit = () => {
    submit.disabled = saving || parsing || !['clear', 'error'].includes(checkState);
    if (!saving) submit.textContent = checkState === 'error' ? '重试查重并保存' : '确认保存';
  };
  const showCheck = (phase, message, conflict) => {
    checkState = phase;
    checkStatus.dataset.state = phase;
    checkStatus.textContent = message;
    for (const [key] of LICENSE_FIELDS) {
      const conflictKey = conflict?.field === 'legal' ? 'legal_name' : conflict?.field;
      if (phase === 'duplicate' && key === conflictKey) form.elements[key].setAttribute('aria-invalid', 'true');
      else form.elements[key].removeAttribute('aria-invalid');
    }
    syncSubmit();
  };
  const cancelCheck = () => { clearTimeout(checkTimer); checkController?.abort(); checkRevision++; };
  const checkNow = async () => {
    cancelCheck();
    if (!form.isConnected || parsing) return false;
    const current = checkRevision;
    const item = readItem();
    const snapshot = JSON.stringify(item);
    if (!Object.values(item).some(Boolean)) { showCheck('empty', '填写企业编号后自动检查全员记录。'); return false; }
    showCheck('pending', '正在检查全员记录…');
    checkController = new AbortController();
    try {
      const result = await api('/api/licenses/check-duplicate', {
        method: 'POST', body: { item }, signal: AbortSignal.any([checkController.signal, AbortSignal.timeout(12000)]),
      });
      if (!form.isConnected || current !== checkRevision || snapshot !== JSON.stringify(readItem())) return false;
      if (result.state === 'duplicate' && result.conflict?.label) {
        showCheck('duplicate', `已存在相同资料（${result.conflict.label}），不能重复保存。`, result.conflict);
        return false;
      }
      if (result.state === 'incomplete') { showCheck('incomplete', result.message || '请填写完整企业编号后继续'); return false; }
      if (result.state !== 'clear') throw new Error('服务响应异常');
      for (const key of ['jurisdiction', 'registration_type']) if (!form.elements[key].value && result.identity?.[key]) form.elements[key].value = result.identity[key];
      showCheck('clear', '未发现重复 · 保存时将再次核对');
      return true;
    } catch (error) {
      if (current === checkRevision && form.isConnected) showCheck('error', '暂时无法完成查重，资料已保留；保存时会先自动重试。');
      return false;
    }
  };
  const scheduleCheck = () => {
    cancelCheck();
    document.getElementById('license-conflict')?.remove();
    showCheck('pending', '正在等待输入完成…');
    checkTimer = setTimeout(checkNow, 350);
  };
  const setParsing = value => {
    parsing = value;
    for (const control of form.elements) control.disabled = value;
    parseText.disabled = value;
    syncSubmit();
  };
  WorkbenchUI.dialog.signal().addEventListener('abort', () => { cancelCheck(); revision++; }, { once: true });
  form.addEventListener('input', scheduleCheck);
  window.addEventListener('online', scheduleCheck, { signal: WorkbenchUI.dialog.signal() });
  syncSubmit();
  const fill = (item) => LICENSE_FIELDS.forEach(([key]) => { form.elements[key].value = item[key] || ''; });
  fileInput.onchange = async () => {
    if (saving) return;
    if (fileInput.files.length > 1) return openLicenseBatch([...fileInput.files]);
    const current = ++revision;
    const file = fileInput.files[0];
    attachment = null;
    cancelCheck();
    setParsing(false);
    document.getElementById('license-conflict')?.remove();
    if (!file) { status.textContent = '也可以不上传文件，直接填写资料。'; scheduleCheck(); return; }
    fill({}); text.value = '';
    showCheck('empty', '识别到企业编号后将自动查重。');
    if (file.size > 10 * 1024 * 1024) { status.textContent = '文件超过 10 MB，请选择较小的 PDF'; fileInput.value = ''; return; }
    status.textContent = '正在识别 PDF…';
    setParsing(true);
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file);
      });
      if (current !== revision || !form.isConnected) return;
      const result = await api('/api/parse/licenses-pdf', { method: 'POST', body: { pdf: base64 } });
      if (current !== revision || !form.isConnected) return;
      attachment = { pdf: base64, filename: file.name };
      const first = result.items[0] || {};
      fill(first);
      text.value = result.text || '';
      status.textContent = first.cvr ? '已提取企业编号，请核对并补齐资料。原 PDF 将一并保存。' : '未识别出唯一企业编号，请手动填写。扫描版或含多个编号的文件需人工核对。';
    } catch (error) {
      if (current === revision && form.isConnected) {
        status.textContent = error.message;
        fileInput.value = '';
        attachment = null;
        if (Array.isArray(error.conflicts) && error.conflicts.length) showLicenseConflicts(error);
      }
    } finally {
      if (current === revision && form.isConnected) {
        setParsing(false);
        if (document.getElementById('license-conflict')) showCheck('duplicate', '这份 PDF 已被记录，不能重复保存。');
        else await checkNow();
      }
    }
  };
  parseText.onclick = async () => {
    if (saving || parseText.disabled) return;
    const current = ++revision;
    const source = text.value;
    cancelCheck();
    setParsing(true);
    WorkbenchUI.busy(parseText, true, '正在提取…');
    fileInput.disabled = true;
    try {
      const result = await api('/api/parse/licenses', { method: 'POST', body: { text: source } });
      if (current !== revision || !form.isConnected || source !== text.value) return;
      if (result.items.length !== 1) return toast('请一次填写一份组织资料，或直接在上方校对字段', 'warn');
      fill(result.items[0]);
    } catch (error) { if (current === revision && form.isConnected) status.textContent = error.message; }
    finally {
      if (current === revision && form.isConnected) {
        WorkbenchUI.busy(parseText, false);
        setParsing(false);
        fileInput.disabled = false;
        await checkNow();
      }
    }
  };
  submit.onclick = async () => {
    if (saving || submit.disabled) return;
    if (!form.reportValidity()) return;
    if (!await checkNow() || !form.isConnected || !form.reportValidity()) return;
    const item = readItem();
    if (!item.name || !item.legal_name) return toast('组织名称和法定名称不能为空', 'warn');
    WorkbenchUI.dialog.pending(submit, true, '正在保存…');
    saving = true;
    fileInput.disabled = true;
    parseText.disabled = true;
    try {
      const result = await api('/api/import/licenses', { method: 'POST', body: { intent: 'create', items: [item], ...attachment } });
      toast(result.added ? '营业执照已保存' : result.attached ? '资料已更新，原 PDF 已关联' : result.updated ? '组织资料已更新' : '该组织已在资料库中');
      if (form.isConnected) closeModal();
      await refreshAfterCommit('资料已保存，但列表刷新失败；请重新连接，不要重复导入');
    } catch (error) {
      if (!form.isConnected) return;
      if (Array.isArray(error.conflicts) && error.conflicts.length) {
        showLicenseConflicts(error);
        showCheck('duplicate', '保存时发现相同资料，已阻止重复写入。请核对企业编号。', error.conflicts[0]);
      }
      else WorkbenchUI.dialog.error(submit, error.message);
    }
    finally { saving = false; WorkbenchUI.dialog.pending(submit, false); fileInput.disabled = false; parseText.disabled = false; syncSubmit(); }
  };
  form.onsubmit = (event) => { event.preventDefault(); submit.click(); };
}

/**
 * 判重提示面板。
 * 识别阶段为预警，导入拒绝为错误；不显示其他成员的资料或身份。
 */
function renderLicenseConflictPanel({ title, conflicts, tone }) {
  document.getElementById('license-conflict')?.remove();
  const items = conflicts.map((c) => `<li>
      <div><b>${esc(c.name || '当前文件')}</b></div>
      <div class="conflict-meta">判重依据：${esc(c.label || '资料重复')} · 已存在相同记录</div>
    </li>`).join('');
  const panel = document.createElement('div');
  panel.id = 'license-conflict';
  panel.className = `license-conflict ${tone}`;
  panel.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  panel.innerHTML = `<strong>${esc(title)}</strong><ul>${items}</ul>
    <p>${tone === 'error'
      ? '没有写入任何重复文件。如确实是不同公司，请核对证书及注册信息；系统不会显示其他成员的内容。'
      : '全员查重发现相同资料，保存时将被拒绝。请核对本次输入。'}</p>`;
  const body = document.querySelector('#modal-root .modal-body');
  if (body) body.prepend(panel);
  return panel;
}

function showLicenseConflicts(error) {
  const panel = renderLicenseConflictPanel({
    title: `已拒绝导入：${error.conflicts.length} 条资料与现有记录重复`,
    conflicts: error.conflicts,
    tone: 'error',
  });
  panel.scrollIntoView({ block: 'nearest' });
  toast('导入已被拒绝：资料与现有记录重复', 'error');
}
