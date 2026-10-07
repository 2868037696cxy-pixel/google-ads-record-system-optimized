const path = require('node:path');
const fs = require('node:fs');
const fastify = require('fastify')({ logger: true });
const fastifyStatic = require('@fastify/static');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

const POOL_TYPES = ['emails', 'proxies', 'cards', 'licenses'];
const STATUSES = ['未使用', '已使用', '停用'];
const RECORD_STATUSES = ['正常', '异常', '停用'];

let db = {
  counters: { emails: 0, proxies: 0, cards: 0, licenses: 0, records: 0 },
  emails: [],
  proxies: [],
  cards: [],
  licenses: [],
  records: [],
};

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db = { ...db, ...parsed };
      for (const t of POOL_TYPES) if (!Array.isArray(db[t])) db[t] = [];
      if (!Array.isArray(db.records)) db.records = [];
      db.counters = db.counters || {};
    }
  } catch (e) {
    console.error('读取数据文件失败:', e);
  }
}

function saveDb() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function nowLocal() {
  const d = new Date();
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function nextId(coll) {
  db.counters[coll] = (db.counters[coll] || 0) + 1;
  return db.counters[coll];
}

function todayKey() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date());
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${m}.${d}`;
}

function nextSeq() {
  return db.records.reduce((m, r) => Math.max(m, r.seq || 0), 0) + 1;
}

/* ---------------- 解析器 ---------------- */

/* ---------------- 邮箱解析 ---------------- */

// 邮箱域部分不允许冒号/端口，避免把 user:pass@host:port 形态误判为邮箱
const EMAIL_RE = /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/;

// 标签关键词（用户 / 密码 / 2FA），标签形式形如「邮箱：a 密码：b 2FA：c」，顺序任意
const LABEL_USER = '邮箱|电子邮件|e-?mail|账号|账户|用户名|user(?:name)?|account';
const LABEL_PASS = '密码|pass(?:word)?|pwd';
const LABEL_FAKEY = '2fa|fakey|secret|totp|谷歌验证|两步验证|验证码?|key';
const LABEL_ALL = `${LABEL_USER}|${LABEL_PASS}|${LABEL_FAKEY}`;
const LABEL_STOP = `${LABEL_ALL}|代理|proxy|备注|note|过期|到期|expire|序号|编号|serial|sn`;

function grabLabeled(t, labels) {
  const re = new RegExp(`(?:${labels})\\s*[:：=]\\s*(.*?)(?=[，,;；、\\s]*(?:${LABEL_STOP})\\s*[:：=]|$)`, 'i');
  const m = t.match(re);
  return m ? m[1].trim().replace(/^["'「」『』【】]+|["'「」『』【】]+$/g, '') : '';
}

// 单行邮箱。分隔符形式支持 ——、—、–、--、|、Tab、:、;、,、空白；字段两端引号自动去除
function parseEmailLine(line) {
  const t = String(line || '').trim();
  if (!t || /^\*{3,}$/.test(t) || ADSPOWER_KV_RE.test(t)) return null;
  let m;
  if (new RegExp(`(?:${LABEL_ALL})\\s*[:：=]`, 'i').test(t)) {
    let user = grabLabeled(t, LABEL_USER);
    if (!EMAIL_RE.test(user)) {
      m = t.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
      if (m && EMAIL_RE.test(m[0])) user = m[0];
    }
    if (EMAIL_RE.test(user)) {
      return { user, pass: grabLabeled(t, LABEL_PASS), fakey: grabLabeled(t, LABEL_FAKEY) };
    }
  }
  const parts = t
    .split(/\s*(?:——|—|–|--|\t|\||;|；|,|，|:|：|\s+)\s*/)
    .map((s) => s.trim().replace(/^["']+|["']+$/g, ''))
    .filter(Boolean);
  if (!parts.length || !EMAIL_RE.test(parts[0])) return null;
  if (parts.length >= 2) {
    // user:pass@host:port 形态的代理行让给代理解析
    const restStr = t.slice(t.indexOf(parts[1])).trim();
    if (/^[^@\s]+@[^\s:@]+:\d{1,5}$/.test(restStr)) return null;
  }
  return { user: parts[0], pass: parts[1] || '', fakey: parts[2] || '' };
}

function parseEmails(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const e = parseEmailLine(raw);
    if (e) out.push(e);
  }
  return out;
}

/* ---------------- 代理解析 ---------------- */

// 中文国家词（用于「美国」「香港 备用」等整行识别）
const PROXY_ZH_COUNTRY = '美国|香港|台湾|日本|新加坡|韩国|英国|德国|法国|荷兰|俄罗斯|加拿大|澳大利亚|澳洲|马来西亚|泰国|越南|菲律宾|印尼|印度尼西亚|印度|巴西|墨西哥|土耳其|阿联酋|阿根廷|巴基斯坦|乌克兰|波兰|西班牙|意大利|瑞典|瑞士|爱尔兰|奥地利|比利时|丹麦|挪威|芬兰|捷克|罗马尼亚|南非|尼日利亚|埃及';

// 多行文本块：编号 / 类型 / 主机 / 端口 / 账号 / 密码 / 国家 / IP，支持中英文标签与裸值
function parseProxies(text) {
  const newItem = () => ({ sn: '', type: '', host: '', port: '', user: '', pass: '', country: '', ip: '' });
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.host || cur.user)) items.push(cur);
    cur = null;
  };
  const ensure = () => (cur || (cur = newItem()));
  const setHost = (val) => {
    const h = String(val).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').trim();
    const hp = h.match(/^(\[[^\]]+\]|[^\s:]+):(\d{1,5})$/);
    if (hp && Number(hp[2]) <= 65535) {
      cur.host = hp[1];
      if (!cur.port) cur.port = hp[2];
    } else {
      cur.host = h;
    }
  };
  const ipRe = /^\d{1,3}(?:\.\d{1,3}){3}$/;
  const zhCountryRe = new RegExp(`^(?:${PROXY_ZH_COUNTRY})(?:[\\s\\-–—|·][\\u4e00-\\u9fa5a-zA-Z0-9]{1,12})?$`);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^(?:代理?账号|用户名|账户|user(?:name)?|login)\s*[:：]\s*(.+)$/i))) {
      if (cur && cur.user) flush();
      ensure().user = m[1].trim();
      continue;
    }
    if ((m = line.match(/^(?:代理?密码|pass(?:word)?|pwd)\s*[:：]\s*(.+)$/i))) {
      if (cur && cur.pass) flush();
      ensure().pass = m[1].trim();
      continue;
    }
    if ((m = line.match(/^(?:序号|编号|序列号|serial|sn(?![a-z]))\s*[:：]?\s*(\S+)\s*$/i))) {
      if (cur && cur.sn) flush();
      ensure().sn = m[1];
      continue;
    }
    if ((m = line.match(/^(?:类型|协议|type|protocol|scheme)\s*[:：]\s*([a-z0-9]+)\s*$/i))) {
      const v = m[1].toLowerCase();
      if (cur && cur.type) flush();
      ensure().type = v === 'socks' ? 'socks5' : v;
      continue;
    }
    if ((m = line.match(/^(?:主机|服务器|地址|端点|host(?:name)?|server|address|endpoint)\s*[:：]\s*(.+)$/i))) {
      if (cur && cur.host) flush();
      ensure();
      setHost(m[1]);
      continue;
    }
    if ((m = line.match(/^(?:端口|port)\s*[:：]\s*(\d{1,5})\s*$/i))) {
      if (cur && cur.port) flush();
      ensure().port = m[1];
      continue;
    }
    if ((m = line.match(/^(?:国家|地区|country|region)\s*[:：]\s*(.+)$/i))) {
      ensure().country = m[1].trim();
      continue;
    }
    if ((m = line.match(/^(?:出口\s*ip|ip\s*地址|exit\s*ip|ip|出口)\s*[:：]\s*(.+)$/i))) {
      ensure().ip = m[1].trim();
      continue;
    }
    if (/^(?:过期时间?|到期|失效|expire[ds]?|状态|status|备注|remark|note|说明)\s*[:：]/i.test(line)) continue;
    const low = line.toLowerCase();
    if (/^(socks5|socks4|socks|http|https|ssh)$/.test(low)) {
      if (cur && cur.type) flush();
      ensure().type = low === 'socks' ? 'socks5' : low;
      continue;
    }
    if (ipRe.test(line)) {
      ensure().ip = line;
      continue;
    }
    if ((m = line.match(/^([A-Za-z]{2})\s*[-–—]\s*(.+)$/)) && /[\u4e00-\u9fa5]/.test(m[2])) {
      ensure().country = line;
      continue;
    }
    if (zhCountryRe.test(line)) {
      ensure().country = line;
      continue;
    }
    if (/^\d+$/.test(line)) {
      const num = parseInt(line, 10);
      if (num <= 65535 && line.length <= 5 && !cur?.port) {
        ensure().port = line;
      } else {
        if (cur && (cur.sn || cur.user)) flush();
        ensure().sn = line;
      }
      continue;
    }
    if (line.includes('.')) {
      if (cur && cur.host) flush();
      ensure();
      setHost(line);
      continue;
    }
  }
  flush();
  return items;
}

/* ---------------- 一行代理 ---------------- */

// 支持格式（IPv6 需方括号 [主机]:端口）：
//   socks5://host:port、http://user:pass@host:port（带协议前缀）
//   host:port、host:port:user:pass、user:pass@host:port、user:pass:host:port
//   host,port,user,pass（逗号/分号）、host port user pass（空白）
const PROXY_SCHEMES = { socks5: 'socks5', socks4: 'socks4', socks: 'socks5', http: 'http', https: 'https', ssh: 'ssh' };

function parseProxyStr(s) {
  let t = String(s || '').trim();
  if (!t) return null;
  let type = '';
  const sch = t.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (sch) {
    type = PROXY_SCHEMES[sch[1].toLowerCase()] || '';
    t = t.slice(sch[0].length);
  }
  t = t.replace(/：/g, ':').trim();
  const at = t.indexOf('@');
  if (at >= 0) {
    t = t.slice(0, at).replace(/[,;，；\s]+/g, ':').replace(/:+/g, ':') + t.slice(at).replace(/\s+/g, '');
  } else if (/[,;，；]/.test(t)) {
    t = t.split(/[,;，；]/).map((x) => x.trim()).filter(Boolean).join(':');
  } else if (/\s/.test(t)) {
    const tok = t.split(/\s+/).filter(Boolean);
    if (tok.length >= 2 && /^\d{1,5}$/.test(tok[1]) && Number(tok[1]) <= 65535) {
      t = tok.slice(0, 4).join(':');
    }
  }
  if (!t.includes('[')) t = t.split(':').map((x) => x.trim()).join(':');
  const done = (host, port, user, pass) => (
    Number(port) <= 65535 ? { host, port, user: user || '', pass: pass || '', ...(type ? { type } : {}) } : null
  );
  let m = t.match(/^(?:([^:@]+):([^@]+))?@(\[[^\]]+\]|[^\s:@]+):(\d{1,5})$/);
  if (m) return done(m[3], m[4], m[1], m[2]);
  m = t.match(/^(\[[^\]]+\]|(?=[^\s:]*\.)[a-zA-Z\d][a-zA-Z\d.-]*):(\d{1,5})(?::([^:@]*):([^:@]*))?$/);
  if (m) return done(m[1], m[2], m[3], m[4]);
  const parts = t.split(':');
  if (parts.length === 4 && !parts[0].includes('.') && !parts[0].startsWith('[')
    && parts[2].includes('.') && /^\d{1,5}$/.test(parts[3])) {
    return done(parts[2], parts[3], parts[0], parts[1]);
  }
  return null;
}

// 代理库导入：一行写法（协议前缀/@/逗号/空格等）逐行优先，其余行整体交给文本块解析
function parseProxyPool(text) {
  const items = [];
  const rest = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const one = parseProxyStr(t);
    if (one) items.push({ sn: '', type: '', country: '', ip: '', ...one });
    else rest.push(line);
  }
  items.push(...parseProxies(rest.join('\n')));
  return items;
}

// AdsPower 导入 TXT：key=value，块之间用星号线分隔（name= 也视为新块开始）
const ADSPOWER_KV_RE = /^(?:name|remark|tab|platform|username|password|fakey|cookie|proxytype|ipchecker|proxy|proxyurl|ip|countrycode|regioncode|citycode|proxyid|ua|resolution)\s*=/i;

function firstToken(s) {
  return String(s || '').split(',')[0].trim().replace(/^"+|"+$/g, '');
}

function parseAdspowerBlocks(text) {
  const emails = [];
  const proxies = [];
  const blocks = [];
  let cur = null;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\*{3,}$/.test(line)) { flush(); continue; }
    const m = line.match(/^([a-z_]+)\s*=\s*(.*)$/i);
    if (m && ADSPOWER_KV_RE.test(line)) {
      const key = m[1].toLowerCase();
      if (key === 'name' && cur) flush();
      if (!cur) cur = {};
      cur[key] = m[2].trim();
      continue;
    }
    flush();
  }
  flush();
  for (const b of blocks) {
    const user = firstToken(b.username);
    if (EMAIL_RE.test(user)) {
      const passRaw = String(b.password || '');
      const quoted = passRaw.match(/"([^"]*)"/);
      emails.push({ user, pass: quoted ? quoted[1] : firstToken(passRaw), fakey: firstToken(b.fakey) });
    }
    const ptype = String(b.proxytype || '').trim().toLowerCase();
    if (b.proxy && ptype !== 'noproxy') {
      const p = parseProxyStr(b.proxy);
      if (p) proxies.push({ sn: '', type: ptype || 'socks5', country: '', ...p, ip: String(b.ip || '').trim() });
    }
  }
  return { emails, proxies };
}

// 智能自动识别：AdsPower TXT / 邮箱行（分隔符或标签）/ 一行代理 / 代理商文本块，可任意混合
function parseAuto(text) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/);
  const isSep = (l) => /^\*{3,}$/.test(l.trim());
  const isKv = (l) => ADSPOWER_KV_RE.test(l.trim());

  const fromBlocks = parseAdspowerBlocks(raw);
  const emails = fromBlocks.emails.slice();
  const proxies = fromBlocks.proxies.slice();

  const rest = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || isSep(line) || isKv(line)) continue;
    const e = parseEmailLine(t);
    if (e) {
      emails.push(e);
      continue;
    }
    const one = parseProxyStr(t);
    if (one) {
      proxies.push({ sn: '', type: '', country: '', ip: '', ...one });
      continue;
    }
    rest.push(line);
  }
  proxies.push(...parseProxies(rest.join('\n')));

  const seenE = new Set();
  const outE = emails.filter((e) => {
    if (!e.user) return false;
    const k = e.user.toLowerCase();
    if (seenE.has(k)) return false;
    seenE.add(k);
    return true;
  });
  const seenP = new Set();
  const outP = proxies.filter((p) => {
    if (!p.host) return false;
    const k = `${p.host}|${p.port}|${p.user}`.toLowerCase();
    if (seenP.has(k)) return false;
    seenP.add(k);
    return true;
  });
  return { emails: outE, proxies: outP };
}

// 信用卡：卡号 有效期 CVV（分隔符支持空格/Tab/逗号/|，日期支持 MM/YY、MM-YY、MMYY 四位无分隔，可只填卡号）
function parseCards(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // 完整：卡号 日期MM/YY CVV
    let m = line.match(/(\d{13,19})\s*[,;\s|]\s*(\d{1,2})\s*[\/\-]\s*(\d{2,4})\s*[,;\s|]\s*(\d{3,4})/);
    if (m) {
      out.push({ number: m[1], expiry: `${m[2]}/${m[3]}`, cvv: m[4] });
      continue;
    }
    // 完整：卡号 日期MMYY(无分隔符) CVV
    m = line.match(/(\d{13,19})\s*[,;\s|]\s*(\d{2})(\d{2})\s*[,;\s|]\s*(\d{3,4})/);
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
      out.push({ number: m[1], expiry: `${m[2]}/${m[3]}`, cvv: m[4] });
      continue;
    }
    // 卡号 日期MM/YY（无 CVV）
    m = line.match(/^(\d{13,19})\s*[,;\s|]\s*(\d{1,2})\s*[\/\-]\s*(\d{2,4})/);
    if (m) {
      out.push({ number: m[1], expiry: `${m[2]}/${m[3]}`, cvv: '' });
      continue;
    }
    // 卡号 日期MMYY（无 CVV）
    m = line.match(/^(\d{13,19})\s*[,;\s|]\s*(\d{2})(\d{2})$/);
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
      out.push({ number: m[1], expiry: `${m[2]}/${m[3]}`, cvv: '' });
      continue;
    }
    m = line.match(/^(\d{13,19})$/);
    if (m) out.push({ number: m[1], expiry: '', cvv: '' });
  }
  return out;
}

// 营业执照：一行一个公司名
function parseLicenses(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(/^\s*(?:\d+[.、)]|[-*•])\s*/, '').trim();
    if (!line || line.includes('@')) continue;
    out.push({ name: line });
  }
  return out;
}

const PARSERS = { emails: parseEmails, proxies: parseProxyPool, cards: parseCards, licenses: parseLicenses };

/* ---------------- 资源库导入 ---------------- */

const DUP_KEYS = {
  emails: (it) => (x) => x.user.toLowerCase() === it.user.toLowerCase(),
  proxies: (it) => (x) => x.host === it.host && x.port === it.port && x.user === it.user,
  cards: (it) => (x) => x.number === it.number,
  licenses: (it) => (x) => x.name === it.name,
};

// 重复项展示用的标识（提示用户具体哪些被跳过）
function dupLabel(type) {
  return (it) => {
    if (type === 'emails') return it.user;
    if (type === 'licenses') return it.name;
    if (type === 'cards') return it.number;
    if (type === 'proxies') return `${it.host}:${it.port}${it.user ? ` @${it.user}` : ''}`;
    return '';
  };
}

function importItems(type, items) {
  let added = 0;
  const skipped = [];
  const seen = new Set();
  const label = dupLabel(type);
  for (const it of items) {
    // 同批次内也去重：以 dupLabel 作为本次批次的键
    const batchKey = label(it);
    if (batchKey && seen.has(batchKey)) { skipped.push(it); continue; }
    const isDup = db[type].some(DUP_KEYS[type](it));
    if (isDup) { skipped.push(it); continue; }
    if (batchKey) seen.add(batchKey);
    const row = { id: nextId(type), status: '未使用', created_at: nowLocal(), ...it };
    db[type].push(row);
    added++;
  }
  saveDb();
  return { added, skipped: skipped.length, duplicates: skipped.map(label) };
}

/* ---------------- 记录创建 ---------------- */

function buildName(country, product, domain) {
  const base = String(domain || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .split('.')[0];
  return [country, product, base].filter(Boolean).join('-');
}

function pickPool(pool, ids, count, label) {
  const chosen = [];
  const used = new Set();
  for (const id of ids || []) {
    const it = pool.find((x) => x.id === id);
    if (it && !used.has(it.id) && it.status !== '停用') {
      chosen.push(it);
      used.add(it.id);
    }
  }
  for (const it of pool) {
    if (chosen.length >= count) break;
    if (it.status === '未使用' && !used.has(it.id)) {
      chosen.push(it);
      used.add(it.id);
    }
  }
  if (chosen.length < count && (pool.length || (ids || []).length)) {
    return { error: `${label}不足：需要 ${count} 个，可用仅 ${chosen.length} 个，请先导入或调整数量` };
  }
  return { items: chosen };
}

function createRecords(body) {
  const country = String(body.country || '').trim();
  const product = String(body.product || '').trim();
  const rawDomains = Array.isArray(body.domains)
    ? body.domains
    : String(body.domains || '').split(/\r?\n|[,\s]+/);
  const domains = rawDomains
    .map((s) => String(s).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  const count = domains.length || Math.max(1, Math.min(500, parseInt(body.count, 10) || 1));
  const dateKey = String(body.date_key || '').trim() || todayKey();
  let seq = parseInt(body.start_seq, 10);
  if (!Number.isFinite(seq) || seq < 1) seq = nextSeq();

  const pickedEmails = pickPool(db.emails, body.email_ids, count, '可用邮箱');
  if (pickedEmails.error) return { error: pickedEmails.error };
  const pickedCards = pickPool(db.cards, body.card_ids, count, '可用信用卡');
  if (pickedCards.error) return { error: pickedCards.error };
  const pickedLic = pickPool(db.licenses, body.license_ids, count, '可用营业执照');
  if (pickedLic.error) return { error: pickedLic.error };

  const proxyMode = ['shared', 'auto', 'none'].includes(body.proxy_mode) ? body.proxy_mode : 'shared';
  let sharedProxy = null;
  if (proxyMode === 'shared') {
    if (body.proxy_id) sharedProxy = db.proxies.find((p) => p.id === body.proxy_id) || null;
    if (!sharedProxy) {
      const last = db.records[db.records.length - 1];
      if (last && last.proxy_id != null) sharedProxy = db.proxies.find((p) => p.id === last.proxy_id) || null;
    }
  }
  let autoProxies = [];
  if (proxyMode === 'auto') {
    const pickedProxies = pickPool(db.proxies, body.proxy_ids, count, '可用代理');
    if (pickedProxies.error) return { error: pickedProxies.error };
    autoProxies = pickedProxies.items;
  }

  const created = [];
  for (let i = 0; i < count; i++) {
    const email = pickedEmails.items[i] || null;
    const card = pickedCards.items[i] || null;
    const lic = pickedLic.items[i] || null;
    const proxy = proxyMode === 'auto' ? autoProxies[i] || null : sharedProxy;
    const domain = domains[i] || '';
    const rec = {
      id: nextId('records'),
      seq,
      fingerprint: `${dateKey}ads${seq}`,
      country, product, domain,
      name: buildName(country, product, domain),
      email_id: email ? email.id : null,
      email_user: email ? email.user : '',
      email_pass: email ? email.pass : '',
      email_fakey: email ? email.fakey : '',
      proxy_id: proxy ? proxy.id : null,
      proxy_sn: proxy ? proxy.sn : '',
      proxy_type: proxy ? proxy.type : '',
      proxy_host: proxy ? proxy.host : '',
      proxy_port: proxy ? proxy.port : '',
      proxy_user: proxy ? proxy.user : '',
      proxy_pass: proxy ? proxy.pass : '',
      proxy_country: proxy ? proxy.country : '',
      proxy_ip: proxy ? proxy.ip : '',
      card_id: card ? card.id : null,
      card_number: card ? card.number : '',
      card_expiry: card ? card.expiry : '',
      card_cvv: card ? card.cvv : '',
      license_id: lic ? lic.id : null,
      license_name: lic ? lic.name : '',
      ip_reg_time: String(body.ip_reg_time || ''),
      id_card: String(body.id_card || '').trim(),
      status: '正常',
      created_at: nowLocal(),
    };
    db.records.push(rec);
    if (email) email.status = '已使用';
    if (proxy) proxy.status = '已使用';
    if (card) card.status = '已使用';
    if (lic) lic.status = '已使用';
    created.push(rec);
    seq++;
  }
  saveDb();
  return { created };
}

/* ---------------- 记录编辑 / 删除 ---------------- */

const SNAP = {
  email: (e) => ({ email_user: e.user, email_pass: e.pass, email_fakey: e.fakey }),
  proxy: (p) => ({
    proxy_sn: p.sn, proxy_type: p.type, proxy_host: p.host, proxy_port: p.port,
    proxy_user: p.user, proxy_pass: p.pass, proxy_country: p.country, proxy_ip: p.ip,
  }),
  card: (c) => ({ card_number: c.number, card_expiry: c.expiry, card_cvv: c.cvv }),
  license: (l) => ({ license_name: l.name }),
};

function releaseIfUnused(prefix, oldId, excludeRecId) {
  if (oldId == null) return;
  const stillUsed = db.records.some((r) => r.id !== excludeRecId && r[`${prefix}_id`] === oldId);
  if (stillUsed) return;
  const coll = { email: 'emails', proxy: 'proxies', card: 'cards', license: 'licenses' }[prefix];
  const it = db[coll].find((x) => x.id === oldId);
  if (it && it.status === '已使用') it.status = '未使用';
}

function updateRecord(id, body) {
  const rec = db.records.find((r) => r.id === id);
  if (!rec) return { error: '记录不存在' };

  for (const k of ['country', 'product', 'domain', 'ip_reg_time', 'id_card', 'status']) {
    if (k in body) rec[k] = String(body[k] ?? '').trim();
  }
  if ('status' in body && !RECORD_STATUSES.includes(rec.status)) rec.status = '正常';

  const reassign = (prefix, coll, newId) => {
    if (newId === undefined) return;
    const targetId = newId === null ? null : Number(newId);
    if (rec[`${prefix}_id`] === targetId) return;
    releaseIfUnused(prefix, rec[`${prefix}_id`], rec.id);
    const nu = targetId == null ? null : db[coll].find((x) => x.id === targetId);
    if (targetId != null && !nu) return;
    rec[`${prefix}_id`] = nu ? nu.id : null;
    // 清空旧快照字段，再填入新关联资源的快照
    for (const key of Object.keys(SNAP[prefix]({}))) rec[key] = '';
    if (nu) {
      const snaps = SNAP[prefix](nu);
      for (const key of Object.keys(snaps)) rec[key] = snaps[key] ?? '';
      nu.status = '已使用';
    }
  };

  reassign('email', 'emails', body.email_id);
  reassign('proxy', 'proxies', body.proxy_id);
  reassign('card', 'cards', body.card_id);
  reassign('license', 'licenses', body.license_id);

  rec.name = buildName(rec.country, rec.product, rec.domain);
  saveDb();
  return { record: rec };
}

function deleteRecords(ids) {
  const idSet = new Set(ids.map(Number));
  const removed = db.records.filter((r) => idSet.has(r.id));
  db.records = db.records.filter((r) => !idSet.has(r.id));
  for (const prefix of ['email', 'proxy', 'card', 'license']) {
    for (const r of removed) releaseIfUnused(prefix, r[`${prefix}_id`], r.id);
  }
  saveDb();
  return { deleted: removed.length };
}

/* ---------------- 导出 ---------------- */

function buildAdspower(records) {
  const SEP = '*'.repeat(36);
  const blocks = records.map((r) => [
    `name=${r.fingerprint || ''}`,
    `remark=${[r.name, r.domain].filter(Boolean).join(' ')}`,
    `tab=`,
    `platform=`,
    `username=${r.email_user || ''}`,
    `password=${r.email_pass || ''}`,
    `fakey=${r.email_fakey || ''}`,
    `cookie=`,
    `proxytype=${r.proxy_host ? (r.proxy_type || 'socks5') : 'noproxy'}`,
    `ipchecker=`,
    `proxy=${r.proxy_host ? `${r.proxy_host}:${r.proxy_port}:${r.proxy_user}:${r.proxy_pass}` : ''}`,
    `proxyurl=`,
    `ip=${r.proxy_ip || ''}`,
    `countrycode=`,
    `regioncode=`,
    `citycode=`,
    `proxyid=`,
    `ua=`,
    `resolution=`,
  ].join('\n'));
  return blocks.join(`\n${SEP}\n`) + '\n';
}

function buildCsv(records) {
  const head = [
    '创建日期(指纹)', '名称', '域名', '谷歌邮箱(完整)', '谷歌邮箱', '邮箱密码', '2FA',
    '代理类型', '代理主机', '端口', '代理编号', '代理账号', '代理密码', '出口IP', '国家',
    '信用卡', '有效期', 'CVV', 'IP注册时间', '营业执照', '身份证', '状态', '创建时间',
  ];
  const esc = (v) => {
    v = String(v ?? '');
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = [head.join(',')];
  for (const r of records) {
    const fullEmail = [r.email_user, r.email_pass, r.email_fakey].filter(Boolean).join('——');
    lines.push([
      r.fingerprint, r.name, r.domain, fullEmail, r.email_user, r.email_pass, r.email_fakey,
      r.proxy_type, r.proxy_host, r.proxy_port, r.proxy_sn, r.proxy_user, r.proxy_pass, r.proxy_ip, r.proxy_country,
      r.card_number, r.card_expiry, r.card_cvv, r.ip_reg_time, r.license_name, r.id_card, r.status, r.created_at,
    ].map(esc).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

/* ---------------- 路由 ---------------- */

fastify.get('/api/bootstrap', async () => {
  const pools = {};
  for (const t of POOL_TYPES) pools[t] = db[t];
  return {
    pools,
    records: [...db.records].sort((a, b) => b.id - a.id),
    next: { fingerprint: `${todayKey()}ads${nextSeq()}`, seq: nextSeq(), date_key: todayKey() },
  };
});

fastify.post('/api/parse/auto', async (req) => {
  return parseAuto(req.body?.text);
});

fastify.post('/api/import/auto', async (req) => {
  let emails = Array.isArray(req.body?.emails)
    ? req.body.emails.filter((e) => e && e.user).map((x) => ({ user: String(x.user).trim(), pass: String(x.pass || ''), fakey: String(x.fakey || '') }))
    : null;
  let proxies = Array.isArray(req.body?.proxies)
    ? req.body.proxies.filter((p) => p && p.host).map((x) => ({
        sn: String(x.sn || ''), type: String(x.type || ''), host: String(x.host), port: String(x.port || ''),
        user: String(x.user || ''), pass: String(x.pass || ''), country: String(x.country || ''), ip: String(x.ip || ''),
      }))
    : null;
  if (!emails || !proxies) {
    const r = parseAuto(req.body?.text);
    emails = r.emails;
    proxies = r.proxies;
  }
  const emailRes = importItems('emails', emails);
  const proxyRes = importItems('proxies', proxies);
  return { emails: emailRes, proxies: proxyRes };
});

fastify.post('/api/parse/:type', async (req) => {
  const type = req.params.type;
  if (!POOL_TYPES.includes(type)) return { error: '未知类型' };
  const items = PARSERS[type](req.body?.text);
  return { items };
});

fastify.post('/api/import/:type', async (req) => {
  const type = req.params.type;
  if (!POOL_TYPES.includes(type)) return { error: '未知类型' };
  const items = Array.isArray(req.body?.items) ? req.body.items : PARSERS[type](req.body?.text);
  return importItems(type, items);
});

fastify.patch('/api/pool/:type/:id', async (req) => {
  const type = req.params.type;
  if (!POOL_TYPES.includes(type)) return { error: '未知类型' };
  const it = db[type].find((x) => x.id === Number(req.params.id));
  if (!it) return { error: '不存在' };
  if ('status' in req.body) {
    if (!STATUSES.includes(req.body.status)) return { error: '无效状态' };
    it.status = req.body.status;
  }
  for (const k of ['sn', 'type', 'host', 'port', 'user', 'pass', 'country', 'ip', 'name', 'number', 'expiry', 'cvv']) {
    if (k in req.body) it[k] = String(req.body[k] ?? '');
  }
  saveDb();
  return { item: it };
});

fastify.delete('/api/pool/:type/:id', async (req) => {
  const type = req.params.type;
  if (!POOL_TYPES.includes(type)) return { error: '未知类型' };
  const id = Number(req.params.id);
  const before = db[type].length;
  db[type] = db[type].filter((x) => x.id !== id);
  saveDb();
  return { deleted: before - db[type].length };
});

fastify.post('/api/records', async (req) => {
  const res = createRecords(req.body || {});
  if (res.error) return reply400(res.error);
  return res;
});

function reply400(msg) {
  const err = new Error(msg);
  err.statusCode = 400;
  throw err;
}

fastify.patch('/api/records/:id', async (req) => {
  const res = updateRecord(Number(req.params.id), req.body || {});
  if (res.error) return reply400(res.error);
  return res;
});

fastify.post('/api/records/batch-delete', async (req) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return { deleted: 0 };
  return deleteRecords(ids);
});

fastify.delete('/api/records/:id', async (req) => {
  return deleteRecords([Number(req.params.id)]);
});

fastify.post('/api/export/adspower', async (req) => {
  const ids = new Set((req.body?.ids || []).map(Number));
  const list = db.records.filter((r) => !ids.size || ids.has(r.id));
  if (!list.length) return reply400('没有可导出的记录');
  return { text: buildAdspower(list), count: list.length };
});

fastify.post('/api/export/csv', async (req) => {
  const ids = new Set((req.body?.ids || []).map(Number));
  const list = db.records.filter((r) => !ids.size || ids.has(r.id));
  if (!list.length) return reply400('没有可导出的记录');
  return { text: buildCsv(list), count: list.length };
});

/* ---------------- 静态资源 & 启动 ---------------- */

fastify.register(fastifyStatic, { root: PUBLIC_DIR });

fastify.setNotFoundHandler((req, reply) => {
  if (req.raw.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
  return reply.sendFile('index.html');
});

loadDb();

const start = async () => {
  try {
    await fastify.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
    console.log('工作台已启动: http://localhost:' + (process.env.PORT || 3000));
  } catch (e) {
    fastify.log.error(e);
    process.exit(1);
  }
};

start();
