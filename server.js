/**
 * 谷歌广告记录系统 - 优化版 server.js
 * v2.0 - 完整的错误处理、数据验证、数据库优化
 */

const path = require('path');
const fs = require('fs');
const fastify = require('fastify')({ logger: true });
const cors = require('@fastify/cors');
const staticPlugin = require('@fastify/static');
const Database = require('better-sqlite3');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'ads.sqlite');
const PORT = Number(process.env.PORT || 3000);

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
    FOREIGN KEY (ad_id) REFERENCES ads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ads_product ON ads(product);
  CREATE INDEX IF NOT EXISTS idx_ads_market ON ads(market);
  CREATE INDEX IF NOT EXISTS idx_ads_status ON ads(status);
  CREATE INDEX IF NOT EXISTS idx_ads_created ON ads(created_at);
  CREATE INDEX IF NOT EXISTS idx_daily_ad_id ON daily_records(ad_id);
  CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_records(date);
`);

const STATUS = new Set(['未铺市场', '已铺市场', '测试中', '继续跑', '观察', '暂停']);
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();
const uid = (p) => `${p}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
const validDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const money = (v) => { const n = Number(String(v ?? 0).replace(',', '.')); return Number.isFinite(n) && n >= 0 ? n : 0; };
const intNum = (v) => Math.max(0, Math.floor(money(v)));

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
    daily: Array.isArray(row.daily) ? row.daily.map(normalizeDaily) : [] };
}

function validateAd(ad) {
  const errors = [];
  if (!ad.no) errors.push('编号不能为空');
  if (!ad.product) errors.push('产品不能为空');
  if (!ad.market) errors.push('市场不能为空');
  if (!validDate(ad.createdAt)) errors.push('创建日期无效');
  if (ad.budget < 0) errors.push('预算不能为负数');
  ad.daily.forEach(d => {
    if (!validDate(d.date)) errors.push('每日日期无效');
    if (d.spend < 0 || d.orders < 0 || d.revenue < 0) errors.push('每日数据不能为负数');
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
  const adRows = db.prepare('SELECT * FROM ads ORDER BY created_at DESC').all();
  const dailyStmt = db.prepare('SELECT * FROM daily_records WHERE ad_id = ? ORDER BY date DESC');
  return adRows.map(r => ({ id: r.id, no: r.no, product: r.product, market: r.market,
    budget: r.budget, status: r.status, note: r.note,
    optimizeNote: r.optimize_note, actionNote: r.action_note, createdAt: r.created_at,
    daily: dailyStmt.all(r.id).map(d => ({ id: d.id, date: d.date, spend: d.spend, orders: d.orders, revenue: d.revenue, note: d.note })) }));
}

const replaceAll = db.transaction((ads) => {
  db.prepare('DELETE FROM daily_records').run();
  db.prepare('DELETE FROM ads').run();
  const insertAd = db.prepare(`INSERT INTO ads (id,no,product,market,budget,status,note,optimize_note,action_note,created_at,updated_at) VALUES (@id,@no,@product,@market,@budget,@status,@note,@optimizeNote,@actionNote,@createdAt,@updatedAt)`);
  const insertDaily = db.prepare(`INSERT INTO daily_records (id,ad_id,date,spend,orders,revenue,note,created_at,updated_at) VALUES (@id,@adId,@date,@spend,@orders,@revenue,@note,@createdAt,@updatedAt)`);
  const timestamp = now();
  ads.forEach(ad => {
    insertAd.run({ ...ad, updatedAt: timestamp });
    ad.daily.forEach(d => insertDaily.run({ ...d, adId: ad.id, createdAt: timestamp, updatedAt: timestamp }));
  });
});

function pack(scope = 'all', ads = readAds()) {
  return { schema: 'ads-record-v2', storage: 'server-sqlite', scope, exportedAt: now(), count: ads.length, ads };
}

fastify.register(cors, { origin: true });
fastify.register(staticPlugin, { root: ROOT, prefix: '/' });

fastify.get('/api/health', async () => {
  const adsCount = db.prepare('SELECT COUNT(*) as n FROM ads').get().n;
  const stat = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : { size: 0 };
  return { ok: true, storage: 'server-sqlite', dbPath: DB_PATH, dbSizeBytes: stat.size, adsCount };
});

fastify.get('/api/ads', async () => pack('all'));

fastify.put('/api/ads', async (request, reply) => {
  const body = request.body || {};
  const incoming = Array.isArray(body.ads) ? body.ads.map(normalizeAd) : [];
  if (!Array.isArray(body.ads)) return reply.code(400).send({ ok: false, error: 'ads 必须是数组' });
  const errors = incoming.flatMap(ad => validateAd(ad).map(msg => `#${ad.no || ad.id}: ${msg}`));
  if (errors.length) return reply.code(400).send({ ok: false, error: errors[0], errors });
  replaceAll(incoming);
  return { ok: true, count: incoming.length, savedAt: now() };
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
  const csv = '\ufeff' + rows.map(r => r.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="ads_${today()}.csv"`);
  return csv;
});

fastify.post('/api/backups', async () => {
  const result = db.prepare('INSERT INTO backups (scope, payload, created_at) VALUES (?, ?, ?)').run('manual-backup', JSON.stringify(pack('backup')), now());
  return { ok: true, backupId: result.lastInsertRowid };
});

fastify.get('/api/backups', async () => db.prepare('SELECT id, scope, created_at FROM backups ORDER BY id DESC LIMIT 50').all());

fastify.setNotFoundHandler((request, reply) => { if (request.raw.url?.startsWith('/api/')) return reply.code(404).send({ ok: false, error: 'API 不存在' }); return reply.sendFile('index.html'); });

console.log('\n🚀 谷歌广告记录系统 v2.0 已启动');
console.log(`📍 访问地址: http://localhost:${PORT}`);
console.log(`📁 数据库: ${DB_PATH}\n`);

fastify.listen({ port: PORT, host: '0.0.0.0' }).catch(err => { console.error(err); process.exit(1); });