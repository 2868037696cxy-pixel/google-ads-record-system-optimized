const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const fastify = require('fastify')({ logger: true, bodyLimit: 16 * 1024 * 1024 });
const fastifyStatic = require('@fastify/static');
const { createStorage, validateSnapshot } = require('./lib/storage');

const ROOT = __dirname;
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data.json');
const storage = createStorage(DATA_FILE);
const PUBLIC_DIR = path.join(ROOT, 'public');

const POOL_TYPES = ['emails', 'proxies', 'cards', 'licenses'];
const STATUSES = ['未使用', '已使用', '停用'];
const RECORD_STATUSES = ['正常', '异常', '停用'];

let db = {
  documents: {},
  counters: { emails: 0, proxies: 0, cards: 0, licenses: 0, records: 0 },
  emails: [],
  proxies: [],
  cards: [],
  licenses: [],
  records: [],
};

function loadDb() {
  db = storage.load(db);
}

function mutate(operation) {
  const previous = structuredClone(db);
  try {
    const result = operation();
    if (result?.error) return reply400(result.error);
    storage.save(db);
    return result;
  } catch (error) {
    db = previous;
    throw error;
  }
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

/* ---------------- PDF 文本提取 ---------------- */
async function extractPdfText(buf) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buf), useSystemFonts: true });
  try {
    const pdf = await loadingTask.promise;
    if (pdf.numPages > 50) return reply400('PDF 最多支持 50 页');
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      pages.push(tc.items.map((it) => it.str).filter(Boolean).join('\n'));
    }
    return pages.join('\n\n');
  } finally {
    await loadingTask.destroy();
  }
}

function decodePdf(base64) {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return reply400('PDF 内容格式不正确');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > 10 * 1024 * 1024) return reply400('PDF 文件不能超过 10 MB');
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return reply400('请选择有效 PDF 文件');
  return bytes;
}

function parseCertificate(text) {
  const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const start = lines.findIndex((line) => /certifies and attests that:/i.test(line));
  if (start >= 0) {
    const name = lines[start + 1] || '';
    const address = lines[start + 2] || '';
    const city = (lines[start + 3] || '').match(/^(?:DK-)?(\d{4})\s+(.+)$/);
    if (name && city) return [{ name, legal_name: name, address, apt: '', zip: city[1], city: city[2], type: '组织', cvr: text.match(/CVR number:\s*(\d{8})/i)?.[1] || '' }];
  }
  const structured = new RegExp(`(?:${LIC_STOP})\\s*[:：=]`, 'i').test(text);
  return structured ? parseLicenses(text) : [];
}

/* ---------------- 营业执照解析 ---------------- */
// 支持两种来源：
//   1) 纯文本一行一个公司名（旧格式兼容）
//   2) 带标签的结构化文本（如 PDF 提取的丹麦工商注册信息）
//      字段：资料类型 / 组织名称 / 法定名称 / 街道地址 / 门牌号 / 邮编 / 市/区
const LIC_LABELS = {
  name: '组织名称|公司名称|企业名称|(?:company|organization|business|firm)\\s*name',
  legal: '法定名称|(?:legal|registered)\\s*name',
  address: '街道地址|地址|(?:street|postal)\\s*address|address',
  apt: '公寓|套房|门牌号|(?:apt|suite|unit)\\b',
  zip: '邮编|(?:postal\\s*code|zip\\s*code|zip)',
  city: '市(?:/区)?|城市|(?:city|town|municipality)',
  type: '资料类型|(?:entity|business|organization)\\s*type|类型|type',
};
const LIC_STOP = Object.values(LIC_LABELS).join('|');

function licGrab(t, labels) {
  const re = new RegExp(`(?:${labels})\\s*[:：=]\\s*(.*?)(?=[，,;；、\\s]*(?:${LIC_STOP})\\s*[:：=]|$)`, 'i');
  const m = t.match(re);
  return m ? m[1].trim().replace(/^["'「」『』【】]+|["'「」『』【】]+$/g, '') : '';
}

function parseLicenses(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  // 检测是否为带标签的结构化文本
  const hasLabel = new RegExp(`(?:${LIC_STOP})\\s*[:：=]`, 'i').test(raw);

  if (hasLabel) {
    // 把多行拍平成一行，标签之间用空格分隔便于前瞻匹配
    const flat = raw.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
    const name = licGrab(flat, LIC_LABELS.name) || licGrab(flat, LIC_LABELS.legal);
    if (!name) return [];
    return [{
      name,
      legal_name: licGrab(flat, LIC_LABELS.legal),
      address: licGrab(flat, LIC_LABELS.address),
      apt: licGrab(flat, LIC_LABELS.apt),
      zip: licGrab(flat, LIC_LABELS.zip).replace(/^DK-/i, ''),
      city: licGrab(flat, LIC_LABELS.city),
      type: licGrab(flat, LIC_LABELS.type) || '组织',
    }];
  }

  // 旧格式：一行一个公司名
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    let l = line.trim();
    if (!l) continue;
    l = l.replace(/^\s*(?:\d+[.、)]|[-*•])\s*/, '').trim();
    if (!l || l.includes('@')) continue;
    out.push({ name: l });
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

const IMPORT_FIELDS = {
  emails: ['user', 'pass', 'fakey'],
  proxies: ['sn', 'type', 'host', 'port', 'user', 'pass', 'country', 'ip'],
  cards: ['number', 'expiry', 'cvv'],
  licenses: ['name', 'legal_name', 'address', 'apt', 'zip', 'city', 'type', 'cvr'],
};

function normalizeImport(type, item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return reply400('导入内容格式不正确');
  const row = Object.fromEntries(IMPORT_FIELDS[type].map((key) => [key, String(item[key] ?? '').trim()]));
  if (type === 'emails' && !EMAIL_RE.test(row.user)) return reply400('存在无效邮箱，请检查导入内容');
  if (type === 'proxies' && (!row.host || (row.port && (!/^\d+$/.test(row.port) || Number(row.port) < 1 || Number(row.port) > 65535)))) return reply400('代理主机或端口无效');
  if (type === 'cards') {
    row.number = row.number.replace(/[ -]/g, '');
    if (!/^\d{12,19}$/.test(row.number)) return reply400('信用卡号格式不正确');
  }
  if (type === 'licenses') {
    if (!row.name) return reply400('营业执照名称不能为空');
    row.legal_name ||= row.name;
    row.zip = row.zip.replace(/^DK-/i, '');
  }
  return row;
}

function importItems(type, items) {
  if (!Array.isArray(items) || items.length > 5000) return reply400('单次导入最多 5000 条');
  items = items.map((item) => normalizeImport(type, item));
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
    const row = { ...normalizeImport(type, it), id: nextId(type), status: '未使用', created_at: nowLocal() };
    db[type].push(row);
    added++;
  }
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
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id < 1))) return { error: `${label}选择格式不正确` };
  const chosen = [];
  const used = new Set();
  for (const id of ids || []) {
    if (chosen.length >= count) break;
    const it = pool.find((x) => x.id === id);
    if (!it || it.status !== '未使用') return { error: `${label}所选资源不存在或不可用，请刷新后重新选择` };
    if (!used.has(it.id)) {
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
  const fpPrefix = String(body.fp_prefix || '').trim() || `${dateKey}ads`;
  let seq = parseInt(body.start_seq, 10);
  if (!Number.isFinite(seq) || seq < 1) seq = nextSeq();

  if (count > 500) return { error: '单次最多创建 500 条记录' };
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(seq + count)) return { error: '指纹编号无效' };
  if (new Set(domains).size !== domains.length) return { error: '域名列表存在重复，请检查后再创建' };
  const fingerprints = new Set(db.records.map((r) => r.fingerprint));
  for (let i = 0; i < count; i++) {
    if (fingerprints.has(`${fpPrefix}${seq + i}`)) return { error: '指纹名称已存在，请调整起始编号' };
  }

  const pickedEmails = pickPool(db.emails, body.email_ids, count, '可用邮箱');
  if (pickedEmails.error) return { error: pickedEmails.error };
  const pickedCards = pickPool(db.cards, body.card_ids, count, '可用信用卡');
  if (pickedCards.error) return { error: pickedCards.error };
  const pickedLic = pickPool(db.licenses, body.license_ids, count, '可用营业执照');
  if (pickedLic.error) return { error: pickedLic.error };

  const proxyMode = ['shared', 'auto', 'none'].includes(body.proxy_mode) ? body.proxy_mode : 'shared';
  let sharedProxy = null;
  if (proxyMode === 'shared') {
    if (body.proxy_id) {
      sharedProxy = db.proxies.find((p) => p.id === Number(body.proxy_id) && p.status !== '停用') || null;
      if (!sharedProxy) return { error: '所选代理不存在或已停用' };
    }
    if (!sharedProxy) {
      const last = db.records[db.records.length - 1];
      if (last && last.proxy_id != null) sharedProxy = db.proxies.find((p) => p.id === last.proxy_id && p.status !== '停用') || null;
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
      fingerprint: `${fpPrefix}${seq}`,
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

  for (const [prefix, coll] of Object.entries({ email: 'emails', proxy: 'proxies', card: 'cards', license: 'licenses' })) {
    const value = body[`${prefix}_id`];
    if (value === undefined || value === null || Number(value) === rec[`${prefix}_id`]) continue;
    const target = db[coll].find((item) => item.id === Number(value));
    if (!target || target.status === '停用') return { error: '所选资源不存在或已停用' };
    if (prefix !== 'proxy' && (target.status !== '未使用' || db.records.some((r) => r.id !== rec.id && r[`${prefix}_id`] === target.id))) {
      return { error: '所选资源已被其他记录使用' };
    }
  }

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
  return { record: rec };
}

function deleteRecords(ids) {
  const idSet = new Set(ids.map(Number));
  const removed = db.records.filter((r) => idSet.has(r.id));
  db.records = db.records.filter((r) => !idSet.has(r.id));
  for (const prefix of ['email', 'proxy', 'card', 'license']) {
    for (const r of removed) releaseIfUnused(prefix, r[`${prefix}_id`], r.id);
  }
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

fastify.addHook('preValidation', async (req) => {
  if (!req.url.startsWith('/api/') || !['POST', 'PATCH'].includes(req.method)) return;
  if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return reply400('请求内容必须为对象');
  if (req.body?.ids !== undefined && (!Array.isArray(req.body.ids) || req.body.ids.some((id) => !Number.isSafeInteger(id) || id < 1))) return reply400('记录编号格式不正确');
});

fastify.addHook('onSend', async (req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  return payload;
});

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
  return mutate(() => ({ emails: importItems('emails', emails), proxies: importItems('proxies', proxies) }));
});

fastify.post('/api/parse/:type', async (req) => {
  const type = req.params.type;
  if (!POOL_TYPES.includes(type)) return reply400('未知类型');
  const items = PARSERS[type](req.body?.text);
  return { items };
});

// Parse without saving. Only confirmed imports retain the original PDF.
fastify.post('/api/parse/licenses-pdf', async (req) => {
  const bytes = decodePdf(req.body?.pdf);
  try {
    const text = await extractPdfText(bytes);
    return { items: parseCertificate(text), text };
  } catch (error) {
    fastify.log.warn({ err: error }, 'PDF extraction failed');
    return reply400('PDF 解析失败，请选择可读取的 PDF 或手动填写信息');
  }
});

fastify.post('/api/import/:type', async (req) => {
  const type = req.params.type;
  if (!POOL_TYPES.includes(type)) return reply400('未知类型');
  const items = Array.isArray(req.body?.items) ? req.body.items : PARSERS[type](req.body?.text);
  return mutate(() => {
    const result = importItems(type, items);
    if (type === 'licenses') {
      let updated = 0;
      for (const item of items) {
        const license = db.licenses.find((row) => row.name === String(item.name).trim());
        if (license && Object.keys(item).some((key) => key !== 'name' && IMPORT_FIELDS.licenses.includes(key))) {
          const supplied = Object.fromEntries(IMPORT_FIELDS.licenses.filter((key) => key in item).map((key) => [key, item[key]]));
          Object.assign(license, normalizeImport('licenses', { ...license, ...supplied }));
          updated++;
        }
      }
      result.updated = updated;
    }
    if (type === 'licenses' && req.body?.pdf) {
      if (items.length !== 1) return reply400('一个 PDF 请对应一份营业执照');
      const bytes = decodePdf(req.body.pdf);
      const id = crypto.createHash('sha256').update(bytes).digest('hex');
      const filename = path.basename(String(req.body.filename || '营业执照.pdf')).replace(/[\\/\r\n]/g, '_');
      db.documents[id] = { filename, base64: bytes.toString('base64') };
      const license = db.licenses.find((item) => item.name === String(items[0].name).trim());
      Object.assign(license, normalizeImport('licenses', items[0]), { document_id: id, document_name: filename, document_size: bytes.length });
      result.attached = 1;
    }
    return result;
  });
});

function licenseDocument(id) {
  const license = db.licenses.find((item) => item.id === Number(id));
  const document = license && db.documents[license.document_id];
  if (!document) throw new Error('这份营业执照尚未保存原 PDF');
  return { ...document, id: license.document_id };
}

fastify.get('/api/licenses/:id/pdf', async (req, reply) => {
  let document;
  try { document = licenseDocument(req.params.id); }
  catch { return reply.code(404).send({ error: '未保存原 PDF' }); }
  reply.header('Content-Type', 'application/pdf');
  reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(document.filename)}`);
  reply.header('Cache-Control', 'no-store');
  return reply.send(Buffer.from(document.base64, 'base64'));
});

fastify.patch('/api/pool/:type/:id', async (req) => mutate(() => {
  const type = req.params.type;
  if (!POOL_TYPES.includes(type)) return reply400('未知类型');
  const it = db[type].find((x) => x.id === Number(req.params.id));
  if (!it) return reply400('资源不存在');
  if ('status' in (req.body || {})) {
    if (!STATUSES.includes(req.body.status)) return reply400('无效状态');
    const prefix = { emails: 'email', proxies: 'proxy', cards: 'card', licenses: 'license' }[type];
    if (req.body.status === '未使用' && db.records.some((r) => r[`${prefix}_id`] === it.id)) return reply400('资源仍关联记录，不能标记为未使用');
    it.status = req.body.status;
  }
  const changed = Object.fromEntries(IMPORT_FIELDS[type].filter((key) => key in (req.body || {})).map((key) => [key, req.body[key]]));
  Object.assign(it, normalizeImport(type, { ...it, ...changed }));
  return { item: it };
}));

fastify.delete('/api/pool/:type/:id', async (req) => mutate(() => {
  const type = req.params.type;
  if (!POOL_TYPES.includes(type)) return reply400('未知类型');
  const id = Number(req.params.id);
  const prefix = { emails: 'email', proxies: 'proxy', cards: 'card', licenses: 'license' }[type];
  if (db.records.some((r) => r[`${prefix}_id`] === id)) return reply400('资源仍关联记录，请先解除关联');
  const before = db[type].length;
  db[type] = db[type].filter((x) => x.id !== id);
  return { deleted: before - db[type].length };
}));

fastify.post('/api/records', async (req) => {
  const res = mutate(() => createRecords(req.body || {}));
  if (res.error) return reply400(res.error);
  return res;
});

function reply400(msg) {
  const err = new Error(msg);
  err.statusCode = 400;
  throw err;
}

fastify.patch('/api/records/:id', async (req) => {
  const res = mutate(() => updateRecord(Number(req.params.id), req.body || {}));
  if (res.error) return reply400(res.error);
  return res;
});

fastify.post('/api/records/batch-delete', async (req) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return { deleted: 0 };
  return mutate(() => deleteRecords(ids));
});

fastify.delete('/api/records/:id', async (req) => {
  return mutate(() => deleteRecords([Number(req.params.id)]));
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

const start = async ({ port = Number(process.env.PORT) || 3000, host = process.env.HOST || '127.0.0.1', token = '' } = {}) => {
  if (token) fastify.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/') && req.headers['x-desktop-token'] !== token) return reply.code(401).send({ error: '仅允许桌面应用访问' });
  });
  try {
    const address = await fastify.listen({ port, host });
    console.log('工作台已启动: ' + address);
    return address;
  } catch (e) {
    fastify.log.error(e);
    throw e;
  }
};

module.exports = { licenseDocument, start, close: () => fastify.close(), snapshot: () => structuredClone(db), restore: (data) => mutate(() => { db = validateSnapshot(data); return { restored: true }; }) };
if (require.main === module) start().catch(() => { process.exitCode = 1; });
