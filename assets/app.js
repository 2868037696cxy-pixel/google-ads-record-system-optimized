/**
 * 谷歌广告记录系统 - 优化版前端应用
 *
 * 优化内容：
 * 1. 模块化代码结构
 * 2. 改进状态管理和数据流
 * 3. 优化 UI/UX 和动画效果
 * 4. 增强错误处理和用户反馈
 * 5. 添加键盘快捷键支持
 * 6. 改进搜索和筛选功能
 */

(function() {
  'use strict';

  // ============================================
  // 常量配置
  // ============================================
  const CONFIG = {
    PAGE_SIZE: 40,
    COST_ALERT_RATIO: 1.2,
    AUTO_SAVE_DELAY: 650,
    UNDO_STACK_SIZE: 30,
    MAX_EXPORT_ROWS: 10000,
    API_TIMEOUT: 30000
  };

  const STATUS = ['未铺市场', '已铺市场', '测试中', '继续跑', '观察', '暂停'];

  const DEFAULT_MARKETS = [
    '德国', '意大利', '西班牙', '波兰', '罗马尼亚', '保加利亚',
    '斯洛伐克', '奥地利', '匈牙利', '葡萄牙', '捷克'
  ];

  const DEFAULT_PRODUCTS = [
    '索尼助听器', '呼吸机', '紧索套件', '汽车读卡器', '卡车导航',
    '自行车码表', '高速棘轮扳手', '电子翻译机', '血糖仪', '胶卷',
    'W55水分', '激光水平仪', '光伏检测仪', '手持电锯', '挖机水平仪'
  ];

  const PMS = [
    { product: '索尼助听器', markets: ['奥地利', '匈牙利', '罗马尼亚', '保加利亚', '波兰'], hot: ['波兰'] },
    { product: '呼吸机', markets: ['波兰', '德国', '保加利亚', '斯洛伐克'], hot: ['德国'] },
    { product: '紧索套件', markets: ['保加利亚', '斯洛伐克', '德国', '意大利'], hot: ['斯洛伐克', '意大利'] },
    { product: '汽车读卡器', markets: ['斯洛伐克', '意大利', '波兰', '葡萄牙'], hot: ['葡萄牙'] },
    { product: '卡车导航', markets: ['罗马尼亚', '德国', '意大利', '西班牙', '保加利亚'], hot: ['保加利亚'] },
    { product: '自行车码表', markets: ['西班牙', '葡萄牙', '意大利'], hot: ['西班牙'] },
    { product: '血糖仪', markets: ['德国', '奥地利', '西班牙', '保加利亚', '波兰', '意大利'], hot: ['西班牙', '保加利亚', '意大利'] },
    { product: '激光水平仪', markets: ['波兰', '罗马尼亚', '西班牙', '德国'], hot: ['波兰', '罗马尼亚', '西班牙'] }
  ];

  const BADGE_CLASS = {
    '暂停': 'pause',
    '已铺市场': 'done',
    '继续跑': 'done',
    '测试中': 'sky',
    '观察': 'sky',
    '未铺市场': 'amber'
  };

  const ACCENT_COLORS = {
    '已铺市场': 'var(--green)',
    '继续跑': 'var(--green)',
    '测试中': 'var(--blue)',
    '观察': 'var(--gold)',
    '暂停': 'var(--red)',
    '未铺市场': 'var(--faint)'
  };

  // ============================================
  // 状态管理
  // ============================================
  const State = {
    ads: [],
    selectedId: '',
    view: 'dashboard',
    dashRange: 7,
    viewMarket: '',
    currentPage: 1,
    sortKey: 'createdAt',
    sortDir: 'desc',
    dirty: false,
    loading: false,
    serverHealth: null,
    undoStack: [],
    redoStack: [],
    searchHistory: [],
    filterPreset: null,
    rev: 0,                 // 服务端数据版本号（乐观锁）
    options: null,          // { product: [], market: [] } 服务端可配置选项
    authToken: (function() { try { return sessionStorage.getItem('ads_token') || ''; } catch { return ''; } })(),
    chartSeries: { spend: true, orders: true, revenue: true }
  };

  // 产品/市场选项：优先服务端配置，失败时用内置默认
  const getProducts = () => (State.options && State.options.product && State.options.product.length
    ? State.options.product : DEFAULT_PRODUCTS);
  const getMarkets = () => (State.options && State.options.market && State.options.market.length
    ? State.options.market : DEFAULT_MARKETS);

  // ============================================
  // 工具函数
  // ============================================
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));

  const today = () => new Date().toISOString().slice(0, 10);
  const uid = (p) => `${p}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const validDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(new Date(`${v}T00:00:00`).getTime());

  const toNum = (v) => {
    const n = Number(String(v ?? 0).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };

  const money = (v) => Math.max(0, toNum(v));
  const intNum = (v) => Math.max(0, Math.floor(money(v)));

  const fmt = (v) => toNum(v).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const fmtI = (v) => toNum(v).toLocaleString('zh-CN');

  const debounce = (fn, delay) => {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  };

  const throttle = (fn, limit) => {
    let inThrottle = false;
    return (...args) => {
      if (!inThrottle) {
        fn(...args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  };

  // ============================================
  // 数据规范化
  // ============================================
  function normalizeDaily(d = {}) {
    return {
      id: String(d.id || uid('d')),
      date: validDate(d.date) ? d.date : today(),
      spend: money(d.spend),
      orders: intNum(d.orders ?? d.order),
      revenue: money(d.revenue),
      note: String(d.note || '')
    };
  }

  function normalizeAd(a = {}) {
    return {
      id: String(a.id || uid('a')),
      no: String(a.no || '').trim(),
      product: String(a.product || '').trim(),
      market: String(a.market || '').trim(),
      budget: money(a.budget),
      status: STATUS.includes(a.status) ? a.status : '测试中',
      note: String(a.note || ''),
      optimizeNote: String(a.optimizeNote || a.optimize_note || ''),
      actionNote: String(a.actionNote || a.action_note || ''),
      createdAt: validDate(a.createdAt || a.created_at) ? (a.createdAt || a.created_at) : today(),
      daily: Array.isArray(a.daily) ? a.daily.map(normalizeDaily) : []
    };
  }

  function validateAd(ad) {
    const errors = [];
    if (!ad.no) errors.push({ field: 'no', message: '编号不能为空' });
    if (!ad.product) errors.push({ field: 'product', message: '产品不能为空' });
    if (!ad.market) errors.push({ field: 'market', message: '市场不能为空' });
    if (!validDate(ad.createdAt)) errors.push({ field: 'createdAt', message: '创建日期无效' });
    if (ad.budget < 0) errors.push({ field: 'budget', message: '预算不能为负数' });

    for (const d of ad.daily) {
      if (!validDate(d.date)) errors.push({ field: 'daily.date', message: '每日日期无效' });
      if (d.spend < 0 || d.orders < 0 || d.revenue < 0) {
        errors.push({ field: 'daily.data', message: '每日数据不能为负数' });
      }
    }
    return errors;
  }

  function calc(ad) {
    const spend = ad.daily.reduce((s, d) => s + toNum(d.spend), 0);
    const orders = ad.daily.reduce((s, d) => s + toNum(d.orders), 0);
    const revenue = ad.daily.reduce((s, d) => s + toNum(d.revenue), 0);
    const profit = revenue - spend;

    return {
      spend,
      orders,
      revenue,
      profit,
      cost: orders ? spend / orders : 0,
      roi: spend ? (profit / spend) * 100 : null,
      margin: revenue ? (profit / revenue) * 100 : null,
      overBudget: ad.budget > 0 && spend > ad.budget * CONFIG.COST_ALERT_RATIO
    };
  }

  function pack(scope = 'frontend-save', data = State.ads) {
    return {
      schema: 'ads-record-v3',
      storage: 'server-sqlite',
      scope,
      rev: State.rev,
      exportedAt: new Date().toISOString(),
      count: data.length,
      ads: data.map(normalizeAd)
    };
  }

  // ============================================
  // API 通信
  // ============================================
  async function api(path, options = {}) {
    const url = path.startsWith('http')
      ? path
      : (window.ADS_API_BASE || '') + path;

    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (State.authToken) headers['x-app-token'] = State.authToken;

    const response = await fetch(url, { ...options, headers });

    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (response.status === 401 && data && data.authRequired) {
      renderLoginGate();
      throw new Error('需要登录');
    }

    if (!response.ok) {
      const err = new Error(data.error || data.message || `HTTP ${response.status}`);
      err.status = response.status;
      err.conflict = !!data.conflict;
      err.serverRev = data.serverRev;
      throw err;
    }

    return data;
  }

  // ---- 登录遮罩（仅服务端启用 APP_PASSWORD 时出现）----
  function renderLoginGate() {
    if ($('#loginGate')) return;
    const div = document.createElement('div');
    div.id = 'loginGate';
    div.innerHTML = `
      <div class="login-card">
        <div class="login-title">🔒 谷歌广告记录系统</div>
        <div class="login-sub">请输入访问密码</div>
        <input id="loginPwd" type="password" class="inp" placeholder="访问密码" autocomplete="current-password">
        <div id="loginErr" class="login-err"></div>
        <button class="btn primary" id="loginBtn">登录</button>
      </div>`;
    document.body.appendChild(div);
    const go = () => doLogin();
    $('#loginBtn').addEventListener('click', go);
    $('#loginPwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    setTimeout(() => $('#loginPwd')?.focus(), 50);
  }

  async function doLogin() {
    const pwd = $('#loginPwd')?.value || '';
    if (!pwd) return;
    try {
      const r = await fetch((window.ADS_API_BASE || '') + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '登录失败');
      State.authToken = data.token || '';
      try { sessionStorage.setItem('ads_token', State.authToken); } catch {}
      $('#loginGate')?.remove();
      toast('登录成功', 'success');
      loadFromServer();
    } catch (err) {
      const el = $('#loginErr');
      if (el) el.textContent = err.message;
    }
  }

  // ============================================
  // Toast 通知系统
  // ============================================
  const toast = (function() {
    let currentTimer = null;

    return function(message, type = '') {
      const el = $('#toast');
      if (!el) return;

      // 清除之前的动画
      el.classList.remove('show', 'success', 'warn', 'error');

      // 设置新内容
      el.textContent = message;
      el.className = `toast ${type}`;

      // 强制重排以触发动画
      void el.offsetWidth;

      // 显示 toast
      requestAnimationFrame(() => {
        el.classList.add('show');
      });

      // 自动隐藏
      clearTimeout(currentTimer);
      currentTimer = setTimeout(() => {
        el.classList.remove('show');
      }, 3000);
    };
  })();

  // ============================================
  // 状态管理函数
  // ============================================
  function pushUndo() {
    State.undoStack.push(JSON.stringify(State.ads));
    if (State.undoStack.length > CONFIG.UNDO_STACK_SIZE) {
      State.undoStack.shift();
    }
    State.redoStack.length = 0;
  }

  function markDirty(skipUndo = false) {
    if (!skipUndo) {
      State.dirty = true;
    }

    updateStats(State.view === 'market' ? filteredAds() : State.ads);

    // 延迟保存
    clearTimeout(State.saveTimer);
    State.saveTimer = setTimeout(() => saveNow(false), CONFIG.AUTO_SAVE_DELAY);
  }

  // ============================================
  // 服务器交互
  // ============================================
  async function loadFromServer() {
    try {
      setLoading(true, '连接服务器数据库...');

      // 获取健康状态
      State.serverHealth = await api('/api/health', {
        signal: AbortSignal.timeout(CONFIG.API_TIMEOUT)
      });

      // 获取广告数据
      const payload = await api('/api/ads', {
        signal: AbortSignal.timeout(CONFIG.API_TIMEOUT)
      });

      State.ads = (payload.ads || []).map(normalizeAd);
      State.rev = typeof payload.rev === 'number' ? payload.rev : 0;
      State.dirty = false;

      // 获取产品/市场可配置选项（失败则用内置默认，不阻塞）
      try {
        const opt = await api('/api/options', { signal: AbortSignal.timeout(CONFIG.API_TIMEOUT) });
        if (opt && Array.isArray(opt.product)) State.options = { product: opt.product, market: opt.market || [] };
      } catch (e) {
        console.warn('[Options]', e.message);
      }

      // 选项加载后刷新侧边栏市场快捷按钮
      const mn = $('#marketNav');
      if (mn) mn.innerHTML = marketNavHTML();

      updateDbStatus(
        '服务端 SQLite 已连接',
        `${State.serverHealth.adsCount || State.ads.length} 条 · ${State.serverHealth.dbPath || 'data/ads.sqlite'}`,
        'ok'
      );

      renderShell();

    } catch (err) {
      console.error('[Load Error]', err);
      updateDbStatus('服务端数据库未连接', '请先运行 npm install && npm start', 'warn');
      renderError(`无法连接服务端 SQLite 数据库: ${err.message}`);
      toast('服务端数据库未连接，数据不会保存到浏览器', 'warn');
    } finally {
      setLoading(false);
    }
  }

  async function saveNow(manual = false) {
    // 验证数据
    const errors = State.ads.flatMap((ad) =>
      validateAd(ad).map((msg) => `#${ad.no || ad.id}: ${msg.message}`)
    );

    if (errors.length) {
      toast(errors[0], 'warn');
      return;
    }

    try {
      setLoading(true, '保存到服务器数据库...');

      const result = await api('/api/ads', {
        method: 'PUT',
        body: JSON.stringify(pack('save', State.ads)),
        signal: AbortSignal.timeout(CONFIG.API_TIMEOUT)
      });

      State.dirty = false;
      if (typeof result.rev === 'number') State.rev = result.rev;

      // 更新健康状态
      try {
        State.serverHealth = await api('/api/health', {
          signal: AbortSignal.timeout(CONFIG.API_TIMEOUT)
        });
      } catch (e) {
        // 忽略
      }

      updateDbStatus(
        '服务端 SQLite 已连接',
        `已保存 ${result.count ?? State.ads.length} 条 · ${new Date().toLocaleTimeString('zh-CN')}`,
        'ok'
      );

      if (manual) {
        toast('已保存到服务端 SQLite 数据库', 'success');
      }

      updateStats(State.view === 'market' ? filteredAds() : State.ads);

    } catch (err) {
      console.error('[Save Error]', err);
      if (err.conflict) {
        conflictBox(err.serverRev);
        return;
      }
      updateDbStatus('保存失败', '服务端数据库不可写', 'warn');
      toast(`保存失败：${err.message}`, 'warn');
    } finally {
      setLoading(false);
    }
  }

  // ---- 保存冲突：服务端版本已变化（专用双按钮弹窗）----
  function conflictBox(serverRev) {
    closeChoice();
    const div = document.createElement('div');
    div.id = 'choiceBox';
    div.className = 'overlay open';
    div.innerHTML = `
      <div class="dialog">
        <h3>⚠️ 保存冲突</h3>
        <p>当前数据版本 v${State.rev}，服务端已是 v${serverRev}（可能其他窗口刚保存过）。</p>
        <p style="margin-top:8px;color:var(--muted)">「重新加载」会丢弃你未保存的修改，载入服务端最新数据；「强制覆盖」会用你的数据覆盖服务端（对方修改将丢失）。</p>
        <div class="dialog-btns">
          <button class="btn small" id="choiceReload">重新加载</button>
          <button class="btn danger small" id="choiceForce">强制覆盖</button>
        </div>
      </div>`;
    document.body.appendChild(div);
    $('#choiceReload').addEventListener('click', async () => {
      closeChoice();
      await loadFromServer();
      toast('已重新加载服务端数据', 'success');
    });
    $('#choiceForce').addEventListener('click', async () => {
      closeChoice();
      try {
        const latest = await api('/api/ads');
        State.rev = latest.rev;
        await saveNow(true);
      } catch (e) { toast(`强制覆盖失败：${e.message}`, 'error'); }
    });
  }

  function closeChoice() {
    $('#choiceBox')?.remove();
  }

  async function diagnose() {
    try {
      const h = await api('/api/health', {
        signal: AbortSignal.timeout(CONFIG.API_TIMEOUT)
      });

      const dbSize = h.dbSizeBytes
        ? `${(h.dbSizeBytes / 1024).toFixed(1)} KB`
        : '未知';

      alert(
        `诊断通过\n\n` +
        `存储方式：服务端 SQLite\n` +
        `数据库文件：${h.dbPath}\n` +
        `数据库大小：${dbSize}\n` +
        `广告数：${h.adsCount}\n` +
        `每日记录数：${h.dailyCount}\n\n` +
        `浏览器只负责显示页面，清空浏览器缓存不会删除服务器数据库。`
      );

      updateDbStatus(
        '服务端 SQLite 正常',
        `${h.adsCount} 条广告 · ${h.dailyCount} 条每日记录`,
        'ok'
      );

    } catch (err) {
      alert(`诊断失败：${err.message}\n请确认已经运行 npm start`);
      updateDbStatus('服务端数据库未连接', '请先运行 npm start', 'warn');
    }
  }

  async function makeBackup() {
    try {
      const r = await api('/api/backups', {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(CONFIG.API_TIMEOUT)
      });
      toast(`已创建服务端备份 #${r.backupId}`, 'success');
    } catch (err) {
      toast(`备份失败：${err.message}`, 'warn');
    }
  }

  // ============================================
  // 导出功能
  // ============================================
  function download(name, content, type = 'application/octet-stream') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 300);
  }

  function exportJson() {
    const data = JSON.stringify(pack('manual-export', State.ads), null, 2);
    download(`ads_backup_${today()}.json`, data, 'application/json;charset=utf-8');
    toast('已导出 JSON 备份', 'success');
  }

  function exportCsvLocal() {
    const rows = [['编号', '产品', '市场', '状态', '预算', '创建日期',
                   '总消耗', '总单量', '收入', '利润', 'ROI%', '毛利率%', '备注']];

    State.ads.forEach((ad) => {
      const c = calc(ad);
      rows.push([
        ad.no, ad.product, ad.market, ad.status, ad.budget, ad.createdAt,
        fmt(c.spend), fmtI(c.orders), fmt(c.revenue), fmt(c.profit),
        c.roi == null ? '' : fmt(c.roi),
        c.margin == null ? '' : fmt(c.margin),
        ad.note
      ]);
    });

    const csv = '\ufeff' + rows.map((r) =>
      r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    download(`ads_table_${today()}.csv`, csv, 'text/csv;charset=utf-8');
    toast('已导出 CSV 表格', 'success');
  }

  function exportExcel() {
    const rows = [['编号', '产品', '市场', '状态', '预算', '创建日期',
                   '总消耗', '总单量', '收入', '利润', 'ROI%', '毛利率%', '备注']];

    State.ads.forEach((ad) => {
      const c = calc(ad);
      rows.push([
        ad.no, ad.product, ad.market, ad.status, ad.budget, ad.createdAt,
        fmt(c.spend), fmtI(c.orders), fmt(c.revenue), fmt(c.profit),
        c.roi == null ? '' : fmt(c.roi),
        c.margin == null ? '' : fmt(c.margin),
        ad.note
      ]);
    });

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>广告数据报表</title>
<style>
body { font-family: Arial, 'Microsoft YaHei', sans-serif; padding: 20px; }
table { width: 100%; border-collapse: collapse; }
td, th { border: 1px solid #ccc; padding: 8px; }
th { background: #f5f5f5; font-weight: bold; }
tr:nth-child(even) { background: #fafafa; }
</style>
</head>
<body>
<h1>广告数据报表</h1>
<p>导出时间：${new Date().toLocaleString('zh-CN')}</p>
<p>共 ${State.ads.length} 条记录</p>
<table>
${rows.map((r, i) => `<tr>${r.map((v) => i ? `<td>${esc(v)}</td>` : `<th>${esc(v)}</th>`).join('')}</tr>`).join('')}
</table>
</body>
</html>`;

    download(`ads_excel_${today()}.xls`, html, 'application/vnd.ms-excel;charset=utf-8');
    toast('已导出 Excel 表格', 'success');
  }

  // ============================================
  // 导入功能
  // ============================================
  function parseImport(payload) {
    if (payload && Array.isArray(payload.ads)) {
      return payload.ads.map(normalizeAd);
    }
    if (Array.isArray(payload)) {
      return payload.map(normalizeAd);
    }
    if (payload && Array.isArray(payload.campaigns)) {
      return payload.campaigns.map((c) => normalizeAd({
        no: c.name,
        product: c.product,
        market: c.market,
        daily: c.records || []
      }));
    }
    throw new Error('无法识别导入格式');
  }

  function parseCsv(text) {
    const lines = text.replace(/<[^>]+>/g, '\t').split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];

    const split = (line) => line.split(/,|\t/).map((x) =>
      x.replace(/^"|"$/g, '').trim()
    );
    const header = split(lines[0]);
    const idx = (...names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0);

    return lines.slice(1).map((line) => {
      const r = split(line);
      return normalizeAd({
        no: r[idx('编号', 'no')] || '',
        product: r[idx('产品', 'product')] || '',
        market: r[idx('市场', 'market')] || '',
        status: r[idx('状态', 'status')] || '测试中',
        budget: r[idx('预算', 'budget')] || 0,
        createdAt: r[idx('创建日期', 'createdAt')] || today(),
        note: r[idx('备注', 'note')] || ''
      });
    });
  }

  function importFile() {
    const input = $('#importInput');
    if (!input) return;

    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const text = String(reader.result || '');
          const incoming = /\.json$/i.test(file.name)
            ? parseImport(JSON.parse(text))
            : parseCsv(text);

          if (!incoming.length) {
            throw new Error('没有识别到数据');
          }

          // 验证数据
          const errors = incoming.flatMap((ad) => validateAd(ad));
          if (errors.length) {
            throw new Error(errors[0].message);
          }

          confirmBox(
            '导入数据',
            `检测到 ${incoming.length} 条记录。确认后写入服务端 SQLite。`,
            async () => {
              pushUndo();
              const map = new Map(State.ads.map((a) => [a.id, a]));
              incoming.forEach((a) => map.set(a.id, a));
              State.ads = Array.from(map.values()).map(normalizeAd);
              State.dirty = true;
              renderShell();
              await saveNow(true);
            }
          );

        } catch (err) {
          alert(`导入失败：${err.message}`);
        } finally {
          input.value = '';
        }
      };

      reader.readAsText(file);
    };

    input.click();
  }

  // ============================================
  // UI 更新函数
  // ============================================
  function setLoading(on, message = '处理中...') {
    State.loading = on;
    const el = $('#countTxt');
    if (el) {
      el.textContent = on ? message : (State.dirty ? '未保存' : '已保存');
    }
  }

  function updateDbStatus(title, message, mode = 'ok') {
    const titleEl = $('#dbTitle');
    const stateEl = $('#dbState');
    const boxEl = $('#dbBox');

    if (titleEl) titleEl.textContent = title;
    if (stateEl) stateEl.textContent = message;
    if (boxEl) boxEl.className = `db-box ${mode}`;
  }

  function updateStats(data = State.ads) {
    const t = totals(data);

    const updateEl = (id, val) => {
      const el = $(`#${id}`);
      if (el) el.textContent = val;
    };

    updateEl('hTotal', t.total);
    updateEl('hRunning', t.running);
    updateEl('hSpend', fmt(t.spend));
    updateEl('hOrders', fmtI(t.orders));
    updateEl('hCost', fmt(t.cost));
    updateEl('sbCount', State.ads.length);

    if (!State.loading) {
      const countTxt = $('#countTxt');
      if (countTxt) countTxt.textContent = State.dirty ? '未保存' : '已保存';
    }
  }

  function totals(data = State.ads) {
    const t = data.reduce((acc, ad) => {
      const c = calc(ad);
      acc.spend += c.spend;
      acc.orders += c.orders;
      acc.revenue += c.revenue;
      acc.profit += c.profit;
      if (ad.status !== '暂停') acc.running += 1;
      return acc;
    }, { total: data.length, running: 0, spend: 0, orders: 0, revenue: 0, profit: 0 });

    t.cost = t.orders ? t.spend / t.orders : 0;
    return t;
  }

  // ============================================
  // 筛选和搜索
  // ============================================
  function filters() {
    return {
      q: ($('#searchInp')?.value || '').trim().toLowerCase(),
      product: $('#productFilter')?.value || '',
      status: $('#statusFilter')?.value || '',
      from: $('#dateFrom')?.value || '',
      to: $('#dateTo')?.value || ''
    };
  }

  function inRange(ad, from, to) {
    if (!from && !to) return true;
    return [ad.createdAt, ...ad.daily.map((d) => d.date)].some((d) =>
      (!from || d >= from) && (!to || d <= to)
    );
  }

  function compareAds(a, b) {
    const ca = calc(a), cb = calc(b);
    const get = (ad, c) => ({
      createdAt: ad.createdAt,
      no: ad.no,
      product: ad.product,
      market: ad.market,
      status: ad.status,
      spend: c.spend,
      orders: c.orders,
      cost: c.cost,
      profit: c.profit
    })[State.sortKey] ?? '';

    const av = get(a, ca), bv = get(b, cb);
    const n = typeof av === 'number' || typeof bv === 'number'
      ? toNum(av) - toNum(bv)
      : String(av).localeCompare(String(bv), 'zh-CN');

    return State.sortDir === 'asc' ? n : -n;
  }

  function filteredAds() {
    const f = filters();
    return State.ads.filter((ad) =>
      (!State.viewMarket || State.viewMarket === 'all' || ad.market === State.viewMarket) &&
      (!f.product || ad.product === f.product) &&
      (!f.status || ad.status === f.status) &&
      inRange(ad, f.from, f.to) &&
      (!f.q || [
        ad.no, ad.product, ad.market, ad.status,
        ad.note, ad.optimizeNote, ad.actionNote
      ].join(' ').toLowerCase().includes(f.q))
    ).sort(compareAds);
  }

  function highlight(text) {
    const q = filters().q;
    const safe = esc(text);
    if (!q) return safe;
    return safe.replace(
      new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
      '<mark>$1</mark>'
    );
  }

  // ============================================
  // 页面渲染
  // ============================================
  function renderShell() {
    try {
      if (State.view === 'dashboard') {
        renderDashboard();
      } else if (State.view === 'list' || State.view === 'market') {
        renderListPage();
      } else if (State.view === 'stats') {
        renderStatsPage();
      } else if (State.view === 'keywords') {
        renderKeywordsPage();
      } else if (State.view === 'settings') {
        renderSettingsPage();
      }

      updateNav();
      updateStats(State.view === 'market' ? filteredAds() : State.ads);

      // Dashboard 自带头部，隐藏外壳的旧标题+统计条，避免重复
      const shellHead = document.querySelector('.body > .head');
      if (shellHead) shellHead.style.display = State.view === 'dashboard' ? 'none' : '';

    } catch (err) {
      console.error('[Render Error]', err);
      renderError(`页面渲染出错：${err.message}`);
    }
  }

  function renderError(message) {
    const content = $('#content');
    if (content) {
      content.innerHTML = `<section class="panel"><div class="empty">⚠️ ${esc(message)}</div></section>`;
    }
  }

  function renderListPage() {
    const title = State.view === 'market'
      ? (State.viewMarket === 'all' ? '全部市场' : `${State.viewMarket}市场`)
      : '广告列表';

    $('#pageTitle').textContent = title;
    $('#bc1').textContent = State.view === 'market' ? '市场' : '工作台';
    $('#bc2').textContent = title;

    const productOptions = getProducts().map((p) => `<option>${esc(p)}</option>`).join('');
    const statusOptions = STATUS.map((s) => `<option>${esc(s)}</option>`).join('');
    const marketOptions = getMarkets().map((m) => `<option>${esc(m)}</option>`).join('');

    $('#content').innerHTML = `
      <div class="grid">
        <section class="panel sticky">
          <div class="ph">广告列表</div>
          <div class="pb stack">
            <div class="safe">✅ 当前使用服务端 SQLite 数据库：${esc(State.serverHealth?.dbPath || 'data/ads.sqlite')}。清浏览器缓存不会丢数据。</div>
            <input id="searchInp" class="inp inp-sm" placeholder="🔍 搜索编号、产品、市场、备注...">
            <div class="row2">
              <select id="productFilter" class="inp inp-sm">
                <option value="">全部产品</option>
                ${productOptions}
              </select>
              <select id="statusFilter" class="inp inp-sm">
                <option value="">全部状态</option>
                ${statusOptions}
              </select>
            </div>
            <div class="row2">
              <input id="dateFrom" class="inp inp-sm" type="date" placeholder="开始日期">
              <input id="dateTo" class="inp inp-sm" type="date" placeholder="结束日期">
            </div>
            <div class="row2">
              <select id="sortSel" class="inp inp-sm">
                <option value="createdAt" ${State.sortKey === 'createdAt' ? 'selected' : ''}>按创建日期</option>
                <option value="spend" ${State.sortKey === 'spend' ? 'selected' : ''}>按消耗</option>
                <option value="orders" ${State.sortKey === 'orders' ? 'selected' : ''}>按单量</option>
                <option value="cost" ${State.sortKey === 'cost' ? 'selected' : ''}>按成本</option>
                <option value="profit" ${State.sortKey === 'profit' ? 'selected' : ''}>按利润</option>
                <option value="no" ${State.sortKey === 'no' ? 'selected' : ''}>按编号</option>
              </select>
              <select id="sortDir" class="inp inp-sm">
                <option value="desc" ${State.sortDir === 'desc' ? 'selected' : ''}>降序</option>
                <option value="asc" ${State.sortDir === 'asc' ? 'selected' : ''}>升序</option>
              </select>
            </div>
            <div class="toolbar">
              <button class="btn small" data-act="batchStatus">批量改状态</button>
              <button class="btn danger small" data-act="batchDelete">批量删除</button>
              <button class="btn small" data-act="undo">撤销</button>
              <button class="btn small" data-act="redo">重做</button>
            </div>
            <button class="quick" data-act="toggleAdd">＋ 新增广告记录</button>
            <div id="qa" class="qa">
              <div class="row2">
                <div class="field">
                  <label>编号</label>
                  <input id="qNo" class="inp inp-sm" placeholder="例如：AD-001">
                </div>
                <div class="field">
                  <label>预算 €</label>
                  <input id="qBudget" class="inp inp-sm" type="number" min="0" step="0.01" placeholder="0.00">
                </div>
              </div>
              <div class="row2">
                <div class="field">
                  <label>产品</label>
                  <select id="qProduct" class="inp inp-sm">
                    <option value="">选择产品</option>
                    ${productOptions}
                  </select>
                </div>
                <div class="field">
                  <label>市场</label>
                  <select id="qMarket" class="inp inp-sm">
                    <option value="">选择市场</option>
                    ${marketOptions}
                  </select>
                </div>
              </div>
              <div class="field">
                <label>状态</label>
                <select id="qStatus" class="inp inp-sm">
                  ${statusOptions}
                </select>
              </div>
              <div class="row2">
                <button class="btn primary small" data-act="addAd">创建广告</button>
                <button class="btn small" data-act="closeAdd">取消</button>
              </div>
            </div>
            <div id="adList" class="list"></div>
            <div id="pager" class="toolbar"></div>
          </div>
        </section>
        <div id="detail">
          <div class="panel empty">📋 请先选择或新建一条广告记录</div>
        </div>
      </div>
    `;

    // 绑定事件
    ['searchInp', 'productFilter', 'statusFilter', 'dateFrom', 'dateTo'].forEach((id) => {
      const el = $(`#${id}`);
      if (el) el.addEventListener('input', () => {
        State.currentPage = 1;
        renderList();
      });
    });

    $('#sortSel')?.addEventListener('change', (e) => {
      State.sortKey = e.target.value;
      renderList();
    });

    $('#sortDir')?.addEventListener('change', (e) => {
      State.sortDir = e.target.value;
      renderList();
    });

    renderList();
  }

  function renderList() {
    const list = filteredAds();
    const pages = Math.max(1, Math.ceil(list.length / CONFIG.PAGE_SIZE));
    State.currentPage = Math.min(State.currentPage, pages);
    const items = list.slice(
      (State.currentPage - 1) * CONFIG.PAGE_SIZE,
      State.currentPage * CONFIG.PAGE_SIZE
    );

    $('#adList').innerHTML = items.length
      ? items.map((ad) => {
          const c = calc(ad);
          const isActive = ad.id === State.selectedId;
          const isWarn = c.overBudget;

          return `
            <label class="card ${isActive ? 'active' : ''} ${isWarn ? 'warn-row' : ''}"
                   style="--accent:${ACCENT_COLORS[ad.status] || 'var(--line)'}">
              <input type="checkbox" data-check="${ad.id}">
              <button class="card-main" data-act="select" data-id="${ad.id}">
                <div class="card-name">#${highlight(ad.no || '未编号')} · ${highlight(ad.product || '未命名')}</div>
                <div class="card-meta">
                  <span>${highlight(ad.market || '未选市场')}</span>
                  <span class="badge ${BADGE_CLASS[ad.status] || 'sky'}">${esc(ad.status)}</span>
                  <span>€${fmt(c.spend)}</span>
                  <span>${fmtI(c.orders)}单</span>
                  ${isWarn ? '<span class="bad">成本预警</span>' : ''}
                </div>
              </button>
            </label>
          `;
        }).join('')
      : '<div class="empty">没有符合条件的广告记录</div>';

    $('#pager').innerHTML = `
      <button class="btn small" data-act="prevPage" ${State.currentPage <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="hint">第 ${State.currentPage}/${pages} 页 · 共 ${list.length} 条</span>
      <button class="btn small" data-act="nextPage" ${State.currentPage >= pages ? 'disabled' : ''}>下一页</button>
    `;

    // 更新详情或显示空状态
    if (State.selectedId && State.ads.some((a) => a.id === State.selectedId)) {
      renderDetail(State.selectedId);
    } else {
      $('#detail').innerHTML = '<div class="panel empty">📋 请先选择或新建一条广告记录</div>';
    }

    updateStats(list);
  }

  function renderDetail(id) {
    const ad = State.ads.find((a) => a.id === id);
    if (!ad) return;

    const c = calc(ad);
    const productOptions = getProducts().map((p) =>
      `<option ${p === ad.product ? 'selected' : ''}>${esc(p)}</option>`
    ).join('');
    const marketOptions = getMarkets().map((m) =>
      `<option ${m === ad.market ? 'selected' : ''}>${esc(m)}</option>`
    ).join('');
    const statusOptions = STATUS.map((s) =>
      `<option ${s === ad.status ? 'selected' : ''}>${esc(s)}</option>`
    ).join('');

    $('#detail').innerHTML = `
      <div class="detail">
        <section class="panel">
          <div class="ph">
            <div class="big-title">#${esc(ad.no || '未编号')} · ${esc(ad.product || '未命名')}</div>
            <div class="toolbar">
              <button class="btn small" data-act="copyAd" data-id="${ad.id}">复制广告</button>
              <button class="btn danger small" data-act="delAd" data-id="${ad.id}">删除广告</button>
            </div>
          </div>
          <div class="pills">
            <span class="pill">市场：${esc(ad.market || '-')}</span>
            <span class="pill">状态：${esc(ad.status)}</span>
            <span class="pill">创建：${esc(ad.createdAt)}</span>
            ${c.overBudget ? '<span class="pill bad">成本超过预算预警</span>' : ''}
          </div>
          <div class="metrics">
            <div class="metric"><span>预算</span><b>€${fmt(ad.budget)}</b></div>
            <div class="metric"><span>总消耗</span><b>€${fmt(c.spend)}</b></div>
            <div class="metric"><span>总单量</span><b>${fmtI(c.orders)}</b></div>
            <div class="metric"><span>均成本</span><b>€${fmt(c.cost)}</b></div>
            <div class="metric"><span>ROI</span><b class="${c.profit >= 0 ? 'good' : 'bad'}">${c.roi === null ? '-' : fmt(c.roi) + '%'}</b></div>
          </div>
          <div class="fields">
            <div class="field"><label>编号</label><input class="inp inp-sm" data-edit="no" value="${esc(ad.no)}"></div>
            <div class="field"><label>产品</label><select class="inp inp-sm" data-edit="product">${productOptions}</select></div>
            <div class="field"><label>市场</label><select class="inp inp-sm" data-edit="market">${marketOptions}</select></div>
            <div class="field"><label>状态</label><select class="inp inp-sm" data-edit="status">${statusOptions}</select></div>
            <div class="field"><label>预算 €</label><input class="inp inp-sm" type="number" min="0" step="0.01" data-edit="budget" value="${esc(ad.budget)}"></div>
          </div>
        </section>

        <section class="panel">
          <div class="ph">消耗趋势
            <span class="chart-legend" id="trendLegend">
              <button class="lg ${State.chartSeries.spend ? 'on' : ''}" data-act="toggleSeries" data-series="spend"><i style="background:var(--primary)"></i>消耗</button>
              <button class="lg ${State.chartSeries.revenue ? 'on' : ''}" data-act="toggleSeries" data-series="revenue"><i style="background:var(--green)"></i>收入</button>
              <button class="lg ${State.chartSeries.orders ? 'on' : ''}" data-act="toggleSeries" data-series="orders"><i style="background:var(--blue)"></i>单量</button>
            </span>
          </div>
          <div class="pb"><canvas id="trendChart" class="chart"></canvas></div>
        </section>

        <section class="panel">
          <div class="ph">每日数据</div>
          <div class="daily-add">
            <div><label>日期</label><input id="dDate" class="inp inp-sm" type="date" value="${today()}"></div>
            <div><label>消耗€</label><input id="dSpend" class="inp inp-sm" type="number" min="0" step="0.01"></div>
            <div><label>单量</label><input id="dOrders" class="inp inp-sm" type="number" min="0" step="1"></div>
            <div><label>收入€</label><input id="dRevenue" class="inp inp-sm" type="number" min="0" step="0.01"></div>
            <div><label>备注</label><input id="dNote" class="inp inp-sm"></div>
            <button class="btn primary small" data-act="addDaily" data-id="${ad.id}">添加</button>
            <button class="btn small" data-act="copyYesterday" data-id="${ad.id}" title="复制昨天的数据行（消耗/单量/收入/备注），日期自动填今天">复制昨日</button>
          </div>
          ${dailyTable(ad)}
        </section>

        <div class="bottom">
          <section class="panel note">
            <div class="ph">备注与优化</div>
            <div class="pb note">
              <div>
                <div class="note-label">广告备注</div>
                <textarea class="inp" rows="3" data-edit="note">${esc(ad.note)}</textarea>
              </div>
              <div>
                <div class="note-label">优化记录</div>
                <textarea class="inp" rows="3" data-edit="optimizeNote">${esc(ad.optimizeNote)}</textarea>
              </div>
              <div>
                <div class="note-label">下一步动作</div>
                <textarea class="inp" rows="3" data-edit="actionNote">${esc(ad.actionNote)}</textarea>
              </div>
            </div>
          </section>
          <section class="panel">
            <div class="ph">产品市场建议</div>
            <div class="pb">${marketHints(ad.product)}</div>
          </section>
        </div>
      </div>
    `;

    // 绑定编辑事件
    $$('[data-edit]').forEach((el) => {
      el.addEventListener('input', (e) => {
        editAd(ad, e.target.dataset.edit, e.target.value);
      });
    });

    // 绑定每日数据编辑事件
    $$('[data-daily]').forEach((el) => {
      el.addEventListener('input', (e) => {
        editDaily(ad, e.target.dataset.id, e.target.dataset.daily, e.target.value);
      });
    });

    drawTrend(ad);
  }

  function dailyTable(ad) {
    const rows = ad.daily.slice().sort((a, b) => b.date.localeCompare(a.date));

    if (!rows.length) {
      return '<table class="table"><tbody><tr><td colspan="7" class="empty">暂无每日数据</td></tr></tbody></table>';
    }

    return `
      <table class="table">
        <thead>
          <tr>
            <th>日期</th>
            <th>消耗€</th>
            <th>单量</th>
            <th>收入€</th>
            <th>均成本</th>
            <th>备注</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((d) => `
            <tr>
              <td><input class="ci" type="date" data-daily="date" data-id="${d.id}" value="${esc(d.date)}"></td>
              <td><input class="ci" type="number" min="0" step="0.01" data-daily="spend" data-id="${d.id}" value="${esc(d.spend)}"></td>
              <td><input class="ci" type="number" min="0" step="1" data-daily="orders" data-id="${d.id}" value="${esc(d.orders)}"></td>
              <td><input class="ci" type="number" min="0" step="0.01" data-daily="revenue" data-id="${d.id}" value="${esc(d.revenue)}"></td>
              <td class="cost">€${fmt(d.orders ? d.spend / d.orders : 0)}</td>
              <td><input class="ci" data-daily="note" data-id="${d.id}" value="${esc(d.note)}"></td>
              <td><button class="btn ghost-danger small" data-act="delDaily" data-ad="${ad.id}" data-id="${d.id}">删</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // 趋势图：多序列双轴（左轴金额/右轴单量），悬停十字线 + tooltip，图例可开关
  function niceTicks(max, n) {
    n = n || 4;
    if (!(max > 0)) return [0];
    const raw = max / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    const ticks = [];
    for (let v = 0; v <= max * 1.001 + step * 0.5; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
  }

  function drawTrend(ad) {
    const canvas = $('#trendChart');
    if (!canvas) return;
    const data = ad.daily.slice().sort((a, b) => a.date.localeCompare(b.date));

    const dpr = window.devicePixelRatio || 1;
    const W = 860, H = 280;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const css = getComputedStyle(document.documentElement);
    const cssVar = (n, f) => (css.getPropertyValue(n) || f).trim() || f;
    const ink = cssVar('--text', '#1f1d18');
    const muted = cssVar('--muted', '#77736c');
    const gridCol = cssVar('--line', '#dedad2');

    ctx.clearRect(0, 0, W, H);
    ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

    if (!data.length) {
      ctx.fillStyle = muted;
      ctx.font = '14px sans-serif';
      ctx.fillText('暂无每日数据', 30, 50);
      return;
    }

    const SERIES = [
      { key: 'spend', label: '消耗€', color: cssVar('--primary', '#01696f'), axis: 'l', fmt: (v) => '€' + fmt(v) },
      { key: 'revenue', label: '收入€', color: cssVar('--green', '#437a22'), axis: 'l', fmt: (v) => '€' + fmt(v) },
      { key: 'orders', label: '单量', color: cssVar('--blue', '#006494'), axis: 'r', fmt: (v) => fmtI(v) + ' 单' }
    ].filter((s) => State.chartSeries[s.key]);

    const padL = 52, padR = 44, padT = 14, padB = 30;
    const iw = W - padL - padR, ih = H - padT - padB;
    const maxL = Math.max(1, ...data.map((d) => Math.max(d.spend || 0, SERIES.some((s) => s.key === 'revenue') ? d.revenue || 0 : 0)));
    const maxR = Math.max(1, ...data.map((d) => d.orders || 0));
    const ticksL = niceTicks(maxL), ticksR = niceTicks(maxR);
    const topL = ticksL[ticksL.length - 1] || 1, topR = ticksR[ticksR.length - 1] || 1;
    const X = (i) => padL + (data.length === 1 ? iw / 2 : (i * iw) / (data.length - 1));
    const YL = (v) => padT + ih - (v / topL) * ih;
    const YR = (v) => padT + ih - (v / topR) * ih;

    // 网格 + 纵轴刻度
    ctx.lineWidth = 1;
    ticksL.forEach((t) => {
      const y = YL(t);
      ctx.strokeStyle = gridCol;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + iw, y); ctx.stroke();
      ctx.fillStyle = muted;
      ctx.textAlign = 'right';
      ctx.fillText(t >= 1000 ? (t / 1000) + 'k' : String(t), padL - 6, y + 4);
    });
    if (SERIES.some((s) => s.axis === 'r')) {
      ctx.fillStyle = muted;
      ctx.textAlign = 'left';
      ticksR.forEach((t) => {
        const y = YR(t);
        ctx.fillText(String(t), padL + iw + 6, y + 4);
      });
    }

    // 横轴日期（最多 6 个）
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.ceil(data.length / 6));
    data.forEach((d, i) => {
      if (i % step === 0 || i === data.length - 1) {
        ctx.fillText(String(d.date).slice(5), X(i), padT + ih + 18);
      }
    });

    // 序列折线 + 面积
    SERIES.forEach((s) => {
      const Y = s.axis === 'l' ? YL : YR;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      data.forEach((d, i) => {
        const x = X(i), y = Y(d[s.key] || 0);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
      // 面积填充（仅金额轴）
      if (s.axis === 'l') {
        ctx.lineTo(X(data.length - 1), padT + ih);
        ctx.lineTo(X(0), padT + ih);
        ctx.closePath();
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // 数据点
      ctx.fillStyle = s.color;
      data.forEach((d, i) => {
        ctx.beginPath();
        ctx.arc(X(i), Y(d[s.key] || 0), 3, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    // 悬停：十字线 + tooltip
    if (canvas._trendMove) canvas.removeEventListener('mousemove', canvas._trendMove);
    if (canvas._trendLeave) canvas.removeEventListener('mouseleave', canvas._trendLeave);
    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (W / rect.width);
      let bi = 0, bd = Infinity;
      data.forEach((d, i) => {
        const dd = Math.abs(X(i) - mx);
        if (dd < bd) { bd = dd; bi = i; }
      });
      drawTrendHover(ctx, { W, H, padL, padR, padT, padB, ink, muted, gridCol }, data, bi, SERIES, X, YL, YR);
    };
    const onLeave = () => drawTrend(ad);
    canvas._trendMove = onMove;
    canvas._trendLeave = onLeave;
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
  }

  function drawTrendHover(ctx, g, data, bi, SERIES, X, YL, YR) {
    const d = data[bi];
    const x = X(bi);
    ctx.save();
    ctx.strokeStyle = g.muted;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, g.padT);
    ctx.lineTo(x, g.H - g.padB);
    ctx.stroke();
    ctx.setLineDash([]);

    const lines = [`📅 ${d.date}`].concat(SERIES.map((s) => {
      const Y = s.axis === 'l' ? YL : YR;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(x, Y(d[s.key] || 0), 4.5, 0, Math.PI * 2);
      ctx.fill();
      return { color: s.color, text: `${s.label} ${s.fmt(d[s.key] || 0)}` };
    }));

    ctx.font = '12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    const tw = Math.max(...lines.map((l) => ctx.measureText(typeof l === 'string' ? l : l.text).width)) + 28;
    const th = lines.length * 20 + 12;
    let tx = x + 12;
    if (tx + tw > g.W - 8) tx = x - tw - 12;
    const ty = Math.min(Math.max(g.padT + 4, 60), g.H - th - 8);
    ctx.fillStyle = 'rgba(20,20,20,0.88)';
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(tx, ty, tw, th, 8); else ctx.rect(tx, ty, tw, th);
    ctx.fill();
    ctx.stroke();
    lines.forEach((l, i) => {
      const yy = ty + 20 + i * 20;
      if (typeof l !== 'string') {
        ctx.fillStyle = l.color;
        ctx.beginPath();
        ctx.arc(tx + 12, yy - 4, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(typeof l === 'string' ? l : l.text, tx + (typeof l === 'string' ? 12 : 22), yy);
    });
    ctx.restore();
  }

  function marketHints(product) {
    const p = PMS.find((x) => x.product === product);
    if (!p) return '<div class="hint">暂无该产品的市场建议。</div>';

    return `
      <div class="pm">
        <div class="pm-name">${esc(product)}</div>
        ${p.markets.map((m) =>
          `<span class="mpill ${p.hot.includes(m) ? 'hot' : ''}">${esc(m)}${p.hot.includes(m) ? ' 热' : ''}</span>`
        ).join('')}
      </div>
    `;
  }

  function renderStatsPage() {
    $('#pageTitle').textContent = '统计报表';
    $('#bc1').textContent = '工作台';
    $('#bc2').textContent = '统计报表';

    $('#content').innerHTML = `
      <div class="grid">
        <section class="panel">
          <div class="ph">按市场统计</div>
          <div class="pb">${statTable(groupStats('market'))}</div>
        </section>
        <section class="panel">
          <div class="ph">按产品统计</div>
          <div class="pb">${statTable(groupStats('product'))}</div>
        </section>
      </div>
      <section class="panel" style="margin-top:16px">
        <div class="ph">热门市场推荐</div>
        <div class="pb">${recommendMarkets()}</div>
      </section>
    `;

    updateStats();
  }

  function renderKeywordsPage() {
    const words = {};
    State.ads.forEach((ad) => {
      [ad.product, ad.market, ad.status,
       ...String(`${ad.note} ${ad.optimizeNote} ${ad.actionNote}`).split(/[\s,，、;；]+/)
      ].forEach((w) => {
        w = String(w || '').trim();
        if (w.length >= 2) words[w] = (words[w] || 0) + 1;
      });
    });

    const rows = Object.entries(words)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100);

    $('#pageTitle').textContent = '关键词';
    $('#bc1').textContent = '工作台';
    $('#bc2').textContent = '关键词';

    $('#content').innerHTML = `
      <section class="panel">
        <div class="ph">关键词频次</div>
        <div class="pb">
          ${rows.length
            ? rows.map(([k, v]) => `<span class="mpill">${esc(k)} · ${v}</span>`).join('')
            : '<div class="empty">暂无关键词</div>'
          }
        </div>
      </section>
    `;

    updateStats();
  }

  // ============================================
  // 系统设置页
  // ============================================
  function renderSettingsPage() {
    $('#pageTitle').textContent = '系统设置';
    $('#bc1').textContent = '工作台';
    $('#bc2').textContent = '系统设置';

    const products = getProducts();
    const markets = getMarkets();

    $('#content').innerHTML = `
      <div class="grid">
        <section class="panel">
          <div class="ph">产品选项 <span class="muted-sm">${products.length} 个</span></div>
          <div class="pb stack">
            <div class="opt-add">
              <input id="optProductInp" class="inp inp-sm" placeholder="输入新产品名称">
              <button class="btn primary small" data-act="addOption" data-kind="product">添加</button>
            </div>
            <div class="opt-list">
              ${products.map((p) => `
                <span class="opt-tag">${esc(p)}
                  <button class="opt-del" data-act="delOption" data-kind="product" data-value="${esc(p)}" title="删除">×</button>
                </span>`).join('')}
            </div>
            <div class="hint">删除选项不影响已有广告记录，只影响新建时的下拉列表。</div>
          </div>
        </section>

        <section class="panel">
          <div class="ph">市场选项 <span class="muted-sm">${markets.length} 个</span></div>
          <div class="pb stack">
            <div class="opt-add">
              <input id="optMarketInp" class="inp inp-sm" placeholder="输入新市场名称">
              <button class="btn primary small" data-act="addOption" data-kind="market">添加</button>
            </div>
            <div class="opt-list">
              ${markets.map((m) => `
                <span class="opt-tag">${esc(m)}
                  <button class="opt-del" data-act="delOption" data-kind="market" data-value="${esc(m)}" title="删除">×</button>
                </span>`).join('')}
            </div>
            <div class="hint">删除选项不影响已有广告记录，只影响新建时的下拉列表。</div>
          </div>
        </section>

        <section class="panel">
          <div class="ph">备份管理</div>
          <div class="pb stack">
            <div class="hint">每次保存会自动快照（保留最近 30 份），也可手动创建备份。恢复前会自动快照当前数据。</div>
            <div class="toolbar">
              <button class="btn small" data-act="backup">创建手动备份</button>
              <button class="btn small" data-act="refreshBackups">刷新列表</button>
            </div>
            <div id="backupList"><div class="empty">加载中...</div></div>
          </div>
        </section>

        <section class="panel">
          <div class="ph">系统信息</div>
          <div class="pb stack">
            <div class="kv"><span>数据版本</span><b>v${State.rev}</b></div>
            <div class="kv"><span>广告记录</span><b>${State.ads.length} 条</b></div>
            <div class="kv"><span>访问密码</span><b>${State.serverHealth?.authEnabled ? '已启用' : '未启用'}</b></div>
            <div class="hint">多窗口同时编辑时，保存会做版本校验，版本过期会弹窗提示，避免互相覆盖。</div>
          </div>
        </section>
      </div>
    `;

    loadBackupList();
    updateStats();
  }

  async function loadBackupList() {
    const el = $('#backupList');
    if (!el) return;
    try {
      const rows = await api('/api/backups');
      el.innerHTML = rows.length ? `
        <table class="table">
          <thead><tr><th>#</th><th>类型</th><th>时间</th><th></th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${r.id}</td>
                <td>${esc(r.scope)}</td>
                <td>${esc(String(r.created_at || '').replace('T', ' ').slice(0, 19))}</td>
                <td><button class="btn small" data-act="restoreBackup" data-id="${r.id}">恢复</button></td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty">暂无备份</div>';
    } catch (err) {
      el.innerHTML = `<div class="empty">加载失败：${esc(err.message)}</div>`;
    }
  }

  async function addOption(kind) {
    const inp = kind === 'product' ? $('#optProductInp') : $('#optMarketInp');
    const v = (inp?.value || '').trim();
    if (!v) { toast('请输入名称', 'warn'); return; }
    try {
      const r = await api('/api/options', { method: 'POST', body: JSON.stringify({ kind, value: v }) });
      State.options = { product: r.product || [], market: r.market || [] };
      toast(`已添加${kind === 'product' ? '产品' : '市场'}：${v}`, 'success');
      renderSettingsPage();
    } catch (err) { toast(`添加失败：${err.message}`, 'error'); }
  }

  function delOption(kind, value) {
    confirmBox('删除选项', `确定删除${kind === 'product' ? '产品' : '市场'}「${value}」吗？已有记录不受影响。`, async () => {
      try {
        const r = await api(`/api/options/${kind}/${encodeURIComponent(value)}`, { method: 'DELETE' });
        State.options = { product: r.product || [], market: r.market || [] };
        toast('已删除', 'success');
        renderSettingsPage();
      } catch (err) { toast(`删除失败：${err.message}`, 'error'); }
    });
  }

  function restoreBackup(id) {
    confirmBox('恢复备份', `确定从备份 #${id} 恢复吗？当前数据会被替换（恢复前会自动快照当前数据，可撤销）。`, async () => {
      try {
        const r = await api(`/api/backups/${id}/restore`, { method: 'POST' });
        if (typeof r.rev === 'number') State.rev = r.rev;
        await loadFromServer();
        toast(`已从备份 #${id} 恢复 ${r.count} 条记录`, 'success');
      } catch (err) { toast(`恢复失败：${err.message}`, 'error'); }
    });
  }

  // ============================================
  // v4.0 总览 Dashboard
  // ============================================
  function dashDates(n, offset = 0) {
    const out = [];
    const t = new Date();
    for (let i = offset + n - 1; i >= offset; i--) {
      const d = new Date(t);
      d.setDate(d.getDate() - i);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  function dashDailyMap() {
    const map = {};
    State.ads.forEach((ad) => ad.daily.forEach((d) => {
      const m = map[d.date] || (map[d.date] = { spend: 0, orders: 0, revenue: 0 });
      m.spend += +d.spend || 0;
      m.orders += +d.orders || 0;
      m.revenue += +d.revenue || 0;
    }));
    return map;
  }

  function sumDays(map, dates) {
    const t = { spend: 0, orders: 0, revenue: 0 };
    dates.forEach((dt) => {
      const m = map[dt];
      if (m) { t.spend += m.spend; t.orders += m.orders; t.revenue += m.revenue; }
    });
    t.profit = t.revenue - t.spend;
    t.roi = t.spend ? (t.profit / t.spend) * 100 : null;
    t.margin = t.revenue ? (t.profit / t.revenue) * 100 : null;
    t.cost = t.orders ? t.spend / t.orders : 0;
    return t;
  }

  function deltaHTML(cur, prev, invert, suffix = '%') {
    if (cur == null) return '<span class="delta na">—</span>';
    if (!prev && cur) return '<span class="delta up">新</span>';
    if (!prev && !cur) return '<span class="delta na">—</span>';
    const d = ((cur - prev) / Math.abs(prev)) * 100;
    const good = invert ? !up : up;
    const cls = Math.abs(d) < 0.05 ? 'na' : (good ? 'up' : 'down');
    const arrow = Math.abs(d) < 0.05 ? '' : (up ? '▲' : '▼');
    return `<span class="delta ${cls}">${arrow} ${Math.abs(d).toFixed(1)}${suffix}</span>`;
  }

  function drawSpark(id, values, color) {
    const cv = document.getElementById(id);
    if (!cv || !values.length) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 120, h = cv.clientHeight || 36;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const validVals = values.filter((v) => v != null);
    const max = Math.max(...validVals, 1), min = Math.min(...validVals, 0);
    const px = (i) => 2 + (i / (values.length - 1 || 1)) * (w - 4);
    const py = (v) => h - 3 - ((v - min) / (max - min || 1)) * (h - 6);
    const trace = () => {
      let pen = false;
      values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        if (!pen) { ctx.moveTo(px(i), py(v)); pen = true; }
        else ctx.lineTo(px(i), py(v));
      });
    };
    // 面积（仅全有效时绘制）
    if (validVals.length === values.length) {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, color + '44'); grad.addColorStop(1, color + '00');
      ctx.beginPath();
      trace();
      ctx.lineTo(px(values.length - 1), h); ctx.lineTo(px(0), h); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
    }
    // 线
    ctx.beginPath();
    trace();
    ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
    // 末端点（最后一个有效值）
    for (let i = values.length - 1; i >= 0; i--) {
      if (values[i] != null) {
        ctx.beginPath();
        ctx.arc(px(i), py(values[i]), 2.6, 0, 7);
        ctx.fillStyle = color; ctx.fill();
        break;
      }
    }
  }

  function drawDashChart(map, dates) {
    const cv = document.getElementById('dashChart');
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 700, h = 300;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const series = [
      { key: 'spend', color: css('--brand') || '#0b6e74', label: '消耗' },
      { key: 'revenue', color: css('--blue') || '#0b5f8a', label: '收入' },
    ];
    const vals = dates.map((dt) => map[dt] || { spend: 0, orders: 0, revenue: 0 });
    const maxV = Math.max(1, ...vals.map((v) => Math.max(v.spend, v.revenue)));
    const padL = 46, padR = 12, padT = 14, padB = 26;
    const iw = w - padL - padR, ih = h - padT - padB;
    const niceMax = Math.ceil(maxV / Math.pow(10, Math.floor(Math.log10(maxV)))) * Math.pow(10, Math.floor(Math.log10(maxV)));
    const px = (i) => padL + (i / (dates.length - 1 || 1)) * iw;
    const py = (v) => padT + ih - (v / niceMax) * ih;
    // 网格
    ctx.strokeStyle = css('--line') || '#e3e8ee'; ctx.lineWidth = 1;
    ctx.fillStyle = css('--faint') || '#9aa5b1'; ctx.font = '10px sans-serif';
    for (let g = 0; g <= 4; g++) {
      const y = padT + (ih / 4) * g;
      const val = niceMax - (niceMax / 4) * g;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText('€' + (val >= 1000 ? (val / 1000) + 'k' : Math.round(val)), 4, y + 3);
    }
    // 日期
    const step = Math.ceil(dates.length / 8);
    ctx.textAlign = 'center';
    dates.forEach((dt, i) => {
      if (i % step === 0 || i === dates.length - 1) ctx.fillText(dt.slice(5), px(i), h - 8);
    });
    ctx.textAlign = 'left';
    // 序列
    series.forEach((s) => {
      const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
      grad.addColorStop(0, s.color + '30'); grad.addColorStop(1, s.color + '00');
      ctx.beginPath();
      vals.forEach((v, i) => i ? ctx.lineTo(px(i), py(v[s.key])) : ctx.moveTo(px(i), py(v[s.key])));
      ctx.lineTo(px(vals.length - 1), padT + ih); ctx.lineTo(px(0), padT + ih); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath();
      vals.forEach((v, i) => i ? ctx.lineTo(px(i), py(v[s.key])) : ctx.moveTo(px(i), py(v[s.key])));
      ctx.strokeStyle = s.color; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.stroke();
    });
  }

  function rankData(n, type) {
    const map = {};
    const dates = new Set(dashDates(n));
    State.ads.forEach((ad) => {
      const k = type === 'market' ? (ad.market || '未选市场') : (ad.product || '未命名');
      const m = map[k] || (map[k] = { spend: 0, orders: 0, revenue: 0 });
      ad.daily.forEach((d) => {
        if (dates.has(d.date)) { m.spend += +d.spend || 0; m.orders += +d.orders || 0; m.revenue += +d.revenue || 0; }
      });
    });
    return Object.entries(map).filter(([, v]) => v.spend > 0)
      .sort((a, b) => b[1].spend - a[1].spend).slice(0, 6);
  }

  function dashAlerts(n) {
    const alerts = [];
    const dates = new Set(dashDates(n));
    const last3 = new Set(dashDates(3));
    State.ads.forEach((ad) => {
      let spend = 0, revenue = 0, s3 = 0, o3 = 0;
      ad.daily.forEach((d) => {
        if (dates.has(d.date)) { spend += +d.spend || 0; revenue += +d.revenue || 0; }
        if (last3.has(d.date)) { s3 += +d.spend || 0; o3 += +d.orders || 0; }
      });
      if (s3 > 0 && o3 === 0) {
        alerts.push({ level: 'bad', ad, text: `近3天消耗 €${fmt(s3)} 但 0 转化` });
      } else if (spend > 0) {
        const roi = ((revenue - spend) / spend) * 100;
        if (roi < -20) alerts.push({ level: 'warn', ad, text: `近${n}天 ROI ${roi.toFixed(0)}%，持续亏损` });
      }
      if (ad.budget > 0) {
        const total = ad.daily.reduce((s, d) => s + (+d.spend || 0), 0);
        if (total / ad.budget >= 0.9 && total > 0) {
          alerts.push({ level: 'warn', ad, text: `预算使用率 ${(total / ad.budget * 100).toFixed(0)}%` });
        }
      }
    });
    return alerts.slice(0, 6);
  }

  function animateNum(el, target, format) {
    if (!el) return;
    const dur = 700, t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = format(target * e);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderDashboard() {
    const n = State.dashRange || 7;
    const map = dashDailyMap();
    const cur = sumDays(map, dashDates(n));
    const prev = sumDays(map, dashDates(n, n));
    const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

    $('#pageTitle').textContent = '总览';
    $('#bc1').textContent = '工作台';
    $('#bc2').textContent = '总览';

    const dates = dashDates(n);
    const dailyROI = dates.map((d) => {
      const m = map[d];
      return (m && m.spend) ? ((m.revenue - m.spend) / m.spend) * 100 : null;
    });
    const dailyMargin = dates.map((d) => {
      const m = map[d];
      return (m && m.revenue) ? ((m.revenue - m.spend) / m.revenue) * 100 : null;
    });

    const kpis = [
      { label: '总消耗', val: cur.spend, fmt: (v) => '€' + fmt(v), delta: deltaHTML(cur.spend, prev.spend, true), spark: dates.map((d) => (map[d] || {}).spend || 0), color: css('--brand') },
      { label: '总单量', val: cur.orders, fmt: (v) => Math.round(v).toString(), delta: deltaHTML(cur.orders, prev.orders, false), spark: dates.map((d) => (map[d] || {}).orders || 0), color: css('--blue') },
      { label: '总收入', val: cur.revenue, fmt: (v) => '€' + fmt(v), delta: deltaHTML(cur.revenue, prev.revenue, false), spark: dates.map((d) => (map[d] || {}).revenue || 0), color: css('--green') },
      { label: 'ROI', val: cur.roi, fmt: (v) => (cur.roi == null ? '—' : v.toFixed(1) + '%'), delta: cur.roi == null ? '<span class="delta na">—</span>' : deltaHTML(cur.roi, prev.roi, false, 'pp'), spark: dailyROI, color: css('--accent') },
      { label: '毛利率', val: cur.margin, fmt: (v) => (cur.margin == null ? '—' : v.toFixed(1) + '%'), delta: cur.margin == null ? '<span class="delta na">—</span>' : deltaHTML(cur.margin, prev.margin, false, 'pp'), spark: dailyMargin, color: css('--orange') },
    ];

    const prodRank = rankData(n, 'product');
    const mktRank = rankData(n, 'market');
    const maxSpend = Math.max(1, ...prodRank.map(([, v]) => v.spend), ...mktRank.map(([, v]) => v.spend));
    const barRow = ([k, v]) => {
      const roi = v.spend ? ((v.revenue - v.spend) / v.spend) * 100 : null;
      return `<div class="rank-row">
        <span class="rank-name">${esc(k)}</span>
        <div class="rank-bar"><i style="width:${(v.spend / maxSpend * 100).toFixed(1)}%"></i></div>
        <span class="rank-val num">€${fmt(v.spend)}</span>
        <span class="rank-roi ${roi == null ? '' : roi >= 0 ? 'pos' : 'neg'}">${roi == null ? '' : roi.toFixed(0) + '%'}</span>
      </div>`;
    };

    const alerts = dashAlerts(n);

    $('#content').innerHTML = `
      <div class="dash">
        <div class="dash-head">
          <div>
            <h2 class="dash-title">业务总览</h2>
            <p class="dash-sub">近 ${n} 天 · 与前 ${n} 天对比 · ${State.ads.length} 条广告在跑</p>
          </div>
          <div class="seg">
            <button class="${n === 7 ? 'on' : ''}" data-act="dashRange" data-n="7">近7天</button>
            <button class="${n === 30 ? 'on' : ''}" data-act="dashRange" data-n="30">近30天</button>
          </div>
        </div>

        <div class="kpis">
          ${kpis.map((k, i) => `
            <div class="kpi" style="--d:${i * 60}ms">
              <div class="kpi-top"><span>${k.label}</span>${k.delta}</div>
              <b class="kpi-num num" id="kpiNum${i}">0</b>
              <canvas class="spark" id="spark${i}"></canvas>
            </div>`).join('')}
        </div>

        <div class="dash-grid">
          <section class="panel span2">
            <div class="ph">消耗 / 收入趋势
              <span class="chart-legend">
                <span class="lg on"><i style="background:var(--brand)"></i>消耗</span>
                <span class="lg on"><i style="background:var(--blue)"></i>收入</span>
              </span>
            </div>
            <div class="pb"><canvas id="dashChart" class="chart dash-chart"></canvas></div>
          </section>
          <section class="panel">
            <div class="ph">智能预警 <span class="muted-sm">${alerts.length}</span></div>
            <div class="pb alerts">
              ${alerts.length ? alerts.map((a) => `
                <div class="alert ${a.level}" data-act="openAd" data-id="${a.ad.id}">
                  <b>${esc(a.ad.no || '')} · ${esc(a.ad.product || '')}</b>
                  <span>${esc(a.text)}</span>
                </div>`).join('')
                : `<div class="empty-sm">暂无预警，投放状态健康</div>`}
            </div>
          </section>
        </div>

        <div class="dash-grid">
          <section class="panel">
            <div class="ph">产品排行 <span class="muted-sm">按消耗</span></div>
            <div class="pb">${prodRank.length ? prodRank.map(barRow).join('') : '<div class="empty-sm">暂无数据</div>'}</div>
          </section>
          <section class="panel">
            <div class="ph">市场排行 <span class="muted-sm">按消耗</span></div>
            <div class="pb">${mktRank.length ? mktRank.map(barRow).join('') : '<div class="empty-sm">暂无数据</div>'}</div>
          </section>
        </div>
      </div>
    `;

    // 数字滚动 + sparkline
    kpis.forEach((k, i) => {
      animateNum(document.getElementById('kpiNum' + i), k.val, k.fmt);
      if (k.spark.filter((v) => v != null).length > 1) drawSpark('spark' + i, k.spark, k.color || '#0b6e74');
    });
    drawDashChart(map, dashDates(n));
    window.addEventListener('resize', () => {
      if (State.view === 'dashboard') {
        drawDashChart(dashDailyMap(), dashDates(State.dashRange || 7));
        kpis.forEach((k, i) => { if (k.spark.filter((v) => v != null).length > 1) drawSpark('spark' + i, k.spark, k.color || '#0b6e74'); });
      }
    });

    updateStats();
  }

  // ============================================
  // v4.0 命令面板 Cmd+K
  // ============================================
  const PALETTE_ACTIONS = [
    { id: 'new', title: '新建广告记录', hint: 'N', run: () => { State.view = 'list'; renderShell(); setTimeout(() => document.querySelector('[data-act="toggleAdd"]')?.click(), 50); } },
    { id: 'dash', title: '前往总览', run: () => { State.view = 'dashboard'; renderShell(); } },
    { id: 'list', title: '前往广告列表', run: () => { State.view = 'list'; renderShell(); } },
    { id: 'stats', title: '前往统计报表', run: () => { State.view = 'stats'; renderShell(); } },
    { id: 'settings', title: '前往系统设置', run: () => { State.view = 'settings'; renderShell(); } },
    { id: 'theme', title: '切换深色 / 浅色', run: () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; if (State.view === 'dashboard') renderDashboard(); } },
    { id: 'save', title: '立即保存', hint: '⌃S', run: () => saveNow(true) },
    { id: 'export', title: '导出 JSON', run: () => exportJson() },
  ];
  let paletteIdx = 0;

  function ensurePalette() {
    if ($('#cmdPalette')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div id="cmdPalette" class="palette-overlay" hidden>
        <div class="palette">
          <div class="palette-input-wrap"><span>⌕</span><input id="paletteInput" placeholder="输入命令或搜索广告编号、产品…" autocomplete="off"></div>
          <div class="palette-list" id="paletteList"></div>
          <div class="palette-foot"><span><kbd>↑↓</kbd> 选择</span><span><kbd>↵</kbd> 执行</span><span><kbd>esc</kbd> 关闭</span></div>
        </div>
      </div>`);
    $('#paletteInput').addEventListener('input', renderPaletteList);
    $('#paletteInput').addEventListener('keydown', (e) => {
      const items = [...document.querySelectorAll('.palette-item')];
      if (e.key === 'ArrowDown') { e.preventDefault(); paletteIdx = Math.min(items.length - 1, paletteIdx + 1); markPalette(items); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIdx = Math.max(0, paletteIdx - 1); markPalette(items); }
      else if (e.key === 'Enter') { e.preventDefault(); items[paletteIdx]?.click(); }
    });
    $('#cmdPalette').addEventListener('click', (e) => { if (e.target.id === 'cmdPalette') togglePalette(false); });
  }

  function markPalette(items) {
    items.forEach((el, i) => el.classList.toggle('sel', i === paletteIdx));
    items[paletteIdx]?.scrollIntoView({ block: 'nearest' });
  }

  function renderPaletteList() {
    const q = ($('#paletteInput').value || '').toLowerCase().trim();
    const acts = PALETTE_ACTIONS.filter((a) => !q || a.title.toLowerCase().includes(q));
    const ads = State.ads
      .filter((a) => q && `${a.no} ${a.product} ${a.market}`.toLowerCase().includes(q))
      .slice(0, 8);
    paletteIdx = 0;
    $('#paletteList').innerHTML =
      (acts.length ? `<div class="palette-group">命令</div>` + acts.map((a) => `
        <div class="palette-item" data-pid="${a.id}"><span>${esc(a.title)}</span>${a.hint ? `<kbd>${esc(a.hint)}</kbd>` : ''}</div>`).join('') : '') +
      (ads.length ? `<div class="palette-group">广告</div>` + ads.map((a) => `
        <div class="palette-item" data-aid="${a.id}"><span><b>${esc(a.no || '')}</b> · ${esc(a.product || '')} · ${esc(a.market || '')}</span></div>`).join('') : '') +
      (!acts.length && !ads.length ? `<div class="empty-sm">无匹配结果</div>` : '');
    [...document.querySelectorAll('.palette-item')].forEach((el) => {
      el.addEventListener('click', () => {
        togglePalette(false);
        if (el.dataset.pid) PALETTE_ACTIONS.find((a) => a.id === el.dataset.pid)?.run();
        else if (el.dataset.aid) { State.view = 'list'; State.selectedId = el.dataset.aid; renderShell(); }
      });
    });
    markPalette([...document.querySelectorAll('.palette-item')]);
  }

  function togglePalette(open) {
    ensurePalette();
    const ov = $('#cmdPalette');
    const show = open === undefined ? ov.hidden : open;
    ov.hidden = !show;
    if (show) {
      $('#paletteInput').value = '';
      renderPaletteList();
      setTimeout(() => $('#paletteInput').focus(), 30);
    }
  }

  // ============================================
  // 统计数据
  // ============================================
  function groupStats(type) {
    const map = {};
    State.ads.forEach((ad) => {
      const k = type === 'market' ? (ad.market || '未选市场') : (ad.product || '未命名');
      const c = calc(ad);

      if (!map[k]) map[k] = { count: 0, spend: 0, orders: 0, revenue: 0, profit: 0 };
      map[k].count++;
      map[k].spend += c.spend;
      map[k].orders += c.orders;
      map[k].revenue += c.revenue;
      map[k].profit += c.profit;
    });
    return map;
  }

  function statTable(map) {
    const rows = Object.entries(map).sort((a, b) => b[1].spend - a[1].spend);
    if (!rows.length) return '<div class="empty">暂无数据</div>';

    return `
      <table class="table">
        <thead>
          <tr><th>名称</th><th>广告</th><th>消耗</th><th>单量</th><th>收入</th><th>利润</th><th>均成本</th></tr>
        </thead>
        <tbody>
          ${rows.map(([k, v]) => `
            <tr>
              <td>${esc(k)}</td>
              <td>${v.count}</td>
              <td>€${fmt(v.spend)}</td>
              <td>${fmtI(v.orders)}</td>
              <td>€${fmt(v.revenue)}</td>
              <td class="${v.profit >= 0 ? 'good' : 'bad'}">€${fmt(v.profit)}</td>
              <td>€${fmt(v.orders ? v.spend / v.orders : 0)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function recommendMarkets() {
    const rows = Object.entries(groupStats('market'))
      .sort((a, b) => b[1].profit - a[1].profit)
      .slice(0, 8);

    return rows.length
      ? rows.map(([k, v], i) =>
          `<span class="mpill ${i < 3 ? 'hot' : ''}">${esc(k)} · 利润€${fmt(v.profit)} · ${fmtI(v.orders)}单</span>`
        ).join('')
      : '<div class="empty">暂无数据</div>';
  }

  // ============================================
  // 数据操作
  // ============================================
  function editAd(ad, key, value) {
    if (!ad._editing) {
      pushUndo();
      ad._editing = true;
      setTimeout(() => delete ad._editing, 800);
    }

    if (key === 'budget') value = money(value);
    ad[key] = value;

    markDirty(true);
    renderList();
  }

  function editDaily(ad, id, key, value) {
    const d = ad.daily.find((x) => x.id === id);
    if (!d) return;

    if (!ad._editing) {
      pushUndo();
      ad._editing = true;
      setTimeout(() => delete ad._editing, 800);
    }

    if (key === 'date' && !validDate(value)) {
      toast('日期无效', 'warn');
      return;
    }

    if (['spend', 'revenue'].includes(key)) {
      value = money(value);
    }

    if (key === 'orders') {
      value = intNum(value);
    }

    d[key] = value;
    markDirty(true);
    renderDetail(ad.id);
    renderList();
  }

  // 自动编号：扫描现有 AD-数字 格式，返回下一个可用编号
  function nextAdNo() {
    let max = 0;
    State.ads.forEach((a) => {
      const m = /^AD-(\d+)$/i.exec(String(a.no || '').trim());
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return `AD-${String(max + 1).padStart(3, '0')}`;
  }

  function addAd() {
    const ad = normalizeAd({
      no: $('#qNo')?.value,
      budget: $('#qBudget')?.value,
      product: $('#qProduct')?.value,
      market: $('#qMarket')?.value,
      status: $('#qStatus')?.value,
      createdAt: today()
    });

    const errors = validateAd(ad);
    if (errors.length) {
      toast(errors[0].message, 'warn');
      return;
    }

    pushUndo();
    State.ads.unshift(ad);
    State.selectedId = ad.id;
    State.dirty = true;

    renderShell();
    saveNow(false);
  }

  function addDaily(id) {
    const ad = State.ads.find((a) => a.id === id);
    if (!ad) return;

    pushUndo();
    ad.daily.push(normalizeDaily({
      date: $('#dDate')?.value,
      spend: $('#dSpend')?.value,
      orders: $('#dOrders')?.value,
      revenue: $('#dRevenue')?.value,
      note: $('#dNote')?.value
    }));

    State.dirty = true;
    renderDetail(id);
    renderList();
    saveNow(false);
  }

  // 复制昨日数据：取离今天最近的一条每日记录，复制消耗/单量/收入/备注，日期填今天
  function copyYesterday(id) {
    const ad = State.ads.find((a) => a.id === id);
    if (!ad) return;
    if (!ad.daily.length) {
      toast('还没有每日数据可复制', 'warn');
      return;
    }
    const t = today();
    const src = ad.daily
      .filter((d) => d.date < t)
      .sort((a, b) => b.date.localeCompare(a.date))[0] || ad.daily[0];

    pushUndo();
    ad.daily.push(normalizeDaily({
      date: t,
      spend: src.spend,
      orders: src.orders,
      revenue: src.revenue,
      note: src.note
    }));

    State.dirty = true;
    renderDetail(id);
    renderList();
    saveNow(false);
    toast(`已复制 ${src.date} 的数据`, 'success');
  }

  function deleteAd(id) {
    confirmBox('删除广告', '确定删除这条广告及所有每日数据吗？可撤销。', () => {
      pushUndo();
      State.ads = State.ads.filter((a) => a.id !== id);
      State.selectedId = '';
      State.dirty = true;
      renderShell();
      saveNow(false);
    });
  }

  function copyAd(id) {
    const ad = State.ads.find((a) => a.id === id);
    if (!ad) return;

    pushUndo();
    const copy = normalizeAd(JSON.parse(JSON.stringify(ad)));
    copy.id = uid('a');
    copy.no = `${copy.no}-copy`;
    copy.daily = [];
    copy.createdAt = today();

    State.ads.unshift(copy);
    State.selectedId = copy.id;
    State.dirty = true;

    renderShell();
    saveNow(false);
  }

  function deleteDaily(adId, dailyId) {
    const ad = State.ads.find((a) => a.id === adId);
    if (!ad) return;

    pushUndo();
    ad.daily = ad.daily.filter((d) => d.id !== dailyId);
    State.dirty = true;

    renderDetail(adId);
    renderList();
    saveNow(false);
  }

  function checkedIds() {
    return $$('[data-check]:checked').map((x) => x.dataset.check);
  }

  function batchStatus() {
    const ids = checkedIds();
    if (!ids.length) {
      toast('请先勾选广告', 'warn');
      return;
    }

    const next = prompt(`将 ${ids.length} 条广告改为状态：\n${STATUS.join(' / ')}`, '暂停');
    if (!STATUS.includes(next)) {
      toast('状态无效', 'warn');
      return;
    }

    pushUndo();
    State.ads.forEach((a) => {
      if (ids.includes(a.id)) a.status = next;
    });

    State.dirty = true;
    renderList();
    saveNow(false);
  }

  function batchDelete() {
    const ids = checkedIds();
    if (!ids.length) {
      toast('请先勾选广告', 'warn');
      return;
    }

    confirmBox('批量删除', `确定删除 ${ids.length} 条广告吗？`, () => {
      pushUndo();
      State.ads = State.ads.filter((a) => !ids.includes(a.id));
      State.selectedId = '';
      State.dirty = true;
      renderShell();
      saveNow(false);
    });
  }

  function clearAll() {
    confirmBox('清空数据', '确定清空服务端 SQLite 数据库里的所有广告记录吗？建议先导出备份。', () => {
      pushUndo();
      State.ads = [];
      State.selectedId = '';
      State.dirty = true;
      renderShell();
      saveNow(true);
    });
  }

  // ============================================
  // 撤销/重做
  // ============================================
  function undo() {
    if (!State.undoStack.length) {
      toast('没有可撤销的操作', 'warn');
      return;
    }

    State.redoStack.push(JSON.stringify(State.ads));
    State.ads = JSON.parse(State.undoStack.pop()).map(normalizeAd);
    State.dirty = true;

    renderShell();
    saveNow(false);
    toast('已撤销', 'success');
  }

  function redo() {
    if (!State.redoStack.length) {
      toast('没有可重做的操作', 'warn');
      return;
    }

    State.undoStack.push(JSON.stringify(State.ads));
    State.ads = JSON.parse(State.redoStack.pop()).map(normalizeAd);
    State.dirty = true;

    renderShell();
    saveNow(false);
  }

  // ============================================
  // 确认对话框
  // ============================================
  let confirmCallback = null;

  function confirmBox(title, message, cb) {
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').textContent = message;
    confirmCallback = cb;
    $('#confirm').classList.add('open');
  }

  function closeConfirm() {
    confirmCallback = null;
    $('#confirm').classList.remove('open');
  }

  // ============================================
  // 导航更新
  // ============================================
  function updateNav() {
    $$('.nav-btn[data-page]').forEach((b) => {
      const isActive = b.dataset.page === State.view &&
        (State.view !== 'market' || b.dataset.param === State.viewMarket);
      b.classList.toggle('active', isActive);
    });
  }

  // ============================================
  // 应用外壳渲染
  // ============================================
  function marketNavHTML() {
    return getMarkets().slice(0, 4).map((m) =>
      `<button class="nav-btn" data-act="nav" data-page="market" data-param="${esc(m)}">
        <span class="nav-ico">${esc(m[0])}</span>
        <span class="nav-text">${esc(m)}</span>
      </button>`
    ).join('');
  }

  function renderAppShell() {
    const marketBtns = marketNavHTML();

    document.body.innerHTML = `
      <div class="app">
        <aside class="sidebar" id="sidebar">
          <div class="sb-head">
            <button class="logo" data-act="side">⌁</button>
            <span class="brand">谷歌广告系统</span>
            <button class="toggle" data-act="side">☰</button>
          </div>

          <nav class="nav">
            <div class="section">
              <div class="label">工作台</div>
              <button class="nav-btn active" data-act="nav" data-page="dashboard">
                <span class="nav-ico">◈</span>
                <span class="nav-text">总览</span>
              </button>
              <button class="nav-btn" data-act="nav" data-page="list">
                <span class="nav-ico">▤</span>
                <span class="nav-text">广告列表</span>
                <span class="badge-count" id="sbCount">0</span>
              </button>
              <button class="nav-btn" data-act="nav" data-page="stats">
                <span class="nav-ico">⌁</span>
                <span class="nav-text">统计报表</span>
              </button>
              <button class="nav-btn" data-act="nav" data-page="keywords">
                <span class="nav-ico">⌕</span>
                <span class="nav-text">关键词</span>
              </button>
            </div>

            <div class="section">
              <div class="label">市场</div>
              <div id="marketNav">${marketBtns}</div>
              <button class="nav-btn" data-act="nav" data-page="market" data-param="all">
                <span class="nav-ico">🌍</span>
                <span class="nav-text">更多市场</span>
              </button>
              <button class="nav-btn" data-act="nav" data-page="settings">
                <span class="nav-ico">⚙</span>
                <span class="nav-text">系统设置</span>
              </button>
            </div>

            <div class="section">
              <div class="label">数据库</div>
              <div class="db-box warn" id="dbBox">
                <b id="dbTitle">连接中</b>
                <span id="dbState">正在连接服务端 SQLite</span>
              </div>
              <button class="nav-btn" data-act="saveNow">
                <span class="nav-ico">✓</span>
                <span class="nav-text">立即保存</span>
              </button>
              <button class="nav-btn" data-act="diagnose">
                <span class="nav-ico">◎</span>
                <span class="nav-text">诊断数据库</span>
              </button>
              <button class="nav-btn" data-act="backup">
                <span class="nav-ico">DB</span>
                <span class="nav-text">创建服务端备份</span>
              </button>
            </div>

            <div class="section">
              <div class="label">数据</div>
              <button class="nav-btn" data-act="exportAll">
                <span class="nav-ico">JSON</span>
                <span class="nav-text">导出JSON</span>
              </button>
              <button class="nav-btn" data-act="exportExcel">
                <span class="nav-ico">XLS</span>
                <span class="nav-text">导出Excel</span>
              </button>
              <button class="nav-btn" data-act="exportCsv">
                <span class="nav-ico">CSV</span>
                <span class="nav-text">导出CSV</span>
              </button>
              <button class="nav-btn" data-act="import">
                <span class="nav-ico">⇧</span>
                <span class="nav-text">导入数据</span>
              </button>
              <input id="importInput" class="hidden" type="file" accept=".json,.csv,.tsv,.xls,text/csv,application/json">
              <button class="nav-btn" data-act="clear">
                <span class="nav-ico">⌧</span>
                <span class="nav-text">清空数据</span>
              </button>
            </div>
          </nav>

          <div class="foot">
            <div class="user">
              <div class="avatar">陈</div>
              <div class="user-info">
                <div class="user-name">陈羽</div>
                <div class="user-role">广告管理员</div>
              </div>
            </div>
          </div>
        </aside>

        <main class="main">
          <header class="top">
            <div class="crumb">
              <span id="bc1">工作台</span> / <b id="bc2">广告列表</b>
            </div>
            <div class="top-right">
              <button class="palette-trigger" data-act="palette" title="命令面板 (Ctrl+K)">⌕ <kbd>⌘K</kbd></button>
              <span class="hint">Ctrl+S 保存 · Ctrl+Z 撤销 · N 新增</span>
              <span id="countTxt"></span>
              <button class="icon" data-act="theme">◐</button>
            </div>
          </header>

          <div class="page">
            <div class="body">
              <div class="head">
                <div>
                  <div class="title" id="pageTitle">广告列表</div>
                  <div class="sub">服务端 SQLite 独立数据库 · 不依赖浏览器存储</div>
                </div>
                <div class="stats">
                  <div class="stat"><b id="hTotal">0</b><span>广告数</span></div>
                  <div class="stat"><b id="hRunning">0</b><span>运行中</span></div>
                  <div class="stat"><b id="hSpend">0.00</b><span>总消耗€</span></div>
                  <div class="stat"><b id="hOrders">0</b><span>总单量</span></div>
                  <div class="stat"><b id="hCost">0.00</b><span>均成本€</span></div>
                </div>
              </div>
              <div id="content"></div>
            </div>
          </div>
        </main>
      </div>

      <div id="confirm" class="overlay">
        <div class="dialog">
          <h3 id="confirmTitle">确认操作</h3>
          <p id="confirmMsg"></p>
          <div class="dialog-btns">
            <button class="btn small" data-act="cancel">取消</button>
            <button class="btn danger small" data-act="ok">确认</button>
          </div>
        </div>
      </div>

      <div id="toast" class="toast"></div>
    `;
  }

  // ============================================
  // 事件绑定
  // ============================================
  function bindEvents() {
    // 点击事件委托
    document.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;

      const act = b.dataset.act;

      switch (act) {
        case 'side':
          $('#sidebar').classList.toggle('collapsed');
          break;

        case 'theme':
          document.documentElement.dataset.theme =
            document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
          break;

        case 'nav':
          State.view = b.dataset.page;
          State.viewMarket = b.dataset.param || '';
          State.selectedId = '';
          State.currentPage = 1;
          renderShell();
          break;

        case 'dashRange':
          State.dashRange = parseInt(b.dataset.n, 10) || 7;
          renderDashboard();
          break;

        case 'openAd':
          State.view = 'list';
          State.selectedId = b.dataset.id;
          renderShell();
          break;

        case 'palette':
          togglePalette();
          break;

        case 'saveNow':
          await saveNow(true);
          break;

        case 'diagnose':
          await diagnose();
          break;

        case 'backup':
          await makeBackup();
          break;

        case 'exportAll':
          exportJson();
          break;

        case 'exportCsv':
          exportCsvLocal();
          break;

        case 'exportExcel':
          exportExcel();
          break;

        case 'import':
          importFile();
          break;

        case 'clear':
          clearAll();
          break;

        case 'toggleAdd': {
          const qa = $('#qa');
          qa?.classList.toggle('open');
          if (qa?.classList.contains('open')) {
            const noInp = $('#qNo');
            if (noInp && !noInp.value) noInp.value = nextAdNo();
            $('#qProduct')?.focus();
          }
          break;
        }

        case 'closeAdd':
          $('#qa')?.classList.remove('open');
          break;

        case 'addAd':
          addAd();
          break;

        case 'select':
          State.selectedId = b.dataset.id;
          renderList();
          break;

        case 'copyAd':
          copyAd(b.dataset.id);
          break;

        case 'delAd':
          deleteAd(b.dataset.id);
          break;

        case 'addDaily':
          addDaily(b.dataset.id);
          break;

        case 'copyYesterday':
          copyYesterday(b.dataset.id);
          break;

        case 'toggleSeries':
          State.chartSeries[b.dataset.series] = !State.chartSeries[b.dataset.series];
          renderDetail(State.selectedId);
          break;

        case 'delDaily':
          deleteDaily(b.dataset.ad, b.dataset.id);
          break;

        case 'batchStatus':
          batchStatus();
          break;

        case 'batchDelete':
          batchDelete();
          break;

        case 'addOption':
          addOption(b.dataset.kind);
          break;

        case 'delOption':
          delOption(b.dataset.kind, b.dataset.value);
          break;

        case 'restoreBackup':
          restoreBackup(b.dataset.id);
          break;

        case 'refreshBackups':
          loadBackupList();
          break;

        case 'undo':
          undo();
          break;

        case 'redo':
          redo();
          break;

        case 'prevPage':
          State.currentPage--;
          renderList();
          break;

        case 'nextPage':
          State.currentPage++;
          renderList();
          break;

        case 'cancel':
          closeConfirm();
          break;

        case 'ok':
          const cb = confirmCallback;
          closeConfirm();
          if (cb) await cb();
          break;
      }
    });

    // 键盘快捷键
    document.addEventListener('keydown', async (e) => {
      // Cmd/Ctrl + K: 命令面板
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePalette();
        return;
      }

      // Ctrl/Cmd + S: 保存
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        await saveNow(true);
        return;
      }

      // Ctrl/Cmd + Shift + Z 或 Ctrl/Cmd + Y: 重做
      if ((e.ctrlKey || e.metaKey) && (e.shiftKey && e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        e.preventDefault();
        redo();
        return;
      }

      // Ctrl/Cmd + Z: 撤销
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
        return;
      }

      // N: 新增广告（在列表视图）
      if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'n' &&
          (State.view === 'list' || State.view === 'market')) {
        $('#qa')?.classList.add('open');
        $('#qNo')?.focus();
      }

      // Escape: 关闭对话框
      if (e.key === 'Escape') {
        if (!$('#cmdPalette')?.hidden) { togglePalette(false); return; }
        closeConfirm();
        closeChoice();
        $('#qa')?.classList.remove('open');
      }
    });

    // 页面卸载前提示
    window.addEventListener('beforeunload', (e) => {
      if (State.dirty) {
        e.preventDefault();
        e.returnValue = '数据尚未保存到服务端 SQLite 数据库';
      }
    });
  }

  // ============================================
  // 启动应用
  // ============================================
  function boot() {
    renderAppShell();
    bindEvents();
    loadFromServer();
  }

  // 等待 DOM 加载完成
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
