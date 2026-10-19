'use strict';

/**
 * 账号工作台 · 服务器版
 *
 * 与旧版的区别：数据存在 SQLite 里，支持多用户账号，各人的资源与记录互相隔离，
 * 而营业执照的判重是跨全体用户的（谁先导入谁占住）。
 *
 * 文件结构：
 *   1. 依赖、配置、数据库连接、通用工具
 *   2. 解析器（邮箱 / 代理 / 信用卡 / 营业执照 / PDF，与旧版逐字一致）
 *   3. 业务逻辑与路由
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { redact, assertNoCardSecrets, getVault, PROTECTED } = require('./lib/vault');
const { audit } = require('./lib/hardening');

const fastify = require('fastify')({
  logger: process.env.LOG_LEVEL === 'silent' ? false : { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 16 * 1024 * 1024,
  // 反向代理后必须信任转发头，否则所有请求会被当成同一个来源 IP（限速会误伤全员）。
  trustProxy: false,
});
const installStatic = require('./lib/static');

const { openDatabase, transaction } = require('./lib/db');
const store = require('./lib/store');
const auth = require('./lib/auth');
const dedup = require('./lib/dedup');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// 旧版单机数据文件（桌面版通过 DATA_FILE 指向它）；数据库落在同一目录，便于整体迁移。
const LEGACY_FILE = process.env.DATA_FILE || path.join(ROOT, 'data.json');
const DATA_DIR = process.env.DATA_DIR
  || (process.env.DATA_FILE ? path.dirname(process.env.DATA_FILE) : path.join(ROOT, 'data'));
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'workbench.sqlite');

// 注册策略：open（任何人可注册）/ invite（需要邀请码）/ closed（关闭注册）
const REGISTRATION = ['open', 'invite', 'closed'].includes(process.env.REGISTRATION)
  ? process.env.REGISTRATION
  : (process.env.NODE_ENV === 'production' ? 'closed' : 'open');
const INVITE_CODE = String(process.env.INVITE_CODE || '');
const SESSION_SECURE = process.env.SESSION_SECURE === '1';
if (REGISTRATION === 'invite' && (!INVITE_CODE || INVITE_CODE.startsWith('REPLACE_'))) throw new Error('A private random INVITE_CODE is required in invite mode');
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '';
if (PUBLIC_ORIGIN && new URL(PUBLIC_ORIGIN).protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must use HTTPS');

const POOL_TYPES = store.POOL_TYPES;
const POOL_PREFIX = store.POOL_PREFIX;
const STATUSES = store.STATUSES;
const RECORD_STATUSES = store.RECORD_STATUSES;

const db = openDatabase(DB_FILE);

/** 抛出带 400 状态的错误；Fastify 会据此返回 400 与中文提示。 */
function reply400(msg) {
  const err = new Error(msg);
  err.statusCode = 400;
  throw err;
}

/** 北京时间字符串，格式与旧版一致，避免前端与导出格式变化。 */
function nowLocal() {
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function todayKey() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === 'month').value}.${parts.find((p) => p.type === 'day').value}`;
}

/** 所有写操作统一走这里：SQLite 事务保证要么全成、要么全不动。 */
function mutate(operation) {
  return transaction(db, operation);
}

/* ---------------- 身份 ---------------- */

const LOCAL_USERNAME = 'local';
let desktopToken = '';
let desktopUserId = null;

/** 桌面版不需要登录：本机令牌等价于一个固定的本机账号。 */
function ensureDesktopUser() {
  if (desktopUserId) return desktopUserId;
  let user = store.findUserByUsername(db, LOCAL_USERNAME);
  if (!user) {
    user = store.insertUser(db, {
      username: LOCAL_USERNAME,
      displayName: '本机用户',
      passwordHash: 'desktop$disabled', // 不是合法的 scrypt 串，无法用密码登录
      createdAt: nowLocal(),
    });
  }
  desktopUserId = user.id;
  return desktopUserId;
}

/** 会话或桌面令牌解析出的当前用户 id（未登录返回 null）。 */
function currentUserId(req) {
  if (desktopToken && req.headers['x-desktop-token'] === desktopToken) return ensureDesktopUser();
  return req.userId ?? null;
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
  // Proxy credentials such as "user:secret@host:port" contain label-like text.
  // Recognize the whole proxy before attempting to extract an email fragment.
  if (parseProxyStr(t)) return null;
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

// Payment metadata only: alias | last4 | expiry（分隔符支持空格/Tab/逗号/|，日期支持 MM/YY、MM-YY、MMYY 四位无分隔，可只填卡号）
function parseCards(text) {
  const lines=String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  return lines.map(line=>{
    if(/\d{12,19}/.test(line.replace(/[ -]/g,''))) return reply400('\u4e0d\u63a5\u6536\u5b8c\u6574\u5361\u53f7\u6216 CVV\u3002\u683c\u5f0f\uff1a\u5de5\u5177\u522b\u540d|\u672b\u56db\u4f4d|\u6709\u6548\u671f');
    const parts=line.split('|').map(x=>x.trim());
    if(parts.length>3) return reply400('\u4ed8\u6b3e\u5de5\u5177\u683c\u5f0f\u4e0d\u6b63\u786e');
    return normalizeImport('cards',{number:parts[0],last4:parts[1]||'',expiry:parts[2]||''});
  });
}

// Bound PDF parser work. Parsing never executes PDF JavaScript.
let parsingPdfs=0;
async function extractPdfText(buf) {
  if(parsingPdfs>=2) {const e=new Error('\u8bc6\u522b\u4efb\u52a1\u8f83\u591a\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5');e.statusCode=429;throw e;}
  parsingPdfs++;
  try{return await extractPdfTextInternal(buf);}finally{parsingPdfs--;}
}

async function extractPdfTextInternal(buf) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs 用 workerSrc 做动态 import()，ESM 加载器只接受 URL。
  // Windows 绝对路径（C:\...）会以协议 'c:' 被拒绝，必须先转成 file:// URL。
  pdfjsLib.GlobalWorkerOptions.workerSrc = require('node:url')
    .pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')).href;
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false });
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

const IMPORT_FIELDS = {
  emails: ['user', 'pass', 'fakey'],
  proxies: ['sn', 'type', 'host', 'port', 'user', 'pass', 'country', 'ip'],
  cards: ['number', 'expiry', 'last4'],
  licenses: ['name', 'legal_name', 'address', 'apt', 'zip', 'city', 'type', 'cvr'],
};

// 同一账号内的重复判定（营业执照另外走跨用户全局判重）
const DUP_KEYS = {
  emails: (it) => (x) => x.user.toLowerCase() === it.user.toLowerCase(),
  proxies: (it) => (x) => x.host.toLowerCase() === it.host.toLowerCase() && x.port === it.port && x.user === it.user,
  cards: (it) => (x) => x.number === it.number,
  licenses: (it) => (x) => x.name.toLowerCase() === it.name.toLowerCase(),
};

/** 重复项展示用的标识（提示用户具体哪些被跳过）。 */
function dupLabel(type) {
  return (it) => {
    if (type === 'emails') return it.user;
    if (type === 'licenses') return it.name;
    if (type === 'cards') return it.number;
    if (type === 'proxies') return `${it.host}:${it.port}${it.user ? ` @${it.user}` : ''}`;
    return '';
  };
}

/** 同批次内去重用的键。营业执照用归一化后的名称与 CVR，避免大小写/后缀差异漏判。 */
function batchKeyOf(type, it) {
  if (type === 'emails') return String(it.user || '').toLowerCase();
  if (type === 'cards') return String(it.number || '');
  if (type === 'proxies') return `${String(it.host || '').toLowerCase()}|${it.port}|${it.user}`;
  const keys = dedup.licenseKeys(it);
  return [keys.dup_name, keys.dup_cvr].filter(Boolean).join('|');
}

function normalizeImport(type, item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return reply400('导入内容格式不正确');
  assertNoCardSecrets(item);
  const row = Object.fromEntries(IMPORT_FIELDS[type].map((key) => [key, String(item[key] ?? '').trim()]));
  if (type === 'emails' && !EMAIL_RE.test(row.user)) return reply400('存在无效邮箱，请检查导入内容');
  if (type === 'proxies' && (!row.host || (row.port && (!/^\d+$/.test(row.port) || Number(row.port) < 1 || Number(row.port) > 65535)))) return reply400('代理主机或端口无效');
  if (type === 'cards') {
    if (!row.number || row.number.length>120 || /[\r\n]/.test(row.number)) return reply400('\u8bf7\u586b\u5199\u4ed8\u6b3e\u5de5\u5177\u522b\u540d');
    if (row.last4 && !/^\d{4}$/.test(row.last4)) return reply400('\u5361\u53f7\u672b\u56db\u4f4d\u5fc5\u987b\u4e3a4\u4f4d\u6570\u5b57');
    if (row.expiry && !/^(0[1-9]|1[0-2])\/\d{2}$/.test(row.expiry)) return reply400('\u6709\u6548\u671f\u683c\u5f0f\u4e3a MM/YY');
  }
  if (type === 'licenses') {
    if (!row.name) return reply400('营业执照名称不能为空');
    row.legal_name ||= row.name;
    row.zip = row.zip.replace(/^DK-/i, '');
  }
  return row;
}

/** 跨用户判重只返回冲突原因，绝不返回其他成员身份与资料。 */
function privateConflictMessage(conflict) {
  return `该资料已存在，不能重复保存（判重依据：${conflict.label}）。请检查文件和组织资料。`;
}
function conflictDetail(conflict, item) {
  return {
    name: String(item?.name || ''),
    field: conflict.field,
    label: conflict.label,
    weak: !!conflict.weak,
    message: privateConflictMessage(conflict),
  };
}

/** 按 PDF 原始字节查重；更改文件名也无法绕过。 */
function checkDuplicatePdf(bytes) {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const row = db.prepare('SELECT 1 FROM document_registry WHERE sha256 = ? LIMIT 1').get(sha256);
  return { sha256, exists: !!row };
}
function rejectDuplicatePdf() {
  return replyConflict('该 PDF 文件已被记录，不能重复上传或保存。请核对文件内容。', [
    { name: '当前上传的 PDF', field: 'file', label: 'PDF 文件内容', message: '文件内容与已保存文件完全相同，已拒绝保存。' },
  ]);
}

/**
 * 批量导入到指定账号名下。
 * 营业执照会跨全体用户查重：重复时整批拒绝，只显示判重依据。
 */
function importItems(ownerId, type, items) {
  if (!Array.isArray(items) || items.length > 5000) return reply400('单次导入最多 5000 条');
  items = items.map((item) => normalizeImport(type, item));
  let added = 0;
  let updated = 0;
  const skipped = [];
  const conflicts = [];
  const seen = new Set();
  const label = dupLabel(type);
  for (const it of items) {
    const batchKey = batchKeyOf(type, it);
    if (batchKey && seen.has(batchKey)) { skipped.push(it); continue; }
    if (type === 'licenses') {
      const keys = dedup.licenseKeys(it);
      // 自己已经导入过的同一家公司属于「更新」，只有别人的才算重复
      const mine = store.listLicenses(db, ownerId).find((row) => dedup.rowMatchesKeys(row, keys));
      const conflict = dedup.findLicenseConflict(db, keys, { excludeId: mine ? mine.id : null });
      if (conflict) {
        skipped.push(it);
        conflicts.push(conflictDetail(conflict, it));
        continue;
      }
      if (mine) {
        try {
          const updatedLicense = store.updatePoolRow(db, ownerId, 'licenses', mine.id, { ...store.toPublic(mine), ...it });
          // 本人只更新组织字段时，已有账号记录中的营业执照快照也要同步。
          syncResource(ownerId, 'licenses', updatedLicense);
          updated++;
        } catch (error) {
          if (!store.isUniqueViolation(error)) throw error;
          skipped.push(it);
          conflicts.push({ name: it.name, field: 'name', label: '组织名称', owner: null, message: '该营业执照已存在，禁止重复保存' });
        }
        continue;
      }
    } else {
      const predicate = store.poolDuplicatePredicate(type, it);
      const dup = predicate && db.prepare(`SELECT 1 AS x FROM ${type} WHERE owner_id = ? AND ${predicate.sql}`)
        .get(ownerId, ...predicate.params);
      if (dup) { skipped.push(it); continue; }
    }
    if (batchKey) seen.add(batchKey);
    try {
      store.insertPoolRow(db, ownerId, type, it, { createdAt: nowLocal() });
    } catch (error) {
      // 数据库唯一索引是最后一道防线（并发或归一化遗漏）
      if (!store.isUniqueViolation(error)) throw error;
      skipped.push(it);
      if (type === 'licenses') {
        const conflict = dedup.findLicenseConflict(db, dedup.licenseKeys(it));
        conflicts.push(conflict
          ? conflictDetail(conflict, it)
          : { name: it.name, field: 'name', label: '组织名称', owner: null, message: '该营业执照已存在' });
      }
      continue;
    }
    added++;
  }
  return { added, updated, skipped: skipped.length, duplicates: skipped.map(label), conflicts };
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

function createRecords(ownerId, body) {
  const country = String(body.country || '').trim();
  const product = String(body.product || '').trim();
  const rawDomains = Array.isArray(body.domains)
    ? body.domains
    : String(body.domains || '').split(/\r?\n|[,\s]+/);
  const domains = rawDomains
    .map((s) => String(s).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase())
    .filter(Boolean);
  const requestedCount = body.count === undefined ? 1 : Number(body.count);
  const count = domains.length || requestedCount;
  const dateKey = String(body.date_key || '').trim() || todayKey();
  const fpPrefix = String(body.fp_prefix || '').trim() || `${dateKey}ads`;
  const seqInput = body.start_seq;
  let seq = seqInput === undefined || seqInput === '' ? store.nextSeq(db, ownerId) : Number(seqInput);

  if (!domains.length && (typeof body.count === 'boolean' || !Number.isSafeInteger(count) || count < 1)) return { error: '创建数量必须为 1 到 500 的整数' };
  if (count > 500) return { error: '单次最多创建 500 条记录' };
  if (typeof seqInput === 'boolean' || !Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(seq + count)) return { error: '指纹编号无效' };
  if (new Set(domains).size !== domains.length) return { error: '域名列表存在重复，请检查后再创建' };
  for (let i = 0; i < count; i++) {
    if (store.fingerprintExists(db, ownerId, `${fpPrefix}${seq + i}`)) return { error: '指纹名称已存在，请调整起始编号' };
  }

  const emails = store.listPool(db, ownerId, 'emails');
  const cards = store.listPool(db, ownerId, 'cards');
  const licenses = store.listPool(db, ownerId, 'licenses');
  const proxies = store.listPool(db, ownerId, 'proxies');

  const pickedEmails = pickPool(emails, body.email_ids, count, '可用邮箱');
  if (pickedEmails.error) return { error: pickedEmails.error };
  const pickedCards = pickPool(cards, body.card_ids, count, '可用信用卡');
  if (pickedCards.error) return { error: pickedCards.error };
  const pickedLic = pickPool(licenses, body.license_ids, count, '可用营业执照');
  if (pickedLic.error) return { error: pickedLic.error };

  const proxyMode = ['shared', 'auto', 'none'].includes(body.proxy_mode) ? body.proxy_mode : 'shared';
  let sharedProxy = null;
  if (proxyMode === 'shared') {
    if (body.proxy_id !== undefined && body.proxy_id !== null) {
      if (!Number.isSafeInteger(body.proxy_id) || body.proxy_id < 1) return { error: '所选代理编号无效' };
      sharedProxy = proxies.find((p) => p.id === Number(body.proxy_id) && p.status !== '停用') || null;
      if (!sharedProxy) return { error: '所选代理不存在或已停用' };
    }
    if (!sharedProxy) {
      const last = store.latestRecord(db, ownerId);
      if (last && last.proxy_id != null) sharedProxy = proxies.find((p) => p.id === last.proxy_id && p.status !== '停用') || null;
    }
  }
  let autoProxies = [];
  if (proxyMode === 'auto') {
    const pickedProxies = pickPool(proxies, body.proxy_ids, count, '可用代理');
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
      card_last4: card ? card.last4 : '',
      license_id: lic ? lic.id : null,
      license_name: lic ? lic.name : '',
      ip_reg_time: String(body.ip_reg_time || ''),
      id_card: String(body.id_card || '').trim(),
      status: '正常',
      created_at: nowLocal(),
    };
    const id = store.insertRecord(db, ownerId, rec);
    rec.id = id;
    if (email) store.setPoolStatus(db, ownerId, 'emails', email.id, '已使用');
    if (proxy) store.setPoolStatus(db, ownerId, 'proxies', proxy.id, '已使用');
    if (card) store.setPoolStatus(db, ownerId, 'cards', card.id, '已使用');
    if (lic) store.setPoolStatus(db, ownerId, 'licenses', lic.id, '已使用');
    created.push(store.toPublic(store.getRecord(db, ownerId, id)));
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
  card: (c) => ({ card_number: c.number, card_expiry: c.expiry, card_last4: c.last4 }),
  license: (l) => ({ license_name: l.name }),
};

/** 资源被改名/改值后，同步到引用它的记录快照里（导出用的是快照字段）。 */
function syncResource(ownerId, type, resource) {
  const prefix = POOL_PREFIX[type];
  const snapshot = SNAP[prefix](resource);
  const rows = db.prepare(`SELECT id FROM records WHERE owner_id = ? AND ${prefix}_id = ?`).all(ownerId, resource.id);
  for (const row of rows) store.updateRecordColumns(db, ownerId, row.id, snapshot);
}

/** 资源解除关联后，如果没有任何记录再用它，就回到「未使用」。 */
function releaseIfUnused(ownerId, prefix, oldId, excludeRecId) {
  if (oldId == null) return;
  if (store.recordsUsingResource(db, ownerId, prefix, oldId, excludeRecId).length) return;
  const kind = { email: 'emails', proxy: 'proxies', card: 'cards', license: 'licenses' }[prefix];
  const item = store.findPoolItem(db, ownerId, kind, oldId);
  if (item && item.status === '已使用') store.setPoolStatus(db, ownerId, kind, oldId, '未使用');
}

function updateRecord(ownerId, id, body) {
  const rec = store.getRecord(db, ownerId, id);
  if (!rec) return { error: '记录不存在' };

  for (const [prefix, kind] of Object.entries({ email: 'emails', proxy: 'proxies', card: 'cards', license: 'licenses' })) {
    const value = body[`${prefix}_id`];
    if (value === undefined || value === null) continue;
    if (!Number.isSafeInteger(value) || value < 1) return { error: '所选资源编号无效' };
    if (value === rec[`${prefix}_id`]) continue;
    const target = store.findPoolItem(db, ownerId, kind, value);
    if (!target || target.status === '停用') return { error: '所选资源不存在或已停用' };
    if (prefix !== 'proxy' && (target.status !== '未使用' || store.recordsUsingResource(db, ownerId, prefix, target.id, rec.id).length)) {
      return { error: '所选资源已被其他记录使用' };
    }
  }

  const patch = {};
  for (const k of ['country', 'product', 'domain', 'ip_reg_time', 'id_card', 'status']) {
    if (k in body) patch[k] = String(body[k] ?? '').trim();
  }
  if ('status' in patch && !RECORD_STATUSES.includes(patch.status)) patch.status = '正常';

  const reassign = (prefix, kind, newId) => {
    if (newId === undefined) return;
    const targetId = newId === null ? null : Number(newId);
    if (rec[`${prefix}_id`] === targetId) return;
    releaseIfUnused(ownerId, prefix, rec[`${prefix}_id`], rec.id);
    const nu = targetId == null ? null : store.findPoolItem(db, ownerId, kind, targetId);
    if (targetId != null && !nu) return;
    rec[`${prefix}_id`] = nu ? nu.id : null;
    for (const key of Object.keys(SNAP[prefix]({}))) patch[key] = '';
    if (nu) {
      const snaps = SNAP[prefix](nu);
      for (const key of Object.keys(snaps)) patch[key] = snaps[key] ?? '';
      store.setPoolStatus(db, ownerId, kind, nu.id, '已使用');
    }
  };

  reassign('email', 'emails', body.email_id);
  reassign('proxy', 'proxies', body.proxy_id);
  reassign('card', 'cards', body.card_id);
  reassign('license', 'licenses', body.license_id);

  const nextCountry = 'country' in patch ? patch.country : rec.country;
  const nextProduct = 'product' in patch ? patch.product : rec.product;
  const nextDomain = 'domain' in patch ? patch.domain : rec.domain;
  patch.name = buildName(nextCountry, nextProduct, nextDomain);

  store.updateRecordColumns(db, ownerId, id, patch);
  return { record: store.toPublic(store.getRecord(db, ownerId, id)) };
}

function deleteRecords(ownerId, ids) {
  const removed = store.deleteRecordRows(db, ownerId, ids);
  for (const prefix of ['email', 'proxy', 'card', 'license']) {
    for (const r of removed) releaseIfUnused(ownerId, prefix, r[`${prefix}_id`], r.id);
  }
  store.pruneDocuments(db);
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
  ].map((line) => line.replace(/[\r\n\u2028\u2029]/g, ' ')).join('\n'));
  return blocks.join(`\n${SEP}\n`) + '\n';
}

function buildCsv(records) {
  records = records.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k, ['email_pass','email_fakey','proxy_pass','id_card'].includes(k)?'':v])));
  const head = [
    '创建日期(指纹)', '名称', '域名', '谷歌邮箱(完整)', '谷歌邮箱', '邮箱密码', '2FA',
    '代理类型', '代理主机', '端口', '代理编号', '代理账号', '代理密码', '出口IP', '国家',
    '信用卡', '有效期', '卡号末四位', 'IP注册时间', '营业执照', '身份证', '状态', '创建时间',
  ];
  const esc = (v) => {
    v = String(v ?? '');
    // Spreadsheet viewers must treat formulas and long/zero-prefixed numbers as text.
    if (/^\s*[=+\-@]|^[\t\r\n]|^\d{12,}$|^0\d+$/.test(v)) v = "'" + v;
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = [head.join(',')];
  for (const r of records) {
    const fullEmail = [r.email_user, r.email_pass, r.email_fakey].filter(Boolean).join('——');
    lines.push([
      r.fingerprint, r.name, r.domain, fullEmail, r.email_user, r.email_pass, r.email_fakey,
      r.proxy_type, r.proxy_host, r.proxy_port, r.proxy_sn, r.proxy_user, r.proxy_pass, r.proxy_ip, r.proxy_country,
      r.card_number, r.card_expiry, r.card_last4, r.ip_reg_time, r.license_name, r.id_card, r.status, r.created_at,
    ].map(esc).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

const { validateSnapshot } = require('./lib/storage');

/* ---------------- 请求钩子：CSRF、鉴权、安全头 ---------------- */

const PUBLIC_PATHS = new Set([
  '/api/auth/config', '/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/healthz',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 只在单机桌面模式下才允许用令牌免登录。 */
function isDesktopRequest(req) {
  return !!desktopToken && req.headers['x-desktop-token'] === desktopToken;
}

/**
 * 在 onRequest 阶段拒绝请求时，请求体通常还没有被读取。
 * 此时必须关闭这条连接：否则 keep-alive 连接上会残留未读完的请求体，
 * 下一个请求的内容就会被错位解析（多用户下等同于数据串号）。
 */
function rejectEarly(reply, code, payload) {
  reply.header('Connection', 'close');
  return reply.code(code).send(payload);
}

function clientAddress(req) {
  const peer=req.raw.socket.remoteAddress||'';
  const candidate=req.headers['cf-connecting-ip'];
  return process.env.TRUST_CLOUDFLARE==='1' && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer) && typeof candidate==='string' && isIP(candidate) ? candidate : peer;
}
const networkLimiter=new auth.RateLimiter({limit:80,windowMs:60000});
let localUnlockUntil=0;
function isUnlocked(req) {
  if(isDesktopRequest(req)) return localUnlockUntil>Date.now();
  const hash=crypto.createHash('sha256').update(req.sessionToken||'').digest('hex');
  return Number(db.prepare('SELECT secrets_until FROM sessions WHERE token_hash=?').get(hash)?.secrets_until||0)>Date.now();
}
function requireUnlocked(req) {
  if(!isUnlocked(req)) { const e=new Error('\u8bf7\u5148\u9a8c\u8bc1\u767b\u5f55\u5bc6\u7801\uff0c\u89e3\u9501\u654f\u611f\u64cd\u4f5c');e.statusCode=403;throw e; }
}
fastify.addHook('onRequest', async (req, reply) => {
  const rawPath=req.url.split('?')[0];
  if(/%2f|%5c|%2e|\\|\/\//i.test(rawPath)) return rejectEarly(reply,400,{error:'Invalid path'});

  // 只接受 origin-form 请求目标。绝对形式（`GET http://host/api/x HTTP/1.1`）是合法
  // HTTP/1.1，find-my-way 仍会把它路由到对应 handler，但 req.url 以 "http://" 开头，
  // 会让下面基于前缀的鉴权判断失效。（本行同时是纵深防御：上面那条 // 拦截虽已覆盖
  // 绝对形式，但不该依赖「恰好含 //」这个副作用。）
  if(!req.url.startsWith('/')) return rejectEarly(reply,400,{error:'Invalid path'});

  // 鉴权判断必须建立在「解码后」的路径上，否则会与路由判断产生分歧：
  // find-my-way 会解码百分号编码，实测 `/%61pi/bootstrap`（%61 = 'a'）被路由到
  // /api/bootstrap 的 handler，而未解码的 req.url 不以 /api/ 开头 —— 原先这里直接
  // return，导致桌面令牌、来源校验、CSRF、限速、会话鉴权被整体跳过，onSend 的
  // Cache-Control: no-store 与敏感字段脱敏也一并失效。实测该路径可在未登录状态下
  // 拿到 /api/bootstrap 的 200 响应（因 handler 自身无法解析 owner 而返回空数据，
  // 破坏性写则被敏感操作解锁检查挡下 —— 但那是巧合，不是设计）。
  // 解码失败（畸形 % 序列）一律 400，避免路由与鉴权再次分歧。
  let pathname;
  try { pathname = decodeURIComponent(rawPath); } catch { return rejectEarly(reply,400,{error:'Invalid path'}); }

  if (!pathname.startsWith('/api/')) return;
  if(!SAFE_METHODS.has(req.method.toUpperCase()) && req.headers.origin && PUBLIC_ORIGIN && req.headers.origin!==PUBLIC_ORIGIN) return rejectEarly(reply,403,{error:'Invalid origin'});
  if(['/api/auth/login','/api/auth/register','/api/security/unlock'].includes(pathname)) {
    if(!networkLimiter.check(clientAddress(req)).allowed) return rejectEarly(reply,429,{error:'Too many attempts. Try later.'});
  }

  // 桌面版仍要求携带本机令牌；网页版没有令牌，这一层自动跳过
  if (desktopToken && !isDesktopRequest(req)) {
    return rejectEarly(reply, 401, { error: '仅允许桌面应用访问' });
  }

  // CSRF：写操作必须带自定义头。跨站请求无法在不触发预检的情况下设置它，
  // 配合 SameSite=Lax 的会话 Cookie 即可挡住表单型 CSRF。
  if (!SAFE_METHODS.has(req.method.toUpperCase()) && req.headers['x-workbench'] !== '1') {
    return rejectEarly(reply, 403, { error: '请求缺少来源标记，请刷新页面后重试' });
  }

  if (PUBLIC_PATHS.has(pathname) || isDesktopRequest(req)) return;

  const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
  const userId = auth.resolveSession(db, token);
  const user = userId ? store.findUserById(db, userId) : null;
  if (!user || user.disabled) return rejectEarly(reply, 401, { error: '未登录', authRequired: true });
  req.userId = userId;
  req.sessionToken = token;
});

fastify.addHook('onSend', async (req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  reply.header('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if(SESSION_SECURE) reply.header('Strict-Transport-Security','max-age=31536000');
  // 与 onRequest 同理：响应的 no-store 与脱敏也按解码后的路径判断，
  // 否则编码路径会绕过这两项保护。
  let sendPath = req.url.split('?')[0];
  try { sendPath = decodeURIComponent(sendPath); } catch { /* 畸形序列不在此处报错 */ }
  if (sendPath.startsWith('/api/')) {
    reply.header('Cache-Control', 'no-store');
    const path=sendPath;
    if(typeof payload==='string' && String(reply.getHeader('content-type')).includes('application/json') && !path.startsWith('/api/parse/') && !req.allowSecrets) {
      try { payload=JSON.stringify(redact(JSON.parse(payload))); } catch { /* non-JSON handled by framework */ }
    }
  }
  return payload;
});

fastify.setErrorHandler((error, req, reply) => {
  const status = Number(error.statusCode) >= 400 && Number(error.statusCode) < 600 ? Number(error.statusCode) : 500;
  if (status >= 500) req.log.error({ code: error.code || 'internal' }, '请求处理失败');
  const body = { error: status >= 500 ? '服务器内部错误，请稍后重试' : error.message };
  if (Array.isArray(error.conflicts)) body.conflicts = error.conflicts;
  reply.code(status).send(body);
});

function replyConflict(message, conflicts) {
  const err = new Error(message);
  err.statusCode = 409;
  err.conflicts = conflicts;
  throw err;
}

/* ---------------- 认证路由 ---------------- */

fastify.get('/api/healthz', async () => ({ ok: true, version: require('./package.json').version }));

fastify.get('/api/auth/config', async () => ({
  registration: REGISTRATION,
  inviteRequired: REGISTRATION === 'invite',
  minPasswordLength: auth.MIN_PASSWORD,
  minUsernameLength: 3,
  maxUsernameLength: 32,
  siteName: '账号工作台',
}));

fastify.get('/api/auth/me', async (req, reply) => {
  const ownerId = currentUserId(req);
  if (!ownerId) return reply.code(401).send({ error: '未登录' });
  const user = store.findUserById(db, ownerId);
  if (!user) return reply.code(401).send({ error: '未登录' });
  return { user: auth.publicUser(user) };
});

const loginLimiter = new auth.RateLimiter({ limit: 10, windowMs: 60_000 });

fastify.post('/api/auth/login', { bodyLimit: 4 * 1024 }, async (req, reply) => {
  const { username, password } = req.body || {};
  if(typeof username!=='string' || typeof password!=='string' || password.length>200) return reply.code(401).send({error:'Invalid credentials'});
  const key = `${clientAddress(req)}|${String(username || '').toLowerCase()}`;
  const gate = loginLimiter.check(key);
  if (!gate.allowed) {
    return reply.code(429).header('Retry-After', String(gate.retryAfter))
      .send({ error: `尝试过于频繁，请 ${gate.retryAfter} 秒后再试` });
  }
  const user = store.findUserByUsername(db, username);
  // 用户不存在与密码错误返回同一句话，避免暴露账号是否存在
  if (!user || user.disabled || !auth.verifyPassword(password, user.password_hash)) {
    return reply.code(401).send({ error: '用户名或密码不正确' });
  }
  loginLimiter.reset(key);
  const token = auth.createSession(db, user.id);
  store.touchLogin(db, user.id, nowLocal());
  reply.header('Set-Cookie', auth.sessionCookie(token, { secure: SESSION_SECURE }));
  return { user: auth.publicUser(user) };
});

// 未登录即可访问的路由只接受很小的请求体，避免成为放大的攻击面（全局上限是 16 MB）。
fastify.post('/api/auth/register', { bodyLimit: 4 * 1024 }, async (req, reply) => {
  if (REGISTRATION === 'closed') return reply400('已关闭注册，请联系管理员开通账号');
  const body = req.body || {};
  if (REGISTRATION === 'invite' && String(body.invite_code || '') !== INVITE_CODE) {
    return reply400('邀请码不正确');
  }
  const checked = auth.validateCredentials(body);
  if (checked.error) return reply400(checked.error);
  const displayName = String(body.display_name || '').trim().slice(0, 40);
  return mutate(() => {
    if (store.findUserByUsername(db, checked.username)) return reply400('该用户名已被注册');
    const user = store.insertUser(db, {
      username: checked.username,
      displayName,
      passwordHash: auth.hashPassword(checked.password),
      createdAt: nowLocal(),
    });
    // 第一个账号接管旧版单机数据
    const adopted = adoptPendingLegacy(user.id);
    const token = auth.createSession(db, user.id);
    store.touchLogin(db, user.id, nowLocal());
    reply.code(201).header('Set-Cookie', auth.sessionCookie(token, { secure: SESSION_SECURE }));
    return { user: auth.publicUser(user), adopted: adopted ? { records: adopted.records, licenses: adopted.licenses } : null };
  });
});

fastify.post('/api/auth/logout', async (req, reply) => {
  const token = req.sessionToken || auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
  if (token) auth.destroySession(db, token);
  reply.header('Set-Cookie', auth.clearCookie());
  return { ok: true };
});


fastify.post('/api/security/unlock', {bodyLimit:4096}, async (req,reply)=>{
  const owner=currentUserId(req),user=store.findUserById(db,owner);
  const password=req.body?.password;
  if(!isDesktopRequest(req) && (typeof password!=='string' || password.length>200 || !auth.verifyPassword(password,user.password_hash))) return reply.code(403).send({error:'\u767b\u5f55\u5bc6\u7801\u4e0d\u6b63\u786e'});
  const until=Date.now()+60000;
  if(isDesktopRequest(req)) localUnlockUntil=until;
  else db.prepare('UPDATE sessions SET secrets_until=? WHERE token_hash=?').run(until,crypto.createHash('sha256').update(req.sessionToken).digest('hex'));
  audit(db,owner,'secrets.unlock');
  return {unlocked_until:until};
});
fastify.post('/api/security/lock', async req=>{
  if(isDesktopRequest(req)) localUnlockUntil=0;
  else db.prepare('UPDATE sessions SET secrets_until=0 WHERE token_hash=?').run(crypto.createHash('sha256').update(req.sessionToken).digest('hex'));
  return {locked:true};
});
fastify.post('/api/account/password', {bodyLimit:4096}, async(req,reply)=>{
  const owner=currentUserId(req),user=store.findUserById(db,owner);
  if(!auth.verifyPassword(String(req.body?.current_password||'').slice(0,201),user.password_hash)) return reply.code(403).send({error:'\u539f\u5bc6\u7801\u4e0d\u6b63\u786e'});
  const checked=auth.validateCredentials({username:user.username,password:req.body?.new_password});
  if(checked.error) return reply400(checked.error);
  mutate(()=>{db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(checked.password),owner);db.prepare('DELETE FROM sessions WHERE user_id=?').run(owner);audit(db,owner,'password.change');});
  reply.header('Set-Cookie',auth.clearCookie());return {changed:true,loginRequired:true};
});
fastify.get('/api/audit',async req=>({events:db.prepare('SELECT action,subject,created_at FROM audit_events WHERE owner_id=? ORDER BY id DESC LIMIT 100').all(currentUserId(req))}));

/* ---------------- 旧版数据迁移 ---------------- */

let pendingLegacy = null;

function loadLegacySnapshot() {
  if (pendingLegacy !== null) return pendingLegacy || null;
  pendingLegacy = false;
  try {
    if (!fs.existsSync(LEGACY_FILE)) return null;
    pendingLegacy = validateSnapshot(JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8')));
    console.log(`[迁移] 发现旧版数据文件：${LEGACY_FILE}`);
  } catch (error) {
    console.warn(`[迁移] 旧版数据文件无法读取，已跳过：${error.message}`);
  }
  return pendingLegacy || null;
}

/** 把旧版单机数据整体交给某个账号；完成后把原文件改名，避免重复迁移。 */
function adoptPendingLegacy(ownerId) {
  const snapshot = loadLegacySnapshot();
  if (!snapshot) return null;
  const stats = store.adoptLegacySnapshot(db, ownerId, snapshot, { createdAt: nowLocal() });
  pendingLegacy = false;
  try { fs.renameSync(LEGACY_FILE, `${LEGACY_FILE}.migrated`); } catch { /* 改名失败不影响数据已导入 */ }
  console.log(`[迁移] 已导入：邮箱 ${stats.emails}、代理 ${stats.proxies}、信用卡 ${stats.cards}、`
    + `营业执照 ${stats.licenses}、记录 ${stats.records}、附件 ${stats.documents}`);
  return stats;
}

/* ---------------- 业务路由 ---------------- */

fastify.get('/api/bootstrap', async (req) => {
  if(req.query?.reveal === '1') {requireUnlocked(req);req.allowSecrets=true;}
  const ownerId = currentUserId(req);
  const seq = store.nextSeq(db, ownerId);
  return {
    user: auth.publicUser(store.findUserById(db, ownerId)),
    pools: store.listAllPools(db, ownerId),
    records: store.listRecords(db, ownerId),
    counts: store.countPoolByStatus(db, ownerId),
    next: { fingerprint: `${todayKey()}ads${seq}`, seq, date_key: todayKey() },
  };
});

/**
 * 记录列表的服务端分页查询（方案工作包 07「查询优化」）。
 *
 * 与 /api/bootstrap 的分工：bootstrap 仍返回完整快照供整体渲染与既有测试使用；本接口
 * 只取当前页，让列表视图按需翻页，不再「读全部 + 传全部」。owner_id 恒定取自会话。
 * 敏感字段的脱敏由 onSend 的 redact() 统一处理，与本服务其他 /api/ 响应同一套规则。
 */
fastify.get('/api/records', async (req) => {
  const ownerId = currentUserId(req);
  const requestedSort = String(req.query?.sort || 'id_desc');
  const page = store.listRecordsPage(db, ownerId, {
    limit: Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200),
    offset: Math.max(Number(req.query?.offset) || 0, 0),
    q: String(req.query?.q || ''),
    status: String(req.query?.status || ''),
    sort: requestedSort,
  });
  return { ...page, limit: Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200),
    offset: Math.max(Number(req.query?.offset) || 0, 0),
    sort: Object.hasOwn(store.RECORD_SORTS, requestedSort) ? requestedSort : 'id_desc' };
});

fastify.post('/api/parse/auto', async (req) => parseAuto(req.body?.text));
fastify.post('/api/import/auto', async (req) => {
  const ownerId = currentUserId(req);
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
  return mutate(() => ({ emails: importItems(ownerId, 'emails', emails), proxies: importItems(ownerId, 'proxies', proxies) }));
});

fastify.post('/api/parse/:type', async (req) => {
  const type = req.params.type;
  if (!POOL_TYPES.includes(type)) return reply400('未知类型');
  return { items: PARSERS[type](req.body?.text) };
});

// 只解析不保存；只有确认导入后才会保存原件。
fastify.post('/api/parse/licenses-pdf', async (req) => {
  const bytes = decodePdf(req.body?.pdf);
  // 解析前先查全库原件，减少重复解析且不泄露来源账号。
  if (checkDuplicatePdf(bytes).exists) rejectDuplicatePdf();
  try {
    const text = await extractPdfText(bytes);
    const items = parseCertificate(text);
    const enriched = items.map((item) => ({ ...item, ...probeDuplicate(item, req) }));
    return { items: enriched, text };
  } catch (error) {
    if (error.statusCode === 400) throw error;
    fastify.log.warn({ err: error }, 'PDF 解析失败');
    return reply400('PDF 解析失败，请选择可读取的 PDF 或手动填写信息');
  }
});

/**
 * 识别阶段就把重复情况告诉用户（导入前预警），避免填完一堆字段才被拒。
 * 这里只读不写。
 */
function probeDuplicate(item, req) {
  const ownerId = currentUserId(req);
  const keys = dedup.licenseKeys(item);
  // 自己已有的同一条属于「更新」，识别阶段不当作重复提醒
  const mine = ownerId ? store.listLicenses(db, ownerId).find((l) => dedup.rowMatchesKeys(l, keys)) : null;
  const conflict = dedup.findLicenseConflict(db, keys, { excludeId: mine ? mine.id : null });
  if (!conflict) return {};
  return {
    duplicate: {
      ...conflictDetail(conflict, item),
      message: privateConflictMessage(conflict),
      self: false,
    },
  };
}

fastify.post('/api/import/:type', async (req, reply) => {
  const ownerId = currentUserId(req);
  const type = req.params.type;
  if (!POOL_TYPES.includes(type)) return reply400('未知类型');
  const items = Array.isArray(req.body?.items) ? req.body.items : PARSERS[type](req.body?.text);
  const hasPdf = Object.hasOwn(req.body || {}, 'pdf');
  if (hasPdf && type !== 'licenses') return reply400('PDF 只能导入到营业执照资料库');

  if (hasPdf) {
    if (items.length !== 1) return reply400('一个 PDF 请对应一份营业执照');
    const bytes = decodePdf(req.body.pdf);
    const item = normalizeImport('licenses', items[0]);
    const documentId = checkDuplicatePdf(bytes).sha256;
    const filename = path.basename(String(req.body.filename || '营业执照.pdf')).replace(/[\\/\r\n]/g, '_');
    return mutate(() => {
      // 再次校验并在单个 SQLite 写事务里拒绝重复，防止两人同时保存。
      if (checkDuplicatePdf(bytes).exists) rejectDuplicatePdf();
      const mine = store.listLicenses(db, ownerId);
      const byDocument = mine.filter((license) => license.document_id === documentId);
      if (byDocument.length > 1) return reply400('原 PDF 已关联多份历史资料，请先核对这些资料再导入');
      const byName = mine.find(DUP_KEYS.licenses(item));
      if (byDocument[0] && byName && byDocument[0].id !== byName.id) {
        return reply400('该 PDF 已属于另一份资料，名称修改与现有组织冲突，请核对后重试');
      }
      const mineMatched = byDocument[0] || byName || null;

      // 关键一步：跨全体用户判重（自己已有的那条属于「更新」，不算重复）
      const conflict = dedup.findLicenseConflict(db, dedup.licenseKeys(item), { excludeId: mineMatched ? mineMatched.id : null });
      if (conflict) return replyConflict(privateConflictMessage(conflict), [conflictDetail(conflict, item)]);

      let license = mineMatched;
      const added = license ? 0 : 1;
      try {
        if (!license) license = store.insertPoolRow(db, ownerId, 'licenses', item, { createdAt: nowLocal() });
        const merged = normalizeImport('licenses', { ...store.toPublic(license), ...items[0] });
        license = store.updatePoolRow(db, ownerId, 'licenses', license.id, merged);
      } catch (error) {
        if (!store.isUniqueViolation(error)) throw error;
        const again = dedup.findLicenseConflict(db, dedup.licenseKeys(item), { excludeId: mineMatched ? mineMatched.id : null });
        return replyConflict(again ? privateConflictMessage(again) : '该营业执照与现有资料重复', again ? [conflictDetail(again, item)] : []);
      }
      db.prepare('UPDATE licenses SET document_id = ?, document_name = ?, document_size = ? WHERE owner_id = ? AND id = ?')
        .run(documentId, filename, bytes.length, ownerId, license.id);
      store.putDocument(db, ownerId, { sha256: documentId, filename, bytes, createdAt: nowLocal() });
      license = store.findPoolItem(db, ownerId, 'licenses', license.id);
      syncResource(ownerId, 'licenses', license);
      store.pruneDocuments(db);
      return {
        added, updated: added ? 0 : 1, skipped: 0, duplicates: [], conflicts: [],
        attached: 1, license_id: license.id, license: store.toPublic(license),
      };
    });
  }

  return mutate(() => {
    const result = importItems(ownerId, type, items);
    // 营业执照出现全局重复时，整批拒绝，避免「悄悄少导一条」
    if (type === 'licenses' && result.conflicts.length) {
      const names = result.conflicts.slice(0, 3).map((c) => c.message).join('；');
      const more = result.conflicts.length > 3 ? `（另有 ${result.conflicts.length - 3} 条同类冲突）` : '';
      return replyConflict(`导入已取消，发现 ${result.conflicts.length} 条重复：${names}${more}`, result.conflicts);
    }
    return result;
  });
});

/** 营业执照原件的读取（按账号隔离）。 */
function licenseDocument(id, ownerId = null) {
  const owner = ownerId ?? (desktopToken ? ensureDesktopUser() : null);
  const license = owner ? store.findPoolItem(db, owner, 'licenses', Number(id)) : null;
  const document = license && license.document_id ? store.getDocument(db, license.document_id) : null;
  if (!document) throw new Error('这份营业执照尚未保存原 PDF');
  return {
    id: license.document_id,
    filename: document.filename,
    base64: Buffer.from(document.bytes).toString('base64'),
  };
}

fastify.get('/api/licenses/:id/pdf', async (req, reply) => {
  let document;
  try {
    document = licenseDocument(req.params.id, currentUserId(req));
  } catch {
    return reply.code(404).send({ error: '未保存原 PDF' });
  }
  reply.header('Content-Type', 'application/pdf');
  reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(document.filename)}`);
  reply.header('Cache-Control', 'no-store');
  return reply.send(Buffer.from(document.base64, 'base64'));
});

/** 全体成员重复体检：跨用户扫描，找出任何形式的重复。 */
// 普通用户不能枚举全体成员的营业执照或归属关系。待管理员权限实现再开放。
fastify.get('/api/licenses/duplicates', async (req, reply) => {
  return reply.code(403).send({ error: '无权查看其他成员的查重报告' });
});

fastify.patch('/api/pool/:type/:id', async (req) => {
  const ownerId = currentUserId(req);
  const type = req.params.type;
  if (!POOL_TYPES.includes(type)) return reply400('未知类型');
  return mutate(() => {
    const id = Number(req.params.id);
    const current = store.findPoolItem(db, ownerId, type, id);
    if (!current) return reply400('资源不存在');
    const body = req.body || {};
    if(body.version !== undefined && body.version !== current.version) return replyConflict('Record changed; refresh before retrying.',[]);
    assertNoCardSecrets(body);
    if ('status' in body) {
      if (!STATUSES.includes(body.status)) return reply400('无效状态');
      const prefix = POOL_PREFIX[type];
      if (body.status === '未使用' && store.recordsUsingResource(db, ownerId, prefix, id).length) {
        return reply400('资源仍关联记录，不能标记为未使用');
      }
      store.setPoolStatus(db, ownerId, type, id, body.status);
    }
    const changed = Object.fromEntries(IMPORT_FIELDS[type].filter((key) => key in body).map((key) => [key, body[key]]));
    const merged = normalizeImport(type, { ...store.toPublic(current), ...changed });
    if (type === 'licenses') {
      const conflict = dedup.findLicenseConflict(db, dedup.licenseKeys(merged), { excludeId: id });
      if (conflict) return replyConflict(privateConflictMessage(conflict), [conflictDetail(conflict, merged)]);
    } else {
      const predicate = store.poolDuplicatePredicate(type, merged);
      const dup = predicate && db.prepare(`SELECT id FROM ${type} WHERE owner_id = ? AND ${predicate.sql} AND id <> ?`)
        .get(ownerId, ...predicate.params, id);
      if (dup) return reply400('修改后的资源与资料库中现有资源重复');
    }
    let updated;
    try {
      updated = store.updatePoolRow(db, ownerId, type, id, merged);
    } catch (error) {
      if (!store.isUniqueViolation(error)) throw error;
      return reply400('修改后的资源与资料库中现有资源重复');
    }
    syncResource(ownerId, type, updated);
    return { item: store.toPublic(updated) };
  });
});

fastify.delete('/api/pool/:type/:id', async (req) => {
  const ownerId = currentUserId(req);
  const type = req.params.type;
  if (!POOL_TYPES.includes(type)) return reply400('未知类型');
  const id = Number(req.params.id);
  return mutate(() => {
    if (store.recordsUsingResource(db, ownerId, POOL_PREFIX[type], id).length) {
      return reply400('资源仍关联记录，请先解除关联');
    }
    const deleted = store.deletePoolRow(db, ownerId, type, id);
    if (type === 'licenses') store.pruneDocuments(db);
    return { deleted };
  });
});

fastify.post('/api/records', async (req) => {
  const ownerId = currentUserId(req);
  assertNoCardSecrets(req.body||{});
  const requestKey=req.headers['idempotency-key'];
  if(requestKey && (typeof requestKey!=='string'||! /^[A-Za-z0-9_-]{16,128}$/.test(requestKey))) return reply400('Invalid idempotency key');
  const hash=crypto.createHash('sha256').update(JSON.stringify(req.body||{})).digest('hex');
  const res = mutate(() => {
    if(requestKey) {
      const old=db.prepare('SELECT request_hash,result_ids FROM idempotency_requests WHERE owner_id=? AND request_key=?').get(ownerId,requestKey);
      if(old) {
        if(old.request_hash!==hash) return replyConflict('Submission changed; start a new request.',[]);
        const created=JSON.parse(old.result_ids).map(id=>store.toPublic(store.getRecord(db,ownerId,id))).filter(Boolean);
        if(!created.length) return replyConflict('This request was already processed and records were removed.',[]);
        return {created,replayed:true};
      }
    }
    const result=createRecords(ownerId,req.body||{});
    if(!result.error) {
      if(requestKey) db.prepare('INSERT INTO idempotency_requests VALUES(?,?,?,?,?)').run(ownerId,requestKey,hash,JSON.stringify(result.created.map(r=>r.id)),new Date().toISOString());
      audit(db,ownerId,'records.create',String(result.created.length));
    }
    return result;
  });
  if (res.error) return reply400(res.error);
  return res;
});

fastify.patch('/api/records/:id', async (req) => {
  const ownerId = currentUserId(req);
  const current=store.getRecord(db,ownerId,Number(req.params.id));
  if(!current) return reply400('Record not found');
  if(req.body?.version!==undefined && req.body.version!==current.version) return replyConflict('Record changed; refresh before retrying.',[]);
  const res = mutate(() => updateRecord(ownerId, Number(req.params.id), req.body || {}));
  if (res.error) return reply400(res.error);
  return res;
});

fastify.post('/api/records/batch-delete', async (req) => {
  const ownerId = currentUserId(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return { deleted: 0 };
  return mutate(() => deleteRecords(ownerId, ids));
});

fastify.delete('/api/records/:id', async (req) => {
  const ownerId = currentUserId(req);
  return mutate(() => deleteRecords(ownerId, [Number(req.params.id)]));
});

fastify.post('/api/export/adspower', async (req) => {
  const ownerId = currentUserId(req);
  if(req.url.split('?')[0]==='/api/export/adspower') requireUnlocked(req);
  if(req.body?.ids && !Array.isArray(req.body.ids)) return reply400('Invalid ids');
  const ids = new Set((req.body?.ids || []).map(Number));
  const list = store.listRecords(db, ownerId).reverse().filter((r) => !ids.size || ids.has(r.id));
  if (!list.length) return reply400('没有可导出的记录');
  audit(db,ownerId,'export.credentials',String(list.length));
  return { text: buildAdspower(list), count: list.length };
});

fastify.post('/api/export/csv', async (req) => {
  const ownerId = currentUserId(req);
  if(req.url.split('?')[0]==='/api/export/adspower') requireUnlocked(req);
  if(req.body?.ids && !Array.isArray(req.body.ids)) return reply400('Invalid ids');
  const ids = new Set((req.body?.ids || []).map(Number));
  const list = store.listRecords(db, ownerId).reverse().filter((r) => !ids.size || ids.has(r.id));
  if (!list.length) return reply400('没有可导出的记录');
  return { text: buildCsv(list), count: list.length };
});

/* ---------------- 个人备份与恢复（服务器版） ---------------- */

/** 导出当前账号的资源、记录与原件。附件以 base64 内嵌，形状与旧版 data.json 一致，可互相导入。 */
fastify.get('/api/backup', async (req, reply) => {
  const ownerId = currentUserId(req);
  const user = store.findUserById(db, ownerId);
  const filename = `账号工作台-${user.username}-${new Date().toISOString().slice(0, 10)}.json`;
  reply.header('Content-Type', 'application/json; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  requireUnlocked(req);
  audit(db,ownerId,'backup.export');
  return reply.send(JSON.stringify(encryptedSnapshot(ownerId)));
});

/**
 * 恢复个人备份：只覆盖当前账号的数据，绝不触碰其他成员。
 * 单独放宽请求体上限（附件内嵌 base64 会很大），避免为此抬高全局上限成为攻击面。
 */
fastify.post('/api/backup/restore', { bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
  const ownerId = currentUserId(req);
  const payload = req.body?.snapshot ?? req.body;
  requireUnlocked(req);
  try {
    restoreEncrypted(payload, ownerId);
    audit(db,ownerId,'backup.restore');
  } catch (error) {
    // 备份内容不对是「你给的文件有问题」，属于 400，不该报成服务器内部错误。
    // 校验在写库之前完成，因此被拒绝时现有数据不会被改动。
    if (!error.statusCode) return reply400(`备份文件无法恢复：${error.message}`);
    throw error;
  }
  return {
    restored: true,
    records: store.listRecords(db, ownerId).length,
    licenses: store.listPool(db, ownerId, 'licenses').length,
  };
});

/* ---------------- 备份与恢复（桌面版接口，语义保持不变） ---------------- */

function resolveDefaultOwner() {
  // 桌面版没有会话，用本机固定的 local 账号（desktop/main.js 里有若干不带 owner 的调用）。
  if (desktopToken) return ensureDesktopUser();
  // 网页版不存在「默认账号」。HTTP 路由始终从会话取 ownerId（server.js 的 currentUserId），
  // 因此能走到这里只可能是上游鉴权出了问题；此时回退到「数据库里第一个用户」会把
  // 破坏性写（restore 会先 DELETE 该账号的 records 与全部资源池）指到某个真实账号上，
  // 把一次鉴权缺陷放大成数据事故。宁可硬失败，也不允许在没有账号上下文时推断归属。
  // 这是文档工作包 02「每个接口均验证会话及所属人，不信任客户端传入的 owner_id」的直接落实。
  throw new Error('未登录：缺少账号上下文，拒绝推断数据归属');
}

function snapshot(ownerId = null) {
  const owner = ownerId ?? resolveDefaultOwner();
  const empty = { counters: {}, documents: {}, emails: [], proxies: [], cards: [], licenses: [], records: [] };
  if (!owner) return empty;
  const docs = db.prepare(`
    SELECT d.sha256, d.filename, d.bytes FROM documents d
     WHERE d.sha256 IN (SELECT document_id FROM licenses WHERE owner_id = ? AND document_id IS NOT NULL)
  `).all(owner);
  return {
    counters: {},
    documents: Object.fromEntries(docs.map((d) => [d.sha256, { filename: d.filename, base64: Buffer.from(store.getDocument(db,d.sha256).bytes).toString('base64') }])),
    emails: store.listPool(db, owner, 'emails'),
    proxies: store.listPool(db, owner, 'proxies'),
    cards: store.listPool(db, owner, 'cards'),
    licenses: store.listPool(db, owner, 'licenses'),
    records: store.listRecords(db, owner).slice().reverse(),
  };
}

function encryptedSnapshot(ownerId=null) {
  const owner=ownerId??resolveDefaultOwner();
  if(!owner) throw new Error('Login required for backup');
  const value=snapshot(owner),vault=getVault(db);
  return {format:'adsworkbench-backup',version:2,owner_id:owner,key_id:vault.keyId,created_at:new Date().toISOString(),
    counts:{records:value.records.length,licenses:value.licenses.length},
    payload:vault.seal(JSON.stringify(value),`backup:${owner}`)};
}
function decryptSnapshot(envelope,ownerId=null) {
  const owner=ownerId??resolveDefaultOwner(),vault=getVault(db);
  if(envelope?.format!=='adsworkbench-backup'||envelope.version!==2||envelope.owner_id!==owner||envelope.key_id!==vault.keyId) throw new Error('\u5907\u4efd\u4e0d\u5c5e\u4e8e\u5f53\u524d\u8d26\u53f7\u6216\u670d\u52a1\u5668\uff1b\u65e7\u683c\u5f0f\u9700\u7ba1\u7406\u5458\u79bb\u7ebf\u8fc1\u79fb');
  return validateSnapshot(JSON.parse(vault.open(envelope.payload,`backup:${owner}`)));
}
function restoreEncrypted(envelope,ownerId=null) {return restore(decryptSnapshot(envelope,ownerId),ownerId);}

function restore(data, ownerId = null) {
  const owner = ownerId ?? resolveDefaultOwner();
  if (!owner) throw new Error('恢复备份需要先创建账号');
  const value = validateSnapshot(data);
  return mutate(() => {
    // 备份恢复仍是一次“写入”，必须防止覆盖其他成员或绕过全员文件查重。
    // 本人的旧备份属于替换本人数据，不视为新建重复。
    for (const license of value.licenses) {
      if (license.document_id) {
        const foreign = db.prepare('SELECT 1 FROM document_registry WHERE owner_id <> ? AND sha256 = ? LIMIT 1')
          .get(owner, license.document_id);
        if (foreign) replyConflict('备份中包含已被其他账号保存的 PDF 文件，恢复已取消；您的现有数据未改变', [
          { name: '备份中的 PDF', field: 'file', label: 'PDF 文件内容', message: '文件与全员数据库中已保存的文件重复' },
        ]);
      }
      const keys = dedup.licenseKeys(license);
      const conflict = dedup.findLicenseConflict(db, keys, {excludeOwnerId:owner});
      if (conflict) {
        replyConflict(privateConflictMessage(conflict), [conflictDetail(conflict, license)]);
      }
    }
    db.prepare('DELETE FROM records WHERE owner_id = ?').run(owner);
    for (const kind of POOL_TYPES) db.prepare(`DELETE FROM ${kind} WHERE owner_id = ?`).run(owner);
    store.adoptLegacySnapshot(db, owner, value, { createdAt: nowLocal() });
    store.pruneDocuments(db);
    return { restored: true };
  });
}

/* ---------------- 静态资源与启动 ---------------- */

fastify.get('/login', (req, reply) => reply.sendFile('login.html'));

installStatic(fastify, PUBLIC_DIR);

fastify.setNotFoundHandler((req, reply) => {
  if (req.raw.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
  return reply.code(404).send({error:'not found'});
});

const start = async ({ port = Number(process.env.PORT) || 3000, host = process.env.HOST || '127.0.0.1', token = '' } = {}) => {
  if (token) desktopToken = token;
  auth.pruneSessions(db);
  if (store.countUsers(db) === 0) loadLegacySnapshot();
  try {
    const address = await fastify.listen({ port, host });
    if (process.env.LOG_LEVEL !== 'silent') console.log('Ads Workbench started: ' + address);
    return address;
  } catch (e) {
    fastify.log.error(e);
    throw e;
  }
};

/** 关闭服务：先停掉 HTTP，再关数据库句柄（Windows 上句柄不关会导致数据文件无法删除/替换）。 */
const close = async () => {
  await fastify.close();
  try { db.close(); } catch { /* 已关闭 */ }
};

module.exports = {
  start,
  close,
  snapshot, encryptedSnapshot, decryptSnapshot, restoreEncrypted,
  restore,
  licenseDocument,
  fastify,
  db,
  store,
};
if (require.main === module) {
  start().catch(() => { process.exitCode = 1; });
  let stopping=false;
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{if(stopping)return;stopping=true;close().finally(()=>process.exit(0));});
}
