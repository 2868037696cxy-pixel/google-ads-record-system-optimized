'use strict';

/* ============ 工具 ============ */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(path, opts = {}) {
  const hasBody = opts.body !== undefined;
  const headers = { ...(opts.headers || {}) };
  if (hasBody) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      ...opts, headers,
      signal: opts.signal || AbortSignal.timeout(20000),
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('连接超时，请稍后重试');
    if (error.name === 'AbortError') throw error;
    throw new Error('无法连接本地服务，请重新连接或重启工作台');
  }
  const data = await res.json().catch(() => { throw new Error('服务响应异常，请重新连接'); });
  if (!res.ok) throw new Error(data.message || data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'ok' ? '' : type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = msg;
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, type === 'error' ? 4200 : 2600);
}

// 导入结果中重复项的提示文案：跳过 N 条（列出前几个具体值）
function dupNote(res) {
  if (!res || !res.skipped) return '';
  const list = (res.duplicates || []).slice(0, 3).join('、');
  const more = res.skipped > 3 ? ` 等 ${res.skipped} 条` : '';
  return `，跳过重复 ${res.skipped} 条（${list}${more}）`;
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制到剪贴板');
}

function download(filename, text, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

function todayKey() {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).formatToParts(new Date());
  return `${parts.find((p) => p.type === 'month').value}.${parts.find((p) => p.type === 'day').value}`;
}

function fmtCard(num) {
  return num ? num.replace(/^(.{6})(.+?)(.{4})$/, '$1 $2 $3') : '';
}

function poolCount(kind, status = '未使用') {
  return state.pools[kind].filter((x) => x.status === status).length;
}

// 解析「起始编号」输入：支持纯数字（如 6）或完整指纹名（如 10.8ads6）
// 纯数字 → 前缀取今日日期 + "ads"，序号为该数字
// 完整指纹名 → 提取末尾数字为序号，前面的部分为前缀
function parseFpStart(input) {
  const raw = String(input || '').trim();
  const dk = todayKey();
  const defaultPrefix = `${dk}ads`;
  if (!raw) return { prefix: defaultPrefix, seq: state.next?.seq || 1, display: defaultPrefix + (state.next?.seq || 1) };
  if (/^\d+$/.test(raw)) {
    const seq = parseInt(raw, 10);
    return { prefix: defaultPrefix, seq, display: defaultPrefix + seq };
  }
  const m = raw.match(/^(.+?)(\d+)$/);
  if (m) {
    return { prefix: m[1], seq: parseInt(m[2], 10), display: raw };
  }
  // 没有数字结尾，当作纯前缀，序号自动取下一个
  return { prefix: raw, seq: state.next?.seq || 1, display: raw + (state.next?.seq || 1) };
}

/* ============ 状态 ============ */

const KINDS = [
  { key: 'emails', label: '邮箱库', ico: '✉' },
  { key: 'proxies', label: '代理库', ico: '⇅' },
  { key: 'cards', label: '信用卡库', ico: '▤' },
  { key: 'licenses', label: '营业执照', ico: '§' },
];

const state = {
  page: 'workbench',
  pools: { emails: [], proxies: [], cards: [], licenses: [] },
  records: [],
  next: null,
  reveal: false,
  sel: new Set(),
  q: '',
  rstatus: '全部',
  poolQ: '',
  poolStatus: '全部',
  picked: { emails: new Set(), cards: new Set(), licenses: new Set() },
  form: { country: '', product: '', domains: '', start_seq: '', ip_reg_time: '', id_card: '', proxy_mode: 'shared', proxy_id: '' },
  loaded: false,
  creating: false,
  recordPage: 1,
  poolPage: 1,
};

const MASK = '••••••';

function sens(value) {
  if (state.reveal) return esc(value);
  if (!value) return '<span class="faint">—</span>';
  return `<span class="masked">${MASK}</span>`;
}

/* ============ 弹窗 ============ */

let modalOpener = null;

function openModal(html, { large = false } = {}) {
  closeModal();
  modalOpener = document.activeElement;
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-overlay" data-action="modal-overlay">
    <div class="modal ${large ? 'modal-lg' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">
      ${html}
    </div>
  </div>`;
  const title = root.querySelector('h3');
  if (title) title.id = 'modal-title';
  const focus = root.querySelector('input:not([type=file]):not([type=checkbox]), textarea, select') || root.querySelector('button') || root.querySelector('.modal');
  focus.focus();
  document.addEventListener('keydown', escListener);
}

function escListener(e) {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Tab') {
    const modal = document.querySelector('#modal-root .modal');
    if (!modal) return;
    const inputs = [...modal.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter((input) => !input.disabled && input.getClientRects().length);
    if (!inputs.length) { e.preventDefault(); modal.focus(); return; }
    const first = inputs[0]; const last = inputs.at(-1);
    if (e.shiftKey && (document.activeElement === first || document.activeElement === modal)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || document.activeElement === modal)) { e.preventDefault(); first.focus(); }
  }
}

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
  document.removeEventListener('keydown', escListener);
  if (modalOpener?.isConnected) modalOpener.focus();
  modalOpener = null;
}

function confirmModal(title, text, onOk, okLabel = '确认删除') {
  openModal(`
    <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" data-action="close-modal">✕</button></div>
    <div class="modal-body"><p style="margin:0;line-height:1.8;color:var(--muted)">${text}</p></div>
    <div class="modal-foot">
      <span class="grow"></span>
      <button class="btn btn-ghost" data-action="close-modal">取消</button>
      <button class="btn btn-danger" id="confirm-ok-btn">${esc(okLabel)}</button>
    </div>`);
  const confirm = document.getElementById('confirm-ok-btn');
  confirm.onclick = async () => {
    if (confirm.disabled) return;
    confirm.disabled = true;
    try {
      await onOk();
      if (confirm.isConnected) closeModal();
    } catch (err) {
      toast(err.message || '操作失败', 'error');
      confirm.disabled = false;
    }
  };
}

/* ============ 骨架渲染 ============ */

function renderNav() {
  const main = [{ key: 'workbench', label: '工作台', ico: '◧', count: state.records.length }];
  const pools = KINDS.map((k) => ({ key: k.key, label: k.label, ico: k.ico, count: state.pools[k.key].length }));
  const item = (it) => `<button class="nav-item ${state.page === it.key ? 'active' : ''}" data-action="nav" data-page="${it.key}">
        <span class="ico">${it.ico}</span>${it.label}
        <span class="count">${it.count}</span>
      </button>`;
  document.getElementById('nav').innerHTML = `
    <div class="nav-label">总览</div>
    ${main.map(item).join('')}
    <div class="nav-label">资源库</div>
    ${pools.map(item).join('')}
  `;
  document.getElementById('revealLabel').textContent = state.reveal ? '敏感信息：显示中' : '敏感信息：已隐藏';
  document.querySelector('.dot-eye').classList.toggle('on', state.reveal);
}

function render() {
  renderNav();
  if (state.page === 'workbench') { renderWorkbench(); refreshSelectionUI(); }
  else renderPool(state.page);
}

async function refresh() {
  const data = await api('/api/bootstrap');
  if (!data?.pools || !Array.isArray(data.records) || !data.next || !KINDS.every((k) => Array.isArray(data.pools[k.key]))) {
    throw new Error('数据格式不正确，请检查备份或重启工作台');
  }
  state.pools = data.pools;
  state.records = data.records;
  const recordIds = new Set(data.records.map((record) => record.id));
  state.sel = new Set([...state.sel].filter((id) => recordIds.has(id)));
  for (const kind of Object.keys(state.picked)) {
    const available = new Set(data.pools[kind].filter((item) => item.status === '未使用').map((item) => item.id));
    state.picked[kind] = new Set([...state.picked[kind]].filter((id) => available.has(id)));
  }
  if (state.form.proxy_id && !data.pools.proxies.some((proxy) => String(proxy.id) === String(state.form.proxy_id) && proxy.status !== '停用')) state.form.proxy_id = '';
  state.next = data.next;
  state.loaded = true;
  if (!state.form.start_seq) state.form.start_seq = data.next.seq;
  render();
  bindLabels();
  const connection = document.getElementById('connectionStatus');
  if (connection) { connection.textContent = '本地服务已连接'; connection.className = 'connection-status connected'; }
}

/* ============ 工作台 ============ */

function renderWorkbench() {
  const f = state.form;
  const main = document.getElementById('main');
  const domains = f.domains.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const count = domains.length || 0;
  const fp = parseFpStart(f.start_seq);
  const fpPreview = count > 0
    ? (count === 1 ? `${fp.prefix}${fp.seq}` : `${fp.prefix}${fp.seq} ~ ${fp.prefix}${fp.seq + count - 1}`)
    : `${fp.prefix}${fp.seq}`;

  const avail = {
    emails: poolCount('emails'),
    cards: poolCount('cards'),
    licenses: poolCount('licenses'),
  };

  const assignInfo = (kind, label) => {
    const picked = state.picked[kind];
    if (picked.size) return `<b>已选 ${picked.size} 项</b> · 手动指定`;
    return `自动分配 · 可用 <b>${avail[kind]}</b> 条`;
  };

  const proxyOptions = [`<option value="">共享上次使用的代理</option>`]
    .concat(
      state.pools.proxies
        .map(
          (p) => `<option value="${p.id}" ${String(f.proxy_id) === String(p.id) ? 'selected' : ''} ${p.status === '停用' ? 'disabled' : ''}>${esc(
            `${p.host ? p.host + ':' + p.port : '未设置主机'} · ${p.sn || '无编号'}${p.country ? ' · ' + p.country : ''}（${p.status}）`
          )}</option>`
        )
        .join('')
    )
    .join('');

  const proxyModeExtra = (fm) => {
    if (fm.proxy_mode === 'shared') {
      return `<select id="f-proxy">${proxyOptions}</select>`;
    }
    if (fm.proxy_mode === 'auto') {
      return `<span class="mini">每条记录从代理库按顺序取一个 · 可用 <b>${poolCount('proxies')}</b> 条</span>`;
    }
    return `<span class="mini">记录中代理字段留空</span>`;
  };

  const filtered = getFilteredRecords();

  const todayCN = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>工作台</h1>
        <p class="sub">指纹名称按今日日期自动生成，资源按状态分组、自动分配</p>
      </div>
      <div class="head-actions">
        <button class="btn btn-primary" data-action="open-auto-import">⚡ 智能导入</button>
        <span class="date-chip"><span class="dot"></span>今天 · ${todayCN}</span>
      </div>
    </div>

    <div class="hstats">
      <div class="hstat hi">
        <span class="v">${state.records.length}</span>
        <span class="k"><span class="dot lime"></span>记录总数</span>
      </div>
      <div class="hstat">
        <span class="v">${avail.emails}<em>/ ${state.pools.emails.length}</em></span>
        <span class="k"><span class="dot green"></span>可用邮箱</span>
      </div>
      <div class="hstat">
        <span class="v">${avail.cards}<em>/ ${state.pools.cards.length}</em></span>
        <span class="k"><span class="dot blue"></span>可用信用卡</span>
      </div>
      <div class="hstat">
        <span class="v">${avail.licenses}<em>/ ${state.pools.licenses.length}</em></span>
        <span class="k"><span class="dot amber"></span>可用营业执照</span>
      </div>
      <div class="hstat">
        <span class="v">${poolCount('proxies')}<em>/ ${state.pools.proxies.length}</em></span>
        <span class="k"><span class="dot"></span>可用代理</span>
      </div>
    </div>

    ${
      state.records.length === 0
        ? `<div class="panel"><div class="panel-body"><div class="steps">
            ${[
              { n: '01', t: '导入邮箱', d: '支持「账号——密码——2FA」格式，一行一个，自动拆分入库', k: 'emails' },
              { n: '02', t: '导入代理', d: '粘贴代理商文本块，自动提取 IP、端口、编号、账号密码', k: 'proxies' },
              { n: '03', t: '导入信用卡', d: '「卡号 有效期 CVV」一行一张，导入后自动按状态分组', k: 'cards' },
              { n: '04', t: '创建记录', d: '回到本页填写国家/产品/域名，指纹名称按今天日期自动生成', k: '' },
            ]
              .map(
                (s) => `<div class="step-card" ${s.k ? `data-action="nav" data-page="${s.k}"` : ''}>
                  <span class="n">STEP ${s.n}</span><h4>${s.t}</h4><p>${s.d}</p>
                </div>`
              )
              .join('')}
          </div></div></div>`
        : ''
    }

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">快速创建 <span class="tag">指纹名称自动生成</span></div>
        <span class="dim" style="font-size:12px">域名一行一个，每行创建一条记录；邮箱 / 信用卡 / 营业执照自动按顺序分配并标记已使用</span>
      </div>
      <div class="panel-body">
        <form id="createForm" class="form-grid" autocomplete="off">
          <div class="field col-3">
            <label>国家 <span class="mini">如：奥地利</span></label>
            <input id="f-country" value="${esc(f.country)}" placeholder="奥地利">
          </div>
          <div class="field col-3">
            <label>产品 <span class="mini">如：呼吸机</span></label>
            <input id="f-product" value="${esc(f.product)}" placeholder="呼吸机">
          </div>
          <div class="field col-2">
            <label>指纹起始 <span class="mini">数字或全名，如 6 或 10.8ads6</span></label>
            <input id="f-start" class="mono" value="${esc(f.start_seq)}" placeholder="${todayKey()}ads1">
          </div>
          <div class="field col-2">
            <label>IP注册时间</label>
            <input id="f-ipreg" type="date" value="${esc(f.ip_reg_time)}">
          </div>
          <div class="field col-2">
            <label>身份证 <span class="mini">选填</span></label>
            <input id="f-idcard" value="${esc(f.id_card)}" placeholder="选填">
          </div>
          <div class="field col-6">
            <label>域名 <span class="mini">一行一个，如 nfjh.shop；名称将自动拼成「国家-产品-域名前缀」</span></label>
            <textarea id="f-domains" class="mono" rows="4" placeholder="nfjh.shop&#10;mkxd.shop&#10;wnfh.shop">${esc(f.domains)}</textarea>
          </div>
          <div class="field col-6">
            <label>资源分配 <span class="mini">点击「选择」可手动指定，否则自动从未使用中按顺序取用</span></label>
            <div style="display:flex;flex-direction:column;gap:8px">
              <div class="assign-row">
                <span class="assign-info">✉ 谷歌邮箱：<span id="info-emails">${assignInfo('emails')}</span></span>
                <button type="button" class="btn btn-ghost btn-sm" data-action="open-picker" data-kind="emails">选择</button>
              </div>
              <div class="assign-row">
                <span class="assign-info">▤ 信用卡：<span id="info-cards">${assignInfo('cards')}</span></span>
                <button type="button" class="btn btn-ghost btn-sm" data-action="open-picker" data-kind="cards">选择</button>
              </div>
              <div class="assign-row">
                <span class="assign-info">§ 营业执照：<span id="info-licenses">${assignInfo('licenses')}</span></span>
                <button type="button" class="btn btn-ghost btn-sm" data-action="open-picker" data-kind="licenses">选择</button>
              </div>
              <div class="assign-row">
                <span class="assign-info">⇅ 代理：
                  <select id="f-proxy-mode" style="flex:0 0 auto">
                    <option value="shared" ${f.proxy_mode === 'shared' ? 'selected' : ''}>共享一个</option>
                    <option value="auto" ${f.proxy_mode === 'auto' ? 'selected' : ''}>自动分配</option>
                    <option value="none" ${f.proxy_mode === 'none' ? 'selected' : ''}>不使用</option>
                  </select>
                  <span id="proxy-mode-extra" style="flex:1">${proxyModeExtra(f)}</span>
                </span>
              </div>
            </div>
          </div>
        </form>
        <div class="create-preview">
          <span>本次将创建 <b>${count || 0}</b> 条记录，指纹名称：<span class="fp">${esc(fpPreview)}</span>
            ${count > avail.emails ? `<span class="warn">⚠ 邮箱仅剩 ${avail.emails} 条</span>` : ''}
            ${count > avail.cards ? `<span class="warn">⚠ 信用卡仅剩 ${avail.cards} 张</span>` : ''}
          </span>
          <button class="btn btn-primary" data-action="create" ${count === 0 || count > 500 || state.creating ? 'disabled' : ''}>${state.creating ? '创建中' : `立即创建 ${count > 0 ? count + ' 条' : ''}`}</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">创建记录</div>
      </div>
      <div class="toolbar">
        <input class="search" id="rec-q" aria-label="搜索记录" placeholder="搜索 指纹 / 名称 / 域名 / 邮箱 / 卡号…" value="${esc(state.q)}">
        <div class="tabs">
          ${['全部', '正常', '异常', '停用'].map((s) => `<button class="tab ${state.rstatus === s ? 'active' : ''}" data-action="rstatus" data-v="${s}">${s}</button>`).join('')}
        </div>
        <span class="sel-count">已选 <b>${state.sel.size}</b> 条</span>
        <span class="toolbar-spacer"></span>
        <button class="btn btn-ghost btn-sm" data-action="export-adspower">导出 AdsPower TXT</button>
        <button class="btn btn-ghost btn-sm" data-action="export-csv">导出 CSV</button>
        <button class="btn btn-danger btn-sm" data-action="delete-selected" ${state.sel.size === 0 ? 'disabled' : ''}>删除所选</button>
      </div>
      ${renderRecordsTable(filtered)}
    </div>
  `;
}

function getFilteredRecords() {
  const q = state.q.trim().toLowerCase();
  return state.records.filter((r) => {
    if (state.rstatus !== '全部' && r.status !== state.rstatus) return false;
    if (!q) return true;
    return [r.fingerprint, r.name, r.domain, r.email_user, r.card_number, r.license_name, r.proxy_host, r.proxy_sn]
      .some((v) => String(v || '').toLowerCase().includes(q));
  });
}

function paginate(items, kind) {
  const key = kind === 'records' ? 'recordPage' : 'poolPage';
  const pages = Math.max(1, Math.ceil(items.length / 50));
  state[key] = Math.max(1, Math.min(state[key], pages));
  return { items: items.slice((state[key] - 1) * 50, state[key] * 50), total: items.length, page: state[key], pages };
}

function renderPagination(kind, page) {
  if (page.total <= 50) return '';
  return `<div class="table-pagination"><span role="status">共 ${page.total} 条 · 第 ${page.page} / ${page.pages} 页 · 每页 50 条</span><div>
    <button class="btn btn-ghost btn-sm" data-action="table-page" data-kind="${kind}" data-page="${page.page - 1}" ${page.page <= 1 ? 'disabled' : ''}>上一页</button>
    <button class="btn btn-ghost btn-sm" data-action="table-page" data-kind="${kind}" data-page="${page.page + 1}" ${page.page >= page.pages ? 'disabled' : ''}>下一页</button>
  </div></div>`;
}

function renderRecordsTable(list) {
  if (!state.records.length) {
    return `<div class="empty">
      <div class="empty-ico">◧</div>
      <h3>还没有创建记录</h3>
      <p>先在上方导入资源，然后填写国家 / 产品 / 域名，点击「立即创建」即可</p>
    </div>`;
  }
  if (!list.length) {
    return `<div class="empty"><div class="empty-ico">⌕</div><h3>没有匹配的记录</h3><p>换个关键词或筛选条件试试</p></div>`;
  }
  const page = paginate(list, 'records');
  list = page.items;
  const allChecked = list.length && list.every((r) => state.sel.has(r.id));
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th style="width:34px"><input type="checkbox" data-action="sel-all" aria-label="全选当前页" ${allChecked ? 'checked' : ''}></th>
      <th>指纹名称</th><th>名称</th><th>域名</th><th>谷歌邮箱</th><th>邮箱密码</th><th>2FA</th>
      <th>代理</th><th>信用卡</th><th>IP注册时间</th><th>营业执照</th><th>身份证</th>
      <th>状态</th><th style="width:110px">操作</th>
    </tr></thead>
    <tbody>
      ${list
        .map((r, i) => {
          const proxy = r.proxy_host
            ? `${esc(r.proxy_host)}:${esc(r.proxy_port)}<br><span class="faint mono">${esc(r.proxy_sn || '')}${r.proxy_country ? ' · ' + esc(r.proxy_country) : ''}${r.proxy_ip ? ' · ' + esc(r.proxy_ip) : ''}</span>`
            : '<span class="faint">—</span>';
          const card = r.card_number
            ? `${sens(r.card_number)}<br><span class="faint mono">${esc(r.card_expiry || '')}${r.card_cvv ? ' · ' + sens(r.card_cvv) : ''}</span>`
            : '<span class="faint">—</span>';
          return `<tr class="${state.sel.has(r.id) ? 'selected' : ''}" data-id="${r.id}" style="--i:${i}">
            <td><input type="checkbox" data-action="sel-row" data-id="${r.id}" ${state.sel.has(r.id) ? 'checked' : ''}></td>
            <td class="mono cell-fp copyable" data-copy="${esc(r.fingerprint)}" title="点击复制">${esc(r.fingerprint)}</td>
            <td class="cell-name">${esc(r.name)}</td>
            <td class="mono copyable" data-copy="${esc(r.domain)}" title="点击复制">${esc(r.domain) || '<span class="faint">—</span>'}</td>
            <td class="mono copyable" data-copy="${esc(r.email_user)}" title="点击复制">${esc(r.email_user) || '<span class="faint">—</span>'}</td>
            <td class="mono copyable" data-copy="${esc(r.email_pass)}" title="点击复制">${sens(r.email_pass)}</td>
            <td class="mono copyable" data-copy="${esc(r.email_fakey)}" title="点击复制">${sens(r.email_fakey)}</td>
            <td class="mono copyable" data-sensitive="${Boolean(r.proxy_user || r.proxy_pass)}" data-copy="${esc(r.proxy_host ? `${r.proxy_host}:${r.proxy_port}:${r.proxy_user}:${r.proxy_pass}` : '')}" title="点击复制完整代理">${proxy}</td>
            <td class="mono copyable" data-copy="${esc(r.card_number ? `${r.card_number} ${r.card_expiry} ${r.card_cvv}` : '')}" title="点击复制完整卡号">${card}</td>
            <td class="dim">${esc(r.ip_reg_time) || '<span class="faint">—</span>'}</td>
            <td>${r.license_id ? `<button class="license-link" data-action="view-license" data-id="${r.license_id}">${esc(r.license_name)}</button>` : '<span class="faint">—</span>'}</td>
            <td class="dim">${esc(r.id_card) || '<span class="faint">—</span>'}</td>
            <td>
              <select class="status-select ${r.status === '正常' ? 's-green' : r.status === '异常' ? 's-red' : 's-blue'}" data-action="rec-status" data-id="${r.id}">
                ${['正常', '异常', '停用'].map((s) => `<option ${r.status === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </td>
            <td><div class="row-actions">
              <button class="icon-btn" data-action="edit-record" data-id="${r.id}">编辑</button>
              <button class="icon-btn danger" data-action="del-record" data-id="${r.id}">删除</button>
            </div></td>
          </tr>`;
        })
        .join('')}
    </tbody>
  </table></div>${renderPagination('records', page)}`;
}

async function doCreate() {
  if (state.creating) return;
  const domains = state.form.domains.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!domains.length) return toast('请至少填写一个域名', 'warn');
  if (domains.length > 500) return toast('单次最多创建 500 条记录，请分批创建', 'warn');
  state.creating = true;
  const btn = document.querySelector('[data-action="create"]');
  const oldText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); btn.textContent = '创建中'; }
  const fp = parseFpStart(state.form.start_seq);
  const body = {
    country: state.form.country,
    product: state.form.product,
    domains,
    start_seq: fp.seq,
    fp_prefix: fp.prefix,
    date_key: todayKey(),
    ip_reg_time: state.form.ip_reg_time,
    id_card: state.form.id_card,
    proxy_mode: state.form.proxy_mode,
    proxy_id: state.form.proxy_mode === 'shared' && state.form.proxy_id ? Number(state.form.proxy_id) : undefined,
    email_ids: [...state.picked.emails].map(Number),
    card_ids: [...state.picked.cards].map(Number),
    license_ids: [...state.picked.licenses].map(Number),
  };
  try {
    const res = await api('/api/records', { method: 'POST', body });
    const list = res.created;
    toast(`✅ 已创建 ${list.length} 条记录：${list[0].fingerprint}${list.length > 1 ? ' ~ ' + list[list.length - 1].fingerprint : ''}`);
    state.picked = { emails: new Set(), cards: new Set(), licenses: new Set() };
    state.form.domains = '';
    state.form.start_seq = `${fp.prefix}${list[list.length - 1].seq + 1}`;
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = oldText; }
  } finally {
    state.creating = false;
    updateCreatePreview();
  }
}

/* ============ 资源库页面 ============ */

const POOL_TABLE = {
  emails: {
    cols: ['ID', '谷歌邮箱', '邮箱密码', '2FA', '状态', '导入时间', '操作'],
    widths: ['60px', '260px', '150px', '170px', '100px', '170px', '70px'],
    row: (e) => [
      `<span class="faint mono">${e.id}</span>`,
      `<span class="mono copyable" data-copy="${esc(e.user)}" title="点击复制">${esc(e.user)}</span>`,
      `<span class="mono copyable" data-copy="${esc(e.pass)}" title="点击复制">${sens(e.pass)}</span>`,
      `<span class="mono copyable" data-copy="${esc(e.fakey)}" title="点击复制">${sens(e.fakey)}</span>`,
    ],
  },
  proxies: {
    cols: ['ID', '编号', '类型', '主机', '端口', '代理账号', '代理密码', '国家', '出口IP', '状态', '导入时间', '操作'],
    widths: ['55px', '75px', '75px', '200px', '65px', '120px', '120px', '90px', '130px', '95px', '160px', '65px'],
    row: (p) => [
      `<span class="faint mono">${p.id}</span>`,
      `<span class="mono copyable" data-copy="${esc(p.sn)}" title="点击复制">${esc(p.sn) || '<span class="faint">—</span>'}</span>`,
      `<span class="pill pill-amber"><span class="dot"></span>${esc(p.type || 'socks5')}</span>`,
      `<span class="mono copyable" data-copy="${esc(p.host)}" title="点击复制">${esc(p.host)}</span>`,
      `<span class="mono copyable" data-copy="${esc(p.port)}" title="点击复制">${esc(p.port)}</span>`,
      `<span class="mono copyable" data-copy="${esc(p.user)}" title="点击复制">${sens(p.user)}</span>`,
      `<span class="mono copyable" data-copy="${esc(p.pass)}" title="点击复制">${sens(p.pass)}</span>`,
      `<span class="dim copyable" data-copy="${esc(p.country)}" title="点击复制">${esc(p.country) || '<span class="faint">—</span>'}</span>`,
      `<span class="mono copyable" data-copy="${esc(p.ip)}" title="点击复制">${esc(p.ip) || '<span class="faint">—</span>'}</span>`,
    ],
  },
  cards: {
    cols: ['ID', '卡号', '有效期', 'CVV', '状态', '导入时间', '操作'],
    widths: ['60px', '220px', '90px', '80px', '100px', '170px', '70px'],
    row: (c) => [
      `<span class="faint mono">${c.id}</span>`,
      `<span class="mono copyable" data-copy="${esc(c.number)}" title="点击复制">${sens(c.number)}</span>`,
      `<span class="mono copyable" data-copy="${esc(c.expiry)}" title="点击复制">${esc(c.expiry) || '<span class="faint">—</span>'}</span>`,
      `<span class="mono copyable" data-copy="${esc(c.cvv)}" title="点击复制">${sens(c.cvv)}</span>`,
    ],
  },
  licenses: {
    cols: ['ID', '公司名称', '法定名称', '城市', '邮编', '状态', '导入时间', '操作'],
    widths: ['60px', '240px', '240px', '110px', '75px', '95px', '160px', '65px'],
    row: (l) => [
      `<span class="faint mono">${l.id}</span>`,
      `<span class="copyable link" data-action="view-license" data-id="${l.id}" title="点击查看详情">${esc(l.name)}</span>`,
      `<span class="copyable" data-copy="${esc(l.legal_name || '')}" title="点击复制">${esc(l.legal_name) || '<span class="faint">—</span>'}</span>`,
      `<span class="copyable" data-copy="${esc(l.city || '')}" title="点击复制">${esc(l.city) || '<span class="faint">—</span>'}</span>`,
      `<span class="copyable" data-copy="${esc(l.zip || '')}" title="点击复制">${esc(l.zip) || '<span class="faint">—</span>'}</span>`,
    ],
  },
};

const POOL_FORMAT = {
  emails: `一行一条，分隔符支持 ——、—、–、|、Tab、:、;、,、空格；也支持「标签：值」形式（顺序任意）
NewkirkCorre.l103@gmail.com——psj5qrajyv——ucyar7gltohvnnxbpxt4vmsdrcaxa5j6
vanmaih.uynh75@gmail.com|Y2IvBdZRN2|54viszzfxqzxuowp57ma2sw7euael6x5
demo@gmail.com:pass123:2fakey
邮箱：demo2@gmail.com 密码：abc12345 2FA：JBSWY3DPEHPK3PXP`,
  proxies: `代理商文本块（账号/密码/主机/端口/国家等标签行，中英文均可、顺序任意）：
5750389
socks5
55.kookeey.info
26004
账号：437d8679
密码：547be5d2
修改
US-美国
217.20.243.226

也支持一行一条：
socks5://user:pass@host:port
user:pass@host:port
host:port:user:pass
user:pass:host:port
host,port,user,pass
host port user pass`,
  cards: `4367970152619097 06/29 596
4367970159932238 06/29 364
4367970169748392 06/29 786`,
  licenses: `一个 PDF 对应一条营业执照记录。
选择 PDF 后校对公司名称、法定名称、地址、邮编和城市，再确认保存。
未识别的字段可手动填写，原 PDF 会与该条资料一起保存。`,
};

function getFilteredPool(kind) {
  const q = state.poolQ.trim().toLowerCase();
  return [...state.pools[kind]].sort((a, b) => b.id - a.id).filter((item) => {
    if (state.poolStatus !== '全部' && item.status !== state.poolStatus) return false;
    return !q || Object.values(item).some((value) => String(value ?? '').toLowerCase().includes(q));
  });
}

function renderPoolTable(kind, list) {
  const conf = KINDS.find((item) => item.key === kind);
  const table = POOL_TABLE[kind];
  if (!state.pools[kind].length) return `<div class="empty">
    <div class="empty-ico">⇩</div><h3>还没有${conf.label}数据</h3>
    <p>${kind === 'licenses' ? '点击右上角「导入营业执照」，上传一份 PDF 并校对资料。' : '点击右上角「批量导入」，支持粘贴以下格式（一行一条）：'}</p>
    <code>${esc(POOL_FORMAT[kind])}</code></div>`;
  if (!list.length) return '<div class="empty"><div class="empty-ico">⌕</div><h3>没有匹配的资源</h3><p>换个关键词或筛选条件试试</p></div>';
  const page = paginate(list, 'pools');
  const reference = { emails: 'email_id', proxies: 'proxy_id', cards: 'card_id', licenses: 'license_id' }[kind];
  const linkedIds = new Set(state.records.map((record) => record[reference]));
  return `<div class="table-wrap"><table class="pool-table">
    <colgroup>${(table.widths || []).map((width) => `<col${width ? ` style="width:${width}"` : ''}>`).join('')}</colgroup>
    <thead><tr>${table.cols.map((column) => `<th>${column}</th>`).join('')}</tr></thead><tbody>
    ${page.items.map((item, index) => {
      const statusIndex = table.cols.indexOf('状态');
      const linked = linkedIds.has(item.id);
      const status = `<select aria-label="资源 ${item.id} 状态" class="status-select ${item.status === '未使用' ? 's-green' : item.status === '已使用' ? 's-blue' : 's-red'}" data-action="pool-item-status" data-kind="${kind}" data-id="${item.id}">
        ${['未使用', '已使用', '停用'].map((value) => `<option ${item.status === value ? 'selected' : ''} ${value === '未使用' && linked ? 'disabled' : ''}>${value}</option>`).join('')}</select>`;
      const cells = table.row(item).slice(0, statusIndex).map((cell) => `<td>${cell}</td>`);
      cells.push(`<td>${status}</td>`, `<td class="dim mono" style="font-size:11px">${esc(item.created_at || '')}</td>`, `<td><div class="row-actions"><button class="icon-btn danger" data-action="del-pool" data-kind="${kind}" data-id="${item.id}" ${linked ? 'disabled title="请先在记录中解除关联"' : ''}>删除</button></div></td>`);
      return `<tr style="--i:${index}">${cells.join('')}</tr>`;
    }).join('')}</tbody></table></div>${renderPagination('pools', page)}`;
}

function renderPool(kind) {
  const conf = KINDS.find((item) => item.key === kind);
  const list = getFilteredPool(kind);
  const stat = (label, count, dot) => `<div class="stat"><div class="k"><span class="dot ${dot}"></span>${label}</div><div class="v">${count}</div></div>`;
  document.getElementById('main').innerHTML = `
    <div class="page-head"><div><h1>${conf.label}</h1><p class="sub">统一管理${conf.label}资源，创建记录时自动分配并标记</p></div>
      <div class="head-actions">${kind === 'emails' || kind === 'proxies' ? '<button class="btn btn-ghost" data-action="open-auto-import">⚡ 智能导入</button>' : ''}
        <button class="btn btn-primary" data-action="open-import" data-kind="${kind}">${kind === 'licenses' ? '导入营业执照' : '批量导入'}</button></div></div>
    <div class="stats">${stat('全部', state.pools[kind].length, 'bg')}${stat('未使用', poolCount(kind), 'dot-green-ic')}${stat('已使用', poolCount(kind, '已使用'), 'dot-blue-ic')}${stat('停用', poolCount(kind, '停用'), 'dot-red-ic')}</div>
    <div class="panel"><div class="toolbar">
      <input class="search" id="pool-q" aria-label="搜索资源" placeholder="搜索…" value="${esc(state.poolQ)}">
      <div class="tabs">${['全部', '未使用', '已使用', '停用'].map((status) => `<button class="tab ${state.poolStatus === status ? 'active' : ''}" data-action="pool-status" data-v="${status}">${status}</button>`).join('')}</div>
      <span class="sel-count">${list.length} 条</span></div>${renderPoolTable(kind, list)}</div>`;
}

function renderPoolTableInto() {
  const panel = document.querySelector('#main .panel');
  if (!panel) return;
  const list = getFilteredPool(state.page);
  panel.querySelectorAll('.table-wrap, .empty, .table-pagination').forEach((element) => element.remove());
  panel.insertAdjacentHTML('beforeend', renderPoolTable(state.page, list));
  const count = panel.querySelector('.sel-count');
  if (count) count.textContent = `${list.length} 条`;
}

/* ============ 导入弹窗 ============ */

function bindImportPreview(textarea, button, resultBox, route, onResult) {
  let revision = 0;
  let timer;
  let controller;
  const parse = async () => {
    const current = ++revision;
    controller?.abort();
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
    const text = textarea.value;
    button.disabled = true;
    if (!text.trim()) { resultBox.textContent = '等待粘贴内容…'; return; }
    resultBox.textContent = '正在识别最新内容…';
    try {
      const result = await api(route, { method: 'POST', body: { text }, signal });
      if (current !== revision || !textarea.isConnected || textarea.value !== text) return;
      onResult(result);
    } catch (error) {
      if (current === revision && textarea.isConnected && error.name !== 'AbortError') resultBox.textContent = error.message;
    }
  };
  const invalidate = () => {
    ++revision;
    controller?.abort();
    button.disabled = true;
    resultBox.textContent = textarea.value.trim() ? '正在识别最新内容…' : '等待粘贴内容…';
    clearTimeout(timer);
  };
  textarea.addEventListener('input', () => {
    invalidate();
    timer = setTimeout(parse, 350);
  });
  return { parse, invalidate };
}

async function openImportModal(kind) {
  if (kind === 'licenses') return openLicenseImport();
  const conf = KINDS.find((k) => k.key === kind);
  openModal(`
    <div class="modal-head"><h3>批量导入 · ${conf.label}</h3><button class="modal-close" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <pre class="format-hint">${esc(POOL_FORMAT[kind])}</pre>
      <textarea id="import-text" class="mono" rows="9" style="width:100%" placeholder="粘贴到此处，一行一条…"></textarea>
      <div class="parse-result" id="parse-result">等待粘贴内容…</div>
    </div>
    <div class="modal-foot">
      <span class="grow"></span>
      <button class="btn btn-ghost" data-action="close-modal">取消</button>
      <button class="btn btn-primary" id="import-ok" disabled>确认导入</button>
    </div>`, { large: true });

  const ta = document.getElementById('import-text');
  const resultBox = document.getElementById('parse-result');
  const okBtn = document.getElementById('import-ok');
  let parsed = [];
  let saving = false;
  bindImportPreview(ta, okBtn, resultBox, `/api/parse/${kind}`, (res) => {
    parsed = res.items || [];
    if (!parsed.length) {
      resultBox.innerHTML = '⚠ 未识别到有效内容，请检查格式';
      okBtn.disabled = true;
    } else {
      const preview = parsed
        .slice(0, 5)
        .map((it) => `<li>${esc(Object.values(it).filter(Boolean).join(' · '))}</li>`)
        .join('');
      resultBox.innerHTML = `识别到 <b>${parsed.length}</b> 条${parsed.length > 5 ? '（预览前 5 条）' : ''}<ul class="parse-preview-list">${preview}</ul>`;
      okBtn.disabled = false;
    }
  });

  okBtn.onclick = async () => {
    if (saving || okBtn.disabled || !parsed.length) return;
    saving = true; okBtn.disabled = true; ta.readOnly = true;
    try {
      const res = await api(`/api/import/${kind}`, { method: 'POST', body: { items: parsed } });
      toast(`✅ 导入成功：新增 ${res.added} 条${dupNote(res)}`);
      if (ta.isConnected) closeModal();
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
      okBtn.disabled = false;
    } finally {
      saving = false; ta.readOnly = false;
    }
  };

  ta.focus();
}

/* ============ 智能导入（自动识别邮箱 / 代理） ============ */

function openAutoImport() {
  openModal(`
    <div class="modal-head"><h3>智能导入 · 邮箱 + 代理</h3><button class="modal-close" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <div class="auto-hint">粘贴任意格式，自动识别并拆分（可混合）：<br>
        ① <b>AdsPower 导入 TXT</b>（key=value，星号线分块）<br>
        ② 邮箱：<span class="mono">账号——密码——2FA</span>，分隔符支持 —、|、Tab、冒号、分号、逗号、空格，或「邮箱：xxx 密码：yyy 2FA：zzz」标签形式（顺序任意）<br>
        ③ 一行代理：<span class="mono">socks5://user:pass@host:port</span>、<span class="mono">user:pass@host:port</span>、<span class="mono">host:port:user:pass</span>、<span class="mono">user:pass:host:port</span>、<span class="mono">host,port,user,pass</span> 等<br>
        ④ 代理商多行文本块（账号/密码/主机/端口/国家等标签行，中英文均可）<br>
        识别后邮箱进「邮箱库」、代理进「代理库」，重复自动跳过。</div>
      <div class="auto-toolbar">
        <button type="button" class="btn btn-ghost btn-sm" id="auto-file-btn">选择 TXT 文件</button>
        <input type="file" id="auto-file" accept=".txt,.csv,text/plain" hidden>
        <span class="mini faint" id="auto-file-name"></span>
      </div>
      <textarea id="auto-text" class="mono" rows="9" style="width:100%" placeholder="粘贴 AdsPower TXT / 邮箱 / 代理，任意混合…"></textarea>
      <div class="parse-result" id="auto-result">等待粘贴内容…</div>
    </div>
    <div class="modal-foot">
      <span class="grow"></span>
      <button class="btn btn-ghost" data-action="close-modal">取消</button>
      <button class="btn btn-primary" id="auto-ok" disabled>确认导入</button>
    </div>`, { large: true });

  const ta = document.getElementById('auto-text');
  const resultBox = document.getElementById('auto-result');
  const okBtn = document.getElementById('auto-ok');
  const fileInput = document.getElementById('auto-file');
  const fileName = document.getElementById('auto-file-name');
  let parsed = { emails: [], proxies: [] };
  let saving = false;

  const renderPreview = () => {
    const { emails, proxies } = parsed;
    if (!emails.length && !proxies.length) {
      resultBox.innerHTML = '⚠ 未识别到有效内容，请检查格式';
      okBtn.disabled = true;
      okBtn.textContent = '确认导入';
      return;
    }
    const sec = (title, ico, items, fmt) => (!items.length ? '' : `
      <div class="auto-section">
        <div class="auto-sec-head"><span class="ico">${ico}</span>${title} <b>${items.length}</b> 条${items.length > 5 ? '<span class="mini faint">（预览前 5 条）</span>' : ''}</div>
        <ul class="parse-preview-list">${items.slice(0, 5).map((it) => `<li>${esc(fmt(it))}</li>`).join('')}</ul>
      </div>`);
    resultBox.innerHTML =
      sec('邮箱', '✉', emails, (e) => [e.user, e.pass, e.fakey].filter(Boolean).join(' · ')) +
      sec('代理', '⇅', proxies, (p) => [p.host ? `${p.host}:${p.port}` : '', p.user, p.sn, p.ip].filter(Boolean).join(' · '));
    okBtn.disabled = false;
    okBtn.textContent = `确认导入（邮箱 ${emails.length} · 代理 ${proxies.length}）`;
  };

  const preview = bindImportPreview(ta, okBtn, resultBox, '/api/parse/auto', (result) => {
    parsed = result;
    renderPreview();
  });

  document.getElementById('auto-file-btn').onclick = () => fileInput.click();
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (!f) return;
    preview.invalidate();
    if (f.size > 10 * 1024 * 1024) { resultBox.textContent = '文本文件不能超过 10 MB'; return; }
    okBtn.disabled = true;
    fileName.textContent = f.name;
    const previousText = ta.value;
    const rd = new FileReader();
    rd.onload = () => {
      if (!ta.isConnected || fileInput.files[0] !== f || ta.value !== previousText) return;
      ta.value = String(rd.result || '');
      preview.parse();
    };
    rd.onerror = () => { if (ta.isConnected) resultBox.textContent = '文件读取失败，请重新选择'; };
    rd.readAsText(f);
  });

  okBtn.onclick = async () => {
    if (saving || okBtn.disabled || (!parsed.emails.length && !parsed.proxies.length)) return;
    saving = true; ta.readOnly = true; fileInput.disabled = true;
    document.getElementById('auto-file-btn').disabled = true;
    okBtn.disabled = true;
    try {
      const res = await api('/api/import/auto', { method: 'POST', body: parsed });
      const parts = [];
      if (parsed.emails.length) parts.push(`邮箱 +${res.emails.added}${dupNote(res.emails)}`);
      if (parsed.proxies.length) parts.push(`代理 +${res.proxies.added}${dupNote(res.proxies)}`);
      toast(`✅ 导入成功：${parts.join('，')}`);
      if (ta.isConnected) closeModal();
      await refresh();
    } catch (e) {
      okBtn.disabled = false;
      toast(e.message, 'error');
    } finally {
      saving = false; ta.readOnly = false; fileInput.disabled = false;
      const fileButton = document.getElementById('auto-file-btn');
      if (ta.isConnected && fileButton) fileButton.disabled = false;
    }
  };

  ta.focus();
}

/* ============ 资源选择弹窗 ============ */

function openPicker(kind) {
  const conf = KINDS.find((k) => k.key === kind);
  const picked = state.picked[kind];
  const items = [...state.pools[kind]]
    .sort((a, b) => (a.status === '未使用' ? -1 : 1) - (b.status === '未使用' ? -1 : 1) || a.id - b.id);

  const mainVal = (it) =>
    kind === 'emails' ? `${it.user} · ${it.pass ? '有密码' : '无密码'}` :
    kind === 'cards' ? `${it.number} ${it.expiry}` :
    kind === 'licenses' ? it.name :
    `${it.host}:${it.port} · ${it.sn || ''}`;

  openModal(`
    <div class="modal-head"><h3>选择${conf.label.replace('库', '')} <span class="dim" style="font-size:12px;font-weight:400">（多选，不选则自动分配）</span></h3><button class="modal-close" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <input id="picker-q" placeholder="搜索…" style="width:100%">
      <div class="picker-list" id="picker-list">
        ${items
          .map(
            (it) => `<label class="picker-item ${it.status !== '未使用' ? 'disabled' : ''}" data-val="${it.id}" data-text="${esc(mainVal(it))}">
              <input type="checkbox" ${picked.has(it.id) ? 'checked' : ''} ${it.status !== '未使用' ? 'disabled' : ''}>
              <span class="mono">${esc(mainVal(it))}</span>
              <span class="pill ${it.status === '未使用' ? 'pill-green' : it.status === '已使用' ? 'pill-blue' : 'pill-red'}"><span class="dot"></span>${it.status}</span>
            </label>`
          )
          .join('') || '<div class="empty"><p>库为空，请先批量导入</p></div>'}
      </div>
    </div>
    <div class="modal-foot">
      <span class="sel-count">已选 <b id="picker-count">${picked.size}</b> 项</span>
      <span class="grow"></span>
      <button class="btn btn-ghost btn-sm" id="picker-clear">清空</button>
      <button class="btn btn-primary btn-sm" id="picker-ok">确定</button>
    </div>`, { large: true });

  const listEl = document.getElementById('picker-list');
  const countEl = document.getElementById('picker-count');
  const qInput = document.getElementById('picker-q');

  listEl.addEventListener('change', (e) => {
    const label = e.target.closest('.picker-item');
    if (!label) return;
    const id = Number(label.dataset.val);
    if (e.target.checked) picked.add(id);
    else picked.delete(id);
    countEl.textContent = picked.size;
  });
  qInput.addEventListener('input', () => {
    const q = qInput.value.trim().toLowerCase();
    listEl.querySelectorAll('.picker-item').forEach((el) => {
      el.style.display = !q || el.dataset.text.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  document.getElementById('picker-clear').onclick = () => {
    picked.clear();
    listEl.querySelectorAll('input[type=checkbox]').forEach((c) => (c.checked = false));
    countEl.textContent = 0;
  };
  document.getElementById('picker-ok').onclick = async () => {
    closeModal();
    render();
  };
}

/* ============ 编辑记录弹窗 ============ */

function openEditRecord(id) {
  const r = state.records.find((x) => x.id === id);
  if (!r) return;

  const poolSelect = (kind, currentId, name) => {
    const opts = [`<option value="">（清空关联）</option>`]
      .concat(
        state.pools[kind]
          .map((it) => {
            const label = kind === 'emails' ? it.user
              : kind === 'cards' ? `${it.number} ${it.expiry}`
              : kind === 'licenses' ? it.name
              : `${it.host}:${it.port} ${it.sn || ''}`;
            const disabled = it.id !== currentId && (it.status === '停用' || (kind !== 'proxies' && it.status !== '未使用'));
            return `<option value="${it.id}" ${it.id === currentId ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(label)}（${it.status}）</option>`;
          })
          .join('')
      );
    return `<select name="${name}">${opts.join('')}</select>`;
  };

  openModal(`
    <div class="modal-head"><h3>编辑记录 · <span class="mono" style="color:var(--accent)">${esc(r.fingerprint)}</span></h3><button class="modal-close" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <div class="form-grid" id="edit-form">
        <div class="field col-4"><label>国家</label><input name="country" value="${esc(r.country)}"></div>
        <div class="field col-4"><label>产品</label><input name="product" value="${esc(r.product)}"></div>
        <div class="field col-4"><label>域名</label><input name="domain" class="mono" value="${esc(r.domain)}"></div>
        <div class="field col-4"><label>IP注册时间</label><input name="ip_reg_time" type="date" value="${esc(r.ip_reg_time)}"></div>
        <div class="field col-4"><label>身份证</label><input name="id_card" value="${esc(r.id_card)}"></div>
        <div class="field col-4"><label>状态</label>
          <select name="status">${['正常', '异常', '停用'].map((s) => `<option ${r.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </div>
        <div class="field col-6"><label>谷歌邮箱（更换后自动释放原邮箱）</label>${poolSelect('emails', r.email_id, 'email_id')}</div>
        <div class="field col-6"><label>代理</label>${poolSelect('proxies', r.proxy_id, 'proxy_id')}</div>
        <div class="field col-6"><label>信用卡</label>${poolSelect('cards', r.card_id, 'card_id')}</div>
        <div class="field col-6"><label>营业执照</label>${poolSelect('licenses', r.license_id, 'license_id')}</div>
      </div>
    </div>
    <div class="modal-foot">
      <span class="grow"></span>
      <button class="btn btn-ghost" data-action="close-modal">取消</button>
      <button class="btn btn-primary" id="edit-ok">保存修改</button>
    </div>`, { large: true });

  const save = document.getElementById('edit-ok');
  save.onclick = async () => {
    if (save.disabled) return;
    save.disabled = true;
    const form = document.getElementById('edit-form');
    const val = (n) => form.querySelector(`[name="${n}"]`).value;
    const body = {
      country: val('country'),
      product: val('product'),
      domain: val('domain'),
      ip_reg_time: val('ip_reg_time'),
      id_card: val('id_card'),
      status: val('status'),
    };
    for (const n of ['email_id', 'proxy_id', 'card_id', 'license_id']) {
      const v = val(n);
      body[n] = v === '' ? null : Number(v);
    }
    try {
      await api(`/api/records/${id}`, { method: 'PATCH', body });
      toast('✅ 已保存');
      if (form.isConnected) closeModal();
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      save.disabled = false;
    }
  };
}

/* ============ 事件 ============ */

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]');

  // 复制：优先用 data-copy 属性，否则兜底复制非交互单元格的文本
  const copyEl = e.target.closest('[data-copy]');
  if (copyEl && copyEl.dataset.copy) {
    if (!state.reveal && (copyEl.dataset.sensitive === 'true' || copyEl.querySelector('.masked'))) return toast('请先显示敏感信息，再复制该字段', 'warn');
    copyText(copyEl.dataset.copy);
    return;
  }
  // 兜底：点击表格中纯文本单元格（不含按钮/下拉/复选框）时复制其内容
  const td = e.target.closest('td');
  if (td && !td.querySelector('.masked, button, select, input, a, [data-action]')) {
    const txt = td.textContent.trim();
    if (txt && txt !== '—') {
      copyText(txt);
      return;
    }
  }

  if (!t) return;
  const action = t.dataset.action;

  try {
    switch (action) {
      case 'retry-load':
        await connect();
        break;
      case 'desktop-backup': {
        const result = await window.desktop.backup();
        if (result.success) toast('完整备份已导出');
        break;
      }
      case 'desktop-restore':
        await window.desktop.restore();
        break;
      case 'desktop-data':
        await window.desktop.openDataFolder();
        break;
      case 'nav': {
        if (state.page !== t.dataset.page) { state.poolQ = ''; state.poolStatus = '全部'; state.poolPage = 1; }
        state.page = t.dataset.page;
        render();
        break;
      }
      case 'modal-overlay': {
        if (e.target === t) closeModal();
        break;
      }
      case 'close-modal':
        closeModal();
        break;
      case 'toggle-reveal':
        state.reveal = !state.reveal;
        render();
        break;
      case 'open-import':
        openImportModal(t.dataset.kind);
        break;
      case 'open-auto-import':
        openAutoImport();
        break;
      case 'open-picker':
        openPicker(t.dataset.kind);
        break;
      case 'create':
        await doCreate();
        break;
      case 'rstatus':
        state.rstatus = t.dataset.v;
        state.recordPage = 1;
        render();
        break;
      case 'pool-status':
        state.poolStatus = t.dataset.v;
        state.poolPage = 1;
        render();
        break;
      case 'table-page':
        if (t.dataset.kind === 'records') { state.recordPage = Number(t.dataset.page); renderRecordsTableInto(); }
        else { state.poolPage = Number(t.dataset.page); renderPoolTableInto(); }
        break;
      case 'export-adspower': {
        const ids = [...state.sel];
        const res = await api('/api/export/adspower', { method: 'POST', body: { ids } });
        download(`adspower_${todayKey().replace('.', '_')}.txt`, res.text);
        toast(`✅ 已导出 ${res.count} 条 AdsPower 导入文件`);
        break;
      }
      case 'export-csv': {
        const ids = [...state.sel];
        const res = await api('/api/export/csv', { method: 'POST', body: { ids } });
        download(`记录_${todayKey().replace('.', '_')}.csv`, res.text, 'text/csv;charset=utf-8');
        toast(`✅ 已导出 ${res.count} 条 CSV`);
        break;
      }
      case 'delete-selected': {
        const ids = [...state.sel];
        if (!ids.length) return;
        confirmModal('删除所选记录', `将删除 <b>${ids.length}</b> 条记录，不再被其他记录使用的资源会自动释放回「未使用」。`, async () => {
          await api('/api/records/batch-delete', { method: 'POST', body: { ids } });
          state.sel.clear();
          toast('已删除');
          await refresh();
        });
        break;
      }
      case 'del-record': {
        const id = Number(t.dataset.id);
        confirmModal('删除记录', '删除后关联的邮箱 / 信用卡 / 营业执照会自动释放回「未使用」。', async () => {
          await api(`/api/records/${id}`, { method: 'DELETE' });
          state.sel.delete(id);
          toast('已删除');
          await refresh();
        });
        break;
      }
      case 'edit-record':
        openEditRecord(Number(t.dataset.id));
        break;
      case 'view-license':
        openLicenseDetails(Number(t.dataset.id));
        break;
      case 'open-license-pdf': {
        const id = Number(t.dataset.id);
        if (window.desktop) await window.desktop.openLicensePdf(id);
        else {
          const response = await fetch(`/api/licenses/${id}/pdf`);
          if (!response.ok) throw new Error('未保存原 PDF');
          const url = URL.createObjectURL(await response.blob());
          const anchor = document.createElement('a');
          anchor.href = url; anchor.download = state.pools.licenses.find((license) => license.id === id)?.document_name || '营业执照.pdf'; anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
        break;
      }
      case 'reveal-license-pdf':
        await window.desktop.revealLicensePdf(Number(t.dataset.id));
        break;
      case 'del-pool': {
        const kind = t.dataset.kind;
        const id = Number(t.dataset.id);
        confirmModal('删除资源', '请先解除关联后再删除。删除后的原 PDF 仍可从历史完整备份恢复。', async () => {
          await api(`/api/pool/${kind}/${id}`, { method: 'DELETE' });
          toast('已删除');
          await refresh();
        });
        break;
      }
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  if (action === 'pool-item-status' || action === 'rec-status') t.disabled = true;
  try {
    if (action === 'pool-item-status') {
      await api(`/api/pool/${t.dataset.kind}/${t.dataset.id}`, { method: 'PATCH', body: { status: t.value } });
      toast('状态已更新');
      await refresh();
    } else if (action === 'rec-status') {
      await api(`/api/records/${t.dataset.id}`, { method: 'PATCH', body: { status: t.value } });
      toast('状态已更新');
      await refresh();
    } else if (action === 'sel-row') {
      const id = Number(t.dataset.id);
      if (t.checked) state.sel.add(id);
      else state.sel.delete(id);
      refreshSelectionUI();
    } else if (action === 'sel-all') {
      const list = paginate(getFilteredRecords(), 'records').items;
      if (t.checked) list.forEach((r) => state.sel.add(r.id));
      else list.forEach((r) => state.sel.delete(r.id));
      refreshSelectionUI();
    }
  } catch (err) {
    if (action === 'pool-item-status') t.value = state.pools[t.dataset.kind].find((item) => item.id === Number(t.dataset.id))?.status || t.value;
    if (action === 'rec-status') t.value = state.records.find((record) => record.id === Number(t.dataset.id))?.status || t.value;
    toast(err.message, 'error');
  } finally {
    if (action === 'pool-item-status' || action === 'rec-status') t.disabled = false;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'rec-q') {
    state.q = e.target.value;
    state.recordPage = 1;
    const el = document.getElementById('rec-q');
    renderRecordsTableInto(e.target);
    el.setSelectionRange(el.value.length, el.value.length);
  } else if (e.target.id === 'pool-q') {
    state.poolQ = e.target.value;
    state.poolPage = 1;
    const el = e.target;
    renderPoolTableInto();
    el.setSelectionRange(el.value.length, el.value.length);
  } else if (e.target.id?.startsWith('f-')) {
    const key = e.target.id.replace('f-', '');
    const map = { country: 'country', product: 'product', start: 'start_seq', ipreg: 'ip_reg_time', idcard: 'id_card', domains: 'domains' };
    if (map[key]) state.form[map[key]] = e.target.value;
    if (['country', 'product', 'domains', 'start'].includes(key)) {
      const btn = document.querySelector('[data-action="create"]');
      const preview = document.querySelector('.create-preview');
      // 轻量更新预览与按钮状态，不重建输入框
      updateCreatePreview();
    }
  }
});

function updateCreatePreview() {
  const preview = document.querySelector('.create-preview');
  if (!preview) return;
  const domains = state.form.domains.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const count = domains.length || 0;
  const fp = parseFpStart(state.form.start_seq);
  const fpPreview = count > 0
    ? (count === 1 ? `${fp.prefix}${fp.seq}` : `${fp.prefix}${fp.seq} ~ ${fp.prefix}${fp.seq + count - 1}`)
    : `${fp.prefix}${fp.seq}`;
  const avail = { emails: poolCount('emails'), cards: poolCount('cards') };
  preview.querySelector('.fp').textContent = fpPreview;
  preview.querySelector('span > b').textContent = count;
  const btn = preview.querySelector('[data-action="create"]');
  btn.disabled = count === 0 || count > 500 || state.creating;
  btn.textContent = state.creating ? '创建中' : count > 0 ? `立即创建 ${count} 条` : '立即创建';
  preview.querySelectorAll('.warn').forEach((w) => w.remove());
  const warns = [];
  if (count > avail.emails) warns.push(`⚠ 邮箱仅剩 ${avail.emails} 条`);
  if (count > avail.cards) warns.push(`⚠ 信用卡仅剩 ${avail.cards} 张`);
  const span = preview.querySelector('span');
  warns.forEach((w) => {
    const el = document.createElement('span');
    el.className = 'warn';
    el.textContent = ' ' + w;
    span.appendChild(el);
  });
}

function renderRecordsTableInto(input) {
  // 只刷新表格部分，保持搜索框焦点
  const panels = document.querySelectorAll('#main .panel');
  const tablePanel = panels[panels.length - 1];
  if (!tablePanel) return;
  const old = tablePanel.querySelector('.table-wrap, .empty');
  if (old) old.remove();
  tablePanel.querySelector('.table-pagination')?.remove();
  tablePanel.insertAdjacentHTML('beforeend', renderRecordsTable(getFilteredRecords()));
  const selCount = tablePanel.querySelector('.sel-count');
  if (selCount) selCount.innerHTML = `已选 <b>${state.sel.size}</b> 条`;
  refreshSelectionUI();
}

// 勾选/全选后只刷新勾选相关 UI（行高亮、全选框、计数、删除按钮），不重建整页
function refreshSelectionUI() {
  const rows = document.querySelectorAll('#main tbody tr[data-id]');
  rows.forEach((tr) => {
    const id = Number(tr.dataset.id);
    const checked = state.sel.has(id);
    tr.classList.toggle('selected', checked);
    const cb = tr.querySelector('input[data-action="sel-row"]');
    if (cb) cb.checked = checked;
  });
  const allCb = document.querySelector('#main thead input[data-action="sel-all"]');
  if (allCb) {
    const visible = paginate(getFilteredRecords(), 'records').items;
    allCb.checked = visible.length > 0 && visible.every((r) => state.sel.has(r.id));
    allCb.indeterminate = visible.some((r) => state.sel.has(r.id)) && !allCb.checked;
  }
  const selCount = document.querySelector('#main .sel-count');
  if (selCount) selCount.innerHTML = `已选 <b>${state.sel.size}</b> 条`;
  const delBtn = document.querySelector('[data-action="delete-selected"]');
  if (delBtn) delBtn.disabled = state.sel.size === 0;
  const label = state.sel.size ? `所选 ${state.sel.size} 条` : '全部';
  const csvButton = document.querySelector('[data-action="export-csv"]');
  const adspowerButton = document.querySelector('[data-action="export-adspower"]');
  if (csvButton) csvButton.textContent = `导出${label} CSV`;
  if (adspowerButton) adspowerButton.textContent = `导出${label} AdsPower TXT`;
}

document.addEventListener('change', (e) => {
  if (e.target.id === 'f-proxy') {
    state.form.proxy_id = e.target.value;
    return;
  }
  if (e.target.id === 'f-proxy-mode') {
    state.form.proxy_mode = e.target.value;
    const extra = document.getElementById('proxy-mode-extra');
    if (extra) {
      const proxyOptions = [`<option value="">共享上次使用的代理</option>`]
        .concat(
          state.pools.proxies
            .map(
              (p) => `<option value="${p.id}" ${String(state.form.proxy_id) === String(p.id) ? 'selected' : ''} ${p.status === '停用' ? 'disabled' : ''}>${esc(
                `${p.host ? p.host + ':' + p.port : '未设置主机'} · ${p.sn || '无编号'}${p.country ? ' · ' + p.country : ''}（${p.status}）`
              )}</option>`
            )
            .join('')
        )
        .join('');
      if (state.form.proxy_mode === 'shared') {
        extra.innerHTML = `<select id="f-proxy">${proxyOptions}</select>`;
      } else if (state.form.proxy_mode === 'auto') {
        extra.innerHTML = `<span class="mini">每条记录从代理库按顺序取一个 · 可用 <b>${poolCount('proxies')}</b> 条</span>`;
      } else {
        extra.innerHTML = `<span class="mini">记录中代理字段留空</span>`;
      }
    }
  }
});

/* ============ 启动 ============ */

let connecting = false;

async function connect() {
  if (connecting) return;
  connecting = true;
  const main = document.getElementById('main');
  const status = document.getElementById('connectionStatus');
  if (status) { status.textContent = '正在连接…'; status.className = 'connection-status'; }
  if (!state.loaded) main.innerHTML = '<section class="connection-panel" role="status"><span class="connection-spinner" aria-hidden="true"></span><h1>正在打开工作台</h1><p>正在读取本地记录和资源</p></section>';
  const retry = document.querySelector('[data-action="retry-load"]');
  if (retry) { retry.disabled = true; retry.textContent = '正在连接…'; }
  try {
    await refresh();
  } catch (error) {
    if (status) { status.textContent = '连接未完成'; status.className = 'connection-status disconnected'; }
    // Keep existing records and form input visible if a later refresh fails.
    if (state.loaded) toast(error.message, 'error');
    else main.innerHTML = `<section class="connection-panel" role="alert"><span class="empty-ico">⚠</span><h1>暂时无法打开工作台</h1><p>${esc(error.message)}</p><button class="btn btn-primary" data-action="retry-load">重新连接</button></section>`;
  } finally {
    connecting = false;
    const retry = document.querySelector('[data-action="retry-load"]');
    if (retry) { retry.disabled = false; retry.textContent = '重新连接'; }
    document.body.classList.remove('boot');
  }
}

function bindLabels() {
  document.querySelectorAll('.field').forEach((field) => {
    const label = field.querySelector('label');
    const input = field.querySelector('input,select,textarea');
    if (input && !input.id && input.name) input.id = `${field.closest('#modal-root') ? 'modal' : 'main'}-${input.name}`;
    if (label && input) label.htmlFor = input.id;
  });
}
new MutationObserver(bindLabels).observe(document.getElementById('main'), { childList: true, subtree: true });
new MutationObserver(bindLabels).observe(document.getElementById('modal-root'), { childList: true, subtree: true });

if (window.desktop) {
  document.getElementById('desktopTools').hidden = false;
  window.desktop.info().then((info) => {
    document.getElementById('desktopVersion').textContent = `Windows 桌面版 · v${info.version}`;
  }).catch(() => {});
}
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    connect();
  }
});
connect();
