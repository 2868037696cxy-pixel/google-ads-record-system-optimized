'use strict';

/* ============================================================
   账号工作台 · 登录 / 注册页
   - 所有请求带 x-workbench: 1（服务端 CSRF 校验），POST 使用 JSON
   - 登录/注册成功后服务端下发 HttpOnly 会话 Cookie，
     前端不保存任何 token，直接 location.replace('/') 进入主应用
   ============================================================ */

const AUTH_API = {
  config: '/api/auth/config',
  me: '/api/auth/me',
  login: '/api/auth/login',
  register: '/api/auth/register',
};

/* 读取 /api/auth/config 失败时的兜底值：
   登录始终可用；注册入口按「开放」处理（首个账号需要注册），
   只有服务端明确返回 closed 时才隐藏。 */
const DEFAULT_CONFIG = {
  registration: 'open',
  minPasswordLength: 8,
  minUsernameLength: 3,
  maxUsernameLength: 32,
  siteName: '账号工作台',
};

const config = { ...DEFAULT_CONFIG };
const state = {
  mode: 'login',
  busy: false,
  redirecting: false,
  registerEnabled: true,
  inviteRequired: false,
};

const el = {};

/* ---------------- 元素缓存 ---------------- */

function cacheEls() {
  const ids = [
    'authTabs', 'tabLogin', 'tabRegister', 'panelLogin', 'panelRegister', 'authAlert', 'brandName',
    'loginForm', 'loginUsername', 'loginPassword', 'loginSubmit', 'switchWrapLogin', 'switchToRegister',
    'registerForm', 'regUsername', 'regUsernameHint', 'regDisplayName', 'regPassword', 'regPasswordHint',
    'regConfirm', 'regInviteField', 'regInvite', 'regSubmit', 'switchToLogin',
    'regStrength', 'regStrengthLabel', 'capsLogin', 'capsRegister',
  ];
  for (const id of ids) el[id] = document.getElementById(id);
}

/* ---------------- 网络 ---------------- */

async function request(path, options = {}) {
  const { method = 'GET', body } = options;
  const headers = { 'x-workbench': '1', Accept: 'application/json' };
  const init = { method, headers, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(path, init);
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/* 服务端返回的 { error: "中文提示" } 原样展示；缺省时按状态码给出等价文案 */
async function failureMessage(res) {
  const data = await readJson(res);
  if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
  if (res.status === 401) return '用户名或密码不正确';
  if (res.status === 429) return '尝试过于频繁，请稍后再试';
  if (res.status === 403) return '请求被拒绝，请刷新页面后重试';
  if (res.status >= 500) return `服务端错误（${res.status}），请稍后重试`;
  return `请求失败（${res.status}），请稍后重试`;
}

async function checkSession() {
  try {
    const res = await request(AUTH_API.me);
    if (res.ok) {
      state.redirecting = true;
      location.replace('/');
    }
  } catch {
    /* 未登录或服务暂时不可用：停留在登录页 */
  }
}

/* ---------------- 服务端配置 ---------------- */

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= min && i <= max ? i : fallback;
}

function normalizeConfig(data) {
  const next = {};
  if (!data || typeof data !== 'object') return next;
  if (data.registration === 'open' || data.registration === 'invite' || data.registration === 'closed') {
    next.registration = data.registration;
  }
  next.minPasswordLength = clampInt(data.minPasswordLength, config.minPasswordLength, 4, 128);
  next.minUsernameLength = clampInt(data.minUsernameLength, config.minUsernameLength, 1, 64);
  next.maxUsernameLength = clampInt(data.maxUsernameLength, config.maxUsernameLength, 1, 128);
  if (next.maxUsernameLength < next.minUsernameLength) next.maxUsernameLength = next.minUsernameLength;
  if (typeof data.siteName === 'string' && data.siteName.trim()) next.siteName = data.siteName.trim();
  return next;
}

async function loadConfig() {
  try {
    const res = await request(AUTH_API.config);
    if (res.ok) Object.assign(config, normalizeConfig(await readJson(res)));
  } catch {
    /* 读取失败：沿用兜底配置，登录路径不受影响 */
  }
  renderConfig();
}

function renderConfig() {
  const canRegister = config.registration !== 'closed';
  state.registerEnabled = canRegister;
  state.inviteRequired = config.registration === 'invite';

  el.tabRegister.hidden = !canRegister;
  el.tabRegister.tabIndex = state.mode === 'register' ? 0 : -1;
  el.switchWrapLogin.hidden = !canRegister;
  el.regInviteField.hidden = !state.inviteRequired;
  el.regInvite.required = state.inviteRequired;

  el.regUsernameHint.textContent = `${config.minUsernameLength}–${config.maxUsernameLength} 个字符`;
  el.regPasswordHint.textContent = `至少 ${config.minPasswordLength} 位`;
  el.regUsername.minLength = config.minUsernameLength;
  el.regUsername.maxLength = config.maxUsernameLength;

  if (config.siteName) el.brandName.textContent = config.siteName;

  if (!canRegister && state.mode === 'register') switchMode('login', false);
  updateStrength();
}

/* ---------------- 模式切换 ---------------- */

function switchMode(mode, focusField) {
  if (mode === 'register' && !state.registerEnabled) mode = 'login';
  state.mode = mode;
  const isLogin = mode === 'login';

  el.tabLogin.classList.toggle('active', isLogin);
  el.tabLogin.setAttribute('aria-selected', String(isLogin));
  el.tabLogin.tabIndex = isLogin ? 0 : -1;
  el.tabRegister.classList.toggle('active', !isLogin);
  el.tabRegister.setAttribute('aria-selected', String(!isLogin));
  el.tabRegister.tabIndex = isLogin ? -1 : 0;

  el.panelLogin.hidden = !isLogin;
  el.panelRegister.hidden = isLogin;

  hideAlert();
  clearFormErrors(el.loginForm);
  clearFormErrors(el.registerForm);

  if (focusField) {
    const target = isLogin ? el.loginUsername : el.regUsername;
    if (target) target.focus();
  }
}

/* ---------------- 提示与错误态 ---------------- */

function setText(box, text) {
  if (!box) return;
  if (text) {
    box.hidden = false;
    box.textContent = text;
  } else {
    box.hidden = true;
    box.textContent = '';
  }
}

function showAlert(kind, message) {
  el.authAlert.hidden = false;
  el.authAlert.dataset.kind = kind;
  el.authAlert.textContent = message;
}

function hideAlert() {
  el.authAlert.hidden = true;
  el.authAlert.textContent = '';
}

function setFieldError(input, message) {
  if (!input) return;
  input.setAttribute('aria-invalid', 'true');
  setText(document.getElementById(`${input.id}Err`), message);
}

function clearFieldError(input) {
  if (!input) return;
  input.removeAttribute('aria-invalid');
  setText(document.getElementById(`${input.id}Err`), '');
}

function clearFormErrors(form) {
  if (!form) return;
  for (const input of form.querySelectorAll('input')) clearFieldError(input);
}

/* ---------------- 提交态 ---------------- */

function setBusy(which, busy, label) {
  state.busy = busy;
  const isLogin = which === 'login';
  const form = isLogin ? el.loginForm : el.registerForm;
  const btn = isLogin ? el.loginSubmit : el.regSubmit;

  btn.disabled = busy;
  btn.classList.toggle('btn-loading', busy);
  btn.textContent = busy ? label : isLogin ? '登录' : '创建账号';

  if (busy) form.setAttribute('aria-busy', 'true');
  else form.removeAttribute('aria-busy');
}

/* ---------------- 前端校验（不通过则不发请求） ---------------- */

function validateLogin() {
  clearFormErrors(el.loginForm);
  let first = null;
  const fail = (input, message) => {
    setFieldError(input, message);
    if (!first) first = input;
  };

  if (!el.loginUsername.value.trim()) fail(el.loginUsername, '请输入用户名');
  if (!el.loginPassword.value) fail(el.loginPassword, '请输入密码');

  if (first) {
    first.focus();
    return false;
  }
  return true;
}

function validateRegister() {
  clearFormErrors(el.registerForm);
  let first = null;
  const fail = (input, message) => {
    setFieldError(input, message);
    if (!first) first = input;
  };

  const username = el.regUsername.value.trim();
  const password = el.regPassword.value;
  const confirm = el.regConfirm.value;

  if (!username) fail(el.regUsername, '请输入用户名');
  else if (username.length < config.minUsernameLength) fail(el.regUsername, `用户名至少 ${config.minUsernameLength} 个字符`);
  else if (username.length > config.maxUsernameLength) fail(el.regUsername, `用户名最多 ${config.maxUsernameLength} 个字符`);

  if (!password) fail(el.regPassword, '请输入密码');
  else if (password.length < config.minPasswordLength) fail(el.regPassword, `密码至少 ${config.minPasswordLength} 位`);

  if (!confirm) fail(el.regConfirm, '请再次输入密码');
  else if (confirm !== password) fail(el.regConfirm, '两次输入的密码不一致');

  if (state.inviteRequired && !el.regInvite.value.trim()) fail(el.regInvite, '请输入邀请码');

  if (first) {
    first.focus();
    return false;
  }
  return true;
}

/* ---------------- 提交 ---------------- */

function finish() {
  state.redirecting = true;
  const btn = state.mode === 'register' ? el.regSubmit : el.loginSubmit;
  btn.classList.remove('btn-loading');
  btn.textContent = '正在进入工作台…';
  location.replace('/');
}

async function submitLogin() {
  if (state.busy) return;
  if (!validateLogin()) return;

  hideAlert();
  setBusy('login', true, '正在登录…');
  try {
    const res = await request(AUTH_API.login, {
      method: 'POST',
      body: { username: el.loginUsername.value.trim(), password: el.loginPassword.value },
    });

    if (res.ok) {
      finish();
      return;
    }

    /* 服务端不区分「用户不存在」与「密码错误」，前端也不做任何暗示 */
    showAlert('error', await failureMessage(res));
    if (res.status === 401) {
      el.loginPassword.value = '';
      el.loginPassword.focus();
    }
  } catch {
    showAlert('error', '无法连接服务，请确认工作台服务正在运行后重试。');
  } finally {
    if (!state.redirecting) setBusy('login', false);
  }
}

async function submitRegister() {
  if (state.busy) return;
  if (!validateRegister()) return;

  hideAlert();
  setBusy('register', true, '正在注册…');
  try {
    const res = await request(AUTH_API.register, {
      method: 'POST',
      body: {
        username: el.regUsername.value.trim(),
        password: el.regPassword.value,
        display_name: el.regDisplayName.value.trim(),
        invite_code: el.regInvite.value.trim(),
      },
    });

    if (res.ok) {
      finish();
      return;
    }

    showAlert('error', await failureMessage(res));
  } catch {
    showAlert('error', '无法连接服务，请确认工作台服务正在运行后重试。');
  } finally {
    if (!state.redirecting) setBusy('register', false);
  }
}

/* ---------------- 密码可见性 ---------------- */

function togglePassword(btn) {
  const input = document.getElementById(btn.getAttribute('data-target'));
  if (!input) return;

  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', String(show));
  btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');

  input.focus();
  const end = input.value.length;
  try {
    input.setSelectionRange(end, end);
  } catch {
    /* 个别输入类型不支持选区 */
  }
}

/* ---------------- 大写锁定提示 ---------------- */

function bindCapsLock(input, hint) {
  const update = (event) => {
    let on = false;
    if (event && typeof event.getModifierState === 'function') {
      try {
        on = event.getModifierState('CapsLock');
      } catch {
        on = false;
      }
    }
    hint.hidden = !on;
  };
  input.addEventListener('keydown', update);
  input.addEventListener('keyup', update);
  input.addEventListener('blur', () => {
    hint.hidden = true;
  });
}

/* ---------------- 密码强度 ---------------- */

function scorePassword(value) {
  let classes = 0;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/\d/.test(value)) classes += 1;
  if (/[^A-Za-z0-9]/.test(value)) classes += 1;

  const min = config.minPasswordLength;
  if (value.length < min || (classes <= 1 && value.length < min + 3)) return 1;
  if (value.length >= min + 4 && classes >= 3) return 3;
  if (classes >= 2 && value.length >= min) return 2;
  return 1;
}

function updateStrength() {
  const value = el.regPassword ? el.regPassword.value : '';
  if (!value) {
    el.regStrength.hidden = true;
    return;
  }
  const level = scorePassword(value);
  el.regStrength.hidden = false;
  el.regStrength.dataset.level = String(level);
  el.regStrengthLabel.textContent = level === 1 ? '强度 弱' : level === 2 ? '强度 中' : '强度 强';
}

/* ---------------- 事件绑定 ---------------- */

function bind() {
  el.loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitLogin();
  });

  el.registerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitRegister();
  });

  /* Tab 本身保持焦点（不抢走键盘用户的位置）；底部链接会被隐藏，需要把焦点交给表单 */
  el.tabLogin.addEventListener('click', () => switchMode('login', false));
  el.tabRegister.addEventListener('click', () => switchMode('register', false));
  el.switchToRegister.addEventListener('click', () => switchMode('register', true));
  el.switchToLogin.addEventListener('click', () => switchMode('login', true));

  el.authTabs.addEventListener('keydown', (event) => {
    if (!state.registerEnabled) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    switchMode(state.mode === 'login' ? 'register' : 'login', false);
  });

  for (const btn of document.querySelectorAll('.pw-toggle')) {
    btn.addEventListener('click', () => togglePassword(btn));
  }

  for (const input of document.querySelectorAll('.auth-form input')) {
    input.addEventListener('input', () => clearFieldError(input));
  }

  bindCapsLock(el.loginPassword, el.capsLogin);
  bindCapsLock(el.regPassword, el.capsRegister);
  el.regPassword.addEventListener('input', updateStrength);

  /* 从 bfcache 返回时可能已在别处登录 */
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) checkSession();
  });
}

function init() {
  cacheEls();
  bind();
  checkSession();
  loadConfig();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
