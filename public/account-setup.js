'use strict';

// A shared, non-sensitive projection. Original company spelling is never translated.
globalThis.WorkbenchAccountSetup = (() => {
  function build(record = {}, license = {}) {
    const field = (key, label, value, source, required = false) => ({ key, label, value: String(value || ''), source, required });
    const business = [
      field('legal_name', '企业法定名称 / Organization name', license.legal_name || license.name, '企业文件', true),
      field('name', '商号 / Business name', license.name, '企业文件'),
      field('jurisdiction', '企业注册国家 / Country', license.jurisdiction, '企业文件', true),
      field('address', '街道地址 / Address line 1', license.address, '企业文件', true),
      field('apt', '门牌 / 楼层 / Address line 2', license.apt, '企业文件'),
      field('city', '城市 / City', license.city, '企业文件', true),
      field('region', '省 / 州 / State or region', license.region, '企业文件'),
      field('zip', '邮编 / Postal code', license.zip, '企业文件'),
      field('cvr', `企业编号${license.registration_type ? ' / ' + license.registration_type : ''}`, license.cvr, '企业文件', true),
    ];
    const resources = [
      field('fingerprint', '工作台记录', record.fingerprint, '工作台'),
      field('email', '登录邮箱', record.email_user, '邮箱池', true),
      field('domain', '网站', record.domain, '创建时填写'),
      field('proxy', 'IP / 代理地址', record.proxy_host ? record.proxy_host + (record.proxy_port ? ':' + record.proxy_port : '') : '', 'IP 池', true),
      field('card', '信用卡别名', record.card_number, '信用卡池', true),
      field('card_last4', '信用卡末四位', record.card_last4, '信用卡池'),
      field('expiry', '信用卡有效期', record.card_expiry, '信用卡池'),
      field('target_country', '投放国家（独立于企业注册国家）', record.country, '创建时填写'),
    ];
    const fields = [...business, ...resources];
    return { business, resources, missing: fields.filter(item => item.required && !item.value).map(item => item.label),
      text: fields.filter(item => item.value).map(item => `${item.label}：${item.value}`).join('\n') };
  }
  return Object.freeze({ build });
})();
if (typeof module !== 'undefined') module.exports = globalThis.WorkbenchAccountSetup;

async function openAccountSetup(id) {
  openModal(`<div class="modal-head"><h3>开户资料</h3><button class="modal-close" data-action="close-modal" aria-label="关闭">✕</button></div><div class="modal-body" id="account-setup-body" role="status">正在读取这条记录的关联资料…</div><div class="modal-foot"><button class="btn btn-ghost" data-action="close-modal">关闭</button><span class="grow"></span><button class="btn btn-primary" id="setup-copy-all" disabled>复制开户资料</button></div>`, { large: true });
  const body = document.getElementById('account-setup-body'), copy = document.getElementById('setup-copy-all');
  try {
    const result = await api(`/api/records/${id}/setup`, { signal: WorkbenchUI.dialog.signal() });
    if (!body.isConnected) return;
    const model = WorkbenchAccountSetup.build(result.record, result.license || {});
    const rows = fields => fields.map(field => `<div class="setup-field"><div><dt>${esc(field.label)}</dt><dd>${esc(field.value || '待补充')}</dd></div><button type="button" class="btn btn-ghost btn-sm" ${field.value ? `data-setup-copy="${esc(field.value)}"` : 'disabled'} aria-label="复制 ${esc(field.label)}">复制</button></div>`).join('');
    body.removeAttribute('role');
    body.innerHTML = `<p class="setup-readiness">${model.missing.length ? `待补充 ${model.missing.length} 项：${esc(model.missing.join('、'))}` : '基础资料已齐 · 请对照原件确认后填写'}</p>
      <section><h4>企业与账单资料</h4><p class="license-help">企业名称、街道和城市保留原文。账单国家应以实际付款资料为准，不能用投放国家或 IP 国家代替。</p><dl class="setup-fields">${rows(model.business)}</dl></section>
      <section><h4>本条记录的资源组合</h4><dl class="setup-fields">${rows(model.resources)}</dl></section>
      <section class="setup-manual"><h4>在 Google Ads 中确认</h4><p>账户类型、账单国家、币种、时区及付款方式需按实际业务选择；PDF 不能确定的字段不会自动填造。当前复制内容不包含邮箱密码、2FA、代理密码或完整信用卡号。</p></section>
      ${result.license?.document_id ? `<button class="btn btn-ghost" data-action="open-license-pdf" data-id="${result.license.id}">${window.desktop ? '打开' : '下载'}原始 PDF</button>` : '<p class="license-help">当前未关联原始 PDF，可到企业文件池补充。</p>'}`;
    const copied = async (button, text) => {
      if (!await copyText(text, { quiet: true }) || !button.isConnected) return;
      button.textContent = '已复制';
      setTimeout(() => { if (button.isConnected) button.textContent = button === copy ? '复制开户资料' : '复制'; }, 1800);
    };
    body.onclick = event => { const button = event.target.closest('[data-setup-copy]'); if (button) void copied(button, button.dataset.setupCopy); };
    copy.disabled = false; copy.onclick = () => copied(copy, model.text);
  } catch (error) { if (body.isConnected) { body.textContent = error.message; body.className = 'modal-body field-error'; } }
}
