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
    state.syncError = warning;
    renderSyncNotice();
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
  const opener = document.activeElement;
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement('textarea');
    let copied = false;
    try {
      ta.value = t;
      ta.readOnly = true;
      ta.style.cssText = 'position:fixed;inset:0 auto auto 0;opacity:0';
      // Keep the fallback within the dialog when the app background is inert.
      (document.querySelector('#modal-root .modal') || document.body).appendChild(ta);
      ta.select();
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    } finally {
      ta.remove();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    }
    if (!copied) return toast('复制未完成，请检查剪贴板权限或手动复制', 'warn');
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
  { key: 'cards', label: '付款工具库', ico: '▤' },
  { key: 'licenses', label: '营业执照', ico: '§' },
];

const state = {
  page: 'records',
  pools: { emails: [], proxies: [], cards: [], licenses: [] },
  // records 只保存当前服务端分页，不再缓存当前账号的全部记录。
  records: [],
  recordFilteredTotal: 0,
  recordStats: { total: 0, 正常: 0, 异常: 0, 停用: 0 },
  recentRecords: [],
  recordLimit: 50,
  recordSort: 'id_desc',
  recordsPhase: 'ready',
  recordError: '',
  syncError: '',
  lastSyncedAt: null,
  next: null,
  reveal: false,
  unlockedUntil: 0,
  sensitiveEpoch: 0,
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
  startSeqAutomatic: true,
  recordPage: 1,
  poolPage: 1,
  // 列显隐偏好（方案工作包 06）：只存「哪些列被隐藏」这类列名，不存任何字段值。
  hiddenCols: [],
  tableDensity: 'comfortable',
};

const MASK = '••••••';
let recordRequestSeq = 0;
let recordSearchTimer = null;
let recordController = null;
let refreshRequestSeq = 0;

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

const densityKey = () => `wb.tableDensity.${state.user?.username || 'anonymous'}`;
function loadTableDensity() {
  try { return localStorage.getItem(densityKey()) === 'compact' ? 'compact' : 'comfortable'; }
  catch { return 'comfortable'; }
}
function saveTableDensity() {
  try { localStorage.setItem(densityKey(), state.tableDensity); } catch { /* 非关键显示偏好 */ }
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

function openModal(html, options) { WorkbenchUI.dialog.open(html, options); }
function closeModal() { WorkbenchUI.dialog.close(); }

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
  // 删除确认默认停在取消，避免打开后按 Enter 直接执行危险操作。
  document.querySelector('#modal-root [data-action="close-modal"].btn')?.focus();
  confirm.onclick = async () => {
    if (confirm.disabled) return;
    WorkbenchUI.dialog.pending(confirm, true, '正在处理…');
    try {
      await onOk();
      if (confirm.isConnected) closeModal();
    } catch (err) {
      WorkbenchUI.dialog.error(confirm, err.message || '操作失败');
    } finally {
      WorkbenchUI.dialog.pending(confirm, false);
    }
  };
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
        <span class="ico">${WorkbenchUI.icon(it.key)}</span>${it.label}
        ${it.count !== '' ? `<span class="count">${it.count}</span>` : ''}
      </button>`;
  document.getElementById('nav').innerHTML = `
    <div class="nav-label">工作台</div>
    ${main.map(item).join('')}
    <div class="nav-label">资源库</div>
    ${pools.map(item).join('')}
    <div class="nav-label">工作空间</div>
    ${item({ key: 'settings', label: '设置与维护', ico: '⚙', count: '' })}
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
  const main = document.getElementById('main');
  const restoreView = WorkbenchUI.preserveView(main);
  // 页面键写到 main 上：「我的记录」与「新建记录」共用同一份渲染与统计条，
  // 由 CSS 决定露出哪一块面板，避免把资源统计复制成两份、后续改漏一边。
  if (main) main.className = `main page-${state.page}`;
  renderNav();
  renderAccount();
  if (state.page === 'overview') renderOverview();
  else if (state.page === 'settings') renderSettings();
  else if (state.page === 'records' || state.page === 'create') { renderWorkbench(); refreshSelectionUI(); }
  else renderPool(state.page);
  // 列偏好是全局样式规则，与记录表是否刚被重建无关
  applyColumnVisibility();
  document.body.classList.toggle('table-compact', state.tableDensity === 'compact');
  renderSyncNotice();
  updateRecordsChrome();
  bindLabels();
  restoreView();
}

function renderSyncNotice() {
  document.getElementById('syncNotice')?.remove();
  if (!state.syncError) return;
  const main = document.getElementById('main');
  main.insertAdjacentHTML('afterbegin', `<div class="sync-notice" id="syncNotice" role="alert"><div><b>当前显示的是上次读取的数据</b><p>${esc(state.syncError)}</p></div><button class="btn btn-ghost btn-sm" data-action="retry-load">重新连接</button></div>`);
}

// 在防抖开始时立即作废旧查询，而不是等到下一次 fetch 发出才作废。
function invalidateRecordQuery() {
  clearTimeout(recordSearchTimer);
  recordSearchTimer = null;
  ++recordRequestSeq;
  recordController?.abort();
  state.recordsPhase = 'loading';
  state.recordError = '';
  updateRecordsChrome();
}

function updateRecordsChrome() {
  const panel = document.querySelector('.page-records #recordsPanel');
  if (!panel) return;
  const pending = state.recordsPhase === 'loading';
  const unavailable = state.recordsPhase !== 'ready';
  panel.setAttribute('aria-busy', String(pending));
  panel.classList.toggle('records-stale', unavailable);
  const feedback = panel.querySelector('#recordsFeedback');
  if (feedback) {
    feedback.hidden = !unavailable;
    feedback.classList.toggle('query-error', state.recordsPhase === 'error');
    feedback.querySelector('[data-feedback-text]').textContent = state.recordsPhase === 'error'
      ? `查询失败：${state.recordError}。下方仍为上次结果。`
      : '正在查询最新记录，下方结果更新前暂不可操作…';
    feedback.querySelector('button').hidden = state.recordsPhase !== 'error';
  }
  panel.querySelectorAll('.table-wrap').forEach(wrap => { wrap.inert = unavailable; });
  panel.querySelectorAll('[data-action="rstatus"]').forEach(button => {
    const active = button.dataset.v === state.rstatus;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const reset = panel.querySelector('[data-action="clear-record-filter"]');
  if (reset) reset.disabled = !state.q && state.rstatus === '全部';
  panel.querySelectorAll('.table-pagination button').forEach(button => {
    button.disabled = unavailable || button.dataset.disabled === 'true';
  });
  panel.querySelectorAll('[data-action^="export-"]').forEach(button => {
    button.disabled = unavailable || !state.recordStats.total;
  });
  const del = panel.querySelector('[data-action="delete-selected"]');
  if (del) del.disabled = unavailable || !state.sel.size;
}

async function loadRecordsPage({ renderMode = 'none' } = {}) {
  clearTimeout(recordSearchTimer);
  recordSearchTimer = null;
  recordController?.abort();
  const controller = new AbortController();
  recordController = controller;
  const requestId = ++recordRequestSeq;
  const reveal = state.reveal;
  state.recordsPhase = 'loading';
  state.recordError = '';
  updateRecordsChrome();
  const params = new URLSearchParams();
  params.set('limit', String(state.recordLimit));
  params.set('offset', String(Math.max(0, (state.recordPage - 1) * state.recordLimit)));
  params.set('sort', state.recordSort);
  if (state.q.trim()) params.set('q', state.q.trim());
  if (state.rstatus !== '全部') params.set('status', state.rstatus);
  if (state.reveal) params.set('reveal', '1');

  let data;
  try {
    data = await api('/api/records?' + params.toString(), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
    if (requestId !== recordRequestSeq || reveal !== state.reveal) return false;
    if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(Number(data.total)) || Number(data.total) < 0) {
      throw new Error('记录分页数据格式不正确');
    }
  } catch (error) {
    if (requestId !== recordRequestSeq || reveal !== state.reveal) return false;
    state.recordsPhase = 'error';
    state.recordError = error.message;
    updateRecordsChrome();
    throw error;
  }

  const total = Number(data.total);
  const pages = Math.max(1, Math.ceil(total / state.recordLimit));
  if (state.recordPage > pages) {
    state.recordPage = pages;
    return loadRecordsPage({ renderMode });
  }

  state.records = data.items;
  state.recordFilteredTotal = total;
  state.recordsPhase = 'ready';
  state.recordError = '';

  if (renderMode === 'table' && state.page === 'records') renderRecordsTableInto();
  else if (renderMode === 'full') render();
  updateRecordsChrome();
  return true;
}

async function refresh() {
  const requestId = ++refreshRequestSeq;
  if(state.reveal && state.unlockedUntil<=Date.now()) state.reveal=false;
  const query = new URLSearchParams({ summary: '1' });
  if (state.reveal) query.set('reveal', '1');
  const reveal = state.reveal;
  const data = await api('/api/bootstrap?' + query.toString());
  if (requestId !== refreshRequestSeq || reveal !== state.reveal) return false;
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
  state.tableDensity = loadTableDensity();

  for (const kind of Object.keys(state.picked)) {
    const available = new Set(data.pools[kind].filter((item) => item.status === '未使用').map((item) => item.id));
    state.picked[kind] = new Set([...state.picked[kind]].filter((id) => available.has(id)));
  }
  if (state.form.proxy_id && !data.pools.proxies.some((proxy) => String(proxy.id) === String(state.form.proxy_id) && proxy.status !== '停用')) state.form.proxy_id = '';
  state.next = data.next;
  if (state.startSeqAutomatic || !state.form.start_seq) state.form.start_seq = data.next.seq;

  const current = await loadRecordsPage();
  if (!current || requestId !== refreshRequestSeq || reveal !== state.reveal) return false;
  state.loaded = true;
  state.syncError = '';
  state.lastSyncedAt = new Date();
  if (state.recordStats.total === 0) state.sel.clear();

  render();
  bindLabels();
  const connection = document.getElementById('connectionStatus');
  if (connection) { connection.textContent = '已连接'; connection.className = 'connection-status connected'; }
  return true;
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
      <span class="overview-resource-icon" aria-hidden="true">${ico}</span>
      <span class="overview-resource-name">${label}<small>管理和导入资源</small></span>
      <b class="overview-resource-count ${poolCount(kind) === 0 ? 'overview-danger' : ''}">${poolCount(kind)}<small>可用</small></b>
      <span class="overview-arrow" aria-hidden="true">↗</span>
    </button>`).join('');
  document.getElementById('main').innerHTML = `
    <div class="page-head">
      <div><h1>运营总览</h1><p class="sub">账号状态、资源库存、待办事项 · 当前账号可见范围</p></div>
      <div class="head-actions"><button class="btn btn-ghost" data-action="open-auto-import">智能导入</button>
      <button class="btn btn-primary" data-action="nav" data-page="create">创建账号记录</button></div>
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
        <span class="overview-recent-icon" aria-hidden="true">◧</span>
        <span class="overview-recent-name"><b>${esc(r.fingerprint)}</b><small>${esc(r.country || '未填国家')} · ${esc(r.product || '未填产品')} · ${esc(r.domain || '未填域名')}</small></span>
        ${WorkbenchUI.status(r.status, r.status === '正常' ? 'success' : r.status === '异常' ? 'danger' : 'neutral')}
        <button class="btn btn-ghost btn-sm" data-action="recent-record" data-id="${r.id}">查看</button>
      </div>`).join('') : '<div class="empty"><h3>还没有账号记录</h3><p>从创建账号记录开始。</p><button class="btn btn-primary" data-action="nav" data-page="create">开始创建</button></div>'}
    </section>`;
}

/* ============ 工作台 ============ */

function renderSettings() {
  const local = Boolean(window.desktop);
  const synced = state.lastSyncedAt ? state.lastSyncedAt.toLocaleString('zh-CN', { hour12: false }) : '尚未完成';
  document.getElementById('main').innerHTML = `
    <div class="page-head"><div><h1>设置与维护</h1><p class="sub">管理工作空间、显示偏好和本人的数据。</p></div></div>
    <div class="settings-grid">
      <section class="panel"><div class="panel-head"><h2 class="panel-title">连接与显示</h2></div><div class="panel-body settings-stack">
        <dl class="settings-facts"><div><dt>运行方式</dt><dd>${local ? '本机桌面工作台' : '服务器工作台'}</dd></div><div><dt>上次成功同步</dt><dd>${esc(synced)}</dd></div><div><dt>数据范围</dt><dd>当前账号的记录与资源</dd></div></dl>
        <div class="settings-row"><div><b>同步最新数据</b><p>重新读取记录、资源和占用状态。快捷键 Ctrl+R。</p></div><button class="btn btn-ghost" data-action="retry-load">重新连接</button></div>
        <div class="settings-row"><div><b>表格行距</b><p>按当前账号保存，仅影响显示。</p></div><button class="btn btn-ghost" data-action="toggle-density" aria-pressed="${state.tableDensity === 'compact'}">${state.tableDensity === 'compact' ? '紧凑模式' : '舒适模式'}</button></div>
        <p class="settings-hint">快捷键：Ctrl+K 搜索当前列表，Esc 关闭弹窗或列菜单。</p>
      </div></section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">数据备份与恢复</h2></div><div class="panel-body settings-stack">
        <div class="settings-row"><div><b>导出备份</b><p>保存记录与资源，备份文件请妥善保管。</p></div><button class="btn btn-ghost" data-action="${local ? 'desktop' : 'web'}-backup">导出备份</button></div>
        ${local ? '<div class="settings-row"><div><b>本机数据目录</b><p>查看桌面程序保存的数据文件。</p></div><button class="btn btn-ghost" data-action="desktop-data">打开目录</button></div>' : ''}
        <div class="settings-row settings-danger"><div><b>从备份恢复</b><p>会替换当前账号的数据。请先导出当前备份，再核对恢复内容。</p></div><button class="btn btn-danger" data-action="${local ? 'desktop' : 'web'}-restore">恢复备份</button></div>
      </div></section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">数据一致性</h2></div><div class="panel-body settings-stack">
        <div class="settings-row"><div><b>记录关联检查</b><p>逐批检查历史关联、字段差异和重复占用，核对后逐项处理。</p></div><button class="btn btn-ghost" data-action="check-integrity">检查本人数据</button></div>
        <p class="settings-hint">检查不会修改数据；修复需临时授权、核对差异并确认。历史归属不明确时由你重新选择资源。</p>
      </div></section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">账号安全</h2></div><div class="panel-body settings-stack">
        <div class="settings-row"><div><b>我的安全操作记录</b><p>查看本人最近的解锁、导出与数据操作。</p></div><button class="btn btn-ghost" data-action="my-audit">查看记录</button></div>
        ${local ? '<p class="settings-hint">敏感信息通过左侧入口临时显示，离开窗口或授权过期后自动隐藏。</p>' : '<div class="settings-row"><div><b>登录密码</b><p>修改后所有设备需要重新登录。</p></div><button class="btn btn-ghost" data-action="change-password">修改密码</button></div>'}
      </div></section>
    </div>`;
}

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
      return `<select id="f-proxy" aria-label="共享代理">${proxyOptions}</select>`;
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
          ? '<button class="btn btn-primary" data-action="open-auto-import">智能导入</button>'
          : '<button class="btn btn-primary" data-action="nav" data-page="create">新建记录</button><button class="btn btn-ghost" data-action="open-auto-import">智能导入</button>'}
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
            <textarea id="f-domains" class="mono" rows="4" aria-describedby="create-domain-error" placeholder="nfjh.shop&#10;mkxd.shop&#10;wnfh.shop">${esc(f.domains)}</textarea>
            <p class="field-error" id="create-domain-error" role="status" hidden></p>
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
                  <select id="f-proxy-mode" aria-label="代理分配方式" style="flex:0 0 auto">
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
        <p class="field-error" id="create-validation" role="alert" tabindex="-1" hidden></p>
        <div class="create-preview">
          <span>本次将创建 <b>${count || 0}</b> 条记录，指纹名称：<span class="fp">${esc(fpPreview)}</span>
            ${count > avail.emails ? `<span class="warn">⚠ 邮箱仅剩 ${avail.emails} 条</span>` : ''}
            ${count > avail.cards ? `<span class="warn">⚠ 付款工具仅剩 ${avail.cards} 张</span>` : ''}
          </span>
          <button class="btn btn-primary" data-action="create" ${count === 0 || count > 500 || state.creating ? 'disabled' : ''}>${state.creating ? '创建中' : `核对并创建 ${count > 0 ? count + ' 条' : ''}`}</button>
        </div>
      </div>
    </div>

    <div class="panel" id="recordsPanel">
      <div class="panel-head">
        <div class="panel-title">账号记录 <span class="overview-title-count">${state.recordFilteredTotal} / ${state.recordStats.total} 条</span></div>
      </div>
      <div class="toolbar record-toolbar">
        <div class="record-filter-row">
        <input class="search" id="rec-q" maxlength="200" aria-label="搜索记录" placeholder="搜索 指纹 / 名称 / 域名 / 邮箱 / 付款工具…" value="${esc(state.q)}">
        <div class="tabs">
          ${['全部', '正常', '异常', '停用'].map((s) => `<button class="tab ${state.rstatus === s ? 'active' : ''}" aria-pressed="${state.rstatus === s}" data-action="rstatus" data-v="${s}">${s}<i class="n">${s === '全部' ? state.recordStats.total : state.recordStats[s]}</i></button>`).join('')}
        </div>
        <span class="sel-count">已选 <b>${state.sel.size}</b> 条</span>
        <button class="btn btn-ghost btn-sm" data-action="clear-record-filter" ${!state.q && state.rstatus === '全部' ? 'disabled' : ''}>清除筛选</button>
        </div><div class="record-tools-row">
        <label class="toolbar-field">排序<select id="rec-sort" aria-label="记录排序">${[['id_desc','最新记录在前'],['id_asc','最早记录在前'],['created_desc','创建时间从新到旧'],['created_asc','创建时间从旧到新']].map(([value,label]) => `<option value="${value}" ${state.recordSort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <details class="col-menu">
          <summary class="btn btn-ghost btn-sm" aria-label="选择显示的列">列 <span class="dim">${RECORD_COLUMNS.length - state.hiddenCols.length}/${RECORD_COLUMNS.length}</span></summary>
          <div class="col-menu-body">
            ${RECORD_COLUMNS.map((column) => `<label class="col-menu-item"><input type="checkbox" data-action="toggle-col" data-col="${column.key}" ${state.hiddenCols.includes(column.key) ? '' : 'checked'}> ${column.label}</label>`).join('')}
            <button class="btn btn-ghost btn-sm" data-action="reset-cols" ${state.hiddenCols.length ? '' : 'disabled'}>恢复默认列</button>
          </div>
        </details>
        <button class="btn btn-ghost btn-sm" data-action="toggle-density" aria-pressed="${state.tableDensity === 'compact'}" title="切换记录表格行距">${state.tableDensity === 'compact' ? '紧凑模式' : '舒适模式'}</button>
        <span class="toolbar-spacer"></span>
        <button class="btn btn-ghost btn-sm" data-action="export-adspower">导出 AdsPower TXT</button>
        <button class="btn btn-ghost btn-sm" data-action="export-csv">导出 CSV</button>
        <button class="btn btn-danger btn-sm" data-action="delete-selected" ${state.sel.size === 0 ? 'disabled' : ''}>删除所选</button>
        </div>
      </div>
      <div class="selection-bar" id="selectionBar" ${state.sel.size ? '' : 'hidden'}><p class="selection-scope" role="status"></p><button class="btn btn-ghost btn-sm" data-action="clear-selection">清空选择</button></div>
      <div class="query-feedback" id="recordsFeedback" role="status" hidden><span data-feedback-text></span><button class="btn btn-ghost btn-sm" data-action="retry-records">重试查询</button></div>
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
  const limit = kind === 'records' ? state.recordLimit : 50;
  return `<div class="table-pagination"><span role="status">共 ${page.total} 条 · 第 ${page.page} / ${page.pages} 页 · 每页 ${limit} 条</span><div>
    ${kind === 'records' ? `<label class="toolbar-field">每页<select id="rec-limit" aria-label="每页记录数">${[25,50,100,200].map(value => `<option value="${value}" ${limit === value ? 'selected' : ''}>${value} 条</option>`).join('')}</select></label>` : ''}
    <button class="btn btn-ghost btn-sm" data-action="table-page" data-kind="${kind}" data-page="${page.page - 1}" data-disabled="${page.page <= 1}" ${page.page <= 1 ? 'disabled' : ''}>上一页</button>
    <button class="btn btn-ghost btn-sm" data-action="table-page" data-kind="${kind}" data-page="${page.page + 1}" data-disabled="${page.page >= page.pages}" ${page.page >= page.pages ? 'disabled' : ''}>下一页</button>
  </div></div>`;
}

function renderRecordsTable(list) {
  if (state.recordStats.total === 0) {
    return `<div class="empty">
      <div class="empty-ico">◧</div>
      <h3>还没有创建记录</h3>
      <p>先导入资源，然后到「新建记录」填写国家 / 产品 / 域名。</p>
      <button class="btn btn-primary" data-action="nav" data-page="create">新建第一条记录</button>
    </div>`;
  }
  if (state.recordFilteredTotal === 0 || !list.length) {
    return `${WorkbenchUI.emptyState({title:'没有匹配的记录',description:'换个关键词或筛选条件试试。',iconName:'search',action:'reset-record-search',actionLabel:'清除筛选'})}`;
  }
  const page = paginate(list, 'records');
  list = page.items;
  const allChecked = list.length && list.every((r) => state.sel.has(r.id));
  return `<p class="table-help">横向滚动查看全部字段 · 指纹名称固定在左侧 · 全选仅作用于当前页</p><div class="table-wrap" tabindex="0" role="region" aria-label="账号记录表格，可横向滚动"><table class="rec-table">
    <thead><tr>
      <th><input type="checkbox" data-action="sel-all" aria-label="全选当前页" ${allChecked ? 'checked' : ''}></th>
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
            <td><input type="checkbox" data-action="sel-row" data-id="${r.id}" aria-label="选择记录 ${esc(r.fingerprint)}" ${state.sel.has(r.id) ? 'checked' : ''}></td>
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
              <select aria-label="记录 ${esc(r.fingerprint)} 状态" class="status-select ${r.status === '正常' ? 's-green' : r.status === '异常' ? 's-red' : 's-blue'}" data-action="rec-status" data-id="${r.id}">
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

function createDraft() {
  const domains = state.form.domains.split(/\r?\n/).map(value => value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean);
  const fp = parseFpStart(state.form.start_seq);
  let error = '', field = '';
  if (!domains.length) { error = '请至少填写一个域名。'; field = 'f-domains'; }
  else if (domains.length > 500) { error = '单次最多创建 500 条记录，请减少域名数量。'; field = 'f-domains'; }
  else if (new Set(domains).size !== domains.length) { error = '域名存在重复（大小写、网址前缀和路径会先统一处理），请核对后再创建。'; field = 'f-domains'; }
  else if (!Number.isSafeInteger(fp.seq) || fp.seq < 1 || !Number.isSafeInteger(fp.seq + domains.length)) { error = '指纹起始编号必须是有效的正整数。'; field = 'f-start'; }
  for (const kind of ['emails', 'cards', 'licenses', ...(state.form.proxy_mode === 'auto' ? ['proxies'] : [])]) {
    if (!error && state.pools[kind].length && poolCount(kind) < domains.length) {
      error = `${KINDS.find(item => item.key === kind).label}可用资源不足：需要 ${domains.length} 条，当前可用 ${poolCount(kind)} 条。请先补充资源或减少创建数量。`;
    }
  }
  return { error, field, fp, body: {
    country: state.form.country, product: state.form.product, domains,
    start_seq: fp.seq, fp_prefix: fp.prefix, date_key: todayKey(),
    ip_reg_time: state.form.ip_reg_time, id_card: state.form.id_card,
    proxy_mode: state.form.proxy_mode,
    proxy_id: state.form.proxy_mode === 'shared' && state.form.proxy_id ? Number(state.form.proxy_id) : undefined,
    email_ids: [...state.picked.emails].map(Number), card_ids: [...state.picked.cards].map(Number), license_ids: [...state.picked.licenses].map(Number),
  } };
}

function showCreateValidation(draft, focus = false) {
  for (const id of ['f-domains', 'f-start']) document.getElementById(id)?.removeAttribute('aria-invalid');
  const domainError = document.getElementById('create-domain-error');
  const generalError = document.getElementById('create-validation');
  [domainError, generalError].forEach(element => { if (element) { element.hidden = true; element.textContent = ''; } });
  if (!draft.error) return;
  const box = draft.field === 'f-domains' ? domainError : generalError;
  if (box) { box.textContent = draft.error; box.hidden = false; }
  if (draft.field) document.getElementById(draft.field)?.setAttribute('aria-invalid', 'true');
  if (focus) (document.getElementById(draft.field) || box)?.focus();
}

function openCreateReview() {
  if (state.creating) return;
  const draft = createDraft();
  showCreateValidation(draft, true);
  if (draft.error) return;
  const count = draft.body.domains.length;
  const resourceRows = ['emails','cards','licenses'].map(kind => {
    const picked = state.picked[kind].size;
    const mode = !state.pools[kind].length ? '库内为空，本次不关联' : picked ? `手动指定 ${Math.min(picked, count)} 条${picked < count ? `，其余 ${count - picked} 条自动分配` : ''}` : `自动分配 ${count} 条`;
    return `<tr><th>${KINDS.find(item => item.key === kind).label}</th><td>${mode}</td></tr>`;
  }).join('');
  const proxy = draft.body.proxy_mode === 'none' ? '不关联代理' : draft.body.proxy_mode === 'auto' ? (state.pools.proxies.length ? `自动分配 ${count} 条` : '库内为空，本次不关联') : draft.body.proxy_id ? '使用指定的共享代理' : '沿用最近一条记录的代理；无可用历史代理时留空';
  openModal(`<div class="modal-head"><h3>核对本次创建</h3><button class="modal-close" data-action="close-modal">✕</button></div>
    <div class="modal-body"><p class="review-intro">将创建 <b>${count}</b> 条记录。确认后分配资源；最终结果以服务端校验为准。</p>
      <dl class="review-facts"><div><dt>国家 / 产品</dt><dd>${esc(draft.body.country || '未填写')} / ${esc(draft.body.product || '未填写')}</dd></div><div><dt>指纹范围</dt><dd class="mono">${esc(draft.fp.prefix + draft.fp.seq)}${count > 1 ? ' ～ ' + esc(draft.fp.prefix + (draft.fp.seq + count - 1)) : ''}</dd></div></dl>
      <table class="review-table"><caption>资源分配</caption><tbody>${resourceRows}<tr><th>代理</th><td>${proxy}</td></tr></tbody></table>
      <table class="review-table"><caption>记录预览${count > 8 ? `（前 8 条，共 ${count} 条）` : ''}</caption><thead><tr><th>指纹名称</th><th>域名</th></tr></thead><tbody>${draft.body.domains.slice(0,8).map((domain,index) => `<tr><td class="mono">${esc(draft.fp.prefix + (draft.fp.seq + index))}</td><td>${esc(domain)}</td></tr>`).join('')}</tbody></table>
      <p class="field-error" id="create-submit-error" role="alert" hidden></p>
    </div><div class="modal-foot"><span class="grow"></span><button class="btn btn-ghost" data-action="close-modal">返回修改</button><button class="btn btn-primary" id="create-confirm">确认创建 ${count} 条</button></div>`, { large: true });
  document.getElementById('create-confirm').onclick = () => doCreate(draft.body);
}

async function doCreate(body = createDraft().body) {
  if (state.creating) return;
  const domains = body.domains;
  if (!domains.length) return toast('请至少填写一个域名', 'warn');
  if (domains.length > 500) return toast('单次最多创建 500 条记录，请分批创建', 'warn');
  state.creating = true;
  const confirm = document.getElementById('create-confirm');
  const submittedInput = { domains: state.form.domains, start: state.form.start_seq };
  if (confirm) WorkbenchUI.dialog.pending(confirm, true, '正在创建…');
  const btn = document.querySelector('[data-action="create"]');
  const oldText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); btn.textContent = '创建中'; }
  const fp = { prefix: body.fp_prefix };
  try {
    const encoded=JSON.stringify(body);
    if(state.submission?.body !== encoded) state.submission={body:encoded,key:crypto.randomUUID()};
    const res = await api('/api/records', { method: 'POST', headers:{'idempotency-key':state.submission.key}, body });
    state.submission=null;
    const list = res.created;
    toast(`✅ 已创建 ${list.length} 条记录：${list[0].fingerprint}${list.length > 1 ? ' ~ ' + list[list.length - 1].fingerprint : ''}`);
    if (confirm?.isConnected) state.picked = { emails: new Set(), cards: new Set(), licenses: new Set() };
    if (state.form.domains === submittedInput.domains) state.form.domains = '';
    if (state.form.start_seq === submittedInput.start) state.form.start_seq = `${fp.prefix}${list[list.length - 1].seq + 1}`;
    await refreshAfterCommit('记录已保存，但列表刷新失败；请重新连接，不要重复创建');
    // A lock may have dismissed this task while the committed response was in flight.
    if (confirm?.isConnected) {
      closeModal();
      openModal(`<div class="modal-head"><h3>已创建 ${list.length} 条记录</h3><button class="modal-close" data-action="close-modal">✕</button></div><div class="modal-body"><p>指纹范围：<b class="mono">${esc(list[0].fingerprint)}${list.length > 1 ? ' ～ ' + esc(list[list.length - 1].fingerprint) : ''}</b></p><p>${state.syncError ? '记录已保存。列表需要重新连接后更新，请勿重复创建。' : '记录与资源分配已保存，可以前往「我的记录」查看。'}</p></div><div class="modal-foot"><button class="btn btn-ghost" data-action="close-modal">继续新建</button><span class="grow"></span><button class="btn btn-primary" data-action="created-records">查看我的记录</button></div>`);
    }
  } catch (e) {
    toast(e.message, 'error');
    const message = confirm?.closest('.modal')?.querySelector('#create-submit-error');
    if (message) { message.hidden = false; message.textContent = e.message; }
    if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = oldText; }
  } finally {
    state.creating = false;
    if (confirm?.isConnected) WorkbenchUI.dialog.pending(confirm, false, `确认创建 ${domains.length} 条`);
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
    <code>${esc(POOL_FORMAT[kind].sample || POOL_FORMAT[kind].rule)}</code><button class="btn btn-primary" data-action="open-empty-import" data-kind="${kind}">${kind === 'licenses' ? '导入营业执照' : '批量导入'}</button></div>`;
  if (!list.length) return WorkbenchUI.emptyState({title:'没有匹配的资源',description:'换个关键词或筛选条件试试。',iconName:'search',action:'reset-pool-search',actionLabel:'清除筛选'});
  const page = paginate(list, 'pools');
  return `<p class="table-help">占用数来自本人的全部记录 · 已关联资源需先解除关联再删除</p><div class="table-wrap" tabindex="0" role="region" aria-label="${conf.label}表格，可横向滚动"><table class="pool-table">
    <colgroup>${(table.widths || []).map((width) => `<col${width ? ` style="width:${width}"` : ''}>`).join('')}</colgroup>
    <thead><tr>${table.cols.map((column) => `<th>${column}</th>`).join('')}</tr></thead><tbody>
    ${page.items.map((item, index) => {
      const statusIndex = table.cols.indexOf('状态');
      const linked = Number(item.linked_record_count || 0) > 0;
      const status = `<select aria-label="资源 ${item.id} 状态" class="status-select ${item.status === '未使用' ? 's-green' : item.status === '已使用' ? 's-blue' : 's-red'}" data-action="pool-item-status" data-kind="${kind}" data-id="${item.id}">
        ${['未使用', '已使用', '停用'].map((value) => `<option ${item.status === value ? 'selected' : ''} ${value === '未使用' && linked ? 'disabled' : ''}>${value}</option>`).join('')}</select>`;
      const cells = table.row(item).slice(0, statusIndex).map((cell) => `<td>${cell}</td>`);
      cells.push(`<td>${status}<span class="resource-usage">${linked ? `已关联 ${Number(item.linked_record_count)} 条记录` : '尚未关联记录'}</span></td>`, `<td class="dim mono">${esc(item.created_at || '')}</td>`, `<td><div class="row-actions"><button class="icon-btn danger" data-action="del-pool" data-kind="${kind}" data-id="${item.id}" ${linked ? 'disabled title="请先在记录中解除关联"' : ''}>删除</button></div></td>`);
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
      <div class="head-actions">${kind === 'emails' || kind === 'proxies' ? '<button class="btn btn-ghost" data-action="open-auto-import">智能导入</button>' : ''}
        <button class="btn btn-primary" data-action="open-import" data-kind="${kind}">${kind === 'licenses' ? '导入营业执照' : '批量导入'}</button></div></div>
    <div class="panel"><div class="toolbar">
      <input class="search" id="pool-q" aria-label="搜索资源" placeholder="搜索…" value="${esc(state.poolQ)}">
      <div class="tabs">${['全部', '未使用', '已使用', '停用'].map((status) => `<button class="tab ${state.poolStatus === status ? 'active' : ''}" aria-pressed="${state.poolStatus === status}" data-action="pool-status" data-v="${status}">${status}<i class="n">${counts[status]}</i></button>`).join('')}</div>
      <span class="sel-count">${list.length} 条</span>
      <button class="btn btn-ghost btn-sm" data-action="clear-pool-filter" ${!state.poolQ && state.poolStatus === '全部' ? 'disabled' : ''}>清除筛选</button></div>${renderPoolTable(kind, list)}</div>`;
}

function renderPoolTableInto() {
  const panel = document.querySelector('#main .panel');
  if (!panel) return;
  const reset=document.querySelector('[data-action="clear-pool-filter"]');
  if(reset) reset.disabled=!state.poolQ&&state.poolStatus==='全部';
  const list = getFilteredPool(state.page);
  panel.querySelectorAll('.table-wrap, .table-help, .empty, .table-pagination').forEach((element) => element.remove());
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
      <div class="format-hint">
        <p class="format-rule">${esc(POOL_FORMAT[kind].rule)}</p>
        ${POOL_FORMAT[kind].sample ? `<pre class="format-sample">${esc(POOL_FORMAT[kind].sample)}</pre>` : ''}
      </div>
      <label for="import-text">粘贴资源文本</label><textarea id="import-text" aria-describedby="parse-result" class="mono" rows="9" style="width:100%" placeholder="粘贴到此处，一行一条…"></textarea>
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
    saving = true; WorkbenchUI.dialog.pending(okBtn, true, '正在导入…'); ta.readOnly = true;
    try {
      const res = await api(`/api/import/${kind}`, { method: 'POST', body: { items: parsed } });
      toast(`✅ 导入成功：新增 ${res.added} 条${dupNote(res)}`);
      if (ta.isConnected) closeModal();
      await refreshAfterCommit('已保存，但列表刷新失败；请点击重新连接');
    } catch (e) {
      WorkbenchUI.dialog.error(okBtn, e.message);
    } finally {
      saving = false; WorkbenchUI.dialog.pending(okBtn, false); ta.readOnly = false;
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
      <label for="auto-text">粘贴需要识别的文本</label><textarea id="auto-text" aria-describedby="auto-result" class="mono" rows="9" style="width:100%" placeholder="粘贴 AdsPower TXT / 邮箱 / 代理，任意混合…"></textarea>
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
    WorkbenchUI.dialog.pending(okBtn, true, '正在导入…');
    try {
      const res = await api('/api/import/auto', { method: 'POST', body: parsed });
      const parts = [];
      if (parsed.emails.length) parts.push(`邮箱 +${res.emails.added}${dupNote(res.emails)}`);
      if (parsed.proxies.length) parts.push(`代理 +${res.proxies.added}${dupNote(res.proxies)}`);
      toast(`✅ 导入成功：${parts.join('，')}`);
      if (ta.isConnected) closeModal();
      await refreshAfterCommit('已保存，但列表刷新失败；请点击重新连接');
    } catch (e) {
      WorkbenchUI.dialog.error(okBtn, e.message);
    } finally {
      saving = false; WorkbenchUI.dialog.pending(okBtn, false); ta.readOnly = false; fileInput.disabled = false;
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
      <input id="picker-q" aria-label="搜索可选资源" placeholder="搜索…" style="width:100%">
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
    WorkbenchUI.dialog.pending(save, true, '正在保存…');
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
      await refreshAfterCommit('修改已保存，但列表刷新失败；请重新连接，不要重复提交');
    } catch (e) {
      WorkbenchUI.dialog.error(save, e.message);
    } finally {
      WorkbenchUI.dialog.pending(save, false);
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
        <input type="file" id="restore-file" aria-label="选择个人备份文件" accept=".json,application/json">
        <span id="restore-status" role="status">尚未选择文件</span>
      </div>
      <label class="restore-confirm"><input type="checkbox" id="restore-confirm" disabled><span>我已核对备份文件，确认替换当前账号的数据</span></label>
    </div>
    <div class="modal-foot"><span class="grow"></span><button class="btn btn-ghost" data-action="close-modal">取消</button><button class="btn btn-danger" id="restore-go" disabled>确认恢复</button></div>`);
  const input = document.getElementById('restore-file');
  const status = document.getElementById('restore-status');
  const go = document.getElementById('restore-go');
  const confirmation = document.getElementById('restore-confirm');
  let parsed = null;
  let revision = 0;
  let saving = false;
  confirmation.onchange = () => { go.disabled = !parsed || !confirmation.checked || saving; };
  input.onchange = async () => {
    if (saving) return;
    const current = ++revision;
    parsed = null;
    go.disabled = true;
    confirmation.checked = false;
    confirmation.disabled = true;
    const file = input.files[0];
    if (!file) { status.textContent = '尚未选择文件'; return; }
    if (file.size > 64 * 1024 * 1024) { status.textContent = '文件超过 64 MB，无法恢复'; input.value = ''; return; }
    try {
      const candidate = JSON.parse(await file.text());
      if (current !== revision || !input.isConnected) return;
      if(candidate?.format!=='adsworkbench-backup'||candidate.version!==2) throw new Error('Invalid backup format');
      parsed = candidate;
      status.textContent = `已选择：${file.name}。这是加密备份，内容与归属将在恢复时由服务端校验；勾选下方确认后可恢复。`;
      confirmation.disabled = false;
    } catch {
      if (current !== revision || !input.isConnected) return;
      parsed = null;
      status.textContent = '无法读取有效备份，请选择本工作台导出的 JSON 备份文件';
      input.value = '';
    }
  };
  go.onclick = async () => {
    if (!parsed || go.disabled || !confirmation.checked || saving) return;
    saving = true;
    WorkbenchUI.dialog.pending(go, true, '正在恢复…');
    try {
      const result = await api('/api/backup/restore', { method: 'POST', body: parsed });
      toast(`恢复完成：记录 ${result.records} 条、营业执照 ${result.licenses} 条`);
      if (go.isConnected) closeModal();
      await refreshAfterCommit('恢复已完成，但列表刷新失败；请重新连接，不要重复恢复');
    } catch (error) {
      WorkbenchUI.dialog.error(go, error.message);
    } finally {
      saving = false;
      WorkbenchUI.dialog.pending(go, false);
    }
  };
}

/* ============ 事件 ============ */

async function openExportDialog(format) {
  if (format !== 'csv' && !await ensureSensitive('此导出包含邮箱和代理凭据，请安全保存文件。')) return;
  const selected = [...state.sel];
  const total = state.recordStats.total;
  const currentSelected = state.records.filter(record => state.sel.has(record.id)).length;
  const title = format === 'csv' ? '导出 CSV' : '导出 AdsPower TXT';
  openModal(`<div class="modal-head"><h3>${title}</h3><button class="modal-close" data-action="close-modal">✕</button></div><div class="modal-body">
    <fieldset class="export-options"><legend>选择导出范围</legend>
      <label><input type="radio" name="export-scope" value="selected" ${selected.length ? 'checked' : 'disabled'}><span><b>所选 ${selected.length} 条</b><small>本页 ${currentSelected} 条，其他页或筛选外 ${selected.length - currentSelected} 条</small></span></label>
      <label><input type="radio" name="export-scope" value="all" ${selected.length ? '' : 'checked'}><span><b>本人全部 ${total} 条记录</b><small>包含所有页面，当前搜索和状态筛选不会缩小这个范围</small></span></label>
    </fieldset><p class="settings-hint">${format === 'csv' ? 'CSV 不包含密码、2FA、代理密码和身份证原文。' : 'AdsPower 文件包含邮箱与代理凭据，需要临时授权。请安全保管。'}</p><p class="field-error" id="export-error" role="alert" hidden></p>
    </div><div class="modal-foot"><span class="grow"></span><button class="btn btn-ghost" data-action="close-modal">取消</button><button class="btn btn-primary" id="export-confirm">确认导出</button></div>`);
  const button = document.getElementById('export-confirm');
  const signal = WorkbenchUI.dialog.signal();
  button.onclick = async () => {
    if (button.disabled) return;
    const ids = document.querySelector('[name="export-scope"]:checked')?.value === 'selected' ? selected : [];
    WorkbenchUI.busy(button, true, '正在导出…');
    const epoch = state.sensitiveEpoch;
    try {
      if (format !== 'csv' && state.unlockedUntil <= Date.now()) throw new Error('敏感授权已过期，请关闭后重新导出');
      const result = await api(`/api/export/${format}`, { method: 'POST', body: { ids }, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
      if (signal.aborted || !button.isConnected) return;
      if (format !== 'csv' && (epoch !== state.sensitiveEpoch || state.unlockedUntil <= Date.now())) throw new Error('敏感授权已结束，请重新授权后导出');
      closeModal();
      download(format === 'csv' ? `记录_${todayKey().replace('.', '_')}.csv` : `adspower_${todayKey().replace('.', '_')}.txt`, result.text, format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8');
      toast(`已导出 ${result.count} 条${format === 'csv' ? ' CSV' : ' AdsPower 导入文件'}`);
    } catch (error) {
      if (signal.aborted || !button.isConnected) return;
      const box = button.closest('.modal').querySelector('#export-error');
      if (box) { box.hidden = false; box.textContent = error.message; }
      else toast(error.message, 'error');
    } finally { WorkbenchUI.busy(button, false); }
  };
}

function focusPageHeading() {
  const main = document.getElementById('main');
  main.scrollTop = 0;
  const heading = main.querySelector('h1');
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
}

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
      case 'retry-records':
        await loadRecordsPage({ renderMode: 'table' });
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
        focusPageHeading();
        break;
      }
      case 'jump-status':
        state.page = 'records'; state.rstatus = t.dataset.status; state.q = ''; state.recordPage = 1;
        render();
        await loadRecordsPage({ renderMode: 'table' });
        document.querySelector('#rec-q')?.focus({preventScroll:true});
        break;
      case 'recent-record': {
        const recent = state.recentRecords.find(r => r.id === Number(t.dataset.id));
        state.q = recent?.fingerprint || '';
        state.rstatus = '全部'; state.recordPage = 1; state.page = 'records';
        render();
        await loadRecordsPage({ renderMode: 'table' });
        document.querySelector('#rec-q')?.focus({preventScroll:true});
        break;
      }
      case 'reset-record-search':
      case 'clear-record-filter':
        state.q = ''; state.rstatus = '全部'; state.recordPage = 1;
        if (document.getElementById('rec-q')) document.getElementById('rec-q').value = '';
        await loadRecordsPage({ renderMode: 'table' });
        document.getElementById('rec-q')?.focus();
        break;
      case 'reset-pool-search':
      case 'clear-pool-filter':
        state.poolQ = ''; state.poolStatus = '全部'; state.poolPage = 1;
        state.poolFilters[state.page] = {q:'',status:'全部',page:1};
        render();
        break;
      case 'modal-overlay': {
        if (e.target === t && !document.querySelector('.modal[data-submitting]')) closeModal();
        break;
      }
      case 'close-modal':
        if (!document.querySelector('.modal[data-submitting]')) closeModal();
        break;
      case 'toggle-reveal':
        if(state.reveal) await lockSensitive();
        else if(await ensureSensitive()) {state.reveal=true;await refresh();}
        break;
      case 'my-audit':
        await showMyAudit();break;
      case 'check-integrity':
        RecordIntegrity.open();break;
      case 'change-password':
        showChangePassword();break;
      case 'duplicate-audit':
        await openDuplicateAudit();
        break;
      case 'web-backup':
        // 走一次同源导航触发下载：Cookie 会自动带上，浏览器停留在当前页面
        if(!await ensureSensitive()) break;
        const backupEpoch = state.sensitiveEpoch;
        const backupResponse=await fetch('/api/backup',{headers:{'x-workbench':'1'},signal:AbortSignal.timeout(60000)});
        if(!backupResponse.ok) throw new Error('备份导出失败，请重新解锁后重试');
        const backupText = await backupResponse.text();
        if (backupEpoch !== state.sensitiveEpoch || state.unlockedUntil <= Date.now()) throw new Error('敏感授权已结束，请重新导出备份');
        download('AdsWorkbench-'+todayKey()+'.json',backupText,'application/json');
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
      case 'open-empty-import':
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
        openCreateReview();
        break;
      case 'created-records':
        closeModal();
        state.page = 'records'; state.q = ''; state.rstatus = '全部'; state.recordPage = 1; state.recordSort = 'id_desc';
        if (state.syncError) await connect();
        else await loadRecordsPage({ renderMode: 'full' });
        focusPageHeading();
        break;
      case 'rstatus':
        state.rstatus = t.dataset.v;
        state.recordPage = 1;
        await loadRecordsPage({ renderMode: 'table' });
        break;
      case 'clear-selection':
        state.sel.clear();
        refreshSelectionUI();
        break;
      case 'toggle-density':
        state.tableDensity = state.tableDensity === 'compact' ? 'comfortable' : 'compact';
        saveTableDensity();
        document.body.classList.toggle('table-compact', state.tableDensity === 'compact');
        t.setAttribute('aria-pressed', String(state.tableDensity === 'compact'));
        t.textContent = state.tableDensity === 'compact' ? '紧凑模式' : '舒适模式';
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
          if (state.recordsPhase !== 'ready') break;
          state.recordPage = Number(t.dataset.page);
          await loadRecordsPage({ renderMode: 'table' });
          const next = document.querySelector(`#recordsPanel [data-action="table-page"][data-page="${t.dataset.page === '1' ? 2 : Number(t.dataset.page) - 1}"]`);
          next?.focus({ preventScroll: true });
        } else {
          state.poolPage = Number(t.dataset.page); state.poolFilters[state.page].page = state.poolPage; renderPoolTableInto();
        }
        break;
      case 'export-adspower': {
        if (state.recordsPhase === 'ready') await openExportDialog('adspower');
        break;
      }
      case 'export-csv': {
        if (state.recordsPhase === 'ready') await openExportDialog('csv');
        break;
      }
      case 'delete-selected': {
        if (state.recordsPhase !== 'ready') break;
        const ids = [...state.sel];
        if (!ids.length) return;
        const onPage = state.records.filter(record => state.sel.has(record.id)).length;
        confirmModal('删除所选记录', `将删除 <b>${ids.length}</b> 条记录：本页 <b>${onPage}</b> 条，其他页或筛选外 <b>${ids.length - onPage}</b> 条。<br>不再被其他记录使用的资源会自动释放回「未使用」。`, async () => {
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
  if (e.target.id === 'rec-sort' || e.target.id === 'rec-limit') {
    if (e.target.id === 'rec-sort') state.recordSort = e.target.value;
    else state.recordLimit = Number(e.target.value);
    state.recordPage = 1;
    try { await loadRecordsPage({ renderMode: 'table' }); }
    catch (error) { toast(error.message, 'error'); }
    if (e.target.id === 'rec-limit') document.getElementById('rec-limit')?.focus({ preventScroll: true });
    return;
  }
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
        const reset = document.querySelector('[data-action="reset-cols"]');
        if (reset) reset.disabled = !state.hiddenCols.length;
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
    invalidateRecordQuery();
    recordSearchTimer = setTimeout(() => {
      loadRecordsPage({ renderMode: 'table' }).catch((error) => toast(error.message, 'error'));
    }, 250);
  } else if (e.target.id === 'pool-q') {
    state.poolQ = e.target.value;
    state.poolPage = 1;
    state.poolFilters[state.page] = {q:state.poolQ,status:state.poolStatus,page:1};
    renderPoolTableInto();
    // 搜索框未被重建，保留原有光标和选区。
  } else if (e.target.id?.startsWith('f-')) {
    const key = e.target.id.replace('f-', '');
    const map = { country: 'country', product: 'product', start: 'start_seq', ipreg: 'ip_reg_time', idcard: 'id_card', domains: 'domains' };
    if (map[key]) state.form[map[key]] = e.target.value;
    if (key === 'start') state.startSeqAutomatic = !e.target.value.trim();
    if (['country', 'product', 'domains', 'start'].includes(key)) {
      // 轻量更新预览与按钮状态，不重建输入框
      updateCreatePreview();
    }
  }
});

function updateCreatePreview() {
  const preview = document.querySelector('.create-preview');
  if (!preview) return;
  const draft = createDraft();
  const domains = draft.body.domains;
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
  btn.textContent = state.creating ? '创建中' : count > 0 ? `核对并创建 ${count} 条` : '核对并创建';
  showCreateValidation(domains.length ? draft : { error: '' });
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
  const tablePanel = document.getElementById('recordsPanel');
  if (!tablePanel) return;
  const scrollLeft = tablePanel.querySelector('.table-wrap')?.scrollLeft || 0;
  const old = tablePanel.querySelector('.table-wrap, .empty');
  if (old) old.remove();
  tablePanel.querySelector('.table-pagination')?.remove();
  tablePanel.querySelector('.table-help')?.remove();
  tablePanel.insertAdjacentHTML('beforeend', renderRecordsTable(getFilteredRecords()));
  const wrap = tablePanel.querySelector('.table-wrap');
  if (wrap) wrap.scrollLeft = scrollLeft;
  const count = tablePanel.querySelector('.overview-title-count');
  if (count) count.textContent = `${state.recordFilteredTotal} / ${state.recordStats.total} 条`;
  const selCount = tablePanel.querySelector('.sel-count');
  if (selCount) selCount.innerHTML = `已选 <b>${state.sel.size}</b> 条`;
  refreshSelectionUI();
  updateRecordsChrome();
  bindLabels();
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
  if (delBtn) delBtn.disabled = state.sel.size === 0 || state.recordsPhase !== 'ready';
  const bar = document.getElementById('selectionBar');
  if (bar) {
    bar.hidden = !state.sel.size;
    const onPage = state.records.filter(record => state.sel.has(record.id)).length;
    bar.querySelector('.selection-scope').textContent = `已选共 ${state.sel.size} 条：本页 ${onPage} 条，其他页或筛选外 ${state.sel.size - onPage} 条。翻页和筛选会保留选择。`;
  }
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
        extra.innerHTML = `<select id="f-proxy" aria-label="共享代理">${proxyOptions}</select>`;
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
  document.querySelectorAll('[data-action="retry-load"]').forEach(retry => WorkbenchUI.busy(retry, true, '正在连接…'));
  try {
    await refresh();
  } catch (error) {
    if (status) { status.textContent = '连接未完成'; status.className = 'connection-status disconnected'; }
    // Keep existing records and form input visible if a later refresh fails.
    if (state.loaded) { state.syncError = error.message; renderSyncNotice(); toast(error.message, 'error'); }
    else main.innerHTML = `<section class="connection-panel" role="alert"><span class="empty-ico">⚠</span><h1>暂时无法打开工作台</h1><p>${esc(error.message)}</p><button class="btn btn-primary" data-action="retry-load">重新连接</button></section>`;
  } finally {
    connecting = false;
    document.querySelectorAll('[data-action="retry-load"]').forEach(retry => WorkbenchUI.busy(retry, false, '重新连接'));
    document.body.classList.remove('boot');
  }
}

function bindLabels() { WorkbenchUI.enhance(); }
new MutationObserver(bindLabels).observe(document.getElementById('main'), { childList: true, subtree: true });
new MutationObserver(bindLabels).observe(document.getElementById('modal-root'), { childList: true, subtree: true });
document.addEventListener('toggle', event => {
  if (event.target.matches('.col-menu[open]')) WorkbenchUI.positionMenu(event.target);
}, true);
document.addEventListener('pointerdown', event => {
  document.querySelectorAll('.col-menu[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
});
window.addEventListener('resize', () => document.querySelectorAll('.col-menu[open]').forEach(WorkbenchUI.positionMenu));

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
  const modalOpen = Boolean(document.querySelector('#modal-root .modal'));
  if (!modalOpen && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    const search = document.querySelector('.page-records #rec-q, #pool-q');
    if (search) { event.preventDefault(); search.focus(); search.select(); }
  }
  if (!modalOpen && event.key === 'Escape') {
    document.querySelectorAll('.col-menu[open]').forEach(menu => { menu.open = false; menu.querySelector('summary')?.focus(); });
  }
  if (['Enter', ' '].includes(event.key) && event.target.matches('[role="button"][data-copy], [role="button"][data-action]')) {
    event.preventDefault(); event.target.click();
  }
  if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    if (!modalOpen && !event.repeat) connect();
  }
});
connect();
