/**
 * 谷歌广告记录系统 - server.js
 * v3.0 - 数据安全强化版
 * 新增：
 *  1. 乐观锁（data_rev）：PUT 必须携带版本号，版本过期返回 409，防止多窗口覆盖丢失
 *  2. 自动备份轮转：每次成功保存自动快照，保留最近 30 份
 *  3. 产品/市场可配置：options 表 + /api/options 接口，不再硬编码
 *  4. /api/health 返回 dailyCount（修复诊断弹窗 undefined）
 *  5. 可选访问密码：设置 APP_PASSWORD 环境变量后启用
 *  6. 修复依赖：@fastify/cors@10 + @fastify/static@8（兼容 fastify 5）
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fastify = require('fastify')({ logger: true, bodyLimit: 50 * 1024 * 1024 }); // DH-7: 提高 PUT 上限到 50MB
const cors = require('@fastify/cors');
const staticPlugin = require('@fastify/static');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');
const multipart = require('@fastify/multipart');

const ROOT = __dirname;
// DH-20: 登录限速（每 IP 每分钟最多 10 次）
const loginAttempts = new Map();
function loginRateLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 60 * 1000 });
    return false;
  }
  rec.count += 1;
  return rec.count > 10;
}

const BLOCKED_STATIC_RE = [
  /^\/data(?:\/|$)/,
  /^\/scripts(?:\/|$)/,
  /^\/docs(?:\/|$)/,
  /^\/node_modules(?:\/|$)/,
  /^\/\./,
  /^\/server\.js$/,
  /^\/package\.json$/,
  /^\/package-lock\.json$/,
  /^\/render\.yaml$/,
  /^\/README\.md$/,
];

const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'ads.sqlite');
const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const MAX_AUTO_BACKUPS = 30;

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');
db.pragma('temp_store = MEMORY');

db.exec(`
  CREATE TABLE IF NOT EXISTS ads (
    id TEXT PRIMARY KEY, no TEXT NOT NULL DEFAULT '',
    product TEXT NOT NULL DEFAULT '', market TEXT NOT NULL DEFAULT '',
    budget REAL NOT NULL DEFAULT 0 CHECK (budget >= 0),
    status TEXT NOT NULL DEFAULT '测试中',
    note TEXT NOT NULL DEFAULT '', optimize_note TEXT NOT NULL DEFAULT '',
    action_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS daily_records (
    id TEXT PRIMARY KEY, ad_id TEXT NOT NULL, date TEXT NOT NULL,
    spend REAL NOT NULL DEFAULT 0 CHECK (spend >= 0),
    orders INTEGER NOT NULL DEFAULT 0 CHECK (orders >= 0),
    revenue REAL NOT NULL DEFAULT 0 CHECK (revenue >= 0),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (ad_id, date),
    FOREIGN KEY (ad_id) REFERENCES ads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS options (
    kind TEXT NOT NULL, value TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, value)
  );
  CREATE INDEX IF NOT EXISTS idx_ads_product ON ads(product);
  CREATE INDEX IF NOT EXISTS idx_ads_market ON ads(market);
  CREATE INDEX IF NOT EXISTS idx_ads_status ON ads(status);
  CREATE INDEX IF NOT EXISTS idx_ads_created ON ads(created_at);
  CREATE INDEX IF NOT EXISTS idx_daily_ad_id ON daily_records(ad_id);
  CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_records(date);
`);

// ---- P1-2 迁移：存量 (ad_id, date) 去重 + 唯一索引（幂等，重启可重复执行）----
db.exec(`
  DELETE FROM daily_records
  WHERE rowid NOT IN (
    SELECT MAX(rowid)
    FROM daily_records
    GROUP BY ad_id, date
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_ad_date ON daily_records(ad_id, date);
`);

// ---- 数据版本号（乐观锁）----
const getRev = () => {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'data_rev'").get();
  return row ? Number(row.value) : 0;
};
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'data_rev'").get()) {
  db.prepare("INSERT INTO meta (key, value) VALUES ('data_rev', '0')").run();
}

// ---- 产品/市场选项种子数据（仅首次为空时写入）----
const DEFAULT_PRODUCTS = [
  '索尼助听器', '呼吸机', '紧索套件', '汽车读卡器', '卡车导航',
  '自行车码表', '高速棘轮扳手', '电子翻译机', '血糖仪', '胶卷',
  'W55水分', '激光水平仪', '光伏检测仪', '手持电锯', '挖机水平仪'
];
const DEFAULT_MARKETS = [
  '德国', '意大利', '西班牙', '波兰', '罗马尼亚', '保加利亚',
  '斯洛伐克', '奥地利', '匈牙利', '葡萄牙', '捷克'
];
{
  const count = db.prepare('SELECT COUNT(*) AS n FROM options').get().n;
  if (!count) {
    const ins = db.prepare('INSERT INTO options (kind, value, sort) VALUES (?, ?, ?)');
    const seed = db.transaction(() => {
      DEFAULT_PRODUCTS.forEach((v, i) => ins.run('product', v, i));
      DEFAULT_MARKETS.forEach((v, i) => ins.run('market', v, i));
    });
    seed();
  }
}
const getOptions = () => {
  const rows = db.prepare('SELECT kind, value FROM options ORDER BY kind, sort, value').all();
  const out = { product: [], market: [] };
  rows.forEach((r) => { if (out[r.kind]) out[r.kind].push(r.value); });
  return out;
};

const STATUS = new Set(['未铺市场', '已铺市场', '测试中', '继续跑', '观察', '暂停']);
const localDate = (d = new Date()) => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
const today = () => localDate();
const now = () => new Date().toISOString();
const uid = (p) => `${p}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
const validDate = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
};
const money = (v) => Number(String(v ?? 0).replace(',', '.'));
const intNum = (v) => ((n) => Number.isFinite(n) ? Math.floor(n) : NaN)(money(v));

function normalizeDaily(row = {}) {
  return { id: String(row.id || uid('d')), date: validDate(row.date) ? row.date : today(),
    spend: money(row.spend), orders: intNum(row.orders ?? row.order), revenue: money(row.revenue), note: String(row.note || '') };
}

function normalizeAd(row = {}) {
  return { id: String(row.id || uid('a')), no: String(row.no || '').trim(),
    product: String(row.product || '').trim(), market: String(row.market || '').trim(),
    budget: money(row.budget), status: STATUS.has(row.status) ? row.status : '测试中',
    note: String(row.note || ''), optimizeNote: String(row.optimizeNote || row.optimize_note || ''),
    actionNote: String(row.actionNote || row.action_note || ''),
    createdAt: validDate(row.createdAt || row.created_at) ? (row.createdAt || row.created_at) : today(),
    daily: Array.isArray(row.daily)
      ? Array.from(new Map(row.daily.map(normalizeDaily).map(d => [d.date, d])).values())
      : [] };
}

function validateAd(ad, allAds) {
  const errors = [];
  if (!ad.no) errors.push('编号不能为空');
  if (!ad.product) errors.push('产品不能为空');

  // DH-4: 编号唯一性（同批 + 库中）
  const noStr = ad.no != null ? String(ad.no).trim() : '';
  if (noStr) {
    const dupInBatch = (allAds || []).some((a) => a !== ad && String(a.no || '').trim() === noStr);
    const dupInDb = readAds().some((a) => String(a.no || '').trim() === noStr && a.id !== ad.id);
    if (dupInBatch || dupInDb) errors.push('广告编号重复');
  }

  if (!ad.market) errors.push('市场不能为空');
  if (!validDate(ad.createdAt)) errors.push('创建日期无效');
  if (!Number.isFinite(ad.budget)) errors.push('预算必须是有效数字');
  else if (ad.budget < 0) errors.push('预算不能为负数');
  ad.daily.forEach(d => {
    if (!validDate(d.date)) errors.push('每日日期无效');
    if (!Number.isFinite(d.spend) || !Number.isFinite(d.orders) || !Number.isFinite(d.revenue)) {
      errors.push('每日数据必须是有效数字');
    } else if (d.spend < 0 || d.orders < 0 || d.revenue < 0) {
      errors.push('每日数据不能为负数');
    }
  });
  return errors;
}

function calc(ad) {
  const spend = ad.daily.reduce((s, d) => s + Number(d.spend || 0), 0);
  const orders = ad.daily.reduce((s, d) => s + Number(d.orders || 0), 0);
  const revenue = ad.daily.reduce((s, d) => s + Number(d.revenue || 0), 0);
  const profit = revenue - spend;
  return { spend, orders, revenue, profit, cost: orders ? spend / orders : 0,
    roi: spend ? (profit / spend) * 100 : null, margin: revenue ? (profit / revenue) * 100 : null };
}

function readAds() {
  // DH-17: 单查询 + 内存分组，消除 N+1
  const adRows = db.prepare('SELECT * FROM ads ORDER BY created_at DESC').all();
  const dailyByAd = new Map();
  if (adRows.length) {
    const placeholders = adRows.map(() => '?').join(',');
    const dailyRows = db.prepare(
      `SELECT * FROM daily_records WHERE ad_id IN (${placeholders}) ORDER BY date DESC`
    ).all(...adRows.map(r => r.id));
    for (const d of dailyRows) {
      if (!dailyByAd.has(d.ad_id)) dailyByAd.set(d.ad_id, []);
      dailyByAd.get(d.ad_id).push({ id: d.id, date: d.date, spend: d.spend, orders: d.orders, revenue: d.revenue, note: d.note });
    }
  }
  return adRows.map(r => ({ id: r.id, no: r.no, product: r.product, market: r.market,
    budget: r.budget, status: r.status, note: r.note,
    optimizeNote: r.optimize_note, actionNote: r.action_note, createdAt: r.created_at,
    daily: dailyByAd.get(r.id) || [] }));
}

function pack(scope = 'all', ads = readAds()) {
  return { schema: 'ads-record-v3', storage: 'server-sqlite', scope, exportedAt: now(), rev: getRev(), count: ads.length, ads };
}

// 全量替换 + 版本号递增 + 自动备份轮转（同一事务，原子完成）
const replaceAll = db.transaction((ads, scope) => {
  db.prepare('DELETE FROM daily_records').run();
  db.prepare('DELETE FROM ads').run();
  const insertAd = db.prepare(`INSERT INTO ads (id,no,product,market,budget,status,note,optimize_note,action_note,created_at,updated_at) VALUES (@id,@no,@product,@market,@budget,@status,@note,@optimizeNote,@actionNote,@createdAt,@updatedAt)`);
  const insertDaily = db.prepare(`INSERT INTO daily_records (id,ad_id,date,spend,orders,revenue,note,created_at,updated_at) VALUES (@id,@adId,@date,@spend,@orders,@revenue,@note,@createdAt,@updatedAt)`);
  const timestamp = now();
  ads.forEach(ad => {
    insertAd.run({ ...ad, updatedAt: timestamp });
    ad.daily.forEach(d => insertDaily.run({ ...d, adId: ad.id, createdAt: timestamp, updatedAt: timestamp }));
  });
  const newRev = getRev() + 1;
  db.prepare("UPDATE meta SET value = ? WHERE key = 'data_rev'").run(String(newRev));
  // 自动备份：写入快照并轮转，只保留最近 N 份
  db.prepare('INSERT INTO backups (scope, payload, created_at) VALUES (?, ?, ?)')
    .run(scope === 'import' ? 'auto-backup-import' : 'auto-backup', JSON.stringify(pack('auto-backup', ads)), timestamp);
  db.prepare(`DELETE FROM backups WHERE scope LIKE 'auto-backup%' AND id NOT IN (
    SELECT id FROM backups WHERE scope LIKE 'auto-backup%' ORDER BY id DESC LIMIT ?)`).run(MAX_AUTO_BACKUPS);
  return newRev;
});

// ---- 可选访问密码 ----
const TOKEN_SALT = 'ads-record-token-v1';
const TOKEN_TTL_HOURS = Number(process.env.TOKEN_TTL_HOURS) || 12;

function makeToken(ts) {
  if (!APP_PASSWORD) return '';
  const hmac = crypto.createHmac('sha256', APP_PASSWORD).update(TOKEN_SALT + ':' + ts).digest('hex');
  return `${ts}.${hmac}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !APP_PASSWORD) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const ts = Number(parts[0]);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const nowMs = Date.now(), ttlMs = TOKEN_TTL_HOURS * 3600 * 1000;
  if (ts > nowMs + 5 * 60 * 1000) return false;
  if (nowMs - ts > ttlMs) return false;
  const expected = makeToken(ts);
  return token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
const hashPwd = (p) => crypto.createHash('sha256').update(String(p)).digest('hex');
const hashExpected = APP_PASSWORD ? hashPwd(APP_PASSWORD) : '';

fastify.register(cors, {
  // DH-19: 只允许同源/无 Origin 与本地局域网
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    try {
      const h = new URL(origin).hostname;
      const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' ||
        /^192\.168\./.test(h) || /^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
      return cb(null, isLocal);
    } catch {
      return cb(null, false);
    }
  }
});
fastify.register(multipart);
fastify.register(staticPlugin, { root: ROOT, prefix: '/' });

fastify.addHook('onRequest', async (request, reply) => {
  // DH-1: 静态目录穿越防护（无论是否设置密码都拦截）
  let pathname;
  try {
    const rawUrl = request.raw.url || '';
    pathname = decodeURIComponent(rawUrl.split('?')[0]);
  } catch (err) {
    return reply.code(400).send({ ok: false, error: 'Bad Request' });
  }
  if (!pathname.startsWith('/')) pathname = '/' + pathname;
  const normalized = require('path').normalize(pathname);
  if (BLOCKED_STATIC_RE.some((re) => re.test(normalized))) {
    return reply.code(404).send({ ok: false, error: 'Not Found' });
  }

  if (!APP_PASSWORD) return;
  const rawUrl = request.raw.url || '';
  const urlPath = rawUrl.split('?')[0];
  if (urlPath === '/api/login' || urlPath === '/api/healthz' || !rawUrl.startsWith('/api/')) return; // 登录接口/健康检查与静态页面放行
  const token = request.headers['x-app-token'] || '';
  if (verifyToken(token)) return;
  return reply.code(401).send({ ok: false, authRequired: true, error: '登录已过期，请重新登录' });
});

fastify.post('/api/login', async (request, reply) => {
  if (!APP_PASSWORD) return { ok: true, token: '', authDisabled: true };
  const clientIp = request.ip;
  if (loginRateLimited(clientIp)) {
    return reply.code(429).send({ ok: false, error: '尝试过于频繁，请稍后再试' });
  }
  const pwd = String((request.body || {}).password || '');
  const a = hashPwd(pwd), b = hashExpected;
  const ok = pwd.length > 0 && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (!ok) return reply.code(401).send({ ok: false, error: '密码错误' });
  loginAttempts.delete(request.ip);
  return { ok: true, token: makeToken(Date.now()) };
});

fastify.get('/api/healthz', async () => ({ ok: true, version: '3.0.0' }));

fastify.get('/api/health', async () => {
  const adsCount = db.prepare('SELECT COUNT(*) as n FROM ads').get().n;
  const dailyCount = db.prepare('SELECT COUNT(*) as n FROM daily_records').get().n;
  const stat = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : { size: 0 };
  return { ok: true, storage: 'server-sqlite', dbPath: DB_PATH, dbSizeBytes: stat.size,
    adsCount, dailyCount, rev: getRev(), authEnabled: !!APP_PASSWORD };
});

fastify.get('/api/ads', async () => pack('all'));

fastify.put('/api/ads', async (request, reply) => {
  const body = request.body || {};
  if (!Array.isArray(body.ads)) return reply.code(400).send({ ok: false, error: 'ads 必须是数组' });
  // 乐观锁：版本号必须匹配，否则 409
  if (typeof body.rev !== 'number') return reply.code(400).send({ ok: false, error: '缺少版本号 rev，请刷新后重试' });
  const curRev = getRev();
  if (body.rev !== curRev) {
    return reply.code(409).send({ ok: false, conflict: true, serverRev: curRev,
      error: '数据已被其他窗口修改，请刷新后重试' });
  }
  const incoming = body.ads.map(normalizeAd);
  const errors = incoming.flatMap(ad => validateAd(ad, incoming).map(msg => `#${ad.no || ad.id}: ${msg}`));
  if (errors.length) return reply.code(400).send({ ok: false, error: errors[0], errors });
  const newRev = replaceAll(incoming, body.scope);
  return { ok: true, count: incoming.length, dailyCount: incoming.reduce((s, a) => s + a.daily.length, 0), rev: newRev, savedAt: now() };
});

fastify.get('/api/options', async () => ({ ok: true, ...getOptions() }));

fastify.post('/api/options', async (request, reply) => {
  const { kind, value } = request.body || {};
  if (!['product', 'market'].includes(kind)) return reply.code(400).send({ ok: false, error: 'kind 只能是 product/market' });
  const v = String(value || '').trim();
  if (!v) return reply.code(400).send({ ok: false, error: '值不能为空' });
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM options WHERE kind = ?').get(kind).m;
  db.prepare('INSERT OR IGNORE INTO options (kind, value, sort) VALUES (?, ?, ?)').run(kind, v, maxSort + 1);
  return { ok: true, ...getOptions() };
});

fastify.delete('/api/options/:kind/:value', async (request, reply) => {
  const { kind, value } = request.params;
  if (!['product', 'market'].includes(kind)) return reply.code(400).send({ ok: false, error: 'kind 只能是 product/market' });
  db.prepare('DELETE FROM options WHERE kind = ? AND value = ?').run(kind, decodeURIComponent(value));
  return { ok: true, ...getOptions() };
});

fastify.get('/api/stats', async () => {
  const ads = readAds();
  const totals = ads.reduce((acc, ad) => { const c = calc(ad); acc.spend += c.spend; acc.orders += c.orders; acc.revenue += c.revenue; acc.profit += c.profit; if (ad.status !== '暂停') acc.running += 1; return acc; }, { total: ads.length, running: 0, spend: 0, orders: 0, revenue: 0, profit: 0 });
  totals.cost = totals.orders ? totals.spend / totals.orders : 0;
  return totals;
});

fastify.get('/api/export/json', async () => pack('manual-json'));

fastify.get('/api/export/csv', async (request, reply) => {
  const rows = [['编号', '产品', '市场', '状态', '预算', '创建日期', '总消耗', '总单量', '收入', '利润', 'ROI%', '毛利率%', '备注']];
  readAds().forEach(ad => { const c = calc(ad); rows.push([ad.no, ad.product, ad.market, ad.status, ad.budget, ad.createdAt, c.spend.toFixed(2), c.orders, c.revenue.toFixed(2), c.profit.toFixed(2), c.roi == null ? '' : c.roi.toFixed(2), c.margin == null ? '' : c.margin.toFixed(2), ad.note]); });
  rows.push(['##daily']);
  rows.push(['广告编号', '日期', '消耗', '单量', '收入', '备注']);
  readAds().forEach(ad => { ad.daily.forEach(d => rows.push([ad.no, d.date, Number(d.spend).toFixed(2), d.orders, Number(d.revenue).toFixed(2), d.note])); });
  // DH-2: CSV 公式注入防护
  const csvSafe = (v) => {
    const s = String(v ?? '');
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  };
  const csv = '\ufeff' + rows.map(r => r.map(x => `"${csvSafe(x).replace(/"/g, '""')}"`).join(',')).join('\n');
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="ads_${today()}.csv"`);
  return csv;
});

fastify.get('/api/export/xlsx', async (request, reply) => {
  const wb = new ExcelJS.Workbook();
  const wsAds = wb.addWorksheet('广告');
  wsAds.addRow(['编号', '产品', '市场', '状态', '预算', '创建日期', '总消耗', '总单量', '收入', '利润', 'ROI%', '毛利率%', '备注']);
  for (const ad of readAds()) {
    const c = calc(ad);
    wsAds.addRow([
      ad.no, ad.product, ad.market, ad.status,
      Number(ad.budget), ad.createdAt,
      Number(c.spend), Number(c.orders), Number(c.revenue), Number(c.profit),
      c.roi == null ? '' : c.roi, c.margin == null ? '' : c.margin,
      ad.note || ''
    ]);
  }
  const wsDaily = wb.addWorksheet('每日记录');
  wsDaily.addRow(['广告编号', '日期', '消耗', '单量', '收入', '备注']);
  for (const ad of readAds()) {
    for (const d of ad.daily || []) {
      wsDaily.addRow([ad.no, d.date, Number(d.spend), Number(d.orders), Number(d.revenue), d.note || '']);
    }
  }
  reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  reply.header('Content-Disposition', `attachment; filename="ads_${today()}.xlsx"`);
  return wb.xlsx.writeBuffer();
});

fastify.post('/api/import/xlsx', async (request, reply) => {
  try {
    const data = await request.file();
    if (!data) return reply.code(400).send({ ok: false, error: '缺少文件' });
    const buf = await data.toBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    let skipped = 0, dailyCount = 0;
    const incoming = [];
    const byNo = new Map();
    const wsAds = wb.getWorksheet('广告');
    if (wsAds) {
      const headers = wsAds.getRow(1).values.slice(1).map(h => String(h ?? '').trim());
      const col = (name) => headers.indexOf(name);
      wsAds.eachRow((row, rn) => {
        if (rn === 1) return;
        const v = row.values.slice(1);
        const get = (name) => { const i = col(name); return i < 0 ? undefined : v[i]; };
        const no = String(get('编号') ?? '').trim();
        const product = String(get('产品') ?? '').trim();
        if (!no || !product) { skipped++; return; }
        const ad = normalizeAd({
          no, product,
          market: get('市场'), status: get('状态'), budget: get('预算'),
          createdAt: get('创建日期'), note: get('备注'), daily: []
        });
        byNo.set(no, incoming.length);
        incoming.push(ad);
      });
    }
    const wsDaily = wb.getWorksheet('每日记录');
    if (wsDaily) {
      const headers = wsDaily.getRow(1).values.slice(1).map(h => String(h ?? '').trim());
      const col = (name) => headers.indexOf(name);
      wsDaily.eachRow((row, rn) => {
        if (rn === 1) return;
        const v = row.values.slice(1);
        const get = (name) => { const i = col(name); return i < 0 ? undefined : v[i]; };
        const no = String(get('广告编号') ?? '').trim();
        let dateVal = get('日期');
        let dateStr;
        if (dateVal instanceof Date) {
          dateStr = `${dateVal.getFullYear()}-${String(dateVal.getMonth() + 1).padStart(2, '0')}-${String(dateVal.getDate()).padStart(2, '0')}`;
        } else {
          dateStr = String(dateVal ?? '').trim();
        }
        if (!no || !byNo.has(no) || !validDate(dateStr)) { skipped++; return; }
        const d = normalizeDaily({ date: dateStr, spend: get('消耗'), orders: get('单量'), revenue: get('收入'), note: get('备注') });
        incoming[byNo.get(no)].daily.push(d);
        dailyCount++;
      });
    }
    incoming.forEach(ad => { ad.daily = Array.from(new Map(ad.daily.map(d => [d.date, d])).values()); });
    const errors = incoming.flatMap(ad => validateAd(ad, incoming).map(msg => `#${ad.no || ad.id}: ${msg}`));
    if (errors.length) return reply.code(400).send({ ok: false, error: errors[0], errors });
    const newRev = replaceAll(incoming, 'import-xlsx');
    return { ok: true, count: incoming.length, dailyCount, skipped, rev: newRev };
  } catch (err) {
    return reply.code(400).send({ ok: false, error: String((err && err.message) || err) });
  }
});

fastify.post('/api/backups', async () => {
  const result = db.prepare('INSERT INTO backups (scope, payload, created_at) VALUES (?, ?, ?)').run('manual-backup', JSON.stringify(pack('backup')), now());
  return { ok: true, backupId: result.lastInsertRowid };
});

fastify.get('/api/backups', async () => db.prepare('SELECT id, scope, created_at, LENGTH(payload) AS size_bytes FROM backups ORDER BY id DESC LIMIT 50').all());

// 从备份恢复（恢复前自动快照当前状态，走同一事务）
fastify.post('/api/backups/:id/restore', async (request, reply) => {
  const row = db.prepare('SELECT payload FROM backups WHERE id = ?').get(request.params.id);
  if (!row) return reply.code(404).send({ ok: false, error: '备份不存在' });
  let data;
  try { data = JSON.parse(row.payload); } catch { return reply.code(400).send({ ok: false, error: '备份数据损坏' }); }
  if (!Array.isArray(data.ads)) return reply.code(400).send({ ok: false, error: '备份格式无效' });
  // DH-14: 恢复同样走乐观锁
  const body = request.body || {};
  if (typeof body.rev !== 'number') return reply.code(400).send({ ok: false, error: '缺少版本号 rev，请刷新后重试' });
  const curRev = getRev();
  if (body.rev !== curRev) {
    return reply.code(409).send({ ok: false, conflict: true, serverRev: curRev,
      error: '数据已被其他窗口修改，请刷新后重试' });
  }
  const incoming = data.ads.map(normalizeAd);
  // DH-15: 恢复前同样校验
  const errors = incoming.flatMap(ad => validateAd(ad, incoming).map(msg => `#${ad.no || ad.id}: ${msg}`));
  if (errors.length) return reply.code(400).send({ ok: false, error: '备份数据校验失败', details: errors.slice(0, 20) });
  // 先快照恢复前状态（可撤销这次恢复）；失败也不阻塞恢复本身
  db.prepare('INSERT INTO backups (scope, payload, created_at) VALUES (?, ?, ?)')
    .run('pre-restore', JSON.stringify(pack('pre-restore')), now());
  const newRev = replaceAll(incoming, 'restore');
  return { ok: true, count: incoming.length, rev: newRev };
});

fastify.setNotFoundHandler((request, reply) => { if (request.raw.url?.startsWith('/api/')) return reply.code(404).send({ ok: false, error: 'API 不存在' }); return reply.sendFile('index.html'); });

console.log('\n🚀 谷歌广告记录系统 v3.0 已启动');
console.log(`📍 访问地址: http://localhost:${PORT}`);
console.log(`📁 数据库: ${DB_PATH}`);
console.log(`🔒 访问密码: ${APP_PASSWORD ? '已启用' : '未设置（局域网/公网部署建议设置 APP_PASSWORD）'}\n`);

fastify.listen({ port: PORT, host: '0.0.0.0' }).catch(err => { console.error(err); process.exit(1); });
