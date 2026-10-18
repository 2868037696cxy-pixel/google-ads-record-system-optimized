'use strict';

/**
 * 身份层：账号密码登录 + 会话 Cookie
 * - 密码用 scrypt 加盐哈希存储，校验用恒定时间比较。
 * - 会话不可被前端脚本读取（HttpOnly），有效期 7 天。
 */

const crypto = require('node:crypto');

const SESSION_COOKIE = 'ads_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/* ---------------- Cookie ---------------- */

function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

function sessionCookie(token, opts = {}) {
  return serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_MS, secure: opts.secure });
}

function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0 });
}

function readSessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE] || '';
}

/* ---------------- 密码 ---------------- */

// 存储格式：scrypt:salt:key
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt:${salt}:${key}`;
}

function verifyPassword(pw, stored) {
  const [scheme, salt, key] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const test = crypto.scryptSync(String(pw), salt, 64);
  const want = Buffer.from(key, 'hex');
  return want.length === test.length && crypto.timingSafeEqual(want, test);
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  parseCookies,
  serializeCookie,
  sessionCookie,
  clearSessionCookie,
  readSessionToken,
  hashPassword,
  verifyPassword,
};
