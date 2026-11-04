'use strict';

// 营业执照固定字段展示：只读已识别/已校对的企业资料，不写库、不改字段。
// 丹麦注册证书按证书原文重算 7 个字段（街道与楼层/房号分开），其他国家沿用已识别字段。
globalThis.WorkbenchLicenseExtract = (() => {
  const LABELS = ['资料类型', '组织名称', '法定名称', '街道地址', '公寓或套房等的门牌号', '邮编', '市/区'];
  const LEGAL_RE = /(?:legal\s*name|legal_name|registered\s*name)\s*[:\uff1a]\s*(.+)/i;
  const UNIT_RE = /^(.*?)(\s*(?:c\/o|C\/O|att\.|Att\.)\s+.*)$/;
  const UNIT_RE2 = /^(.*?),\s*(.*(?:sal|sal\.|st\.|st\b|suite|lejl|lejlighed|floor|etage|tv\b|th\b|mf\b).*)$/i;
  const UNIT_RE3 = /^(.*?),\s*((?:\d+\.\s*\w{0,3}|\w{1,3}\.\s*\w{1,3}))$/i;
  const clean = value => String(value == null ? '' : value).trim();
  // 去掉 DK- 等国家前缀；纯数字邮编只保留数字，其他国家的字母邮编保持原样。
  const zip = value => {
    const raw = clean(value).replace(/^(?:DK)-?\s*/i, '');
    if (!raw) return '未提供';
    return /^[0-9\s]+$/.test(raw) ? raw.replace(/[^0-9]/g, '') : raw;
  };

  // 只处理丹麦注册证书（含 certifies and attests）；其他证书返回 null，避免误切分。
  function parseText(text) {
    const L = String(text || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const at = L.findIndex(line => /certifies and attests/i.test(line));
    if (at < 0) return null;
    let name = '', street = '', unit = '', postal = '', city = '', legal = '';
    let block = [];
    for (let i = at + 1; i < L.length; i++) {
      const line = L[i];
      const match = /^(?:DK-)?(\d{4})\s+(.+)$/.exec(line);
      if (match) { postal = match[1]; city = match[2].trim(); break; }
      if (/^with cvr/i.test(line) || /CVR number/i.test(line)) break;
      block.push(line);
    }
    if (!postal) {
      for (let i = at + 1; i < L.length; i++) {
        const match = /^(?:DK-)?(\d{4})\s+(.+)$/.exec(L[i]);
        if (match) { postal = match[1]; city = match[2].trim(); block = L.slice(Math.max(at + 1, i - 3), i); break; }
      }
    }
    if (block.length >= 2) {
      name = block[0];
      street = block[1];
      let rest = block.slice(2);
      if (!/\d/.test(street)) {
        const candidate = block.slice(1).find(line => /\d/.test(line));
        if (candidate) { street = candidate; rest = block.slice(1).filter(line => line !== candidate); }
      }
      for (const line of rest) {
        if (/^(?:c\/o|C\/O|att\.|Att\.)\b/.test(line) || /^(?:sal|sal\.|st\.|suite|lejl|lejlighed|floor|etage|tv|th|mf)\b/i.test(line)) unit = line;
      }
    } else if (block.length === 1) name = block[0];
    for (const line of L) { const match = LEGAL_RE.exec(line); if (match) { legal = match[1].trim(); break; } }
    if (street) {
      let match = UNIT_RE.exec(street);
      if (match) { street = match[1].trim(); unit = match[2].trim(); }
      else if ((match = UNIT_RE2.exec(street))) { street = match[1].trim(); unit = match[2].trim(); }
      else if ((match = UNIT_RE3.exec(street))) { street = match[1].trim(); unit = match[2].trim(); }
    }
    if (!name || !postal) return null;
    return { name, legal_name: legal || name, address: street, apt: unit, zip: postal, city, type: '组织' };
  }

  function fields(item = {}) {
    const name = clean(item.name);
    const legal = clean(item.legal_name) || name;
    const values = {
      '资料类型': '组织',
      '组织名称': name || '未提供',
      '法定名称': legal || '未提供',
      '街道地址': clean(item.address) || '未提供',
      '公寓或套房等的门牌号': clean(item.apt) || '未提供',
      '邮编': zip(item.zip),
      '市/区': clean(item.city) || '未提供',
    };
    return LABELS.map(label => [label, values[label]]);
  }

  function text(item) {
    return fields(item).map(([label, value]) => `${label}：${value}`).join('\n');
  }

  function filename(name) {
    return `${String(name || 'license').replace(/\.pdf$/i, '')}_extracted.txt`;
  }

  // 以浮层显示在现有弹窗之上：不调用 WorkbenchUI.dialog.open，避免关闭批量校对。
  function open(item, name, sourceText) {
    document.querySelector('.extract-sheet')?.remove();
    const opener = document.activeElement;
    const rows = fields(parseText(sourceText) || item);
    const empty = rows.slice(1).every(([, value]) => value === '未提供');
    const sheet = document.createElement('div');
    sheet.className = 'extract-sheet';
    sheet.innerHTML = `
      <section class="extract-card" role="dialog" aria-modal="true" aria-labelledby="extract-title">
        <div class="extract-head"><div><span class="license-eyebrow">营业执照提取</span><h3 id="extract-title">提取结果</h3><p class="extract-file" id="extract-file"></p></div><button type="button" class="icon-btn" data-extract-close aria-label="关闭提取结果">✕</button></div>
        <div class="extract-body">
          <p class="license-help" id="extract-status" role="status" aria-live="polite">点击字段即可复制对应内容。</p>
          ${empty ? '<p class="license-help">没有从这份 PDF 读到文字，可能是扫描件；请换可复制文字的 PDF。</p>' : ''}
          <table class="detail-table"><tbody>${rows.map(([label, value]) => `<tr><th>${esc(label)}</th><td>${value === '未提供' ? '<span class="license-value-empty">未提供</span>' : `<button type="button" class="license-value-copy" data-extract-copy="${esc(value)}" aria-label="复制${esc(label)}">${esc(value)}<span aria-hidden="true">复制</span></button>`}</td></tr>`).join('')}</tbody></table>
        </div>
        <div class="extract-foot"><button type="button" class="btn btn-primary" data-extract-all>复制全部</button><button type="button" class="btn btn-ghost" data-extract-txt>下载 txt</button><span class="grow"></span><button type="button" class="btn btn-ghost" data-extract-close>关闭</button></div>
      </section>`;
    let dismissed = false;
    const onKey = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      sheet.remove();
      document.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
    document.getElementById('modal-root')?.appendChild(sheet);
    if (!sheet.isConnected) document.body.appendChild(sheet);
    const status = sheet.querySelector('#extract-status');
    const file = sheet.querySelector('#extract-file');
    if (name) file.textContent = name; else file.remove();

    const say = message => { if (status?.isConnected) status.textContent = message; };
    sheet.querySelectorAll('[data-extract-copy]').forEach(button => {
      button.onclick = async () => {
        const ok = await copyText(button.dataset.extractCopy, { quiet: true });
        say(ok ? `已复制${button.closest('tr').querySelector('th').textContent}` : '复制失败，请选中文字后复制');
      };
    });
    sheet.querySelector('[data-extract-all]').onclick = async () => {
      const ok = await copyText(text(parseText(sourceText) || item), { quiet: true });
      say(ok ? '已复制全部字段' : '复制失败，请选中文字后复制');
    };
    sheet.querySelector('[data-extract-txt]').onclick = () => download(filename(name), text(parseText(sourceText) || item));
    sheet.querySelectorAll('[data-extract-close]').forEach(button => { button.onclick = dismiss; });
    sheet.onmousedown = event => { if (event.target === sheet) dismiss(); };
    sheet.querySelector('[aria-label="关闭提取结果"]').focus({ preventScroll: true });
    document.addEventListener('keydown', onKey, true);
    return sheet;
  }

  return Object.freeze({ fields, text, filename, parseText, open });
})();

if (typeof module !== 'undefined') module.exports = globalThis.WorkbenchLicenseExtract;
