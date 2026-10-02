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
  const res = await fetch(path, {
    headers,
    ...opts,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'ok' ? '' : type}`;
  el.textContent = msg;
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, type === 'error' ? 4200 : 2600);
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

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

function todayKey() {
  const d = new Date();
  return `${d.getMonth() + 1}.${d.getDate()}`;
}

function fmtCard(num) {
  return num ? num.replace(/^(.{6})(.+?)(.{4})$/, '$1 $2 $3') : '';
}

function poolCount(kind, status = '未使用') {
  return state.pools[kind].filter((x) => x.status === status).length;
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
};

const MASK = '••••••';

function sens(value) {
  if (state.reveal) return esc(value);
  if (!value) return '<span class="faint">—</span>';
  return `<span class="masked">${MASK}</span>`;
}

/* ============ 弹窗 ============ */

function openModal(html, { large = false } = {}) {
  closeModal();
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-overlay" data-action="modal-overlay">
    <div class="modal ${large ? 'modal-lg' : ''}">
      ${html}
    </div>
  </div>`;
  document.addEventListener('keydown', escListener);
}

function escListener(e) {
  if (e.key === 'Escape') closeModal();
}

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
  document.removeEventListener('keydown', escListener);
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
  document.getElementById('confirm-ok-btn').onclick = async () => {
    try {
      await onOk();
      closeModal();
    } catch (err) {
      toast(err.message || '操作失败', 'error');
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
  if (state.page === 'workbench') renderWorkbench();
  else renderPool(state.page);
}

async function refresh() {
  const data = await api('/api/bootstrap');
  state.pools = data.pools;
  state.records = data.records;
  state.next = data.next;
  state.loaded = true;
  if (!state.form.start_seq) state.form.start_seq = data.next.seq;
  render();
}

/* ============ 工作台 ============ */

function renderWorkbench() {
  const f = state.form;
  const main = document.getElementById('main');
  const domains = f.domains.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const count = domains.length || 0;
  const startSeq = parseInt(f.start_seq, 10) || state.next?.seq || 1;
  const dk = todayKey();

  const fpPreview = count > 0
    ? (count === 1 ? `${dk}ads${startSeq}` : `${dk}ads${startSeq} ~ ${dk}ads${startSeq + count - 1}`)
    : `${dk}ads${startSeq}`;

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
          (p) => `<option value="${p.id}" ${String(f.proxy_id) === String(p.id) ? 'selected' : ''}>${esc(
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

  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date().getDay()];
  const todayCN = `${new Date().getMonth() + 1}月${new Date().getDate()}日 · ${week}`;

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>工作台</h1>
        <p class="sub">指纹名称按今日日期自动生成，资源按状态分组、自动分配</p>
      </div>
      <span class="date-chip"><span class="dot"></span>今天 · ${todayCN}</span>
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
            <label>起始编号 <span class="mini">自动</span></label>
            <input id="f-start" class="mono" type="number" min="1" value="${esc(f.start_seq)}">
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
          <button class="btn btn-primary" data-action="create" ${count === 0 ? 'disabled' : ''}>立即创建 ${count > 0 ? count + ' 条' : ''}</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">创建记录</div>
      </div>
      <div class="toolbar">
        <input class="search" id="rec-q" placeholder="搜索 指纹 / 名称 / 域名 / 邮箱 / 卡号…" value="${esc(state.q)}">
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
  const allChecked = list.length && list.every((r) => state.sel.has(r.id));
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th style="width:34px"><input type="checkbox" data-action="sel-all" ${allChecked ? 'checked' : ''}></th>
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
            <td class="mono copyable" data-copy="${esc(r.proxy_host ? `${r.proxy_host}:${r.proxy_port}:${r.proxy_user}:${r.proxy_pass}` : '')}" title="点击复制完整代理">${proxy}</td>
            <td class="mono copyable" data-copy="${esc(r.card_number ? `${r.card_number} ${r.card_expiry} ${r.card_cvv}` : '')}" title="点击复制完整卡号">${card}</td>
            <td class="dim">${esc(r.ip_reg_time) || '<span class="faint">—</span>'}</td>
            <td>${esc(r.license_name) || '<span class="faint">—</span>'}</td>
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
  </table></div>`;
}

async function doCreate() {
  const domains = state.form.domains.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!domains.length) return toast('请至少填写一个域名', 'warn');
  const body = {
    country: state.form.country,
    product: state.form.product,
    domains,
    start_seq: parseInt(state.form.start_seq, 10) || undefined,
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
    state.form.start_seq = String(list[list.length - 1].seq + 1);
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ============ 资源库页面 ============ */

const POOL_TABLE = {
  emails: {
    cols: ['ID', '谷歌邮箱', '邮箱密码', '2FA', '状态', '导入时间', '操作'],
    row: (e) => [
      `<span class="faint mono">${e.id}</span>`,
      `<span class="mono copyable" data-copy="${esc(e.user)}" title="点击复制">${esc(e.user)}</span>`,
      `<span class="mono copyable" data-copy="${esc(e.pass)}" title="点击复制">${sens(e.pass)}</span>`,
      `<span class="mono copyable" data-copy="${esc(e.fakey)}" title="点击复制">${sens(e.fakey)}</span>`,
    ],
  },
  proxies: {
    cols: ['ID', '编号', '类型', '主机', '端口', '代理账号', '代理密码', '国家', '出口IP', '状态', '导入时间', '操作'],
    row: (p) => [
      `<span class="faint mono">${p.id}</span>`,
      `<span class="mono">${esc(p.sn) || '<span class="faint">—</span>'}</span>`,
      `<span class="pill pill-amber"><span class="dot"></span>${esc(p.type || 'socks5')}</span>`,
      `<span class="mono copyable" data-copy="${esc(p.host)}" title="点击复制">${esc(p.host)}</span>`,
      `<span class="mono">${esc(p.port)}</span>`,
      `<span class="mono copyable" data-copy="${esc(p.user)}" title="点击复制">${sens(p.user)}</span>`,
      `<span class="mono copyable" data-copy="${esc(p.pass)}" title="点击复制">${sens(p.pass)}</span>`,
      `<span class="dim">${esc(p.country) || '<span class="faint">—</span>'}</span>`,
      `<span class="mono copyable" data-copy="${esc(p.ip)}" title="点击复制">${esc(p.ip) || '<span class="faint">—</span>'}</span>`,
    ],
  },
  cards: {
    cols: ['ID', '卡号', '有效期', 'CVV', '状态', '导入时间', '操作'],
    row: (c) => [
      `<span class="faint mono">${c.id}</span>`,
      `<span class="mono copyable" data-copy="${esc(c.number)}" title="点击复制">${sens(c.number)}</span>`,
      `<span class="mono">${esc(c.expiry) || '<span class="faint">—</span>'}</span>`,
      `<span class="mono copyable" data-copy="${esc(c.cvv)}" title="点击复制">${sens(c.cvv)}</span>`,
    ],
  },
  licenses: {
    cols: ['ID', '公司名称', '状态', '导入时间', '操作'],
    row: (l) => [
      `<span class="faint mono">${l.id}</span>`,
      `<span class="copyable" data-copy="${esc(l.name)}" title="点击复制">${esc(l.name)}</span>`,
    ],
  },
};

const POOL_FORMAT = {
  emails: `NewkirkCorre.l103@gmail.com——psj5qrajyv——ucyar7gltohvnnxbpxt4vmsdrcaxa5j6
vanmaih.uynh75@gmail.com——Y2IvBdZRN2——54viszzfxqzxuowp57ma2sw7euael6x5`,
  proxies: `5750389
socks5
55.kookeey.info
26004
账号：437d8679
密码：547be5d2
修改
US-美国
217.20.243.226

9189913
socks5
55.kookeey.info
30263
账号：437d8679
密码：547be5d2
US-美国
154.16.121.213`,
  cards: `4367970152619097 06/29 596
4367970159932238 06/29 364
4367970169748392 06/29 786`,
  licenses: `CC TEKNIK ApS
Capital Service ApS
CFTS-Byg ApS`,
};

function renderPool(kind) {
  const conf = KINDS.find((k) => k.key === kind);
  const tableConf = POOL_TABLE[kind];
  const q = state.poolQ.trim().toLowerCase();
  const list = state.pools[kind].filter((x) => {
    if (state.poolStatus !== '全部' && x.status !== state.poolStatus) return false;
    if (!q) return true;
    return Object.values(x).some((v) => String(v ?? '').toLowerCase().includes(q));
  });
  const total = state.pools[kind].length;
  const unused = poolCount(kind);
  const used = poolCount(kind, '已使用');
  const off = poolCount(kind, '停用');

  const statHtml = (label, v, cls) =>
    `<div class="stat"><div class="k"><span class="dot ${cls}"></span>${label}</div><div class="v">${v}</div></div>`;

  document.getElementById('main').innerHTML = `
    <div class="page-head">
      <div>
        <h1>${conf.label}</h1>
        <p class="sub">统一管理${conf.label}资源，创建记录时自动分配并标记</p>
      </div>
      <div class="head-actions">
        <button class="btn btn-primary" data-action="open-import" data-kind="${kind}">批量导入</button>
      </div>
    </div>
    <div class="stats">
      ${statHtml('全部', total, 'bg')}
      ${statHtml('未使用', unused, 'dot-green-ic')}
      ${statHtml('已使用', used, 'dot-blue-ic')}
      ${statHtml('停用', off, 'dot-red-ic')}
    </div>
    <div class="panel">
      <div class="toolbar">
        <input class="search" id="pool-q" placeholder="搜索…" value="${esc(state.poolQ)}">
        <div class="tabs">
          ${['全部', '未使用', '已使用', '停用'].map((s) => `<button class="tab ${state.poolStatus === s ? 'active' : ''}" data-action="pool-status" data-v="${s}">${s}</button>`).join('')}
        </div>
        <span class="sel-count">${list.length} 条</span>
      </div>
      ${
        total === 0
          ? `<div class="empty">
              <div class="empty-ico">⇩</div>
              <h3>还没有${conf.label}数据</h3>
              <p>点击右上角「批量导入」，支持粘贴以下格式（一行一条）：</p>
              <code>${esc(POOL_FORMAT[kind])}</code>
            </div>`
          : `<div class="table-wrap"><table>
              <thead><tr>${tableConf.cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
              <tbody>
                ${list
                  .map((item, i) => {
                    const cells = tableConf.row(item);
                    const statusIdx = tableConf.cols.indexOf('状态');
                    const rest = [...cells];
                    let statusHtml = `<select class="status-select ${item.status === '未使用' ? 's-green' : item.status === '已使用' ? 's-blue' : 's-red'}" data-action="pool-item-status" data-kind="${kind}" data-id="${item.id}">
                      ${['未使用', '已使用', '停用'].map((s) => `<option ${item.status === s ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>`;
                    return `<tr style="--i:${i}">${rest
                      .slice(0, statusIdx)
                      .concat([statusHtml, `<td class="dim mono" style="font-size:11px">${esc(item.created_at || '')}</td>`, `<td><div class="row-actions"><button class="icon-btn danger" data-action="del-pool" data-kind="${kind}" data-id="${item.id}">删除</button></div></td>`])
                      .join('')}</tr>`;
                  })
                  .join('')}
              </tbody>
            </table></div>`
      }
    </div>
  `;
}

/* ============ 导入弹窗 ============ */

async function openImportModal(kind) {
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

  const doParse = async () => {
    const text = ta.value;
    if (!text.trim()) {
      parsed = [];
      resultBox.innerHTML = '等待粘贴内容…';
      okBtn.disabled = true;
      return;
    }
    try {
      const res = await api(`/api/parse/${kind}`, { method: 'POST', body: { text } });
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
    } catch (e) {
      resultBox.textContent = e.message;
      okBtn.disabled = true;
    }
  };

  let timer = null;
  ta.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(doParse, 350);
  });

  okBtn.onclick = async () => {
    if (!parsed.length) return;
    try {
      const res = await api(`/api/import/${kind}`, { method: 'POST', body: { items: parsed } });
      toast(`✅ 导入成功：新增 ${res.added} 条${res.skipped ? `，跳过重复 ${res.skipped} 条` : ''}`);
      closeModal();
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
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
            (it) => `<label class="picker-item ${it.status === '停用' ? 'disabled' : ''}" data-val="${it.id}" data-text="${esc(mainVal(it))}">
              <input type="checkbox" ${picked.has(it.id) ? 'checked' : ''} ${it.status === '停用' ? 'disabled' : ''}>
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
    const opts = [`<option value="">（保留当前 / 清空）</option>`]
      .concat(
        state.pools[kind]
          .map((it) => {
            const label = kind === 'emails' ? it.user
              : kind === 'cards' ? `${it.number} ${it.expiry}`
              : kind === 'licenses' ? it.name
              : `${it.host}:${it.port} ${it.sn || ''}`;
            return `<option value="${it.id}" ${it.id === currentId ? 'selected' : ''}>${esc(label)}（${it.status}）</option>`;
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

  document.getElementById('edit-ok').onclick = async () => {
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
      closeModal();
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

/* ============ 事件 ============ */

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]');

  // 复制
  const copyEl = e.target.closest('[data-copy]');
  if (copyEl && !copyEl.dataset.copy) {
    // noop
  }
  if (e.target.closest('[data-copy]')) {
    const el = e.target.closest('[data-copy]');
    if (el.dataset.copy) {
      copyText(el.dataset.copy);
      return;
    }
  }

  if (!t) return;
  const action = t.dataset.action;

  try {
    switch (action) {
      case 'nav': {
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
      case 'open-picker':
        openPicker(t.dataset.kind);
        break;
      case 'create':
        await doCreate();
        break;
      case 'rstatus':
        state.rstatus = t.dataset.v;
        render();
        break;
      case 'pool-status':
        state.poolStatus = t.dataset.v;
        render();
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
        download(`记录_${todayKey().replace('.', '_')}.csv`, res.text);
        toast(`✅ 已导出 ${res.count} 条 CSV`);
        break;
      }
      case 'delete-selected': {
        const ids = [...state.sel];
        if (!ids.length) return;
        confirmModal('删除所选记录', `将删除 <b>${ids.length}</b> 条记录，关联的邮箱 / 信用卡 / 营业执照会自动释放回「未使用」（代理不动）。`, async () => {
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
      case 'del-pool': {
        const kind = t.dataset.kind;
        const id = Number(t.dataset.id);
        confirmModal('删除资源', '已创建的记录不受影响（记录中保存了快照）。', async () => {
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
      render();
    } else if (action === 'sel-all') {
      const list = getFilteredRecords();
      if (t.checked) list.forEach((r) => state.sel.add(r.id));
      else state.sel.clear();
      render();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'rec-q') {
    state.q = e.target.value;
    const el = document.getElementById('rec-q');
    renderRecordsTableInto(e.target);
    el.setSelectionRange(el.value.length, el.value.length);
  } else if (e.target.id === 'pool-q') {
    state.poolQ = e.target.value;
    render();
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
  const startSeq = parseInt(state.form.start_seq, 10) || state.next?.seq || 1;
  const dk = todayKey();
  const fp = count > 0
    ? (count === 1 ? `${dk}ads${startSeq}` : `${dk}ads${startSeq} ~ ${dk}ads${startSeq + count - 1}`)
    : `${dk}ads${startSeq}`;
  const avail = { emails: poolCount('emails'), cards: poolCount('cards') };
  preview.querySelector('.fp').textContent = fp;
  const btn = preview.querySelector('[data-action="create"]');
  btn.disabled = count === 0;
  btn.textContent = count > 0 ? `立即创建 ${count} 条` : '立即创建';
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
  tablePanel.insertAdjacentHTML('beforeend', renderRecordsTable(getFilteredRecords()));
  const selCount = tablePanel.querySelector('.sel-count');
  if (selCount) selCount.innerHTML = `已选 <b>${state.sel.size}</b> 条`;
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
              (p) => `<option value="${p.id}" ${String(state.form.proxy_id) === String(p.id) ? 'selected' : ''}>${esc(
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

refresh().catch((err) => {
  document.getElementById('main').innerHTML = `<div class="empty"><div class="empty-ico">⚠</div><h3>加载失败</h3><p>${esc(err.message)}</p></div>`;
});
