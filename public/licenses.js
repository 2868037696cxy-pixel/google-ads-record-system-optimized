'use strict';

const LICENSE_FIELDS = [
  ['name', '组织名称', true], ['legal_name', '法定名称', true],
  ['address', '街道地址', false], ['apt', '公寓或套房门牌号', false],
  ['zip', '邮编', false], ['city', '市 / 区', false], ['cvr', 'CVR 注册号', false],
];

function openLicenseDetails(id) {
  const license = state.pools.licenses.find((item) => item.id === id);
  if (!license) return toast('营业执照不存在，请重新连接刷新数据', 'warn');
  const rows = LICENSE_FIELDS.map(([key, label]) => `<tr><th>${label}</th><td><span class="copyable" data-copy="${esc(license[key] || '')}" title="点击复制">${esc(license[key] || '—')}</span></td></tr>`).join('');
  openModal(`
    <div class="modal-head"><div><span class="license-eyebrow">组织资料 · ${esc(license.status)}</span><h3>${esc(license.name)}</h3></div><button class="modal-close" data-action="close-modal" aria-label="关闭">✕</button></div>
    <div class="modal-body">
      <table class="detail-table"><tbody>${rows}</tbody></table>
      <div class="license-document">
        <span class="license-document-icon" aria-hidden="true">PDF</span>
        <div class="grow"><strong>${esc(license.document_name || '原 PDF 未保存')}</strong><p>${license.document_id ? `原始文件已保存到工作台 · ${Math.ceil((license.document_size || 0) / 1024)} KB · 完整备份可恢复` : '可重新导入同名组织的 PDF，补充原文件。'}</p></div>
      </div>
    </div>
    <div class="modal-foot">
      ${license.document_id ? `<button class="btn btn-primary" data-action="open-license-pdf" data-id="${id}">${window.desktop ? '打开原 PDF' : '下载原 PDF'}</button>${window.desktop ? `<button class="btn btn-ghost" data-action="reveal-license-pdf" data-id="${id}">打开文件位置</button>` : ''}` : ''}
      <span class="grow"></span><button class="btn btn-ghost" data-action="close-modal">关闭</button>
    </div>`, { large: true });
}

function openLicenseImport() {
  openModal(`
    <div class="modal-head"><div><span class="license-eyebrow">营业执照资料库</span><h3>导入与校对</h3></div><button class="modal-close" data-action="close-modal" aria-label="关闭">✕</button></div>
    <div class="modal-body">
      <div class="license-upload"><strong>一个 PDF · 一条营业执照记录</strong><p>自动提取公司资料，字段合并到同一条记录中。多页证书也只保存一条，最大 10 MB。</p><input type="file" id="license-file" accept=".pdf,application/pdf"><span id="license-file-status" role="status">也可以不上传文件，直接填写资料。</span></div>
      <form id="license-form" class="license-form" autocomplete="off">
        ${LICENSE_FIELDS.map(([key, label, required]) => `<div class="field ${key === 'address' ? 'license-wide' : ''}"><label for="license-${key}">${label}${required ? ' *' : '（选填）'}</label><input id="license-${key}" name="${key}" ${required ? 'required' : ''} ${key === 'zip' ? 'placeholder="9310 或 DK-9310"' : ''}></div>`).join('')}
      </form>
      <details class="license-source"><summary>粘贴结构化信息 / 查看识别原文</summary><textarea id="license-text" class="mono" rows="6" placeholder="组织名称：PBF Auto ApS\n法定名称：PBF Auto ApS\n街道地址：Følfodvej 1\n邮编：9310\n市/区：Vodskov"></textarea><button class="btn btn-ghost btn-sm" id="license-parse-text">从文本提取</button></details>
      <p class="license-help">全员统一查重：相同 PDF 文件禁止重复上传（即使改名），公司名称或注册号重复也会提示。只会显示重复原因，不会展示其他成员资料。校对后才能确认保存。</p>
    </div>
    <div class="modal-foot"><span class="grow"></span><button class="btn btn-ghost" data-action="close-modal">取消</button><button class="btn btn-primary" id="license-import">确认保存</button></div>
  `, { large: true });
  const form = document.getElementById('license-form');
  const fileInput = document.getElementById('license-file');
  const status = document.getElementById('license-file-status');
  const submit = document.getElementById('license-import');
  const text = document.getElementById('license-text');
  const parseText = document.getElementById('license-parse-text');
  let attachment = null;
  let revision = 0;
  let saving = false;
  const fill = (item) => LICENSE_FIELDS.forEach(([key]) => { form.elements[key].value = item[key] || ''; });
  fileInput.onchange = async () => {
    if (saving) return;
    const current = ++revision;
    const file = fileInput.files[0];
    attachment = null;
    submit.disabled = false;
    parseText.disabled = false;
    document.getElementById('license-conflict')?.remove();
    if (!file) { status.textContent = '也可以不上传文件，直接填写资料。'; return; }
    fill({}); text.value = '';
    if (file.size > 10 * 1024 * 1024) { status.textContent = '文件超过 10 MB，请选择较小的 PDF'; fileInput.value = ''; return; }
    status.textContent = '正在识别 PDF…';
    submit.disabled = true;
    parseText.disabled = true;
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
      if (first.duplicate) renderLicenseConflictPanel({ title: '注意：这份资料与现有记录重复', conflicts: [first.duplicate], tone: 'warn' });
      status.textContent = result.items.length ? '已提取信息，请核对后保存。原 PDF 将一并保存。' : '未能自动识别，请手动填写资料。原 PDF 仍可保存。';
    } catch (error) {
      if (current === revision && form.isConnected) {
        status.textContent = error.message;
        fileInput.value = '';
        attachment = null;
        if (Array.isArray(error.conflicts) && error.conflicts.length) showLicenseConflicts(error);
      }
    } finally {
      if (current === revision && form.isConnected) { submit.disabled = false; parseText.disabled = false; }
    }
  };
  parseText.onclick = async () => {
    if (saving || parseText.disabled) return;
    const current = revision;
    const source = text.value;
    try {
      const result = await api('/api/parse/licenses', { method: 'POST', body: { text: source } });
      if (current !== revision || !form.isConnected || source !== text.value) return;
      if (result.items.length !== 1) return toast('请一次填写一份组织资料，或直接在上方校对字段', 'warn');
      fill(result.items[0]);
    } catch (error) { toast(error.message, 'error'); }
  };
  submit.onclick = async () => {
    if (saving || submit.disabled) return;
    if (!form.reportValidity()) return;
    submit.disabled = true;
    const item = Object.fromEntries(LICENSE_FIELDS.map(([key]) => [key, form.elements[key].value.trim()]));
    if (!item.name || !item.legal_name) { submit.disabled = false; return toast('组织名称和法定名称不能为空', 'warn'); }
    saving = true;
    fileInput.disabled = true;
    parseText.disabled = true;
    try {
      const result = await api('/api/import/licenses', { method: 'POST', body: { items: [item], ...attachment } });
      toast(result.added ? '营业执照已保存' : result.attached ? '资料已更新，原 PDF 已关联' : result.updated ? '组织资料已更新' : '该组织已在资料库中');
      if (form.isConnected) closeModal();
      await refresh();
    } catch (error) {
      if (Array.isArray(error.conflicts) && error.conflicts.length) showLicenseConflicts(error);
      else toast(error.message, 'error');
    }
    finally { saving = false; submit.disabled = false; fileInput.disabled = false; parseText.disabled = false; }
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
