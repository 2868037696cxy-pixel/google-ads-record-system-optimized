'use strict';

/**
 * 身份层（P2）：会话 Cookie + 飞书扫码登录
 * - 飞书凭证全部走环境变量，未配置时登录入口会提示未启用（不影响其它接口）。
 * - AUTH_DEV_LOGIN=1 时启用本地开发登录（仅用于本地联调，生产请勿开启）。
 */

const crypto = require('node:crypto');

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const SESSION_COOKIE = 'ads_session';
const STATE_COOKIE = 'ads_oauth_state';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

function config() {
  const appId = process.env.FEISHU_APP_ID || '';
  const appSecret = process.env.FEISHU_APP_SECRET || '';
  return {
    appId,
    appSecret,
    redirectUri: process.env.FEISHU_REDIRECT_URI || '',
    configured: Boolean(appId && appSecret),
    devLogin: process.env.AUTH_DEV_LOGIN === '1',
  };
}

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

function sessionCookie(token) {
  return serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_MS });
}

function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0 });
}

function stateCookie(state) {
  return serializeCookie(STATE_COOKIE, state, { maxAge: 10 * 60 * 1000 });
}

function readSessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE] || '';
}

function readState(req) {
  return parseCookies(req)[STATE_COOKIE] || '';
}

/* ---------------- 飞书 OAuth ---------------- */

function oauthState() {
  return crypto.randomBytes(16).toString('hex');
}

function resolveRedirectUri(req) {
  const cfg = config();
  if (cfg.redirectUri) return cfg.redirectUri;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${process.env.PORT || 3000}`;
  return `${proto}://${host}/api/auth/feishu/callback`;
}

function authorizeUrl(redirectUri, state) {
  const cfg = config();
  const q = new URLSearchParams({ app_id: cfg.appId, redirect_uri: redirectUri, state });
  return `${FEISHU_BASE}/authen/v1/index?${q.toString()}`;
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  return res.json();
}

// 用授权码换取用户资料：app_access_token → user_access_token → user_info
async function exchangeCode(code) {
  const cfg = config();
  if (!cfg.configured) throw new Error('飞书应用未配置');

  const appRes = await postJson(`${FEISHU_BASE}/auth/v3/app_access_token/internal`, {
    app_id: cfg.appId,
    app_secret: cfg.appSecret,
  });
  if (appRes.code !== 0 || !appRes.app_access_token) {
    throw new Error('获取 app_access_token 失败：' + (appRes.msg || appRes.code));
  }

  const tokenRes = await postJson(
    `${FEISHU_BASE}/authen/v1/oidc/access_token`,
    { grant_type: 'authorization_code', code },
    { Authorization: `Bearer ${appRes.app_access_token}` }
  );
  if (tokenRes.code !== 0 || !tokenRes.data?.access_token) {
    throw new Error('换取用户令牌失败：' + (tokenRes.msg || tokenRes.code));
  }

  const infoRes = await getJson(`${FEISHU_BASE}/authen/v1/user_info`, {
    Authorization: `Bearer ${tokenRes.data.access_token}`,
  });
  if (infoRes.code !== 0 || !infoRes.data) {
    throw new Error('获取用户信息失败：' + (infoRes.msg || infoRes.code));
  }
  return infoRes.data; // { open_id, name, avatar_url, ... }
}

// 前端登录页需要的登录入口信息
function loginMeta(req) {
  const cfg = config();
  return {
    feishu_enabled: cfg.configured,
    dev_login: cfg.devLogin,
    login_url: cfg.configured ? '/api/auth/login' : '',
  };
}

module.exports = {
  config,
  loginMeta,
  oauthState,
  resolveRedirectUri,
  authorizeUrl,
  exchangeCode,
  readSessionToken,
  readState,
  sessionCookie,
  clearSessionCookie,
  stateCookie,
  SESSION_COOKIE,
  STATE_COOKIE,
  SESSION_TTL_MS,
};
