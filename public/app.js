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
  // 服务器版要求所有请求带来源标记头（写操作缺它会被拒绝），并靠会话 Cookie 识别账号
  const headers = { 'x-workbench': '1', ...(opts.headers || {}) };
  if (hasBody) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      ...opts, headers,
      signal: opts.signal || AbortSignal.timeout(60000),
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('连接超时，提交结果尚未确认。请重新连接查询，不要重复新建。');
    if (error.name === 'AbortError') throw error;
    throw new Error('无法连接服务，请检查网络后重新连接');
  }
  if (res.status === 401) {
    // 会话失效：直接回登录页，避免在页面上留下半截状态
    location.replace('/login.html');
    throw new Error('登录状态已失效，请重新登录');
  }
  let data;
  try { data = await res.json(); } catch {
    const messages = {403:'访问被拦截，可能处于维护期或当前出口 IP 未获放行，请联系管理员',413:'请求过大，请减少文件或批次大小',429:'请求过于频繁，请稍后重试',502:'后台暂时不可用，请稍后重试',503:'服务维护中，请稍后重试',504:'后台响应超时，提交结果待确认，请勿重复新建'};
    const error = new Error(messages[res.status] || '服务响应格式异常，请重新连接或联系管理员');
    error.status = res.status; throw error;
  }
  if (!res.ok) {
    const error = new Error(data.message || data.error || `请求失败 (${res.status})`);
    // 判重被拒绝时携带冲突明细（谁在什么时候导入的），供界面逐条展示
    if (Array.isArray(data.conflicts)) error.conflicts = data.conflicts;
    error.status = res.status;
    throw error;
  }
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

async function refreshAfterCommit(warning) {
  try {
    await refresh();
    return true;
  } catch {
    toast(warning, 'warn');
    return false;
  }
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
    const copied = document.execCommand('copy');
    ta.remove();
    if (!copied) { toast('复制失败，请手动选择文本后复制', 'error'); return; }
  }
  toast('已复制到剪贴板');
}

/* Explicitly copyable values are keyboard reachable; ordinary cells are not
   turned into hundreds of extra Tab stops. Never use their contents as labels. */
function enhanceCopyTargets(root = document) {
  for (const el of root.querySelectorAll('span[data-copy], div[data-copy]')) {
    if (el.hasAttribute('data-action')) continue;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', '复制字段内容');
    if (!el.title) el.title = '点击或按 Enter 复制';
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || document.querySelector('#modal-root .modal')) return;
  const open = document.querySelector('.col-menu[open]');
  if (open) {
    event.preventDefault();
    open.open = false;
    open.querySelector('summary')?.focus();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target.closest('span[data-copy], div[data-copy]');
  if (!target || target.hasAttribute('data-action')) return;
  event.preventDefault();
  if (!state.reveal && (target.dataset.sensitive === 'true' || target.querySelector('.masked'))) {
    toast('请先显示敏感信息，再复制该字段', 'warn');
    return;
  }
  copyText(target.dataset.copy || '');
});

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
  { key: 'cards', label: '付款工具库', ico: '▤' },
  { key: 'licenses', label: '营业执照', ico: '§' },
];

function readTableDensity() {
  try { return localStorage.getItem('ads-workbench-table-density') === 'compact' ? 'compact' : 'standard'; }
  catch { return 'standard'; }
}

const state = {
  page: 'records',
  tableDensity: readTableDensity(),
  pools: { emails: [], proxies: [], cards: [], licenses: [] },
  // records 只保存当前服务端分页，不再缓存当前账号的全部记录。
  records: [],
  recordFilteredTotal: 0,
  recordStats: { total: 0, 正常: 0, 异常: 0, 停用: 0 },
  recentRecords: [],
  recordLimit: 50,
  next: null,
  reveal: false,
  unlockedUntil: 0,
  submission: null,
  sel: new Set(),
  q: '',
  rstatus: '全部',
  poolQ: '',
  poolStatus: '全部',
  poolFilters: Object.fromEntries(['emails','proxies','cards','licenses'].map(kind => [kind, {q:'',status:'全部',page:1}])),
  picked: { emails: new Set(), cards: new Set(), licenses: new Set() },
  form: { country: '', product: '', domains: '', start_seq: '', ip_reg_time: '', id_card: '', proxy_mode: 'shared', proxy_id: '' },
  loaded: false,
  user: null,
  creating: false,
  recordPage: 1,
  poolPage: 1,
  // 列显隐偏好（方案工作包 06）：只存「哪些列被隐藏」这类列名，不存任何字段值。
  hiddenCols: [],
};

const MASK = '••••••';
let recordRequestSeq = 0;
let recordSearchTimer = null;

/* ============ 记录表列显隐（方案工作包 06：列显隐 + 按用户保存的表格偏好） ============
   本地偏好里只写「哪些列被隐藏」这类列名，不写任何字段值 —— 方案要求
   「敏感字段不写入不受控的本地偏好」。复选框、指纹名称、状态与操作四列不参与显隐：
   它们是识别记录与操作记录的最小集合，藏掉表格就没法用了。
   用一条动态样式表按 nth-child 隐藏，而不是在模板里逐列写条件：后者要改 20 处
   <th>/<td>，很容易改漏一半；nth-child 按 DOM 位置计数，隐藏前面某一列不会让
   后面的列错位（也保证冻结列用的 nth-child(1)/(2) 始终成立）。 */
const RECORD_COLUMNS = [
  { key: 'name', label: '名称', index: 3 },
  { key: 'domain', label: '域名', index: 4 },
  { key: 'email', label: '谷歌邮箱', index: 5 },
  { key: 'emailPass', label: '邮箱密码', index: 6 },
  { key: 'fakey', label: '2FA', index: 7 },
  { key: 'proxy', label: '代理', index: 8 },
  { key: 'card', label: '付款工具', index: 9 },
  { key: 'ipreg', label: 'IP注册时间', index: 10 },
  { key: 'license', label: '营业执照', index: 11 },
  { key: 'idcard', label: '身份证', index: 12 },
];
const hiddenColKey = () => `wb.hiddenCols.${state.user?.username || 'anonymous'}`;
function loadHiddenCols() {
  try {
    const parsed = JSON.parse(localStorage.getItem(hiddenColKey()) || '[]');
    // 白名单过滤：本地存储可以被手工改，不能让它注入任意 nth-child
    return Array.isArray(parsed) ? parsed.filter((k) => RECORD_COLUMNS.some((c) => c.key === k)) : [];
  } catch { return []; }
}
function saveHiddenCols() {
  try { localStorage.setItem(hiddenColKey(), JSON.stringify(state.hiddenCols)); } catch { /* 无痕模式下不可写，忽略 */ }
}
/** 把隐藏列写成一条动态规则；没有隐藏列时规则为空。 */
function applyColumnVisibility() {
  let style = document.getElementById('rec-col-style');
  if (!style) { style = document.createElement('style'); style.id = 'rec-col-style'; document.head.appendChild(style); }
  style.textContent = state.hiddenCols
    .map((key) => RECORD_COLUMNS.find((column) => column.key === key))
    .filter(Boolean)
    .map((column) => `#recordsPanel .rec-table th:nth-child(${column.index}),#recordsPanel .rec-table td:nth-child(${column.index}){display:none}`)
    .join('\n');
}

function sens(value) {
  if (state.reveal && value !== '[protected]') return esc(value);
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

/* ============ Shared outline icons (no external runtime or icon fonts) ============ */
const UI_ICONS = Object.freeze({
  records: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  create: '<path d="M12 5v14M5 12h14"/>',
  overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
  emails: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.8 6.5 8.2 6 8.2-6"/>',
  proxies: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a16 16 0 0 1 0 18M12 3a16 16 0 0 0 0 18"/>',
  cards: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>',
  licenses: '<path d="M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v6h5M9 13h6M9 17h6"/>',
});
function uiIcon(name) {
  const paths = UI_ICONS[name] || UI_ICONS.records;
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/* ============ 骨架渲染 ============ */

function renderNav() {
  const main = [
    { key: 'records', label: '我的记录', ico: '▤', count: state.recordStats.total },
    { key: 'create', label: '新建记录', ico: '＋', count: '' },
    { key: 'overview', label: '运营总览', ico: '◈', count: '' },
  ];
  const pools = KINDS.map((k) => ({ key: k.key, label: k.label, ico: k.ico, count: state.pools[k.key].length }));
  const item = (it) => `<button class="nav-item ${state.page === it.key ? 'active' : ''}" data-action="nav" data-page="${it.key}" ${state.page === it.key ? 'aria-current="page"' : ''}>
        <span class="ico" aria-hidden="true">${uiIcon(it.key)}</span>${it.label}
        ${it.count !== '' ? `<span class="count">${it.count}</span>` : ''}
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

/** 侧栏底部的当前账号（服务器版：每个账号只看得到自己的数据）。 */
function renderAccount() {
  const name = document.getElementById('accountName');
  if (!name) return;
  const user = state.user;
  const label = user ? (user.display_name || user.username) : '未登录';
  name.textContent = label;
  document.getElementById('accountAvatar').textContent = user ? label.slice(0, 1).toUpperCase() : '—';
  document.getElementById('accountHint').textContent = user && user.display_name ? `@${user.username}` : '数据仅本人可见';
}

function render() {
  document.body.dataset.tableDensity = state.tableDensity;
  const main = document.getElementById('main');
  // 页面键写到 main 上：「我的记录」与「新建记录」共用同一份渲染与统计条，
  // 由 CSS 决定露出哪一块面板，避免把资源统计复制成两份、后续改漏一边。
  if (main) main.className = `main page-${state.page}`;
  renderNav();
  renderAccount();
  if (state.page === 'overview') renderOverview();
  else if (state.page === 'records' || state.page === 'create') { renderWorkbench(); refreshSelectionUI(); }
  else renderPool(state.page);
  enhanceCopyTargets(main);
  // 列偏好是全局样式规则，与记录表是否刚被重建无关
  applyColumnVisibility();
}

async function loadRecordsPage({ renderMode = 'none' } = {}) {
  const requestId = ++recordRequestSeq;
  const params = new URLSearchParams();
  params.set('limit', String(state.recordLimit));
  params.set('offset', String(Math.max(0, (state.recordPage - 1) * state.recordLimit)));
  params.set('sort', 'id_desc');
  if (state.q.trim()) params.set('q', state.q.trim());
  if (state.rstatus !== '全部') params.set('status', state.rstatus);
  if (state.reveal) params.set('reveal', '1');

  let data;
  try {
    data = await api('/api/records?' + params.toString());
  } catch (error) {
    if (requestId !== recordRequestSeq) return false;
    throw error;
  }
  if (requestId !== recordRequestSeq) return false;
  if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(Number(data.total)) || Number(data.total) < 0) {
    throw new Error('记录分页数据格式不正确');
  }

  const total = Number(data.total);
  const pages = Math.max(1, Math.ceil(total / state.recordLimit));
  if (state.recordPage > pages) {
    state.recordPage = pages;
    return loadRecordsPage({ renderMode });
  }

  state.records = data.items;
  state.recordFilteredTotal = total;

  if (renderMode === 'table' && state.page === 'records') renderRecordsTableInto();
  else if (renderMode === 'full') render();
  return true;
}

async function refresh() {
  if(state.reveal && state.unlockedUntil<=Date.now()) state.reveal=false;
  const query = new URLSearchParams({ summary: '1' });
  if (state.reveal) query.set('reveal', '1');
  const data = await api('/api/bootstrap?' + query.toString());
  if (!data?.pools || !data.next || !data.record_stats || !Array.isArray(data.recent_records)
      || !KINDS.every((k) => Array.isArray(data.pools[k.key]))) {
    throw new Error('数据格式不正确，请检查备份或重启工作台');
  }
  state.pools = data.pools;
  state.user = data.user || null;
  state.recordStats = {
    total: Number(data.record_stats.total || 0),
    正常: Number(data.record_stats['正常'] || 0),
    异常: Number(data.record_stats['异常'] || 0),
    停用: Number(data.record_stats['停用'] || 0),
  };
  state.recentRecords = data.recent_records;
  state.hiddenCols = loadHiddenCols();

  for (const kind of Object.keys(state.picked)) {
    const available = new Set(data.pools[kind].filter((item) => item.status === '未使用').map((item) => item.id));
    state.picked[kind] = new Set([...state.picked[kind]].filter((id) => available.has(id)));
  }
  if (state.form.proxy_id && !data.pools.proxies.some((proxy) => String(proxy.id) === String(state.form.proxy_id) && proxy.status !== '停用')) state.form.proxy_id = '';
  state.next = data.next;
  state.loaded = true;
  if (!state.form.start_seq) state.form.start_seq = data.next.seq;

  await loadRecordsPage();
  if (state.recordStats.total === 0) state.sel.clear();

  render();
  bindLabels();
  const connection = document.getElementById('connectionStatus');
  if (connection) { connection.textContent = '已连接'; connection.className = 'connection-status connected'; }
}

/* ============ 运营总览：当前账号授权数据，不代表团队共享已上线 ============ */
function renderOverview() {
  const normal = state.recordStats['正常'];
  const abnormal = state.recordStats['异常'];
  const paused = state.recordStats['停用'];
  const recent = state.recentRecords;
  const resources = [
    {kind:'emails', label:'邮箱资源', ico:'✉'},
    {kind:'proxies', label:'代理资源', ico:'⇅'},
    {kind:'cards', label:'支付资源', ico:'▤'},
    {kind:'licenses', label:'营业执照', ico:'§'},
  ];
  const resourceRows = resources.map(({kind,label,ico}) => `
    <button type="button" class="overview-resource" data-action="nav" data-page="${kind}">
      <span class="overview-resource-icon" aria-hidden="true">${uiIcon(kind)}</span>
      <span class="overview-resource-name">${label}<small>管理和导入资源</small></span>
      <b class="overview-resource-count ${poolCount(kind) === 0 ? 'overview-danger' : ''}">${poolCount(kind)}<small>可用</small></b>
      <span class="overview-arrow" aria-hidden="true">↗</span>
    </button>`).join('');
  document.getElementById('main').innerHTML = `
    <div class="page-head">
      <div><h1>运营总览</h1><p class="sub">账号状态、资源库存、待办事项 · 当前账号可见范围</p></div>
      <div class="head-actions"><button class="btn btn-ghost" data-action="open-auto-import">智能导入</button>
      <button class="btn btn-primary" data-action="nav" data-page="create">＋ 创建账号记录</button></div>
    </div>
    <div class="overview-metrics">
      <div class="overview-metric"><span>账号记录</span><b>${state.recordStats.total}</b><small>已建档总数</small></div>
      <div class="overview-metric"><span>正常</span><b class="overview-good">${normal}</b><small>当前状态正常</small></div>
      <div class="overview-metric"><span>异常</span><b class="${abnormal?'overview-danger':''}">${abnormal}</b><small>建议优先核对</small></div>
      <div class="overview-metric"><span>停用</span><b>${paused}</b><small>检查关联资源</small></div>
    </div>
    <div class="overview-columns">
      <section class="panel"><div class="panel-head"><div class="panel-title">资源准备度</div><span class="dim">点击管理</span></div>
        <div class="overview-resource-list">${resourceRows}</div>
        <p class="overview-footnote">此处仅展示当前用户库存。实际批量创建还需服务端分配校验。</p>
      </section>
      <section class="panel"><div class="panel-head"><div class="panel-title">优先处理</div><span class="dim">账号状态</span></div>
        <div class="overview-todo">
          ${abnormal ? `<button class="overview-todo-row" data-action="jump-status" data-status="异常"><span class="overview-dot red"></span><span><b>${abnormal} 条异常账号</b><small>检查账号资料和异常原因</small></span><span class="overview-arrow">→</span></button>`:''}
          ${paused ? `<button class="overview-todo-row" data-action="jump-status" data-status="停用"><span class="overview-dot"></span><span><b>${paused} 条停用账号</b><small>检查是否仍占用独占资源</small></span><span class="overview-arrow">→</span></button>`:''}
          ${!abnormal && !paused ? '<div class="overview-ok"><b>✓ 暂无异常或停用记录</b><p>可以继续补充资源或创建账号记录。</p></div>' : ''}
        </div>
      </section>
    </div>
    <section class="panel overview-recent">
      <div class="panel-head"><div class="panel-title">最近创建的账号</div><button class="btn btn-ghost btn-sm" data-action="nav" data-page="records">查看全部 →</button></div>
      ${recent.length ? recent.map(r => `<div class="overview-recent-row">
        <span class="overview-recent-icon" aria-hidden="true">${uiIcon('records')}</span>
        <span class="overview-recent-name"><b>${esc(r.fingerprint)}</b><small>${esc(r.country || '未填国家')} · ${esc(r.product || '未填产品')} · ${esc(r.domain || '未填域名')}</small></span>
        <span class="overview-status">${esc(r.status)}</span>
        <button class="btn btn-ghost btn-sm" data-action="recent-record" data-id="${r.id}">查看</button>
      </div>`).join('') : '<div class="empty"><h3>还没有账号记录</h3><p>从创建账号记录开始。</p><button class="btn btn-primary" data-action="nav" data-page="create">开始创建</button></div>'}
    </section>`;
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

  const filtered = state.page === 'create' ? [] : state.records;

  const todayCN = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${state.page === 'create' ? '新建记录' : '我的记录'}</h1>
        <p class="sub">${state.page === 'create'
          ? '指纹名称按今日日期自动生成，资源按状态分组、自动分配'
          : '查记录、看状态、处理异常优先；需要录入新记录时走「新建记录」'}</p>
      </div>
      <div class="head-actions">
        ${state.page === 'create'
          ? '<button class="btn btn-primary" data-action="open-auto-import">⚡ 智能导入</button>'
          : '<button class="btn btn-primary" data-action="nav" data-page="create">＋ 新建记录</button><button class="btn btn-ghost" data-action="open-auto-import">⚡ 智能导入</button>'}
        <span class="date-chip"><span class="dot"></span>今天 · ${todayCN}</span>
      </div>
    </div>

    <div class="stat-strip">
      <div class="strip-item hi"><span class="v">${state.recordStats.total}</span><span class="k">记录总数</span></div>
      <div class="strip-item"><span class="v">${avail.emails}<em>/${state.pools.emails.length}</em></span><span class="k"><span class="dot green"></span>可用邮箱</span></div>
      <div class="strip-item"><span class="v">${avail.cards}<em>/${state.pools.cards.length}</em></span><span class="k"><span class="dot blue"></span>可用付款工具</span></div>
      <div class="strip-item"><span class="v">${avail.licenses}<em>/${state.pools.licenses.length}</em></span><span class="k"><span class="dot amber"></span>可用营业执照</span></div>
      <div class="strip-item"><span class="v">${poolCount('proxies')}<em>/${state.pools.proxies.length}</em></span><span class="k"><span class="dot"></span>可用代理</span></div>
    </div>

    ${
      state.recordStats.total === 0
        ? `<div class="panel"><div class="panel-body"><div class="steps">
            ${[
              { n: '01', t: '导入邮箱', d: '支持「账号——密码——2FA」格式，一行一个，自动拆分入库', k: 'emails' },
              { n: '02', t: '导入代理', d: '粘贴代理商文本块，自动提取 IP、端口、编号、账号密码', k: 'proxies' },
              { n: '03', t: '导入付款工具', d: '工具别名 | 末四位 | 有效期；不接收完整卡号和 CVV', k: 'cards' },
              { n: '04', t: '创建记录', d: '在「新建记录」填写国家/产品/域名，指纹名称按今天日期自动生成', k: 'create' },
            ]
              .map(
                (s) => `<div class="step-card" ${s.k ? `data-action="nav" data-page="${s.k}"` : ''}>
                  <span class="n">STEP ${s.n}</span><h4>${s.t}${s.k ? '<span class="go">→</span>' : ''}</h4><p>${s.d}</p>
                </div>`
              )
              .join('')}
          </div></div></div>`
        : ''
    }

    <div class="panel" id="createPanel">
      <div class="panel-head">
        <div class="panel-title">快速创建 <span class="tag">指纹名称自动生成</span></div>
        <span class="dim" style="font-size:12px">域名一行一个，每行创建一条记录；邮箱 / 付款工具 / 营业执照自动按顺序分配并标记已使用</span>
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
          <div class="field col-3">
            <label>域名 <span class="mini">一行一个，如 nfjh.shop；名称将自动拼成「国家-产品-域名前缀」</span></label>
            <textarea id="f-domains" class="mono" rows="4" placeholder="nfjh.shop&#10;mkxd.shop&#10;wnfh.shop">${esc(f.domains)}</textarea>
          </div>
          <div class="field col-3">
            <label>资源分配 <span class="mini">点击「选择」可手动指定，否则自动从未使用中按顺序取用</span></label>
            <div style="display:flex;flex-direction:column;gap:8px">
              <div class="assign-row">
                <span class="assign-info">✉ 谷歌邮箱：<span id="info-emails">${assignInfo('emails')}</span></span>
                <button type="button" class="btn btn-ghost btn-sm" data-action="open-picker" data-kind="emails">选择</button>
              </div>
              <div class="assign-row">
                <span class="assign-info">▤ 付款工具：<span id="info-cards">${assignInfo('cards')}</span></span>
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
            ${count > avail.cards ? `<span class="warn">⚠ 付款工具仅剩 ${avail.cards} 张</span>` : ''}
          </span>
          <button class="btn btn-primary" data-action="create" ${count === 0 || count > 500 || state.creating ? 'disabled' : ''}>${state.creating ? '创建中' : `立即创建 ${count > 0 ? count + ' 条' : ''}`}</button>
        </div>
      </div>
    </div>

    <div class="panel" id="recordsPanel">
      <div class="panel-head">
        <div class="panel-title">账号记录 <span class="overview-title-count">${state.recordFilteredTotal} / ${state.recordStats.total} 条</span></div>
      </div>
      <div class="toolbar">
        <input class="search" id="rec-q" maxlength="200" aria-label="搜索记录" placeholder="搜索 指纹 / 名称 / 域名 / 邮箱 / 付款工具…" value="${esc(state.q)}">
        <div class="tabs">
          ${['全部', '正常', '异常', '停用'].map((s) => `<button class="tab ${state.rstatus === s ? 'active' : ''}" data-action="rstatus" data-v="${s}">${s}</button>`).join('')}
        </div>
        <span class="sel-count">已选 <b>${state.sel.size}</b> 条</span>
        <button class="btn btn-ghost btn-sm" data-action="clear-record-filter" ${!state.q && state.rstatus === '全部' ? 'disabled' : ''}>清除筛选</button>
         <button class="btn btn-ghost btn-sm table-density-toggle" data-action="toggle-density" aria-label="紧凑表格行距" aria-pressed="${state.tableDensity === 'compact'}" title="仅调整行距，保留当前筛选">${state.tableDensity === 'compact' ? '行距：紧凑' : '行距：标准'}</button>
        <details class="col-menu">
          <summary class="btn btn-ghost btn-sm" aria-label="选择显示的列">列 <span class="dim">${RECORD_COLUMNS.length - state.hiddenCols.length}/${RECORD_COLUMNS.length}</span></summary>
          <div class="col-menu-body">
            <div class="col-preset-actions" role="group" aria-label="列显示预设">
              <button class="btn btn-ghost btn-sm" data-action="preset-cols" data-preset="core">常用列</button>
              <button class="btn btn-ghost btn-sm" data-action="reset-cols" ${state.hiddenCols.length ? '' : 'disabled'}>全部列</button>
            </div>
            ${RECORD_COLUMNS.map((column) => `<label class="col-menu-item"><input type="checkbox" data-action="toggle-col" data-col="${column.key}" ${state.hiddenCols.includes(column.key) ? '' : 'checked'}> ${column.label}</label>`).join('')}
          </div>
        </details>
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
  // 搜索与状态筛选已经下推到 /api/records；这里只返回当前服务端页。
  return state.records;
}

function paginate(items, kind) {
  if (kind === 'records') {
    const pages = Math.max(1, Math.ceil(state.recordFilteredTotal / state.recordLimit));
    state.recordPage = Math.max(1, Math.min(state.recordPage, pages));
    return { items, total: state.recordFilteredTotal, page: state.recordPage, pages };
  }
  const pages = Math.max(1, Math.ceil(items.length / 50));
  state.poolPage = Math.max(1, Math.min(state.poolPage, pages));
  return { items: items.slice((state.poolPage - 1) * 50, state.poolPage * 50), total: items.length, page: state.poolPage, pages };
}

function renderPagination(kind, page) {
  if (page.total <= 50) return '';
  return `<div class="table-pagination"><span role="status">共 ${page.total} 条 · 第 ${page.page} / ${page.pages} 页 · 每页 50 条</span><div>
    <button class="btn btn-ghost btn-sm" data-action="table-page" data-kind="${kind}" data-page="${page.page - 1}" ${page.page <= 1 ? 'disabled' : ''}>上一页</button>
    <button class="btn btn-ghost btn-sm" data-action="table-page" data-kind="${kind}" data-page="${page.page + 1}" ${page.page >= page.pages ? 'disabled' : ''}>下一页</button>
  </div></div>`;
}

function renderRecordsTable(list) {
  if (state.recordStats.total === 0) {
    return `<div class="empty">
      <div class="empty-ico">◧</div>
      <h3>还没有创建记录</h3>
      <p>先导入资源，然后到「新建记录」填写国家 / 产品 / 域名。</p>
    </div>`;
  }
  if (state.recordFilteredTotal === 0 || !list.length) {
    return `<div class="empty"><div class="empty-ico">⌕</div><h3>没有匹配的记录</h3><p>换个关键词或筛选条件试试</p></div>`;
  }
  const page = paginate(list, 'records');
  list = page.items;
  const allChecked = list.length && list.every((r) => state.sel.has(r.id));
  return `<div class="table-wrap"><table class="rec-table">
    <thead><tr>
      <th style="width:34px"><input type="checkbox" data-action="sel-all" aria-label="全选当前页" ${allChecked ? 'checked' : ''}></th>
      <th>指纹名称</th><th>名称</th><th>域名</th><th>谷歌邮箱</th><th>邮箱密码</th><th>2FA</th>
      <th>代理</th><th>付款工具</th><th>IP注册时间</th><th>营业执照</th><th>身份证</th>
      <th>状态</th><th style="width:110px">操作</th>
    </tr></thead>
    <tbody>
      ${list
        .map((r, i) => {
          const proxy = r.proxy_host
            ? `${esc(r.proxy_host)}:${esc(r.proxy_port)}<br><span class="faint mono">${esc(r.proxy_sn || '')}${r.proxy_country ? ' · ' + esc(r.proxy_country) : ''}${r.proxy_ip ? ' · ' + esc(r.proxy_ip) : ''}</span>`
            : '<span class="faint">—</span>';
          const card = r.card_number
            ? `${esc(r.card_number)}<br><span class="faint mono">${esc(r.card_expiry || '')}${r.card_last4 ? ' · ' + esc(r.card_last4) : ''}</span>`
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
            <td class="mono copyable" data-copy="${esc(r.card_number ? `${r.card_number} ${r.card_expiry} ${r.card_last4}` : '')}" title="复制付款工具信息">${card}</td>
            <td class="dim">${esc(r.ip_reg_time) || '<span class="faint">—</span>'}</td>
            <td>${r.license_id ? `<button class="license-link" data-action="view-license" data-id="${r.license_id}">${esc(r.license_name)}</button>` : '<span class="faint">—</span>'}</td>
            <td class="dim">${sens(r.id_card)}</td>
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
    const encoded=JSON.stringify(body);
    if(state.submission?.body !== encoded) state.submission={body:encoded,key:crypto.randomUUID()};
    const res = await api('/api/records', { method: 'POST', headers:{'idempotency-key':state.submission.key}, body });
    state.submission=null;
    const list = res.created;
    toast(`✅ 已创建 ${list.length} 条记录：${list[0].fingerprint}${list.length > 1 ? ' ~ ' + list[list.length - 1].fingerprint : ''}`);
    state.picked = { emails: new Set(), cards: new Set(), licenses: new Set() };
    state.form.domains = '';
    state.form.start_seq = `${fp.prefix}${list[list.length - 1].seq + 1}`;
    await refresh().catch(error=>toast('已保存，但列表刷新失败；请重新连接','warn'));
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
    cols: ['ID', '工具别名', '有效期', '末四位', '状态', '导入时间', '操作'],
    widths: ['60px', '220px', '90px', '80px', '100px', '170px', '70px'],
    row: (c) => [
      `<span class="faint mono">${c.id}</span>`,
      `<span class="mono copyable" data-copy="${esc(c.number)}" title="点击复制">${esc(c.number)}</span>`,
      `<span class="mono copyable" data-copy="${esc(c.expiry)}" title="点击复制">${esc(c.expiry) || '<span class="faint">—</span>'}</span>`,
      `<span class="mono copyable" data-copy="${esc(c.last4)}" title="点击复制">${esc(c.last4)}</span>`,
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

// 规则与示例分开：原来两者挤在同一个等宽块里，示例又都是像真实凭据的长串
// （2FA 密钥、代理商主机、真实格式卡号），既难扫读也容易被误认成已有数据。
const POOL_FORMAT = {
  emails: {
    rule: '一行一条。分隔符支持 ——、—、–、|、Tab、:、;、,、空格；也支持「标签：值」形式，顺序任意。',
    sample: `example@gmail.com——password——JBSWY3DPEHPK3PXP
example2@gmail.com|password|JBSWY3DPEHPK3PXP
邮箱：example3@gmail.com 密码：password 2FA：JBSWY3DPEHPK3PXP`,
  },
  proxies: {
    rule: '粘贴代理商文本块（账号 / 密码 / 主机 / 端口 / 国家等标签行，中英文均可、顺序任意），也可以一行一条。',
    sample: `socks5://user:pass@host:port
user:pass@host:port
host:port:user:pass
host,port,user,pass`,
  },
  cards: {
    rule: '一行一条：付款工具别名|末四位|有效期。不接收完整卡号和 CVV。',
    sample: 'Finance-card-A|1234|06/29\nFinance-card-B|5678|12/29',
  },
  licenses: {
    rule: '一个 PDF 对应一条营业执照记录。选择 PDF 后校对公司名称、法定名称、地址、邮编和城市，再确认保存；未识别的字段可手动填写，原 PDF 会与该条资料一起保存。',
    sample: '',
  },
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
    <code>${esc(POOL_FORMAT[kind].sample || POOL_FORMAT[kind].rule)}</code></div>`;
  if (!list.length) return '<div class="empty"><div class="empty-ico">⌕</div><h3>没有匹配的资源</h3><p>换个关键词或筛选条件试试</p></div>';
  const page = paginate(list, 'pools');
  return `<div class="table-wrap"><table class="pool-table">
    <colgroup>${(table.widths || []).map((width) => `<col${width ? ` style="width:${width}"` : ''}>`).join('')}</colgroup>
    <thead><tr>${table.cols.map((column) => `<th>${column}</th>`).join('')}</tr></thead><tbody>
    ${page.items.map((item, index) => {
      const statusIndex = table.cols.indexOf('状态');
      const linked = Number(item.linked_record_count || 0) > 0;
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
  // 状态数量直接标在筛选标签上：原来上方另有一排大数字卡片，与这里说的是同一件事，白占一块空间。
  const counts = { 全部: state.pools[kind].length, 未使用: poolCount(kind), 已使用: poolCount(kind, '已使用'), 停用: poolCount(kind, '停用') };
  document.getElementById('main').innerHTML = `
    <div class="page-head"><div><h1>${conf.label}</h1><p class="sub">统一管理${conf.label}资源，创建记录时自动分配并标记</p></div>
      <div class="head-actions">${kind === 'emails' || kind === 'proxies' ? '<button class="btn btn-ghost" data-action="open-auto-import">⚡ 智能导入</button>' : ''}
        <button class="btn btn-primary" data-action="open-import" data-kind="${kind}">${kind === 'licenses' ? '导入营业执照' : '批量导入'}</button></div></div>
    <div class="panel"><div class="toolbar">
      <input class="search" id="pool-q" aria-label="搜索资源" placeholder="搜索…" value="${esc(state.poolQ)}">
      <div class="tabs">${['全部', '未使用', '已使用', '停用'].map((status) => `<button class="tab ${state.poolStatus === status ? 'active' : ''}" data-action="pool-status" data-v="${status}">${status}<i class="n">${counts[status]}</i></button>`).join('')}</div>
      <span class="sel-count">${list.length} 条</span>
      <button class="btn btn-ghost btn-sm" data-action="clear-pool-filter" ${!state.poolQ && state.poolStatus === '全部' ? 'disabled' : ''}>清除筛选</button>
      <button class="btn btn-ghost btn-sm table-density-toggle" data-action="toggle-density" aria-label="紧凑表格行距" aria-pressed="${state.tableDensity === 'compact'}" title="仅调整行距，保留当前筛选">${state.tableDensity === 'compact' ? '行距：紧凑' : '行距：标准'}</button></div>${renderPoolTable(kind, list)}</div>`;
}

function renderPoolTableInto() {
  const panel = document.querySelector('#main .panel');
  if (!panel) return;
  const reset=document.querySelector('[data-action="clear-pool-filter"]');
  if(reset) reset.disabled=!state.poolQ&&state.poolStatus==='全部';
  const list = getFilteredPool(state.page);
  panel.querySelectorAll('.table-wrap, .empty, .table-pagination').forEach((element) => element.remove());
  panel.insertAdjacentHTML('beforeend', renderPoolTable(state.page, list));
  enhanceCopyTargets(panel);
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
      <div class="format-hint">
        <p class="format-rule">${esc(POOL_FORMAT[kind].rule)}</p>
        ${POOL_FORMAT[kind].sample ? `<pre class="format-sample">${esc(POOL_FORMAT[kind].sample)}</pre>` : ''}
      </div>
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
        .map((it) => `<li>${esc(Object.entries(it).filter(([k,v])=>v&&!['pass','fakey'].includes(k)).map(([,v])=>v).join(' · '))}</li>`)
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
      await refresh().catch(error=>toast('已保存，但列表刷新失败；请点击重新连接','warn'));
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
      sec('邮箱', '✉', emails, (e) => [e.user,e.pass?'密码已识别':'',e.fakey?'2FA已识别':''].filter(Boolean).join(' · ')) +
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
      await refresh().catch(error=>toast('已保存，但列表刷新失败；请点击重新连接','warn'));
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
  const picked = new Set(state.picked[kind]);
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
    const available = new Set(state.pools[kind].filter(item => item.status === '未使用').map(item => item.id));
    state.picked[kind] = new Set([...picked].filter(id => available.has(id)));
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
        <div class="field col-6"><label>付款工具</label>${poolSelect('cards', r.card_id, 'card_id')}</div>
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
      version:r.version,
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
      await refresh().catch(() => toast('修改已保存，但列表刷新失败；请重新连接，不要重复提交', 'warn'));
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      save.disabled = false;
    }
  };
}

/* ============ 全体重复体检 ============ */

function renderAuditReport(report) {
  const groups = report.groups || [];
  const shared = report.shared_documents || [];
  const summary = `<div class="audit-summary">
    <div><b>${report.scanned}</b><span>扫描营业执照</span></div>
    <div><b>${report.users}</b><span>参与账号</span></div>
    <div class="${groups.length ? 'warn' : 'ok'}"><b>${groups.length}</b><span>重复分组</span></div>
  </div>`;
  if (!groups.length && !shared.length) {
    return `${summary}<p class="audit-empty">没有发现重复。全体成员的营业执照在组织名称、法定名称、CVR 注册号与街道地址上都互不冲突。</p>`;
  }
  const groupHtml = groups.map((group) => `
    <section class="audit-group">
      <header><span class="audit-tag">${esc(group.label)}</span><code>${esc(group.key)}</code></header>
      <ul>${group.members.map((member) => `<li>
        <span class="audit-owner" title="所属账号">${esc(member.owner.display_name || member.owner.username)}</span>
        <span class="grow">${esc(member.name)}${member.cvr ? ` · CVR ${esc(member.cvr)}` : ''}</span>
        ${member.has_pdf ? '<span class="audit-pdf">PDF</span>' : ''}
        <span class="faint">${esc(String(member.created_at || '').slice(0, 10))}</span>
      </li>`).join('')}</ul>
    </section>`).join('');
  const sharedHtml = shared.length ? `
    <section class="audit-group">
      <header><span class="audit-tag warn">同一份原件</span><span class="faint">多条资料引用了同一个 PDF 文件</span></header>
      <ul>${shared.flatMap((doc) => doc.members.map((member) => `<li>
        <span class="audit-owner">${esc(member.owner.display_name || member.owner.username)}</span>
        <span class="grow">${esc(member.name)}</span>
        <span class="faint mono">${esc(String(doc.document_id).slice(0, 10))}…</span>
      </li>`)).join('')}</ul>
    </section>` : '';
  return `${summary}${groupHtml}${sharedHtml}`;
}

/** 扫描全体成员的营业执照，找出任何形式的重复（含「同一份原件被多人引用」）。 */
async function openDuplicateAudit() {
  openModal(`
    <div class="modal-head"><div><span class="license-eyebrow">全体成员</span><h3>营业执照重复体检</h3></div><button class="modal-close" data-action="close-modal" aria-label="关闭">✕</button></div>
    <div class="modal-body" id="audit-body"><p class="audit-empty">正在扫描全体成员的营业执照…</p></div>
    <div class="modal-foot"><span class="grow"></span><button class="btn btn-ghost" data-action="close-modal">关闭</button></div>`, { large: true });
  const body = document.getElementById('audit-body');
  try {
    const report = await api('/api/licenses/duplicates');
    if (body.isConnected) body.innerHTML = renderAuditReport(report);
  } catch (error) {
    if (body.isConnected) body.innerHTML = `<p class="audit-empty">读取失败：${esc(error.message)}</p>`;
  }
}

/** 从备份文件恢复（只影响当前账号）。 */
function openRestoreDialog() {
  openModal(`
    <div class="modal-head"><div><span class="license-eyebrow">个人数据</span><h3>从备份恢复</h3></div><button class="modal-close" data-action="close-modal" aria-label="关闭">✕</button></div>
    <div class="modal-body">
      <div class="license-upload">
        <strong>只恢复你自己的数据</strong>
        <p>恢复会覆盖当前账号下的资源与记录，不会影响其他成员。请选择本工作台导出的备份文件；恢复前建议先「导出备份」留一份当前数据。</p>
        <input type="file" id="restore-file" accept=".json,application/json">
        <span id="restore-status" role="status">尚未选择文件</span>
      </div>
    </div>
    <div class="modal-foot"><span class="grow"></span><button class="btn btn-ghost" data-action="close-modal">取消</button><button class="btn btn-danger" id="restore-go" disabled>确认恢复</button></div>`);
  const input = document.getElementById('restore-file');
  const status = document.getElementById('restore-status');
  const go = document.getElementById('restore-go');
  let parsed = null;
  input.onchange = async () => {
    parsed = null;
    go.disabled = true;
    const file = input.files[0];
    if (!file) { status.textContent = '尚未选择文件'; return; }
    if (file.size > 64 * 1024 * 1024) { status.textContent = '文件超过 64 MB，无法恢复'; input.value = ''; return; }
    try {
      parsed = JSON.parse(await file.text());
      if(parsed.format!=='adsworkbench-backup'||parsed.version!==2) throw new Error('Invalid backup format');
      const records = Number(parsed.counts?.records)||0;
      const licenses = Number(parsed.counts?.licenses)||0;
      status.textContent = `已读取：记录 ${records} 条 · 营业执照 ${licenses} 条，确认后将覆盖当前账号数据`;
      go.disabled = false;
    } catch {
      status.textContent = '这个文件不是有效的备份（JSON 解析失败）';
      input.value = '';
    }
  };
  go.onclick = async () => {
    if (!parsed || go.disabled) return;
    go.disabled = true;
    go.textContent = '正在恢复…';
    try {
      const result = await api('/api/backup/restore', { method: 'POST', body: parsed });
      toast(`恢复完成：记录 ${result.records} 条、营业执照 ${result.licenses} 条`);
      if (go.isConnected) closeModal();
      await refreshAfterCommit('恢复已完成，但列表刷新失败；请重新连接，不要重复恢复');
    } catch (error) {
      toast(error.message, 'error');
      go.disabled = false;
      go.textContent = '确认恢复';
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
        const prev = state.page;
        const next = t.dataset.page;
        if (KINDS.some(k => k.key === prev)) state.poolFilters[prev] = {q:state.poolQ,status:state.poolStatus,page:state.poolPage};
        state.page = next;
        if (KINDS.some(k => k.key === next)) {
          const f = state.poolFilters[next];
          state.poolQ = f.q; state.poolStatus = f.status; state.poolPage = f.page;
        }
        render();
        break;
      }
      case 'jump-status':
        state.page = 'records'; state.rstatus = t.dataset.status; state.q = ''; state.recordPage = 1;
        await loadRecordsPage();
        render();
        document.querySelector('#rec-q')?.focus({preventScroll:true});
        break;
      case 'recent-record': {
        const recent = state.recentRecords.find(r => r.id === Number(t.dataset.id));
        state.q = recent?.fingerprint || '';
        state.rstatus = '全部'; state.recordPage = 1; state.page = 'records';
        await loadRecordsPage();
        render();
        document.querySelector('#rec-q')?.focus({preventScroll:true});
        break;
      }
      case 'clear-record-filter':
        state.q = ''; state.rstatus = '全部'; state.recordPage = 1;
        await loadRecordsPage();
        render();
        break;
      case 'clear-pool-filter':
        state.poolQ = ''; state.poolStatus = '全部'; state.poolPage = 1;
        state.poolFilters[state.page] = {q:'',status:'全部',page:1};
        render();
        break;
      case 'modal-overlay': {
        if (e.target === t) closeModal();
        break;
      }
      case 'close-modal':
        closeModal();
        break;
      case 'toggle-reveal':
        if(state.reveal) await lockSensitive();
        else if(await ensureSensitive()) {state.reveal=true;await refresh();}
        break;
      case 'my-audit':
        await showMyAudit();break;
      case 'change-password':
        showChangePassword();break;
      case 'duplicate-audit':
        await openDuplicateAudit();
        break;
      case 'web-backup':
        // 走一次同源导航触发下载：Cookie 会自动带上，浏览器停留在当前页面
        if(!await ensureSensitive()) break;
        const backupResponse=await fetch('/api/backup',{headers:{'x-workbench':'1'},signal:AbortSignal.timeout(60000)});
        if(!backupResponse.ok) throw new Error('备份导出失败，请重新解锁后重试');
        download('AdsWorkbench-'+todayKey()+'.json',await backupResponse.text(),'application/json');
        toast('正在导出备份…');
        break;
      case 'web-restore':
        if(!await ensureSensitive()) break;
        openRestoreDialog();
        break;
      case 'logout': {
        if (t.disabled) break;
        t.disabled = true;
        try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* 无论成败都回登录页 */ }
        location.replace('/login.html');
        break;
      }
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
        await loadRecordsPage();
        render();
        break;
      case 'toggle-density': {
        state.tableDensity = state.tableDensity === 'compact' ? 'standard' : 'compact';
        try { localStorage.setItem('ads-workbench-table-density', state.tableDensity); } catch { /* optional preference */ }
        document.body.dataset.tableDensity = state.tableDensity;
        for (const button of document.querySelectorAll('[data-action="toggle-density"]')) {
          button.setAttribute('aria-pressed', String(state.tableDensity === 'compact'));
          button.textContent = state.tableDensity === 'compact' ? '行距：紧凑' : '行距：标准';
        }
        break;
      }
      case 'preset-cols':
        if (t.dataset.preset === 'core') {
          state.hiddenCols = ['emailPass','fakey','ipreg','idcard'];
          saveHiddenCols();
          render();
        }
        break;
      case 'reset-cols':
        state.hiddenCols = [];
        saveHiddenCols();
        render();
        break;
      case 'pool-status':
        state.poolStatus = t.dataset.v;
        state.poolPage = 1;
        state.poolFilters[state.page] = {q:state.poolQ,status:state.poolStatus,page:1};
        render();
        break;
      case 'table-page':
        if (t.dataset.kind === 'records') {
          state.recordPage = Number(t.dataset.page);
          await loadRecordsPage({ renderMode: 'table' });
        } else {
          state.poolPage = Number(t.dataset.page); state.poolFilters[state.page].page = state.poolPage; renderPoolTableInto();
        }
        break;
      case 'export-adspower': {
        if(!await ensureSensitive('此导出包含邮箱和代理凭据，请安全保存文件。')) break;
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
          await refreshAfterCommit('记录已删除，但列表刷新失败；请重新连接，不要重复删除');
        });
        break;
      }
      case 'del-record': {
        const id = Number(t.dataset.id);
        confirmModal('删除记录', '删除后关联的邮箱 / 付款工具 / 营业执照会自动释放回「未使用」。', async () => {
          await api(`/api/records/${id}`, { method: 'DELETE' });
          state.sel.delete(id);
          toast('已删除');
          await refreshAfterCommit('记录已删除，但列表刷新失败；请重新连接，不要重复删除');
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
          await refreshAfterCommit('资源已删除，但列表刷新失败；请重新连接，不要重复删除');
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
      const item = state.pools[t.dataset.kind].find(r=>r.id===Number(t.dataset.id));
      await api(`/api/pool/${t.dataset.kind}/${t.dataset.id}`, { method: 'PATCH', body: { status: t.value, version: item?.version } });
      toast('状态已更新');
      await refreshAfterCommit('状态已更新，但列表刷新失败；请重新连接，不要重复修改');
    } else if (action === 'rec-status') {
      const record = state.records.find(r=>r.id===Number(t.dataset.id));
      await api(`/api/records/${t.dataset.id}`, { method: 'PATCH', body: { status: t.value, version: record?.version } });
      toast('状态已更新');
      await refreshAfterCommit('状态已更新，但列表刷新失败；请重新连接，不要重复修改');
    } else if (action === 'toggle-col') {
      const key = t.dataset.col;
      if (RECORD_COLUMNS.some((column) => column.key === key)) {
        state.hiddenCols = t.checked ? state.hiddenCols.filter((k) => k !== key) : [...state.hiddenCols, key];
        saveHiddenCols();
        // 只重算列可见性，不做整体 render：整体重建会把 <details> 收起，变成一次只能勾一列
        applyColumnVisibility();
        const counter = document.querySelector('.col-menu summary .dim');
        if (counter) counter.textContent = `${RECORD_COLUMNS.length - state.hiddenCols.length}/${RECORD_COLUMNS.length}`;
      }
    } else if (action === 'sel-row') {
      const id = Number(t.dataset.id);
      if (t.checked) state.sel.add(id);
      else state.sel.delete(id);
      refreshSelectionUI();
    } else if (action === 'sel-all') {
      const list = state.records;
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
    clearTimeout(recordSearchTimer);
    recordSearchTimer = setTimeout(() => {
      loadRecordsPage({ renderMode: 'table' }).catch((error) => toast(error.message, 'error'));
    }, 250);
  } else if (e.target.id === 'pool-q') {
    state.poolQ = e.target.value;
    state.poolPage = 1;
    state.poolFilters[state.page] = {q:state.poolQ,status:state.poolStatus,page:1};
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
  if (count > avail.cards) warns.push(`⚠ 付款工具仅剩 ${avail.cards} 张`);
  const span = preview.querySelector('span');
  warns.forEach((w) => {
    const el = document.createElement('span');
    el.className = 'warn';
    el.textContent = ' ' + w;
    span.appendChild(el);
  });
}

function renderRecordsTableInto(input) {
  const reset=document.querySelector('[data-action="clear-record-filter"]');
  if(reset) reset.disabled=!state.q&&state.rstatus==='全部';
  // 只刷新表格部分，保持搜索框焦点
  const panels = document.querySelectorAll('#main .panel');
  const tablePanel = panels[panels.length - 1];
  if (!tablePanel) return;
  const old = tablePanel.querySelector('.table-wrap, .empty');
  if (old) old.remove();
  tablePanel.querySelector('.table-pagination')?.remove();
  tablePanel.insertAdjacentHTML('beforeend', renderRecordsTable(getFilteredRecords()));
  enhanceCopyTargets(tablePanel);
  const count = tablePanel.querySelector('.overview-title-count');
  if (count) count.textContent = `${state.recordFilteredTotal} / ${state.recordStats.total} 条`;
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
    const visible = state.records;
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
  if (!state.loaded) main.innerHTML = '<section class="connection-panel" role="status"><span class="connection-spinner" aria-hidden="true"></span><h1>正在打开工作台</h1><p>正在读取你的记录和资源</p></section>';
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
  // 桌面版用自己的原生备份/恢复（可写文件、可打开数据目录），隐藏网页版入口
  const webTools = document.getElementById('webTools');
  if (webTools) webTools.hidden = true;
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
