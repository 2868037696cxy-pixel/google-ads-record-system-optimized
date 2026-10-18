'use strict';

/**
 * 账号、密码与会话。
 *
 * 零外部依赖：密码用 Node 内置 scrypt，会话令牌用随机字节 + SHA-256 摘要存储。
 * 库里只存令牌摘要，即使数据库泄露也无法直接冒用会话。
 */

const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const SESSION_COOKIE = 'wb_session';
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

/* ---------------- 密码 ---------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  let expected;
  try {
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (!expected.length) return false;
  let derived;
  try {
    derived = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/* ---------------- 会话 ---------------- */

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)')
    .run(sha256(token), userId, new Date().toISOString(), Date.now() + SESSION_TTL_MS);
  return token;
}

/** 解析会话；过期即删除。剩余有效期不足一半时自动续期（滑动过期）。 */
function resolveSession(db, token) {
  if (typeof token !== 'string' || !token) return null;
  const hash = sha256(token);
  const row = db.prepare('SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = ?').get(hash);
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  const remaining = row.expires_at - Date.now();
  if (remaining < SESSION_TTL_MS / 2) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + SESSION_TTL_MS, hash);
  }
  return row.user_id;
}

function destroySession(db, token) {
  if (typeof token !== 'string' || !token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function pruneSessions(db) {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()).changes;
}

/* ---------------- Cookie ---------------- */

function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }
  return out;
}

function sessionCookie(token, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/* ---------------- 校验 ---------------- */

function validateCredentials({ username, password }) {
  const name = String(username ?? '').trim();
  const pass = String(password ?? '');
  if (!USERNAME_RE.test(name)) return { error: '用户名需为 3-32 位字母、数字、下划线、点或短横线' };
  if (pass.length < MIN_PASSWORD) return { error: `密码至少 ${MIN_PASSWORD} 位` };
  if (pass.length > MAX_PASSWORD) return { error: '密码过长' };
  return { username: name, password: pass };
}

const publicUser = (row) => row && ({
  id: row.id,
  username: row.username,
  display_name: row.display_name || row.username,
  created_at: row.created_at,
});

/* ---------------- 登录限速 ---------------- */

/**
 * 按「IP + 用户名」限速。带过期清理，避免长期运行时的内存增长
 * （对比：被审查的广告记录系统用了一个永不清理的 Map）。
 */
class RateLimiter {
  constructor({ limit = 10, windowMs = 60_000, maxKeys = 10_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  #sweep(now) {
    if (this.buckets.size < this.maxKeys) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    // 仍超限时丢弃最早的一批，宁可放宽限速也不让内存无界增长
    if (this.buckets.size >= this.maxKeys) {
      let drop = this.buckets.size - this.maxKeys + 1;
      for (const key of this.buckets.keys()) {
        this.buckets.delete(key);
        if (--drop <= 0) break;
      }
    }
  }

  check(key) {
    const now = Date.now();
    this.#sweep(now);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    bucket.count += 1;
    if (bucket.count > this.limit) {
      return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfter: 0 };
  }

  reset(key) {
    this.buckets.delete(key);
  }
}

module.exports = {
  SCRYPT, SESSION_COOKIE, SESSION_TTL_MS, MIN_PASSWORD, USERNAME_RE,
  hashPassword, verifyPassword,
  createSession, resolveSession, destroySession, pruneSessions,
  parseCookies, sessionCookie, clearCookie,
  validateCredentials, publicUser,
  RateLimiter,
};
