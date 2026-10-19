'use strict';
// HTTP 层回归：静态页面与安全头、未登录拦截、会话生命周期、个人备份往返。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { after, before, describe, it } = require('node:test');

// 隔离数据目录：绝不触碰日常数据。
const DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-http-'));
process.env.DATA_DIR = DIRECTORY;
process.env.DB_FILE = path.join(DIRECTORY, 'workbench.sqlite');
process.env.DATA_FILE = path.join(DIRECTORY, 'absent.json');
process.env.LOG_LEVEL = 'silent';

const service = require('../server');

let origin = '';
let cookie = '';

/** 已登录会话下的请求；默认带来源标记头与 Cookie。 */
const call = async (method, url, { body, headers = {}, auth = true } = {}) => fetch(origin + url, {
  method,
  headers: {
    'x-workbench': '1',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(auth && cookie ? { cookie } : {}),
    ...headers,
  },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** 从响应里取出会话 Cookie，供后续请求复用。 */
const sessionCookieFrom = (response) => (response.headers.getSetCookie() || [])
  .map((value) => value.split(';')[0])
  .find((value) => value.startsWith('wb_session='));

/** 用原始 socket 发请求：只有这样才能构造绝对形式请求行，fetch 无法发送。 */
const rawRequest = (port, requestLine, headers = {}, body = null) => new Promise((resolve, reject) => {
  const socket = net.connect(Number(port), '127.0.0.1');
  let buffer = '';
  socket.setTimeout(8000);
  socket.on('connect', () => {
    const payload = body === null ? null : Buffer.from(body);
    const lines = [requestLine, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    lines.push(`Content-Length: ${payload ? payload.length : 0}`, 'Connection: close');
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (payload) socket.write(payload);
  });
  socket.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
  socket.on('end', () => resolve(buffer.split('\r\n')[0] || ''));
  socket.on('timeout', () => { socket.destroy(); reject(new Error('原始请求超时')); });
  socket.on('error', reject);
});

before(async () => {
  origin = await service.start({ port: 0, host: '127.0.0.1' });
});

after(async () => {
  await service.close();
  fs.rmSync(DIRECTORY, { recursive: true, force: true });
});

describe('静态资源与会话', () => {
  it('主页面可访问、带 CSP 安全头，并含账号与重复体检入口', async () => {
    const response = await call('GET', '/', { auth: false });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy') || '', /script-src 'self'/);
    assert.ok(html.includes('id="accountName"'));
    assert.ok(html.includes('data-action="logout"'));
    assert.ok(html.includes('data-action="duplicate-audit"'));
    assert.ok(html.includes('data-action="web-backup"'));
  });

  it('登录页可访问，且不依赖内联脚本（否则被 CSP 拦下）', async () => {
    const response = await call('GET', '/login.html', { auth: false });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(html.includes('/login.js'));
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
    assert.equal((await call('GET', '/login', { auth: false })).status, 200);
  });

  it('登录页与主页面引用同一版本的样式表', async () => {
    const [, index, login] = await Promise.all([0, 1, 2].map(async (index) => {
      const url = index === 1 ? '/' : '/login.html';
      return (await call('GET', url, { auth: false })).text();
    }));
    const version = (html) => html.match(/\/styles\.css\?v=([\w.]+)/)?.[1];
    assert.ok(version(index), '主页面未引用带版本号的样式表');
    assert.equal(version(login), version(index));
  });

  it('前端为每个请求带上来源标记头，并在 401 时回到登录页', async () => {
    const source = await (await call('GET', '/app.js', { auth: false })).text();
    assert.ok(source.includes("'x-workbench': '1'"));
    assert.ok(source.includes("location.replace('/login.html')"));
  });

  it('拒绝非 origin-form 请求目标，防止整个鉴权钩子被跳过', async () => {
    // 绝对形式请求行（`GET http://host/api/...`）是合法 HTTP/1.1，Fastify 仍会路由到
    // 对应 handler，但 req.url 会以 "http://" 开头，使 onRequest 里的
    // startsWith('/api/') 判假并 return —— 桌面令牌、CSRF、会话鉴权被整体跳过。
    // 修复前实测：未带 Cookie 与 x-workbench 头的绝对形式写请求返回 200 并覆盖数据。
    // 下面用「同一条 socket、同样的头、只改请求行形式」做对照，确保测的就是这一个变量。
    const { port } = new URL(origin);
    const absolute = `http://127.0.0.1:${port}`;
    const snapshot = JSON.stringify({
      counters: {}, documents: {}, emails: [], proxies: [], cards: [], licenses: [], records: [],
    });

    const readAbsolute = await rawRequest(port, `GET ${absolute}/api/bootstrap HTTP/1.1`, { Host: `127.0.0.1:${port}` });
    assert.match(readAbsolute, /^HTTP\/1\.1 400/, `绝对形式读请求应被拒绝，实际：${readAbsolute}`);

    const writeHeaders = { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' };
    const writeAbsolute = await rawRequest(port, `POST ${absolute}/api/backup/restore HTTP/1.1`, writeHeaders, snapshot);
    assert.match(writeAbsolute, /^HTTP\/1\.1 400/, `绝对形式写请求应被拒绝，实际：${writeAbsolute}`);

    // 对照：同一写请求改用 origin-form，应被 CSRF 层挡在 403（说明差异只来自请求行形式）
    const writeOrigin = await rawRequest(port, 'POST /api/backup/restore HTTP/1.1', writeHeaders, snapshot);
    assert.match(writeOrigin, /^HTTP\/1\.1 403/, `origin-form 写请求应被 CSRF 拦下，实际：${writeOrigin}`);

    // 编码路径：find-my-way 会解码 %61='a'，把 /%61pi/bootstrap 交给 /api/bootstrap 的
    // handler，而未解码的 req.url 不以 /api/ 开头 —— 鉴权判断与路由判断就此分歧。
    // 修复前实测返回 200 且响应头缺少 cache-control: no-store（onSend 判断同样被跳过）。
    for (const target of ['/%61pi/bootstrap', '/%61p%69/bootstrap']) {
      const encoded = await rawRequest(port, `GET ${target} HTTP/1.1`, { Host: `127.0.0.1:${port}` });
      assert.match(encoded, /^HTTP\/1\.1 401/, `编码路径 ${target} 不应绕过鉴权，实际：${encoded}`);
    }
    const encodedWrite = await rawRequest(port, 'POST /%61pi/backup/restore HTTP/1.1', writeHeaders, snapshot);
    assert.match(encodedWrite, /^HTTP\/1\.1 (401|403)/, `编码路径写请求不应绕过鉴权，实际：${encodedWrite}`);
  });
});

describe('账号与会话', () => {
  it('未登录访问数据接口返回 401', async () => {
    const response = await call('GET', '/api/bootstrap', { auth: false });
    assert.equal(response.status, 401);
  });

  it('缺少来源标记头的写请求被拒绝', async () => {
    const response = await fetch(origin + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'whoever', password: 'whatever-1' }),
    });
    assert.equal(response.status, 403);
  });

  it('注册成功下发会话，可读取带当前账号的数据，登出后同一 Cookie 失效', async () => {
    const registered = await call('POST', '/api/auth/register', {
      body: { username: 'smoke', password: 'smoke-pass-1' }, auth: false,
    });
    assert.equal(registered.status, 201);
    cookie = sessionCookieFrom(registered);
    assert.ok(cookie, '注册未下发会话 Cookie');

    const boot = await (await call('GET', '/api/bootstrap')).json();
    assert.equal(boot.user.username, 'smoke');
    assert.ok(boot.pools.emails);
    assert.ok(Array.isArray(boot.records));

    assert.equal((await call('POST', '/api/auth/logout')).status, 200);
    assert.equal((await call('GET', '/api/bootstrap')).status, 401);
  });

  it('密码错误返回不区分原因的 401，重新登录可恢复会话', async () => {
    const rejected = await call('POST', '/api/auth/login', {
      body: { username: 'smoke', password: 'wrong-password' }, auth: false,
    });
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error, '用户名或密码不正确');

    const login = await call('POST', '/api/auth/login', {
      body: { username: 'smoke', password: 'smoke-pass-1' }, auth: false,
    });
    assert.equal(login.status, 200);
    cookie = sessionCookieFrom(login);
    assert.ok(cookie, '登录未下发会话 Cookie');
    assert.equal((await call('GET', '/api/bootstrap')).status, 200);
  });
});

describe('个人备份与恢复', () => {
  const restore = (payload) => call('POST', '/api/backup/restore', { body: payload });
  const emails = async () => (await (await call('GET', '/api/bootstrap')).json()).pools.emails;
  let backup = null;

  it('备份以附件形式导出，且只含本人数据', async () => {
    const imported = await call('POST', '/api/import/emails', {
      body: { items: [{ user: 'backup@example.com', pass: 'p' }] },
    });
    assert.equal(imported.status, 200);

    const response = await call('GET', '/api/backup');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') || '', /attachment/);
    backup = await response.text();
    const parsed = JSON.parse(backup);
    assert.equal(parsed.emails.length, 1);
    assert.equal(parsed.account, 'smoke');
  });

  it('删除后可以完整恢复回来', async () => {
    const [target] = await emails();
    assert.equal((await call('DELETE', `/api/pool/emails/${target.id}`)).status, 200);
    assert.equal((await emails()).length, 0);

    const response = await restore(JSON.parse(backup));
    assert.equal(response.status, 200);
    const restored = await emails();
    assert.equal(restored.length, 1);
    assert.equal(restored[0].user, 'backup@example.com');
  });

  it('非法备份被拒绝（400）且现有数据一个字节都不动', async () => {
    const response = await restore({ records: [{ id: 'not-a-number' }] });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /备份文件无法恢复/);
    assert.equal((await emails()).length, 1);
  });

  it('重复体检可扫描全体成员并返回分组', async () => {
    const report = await (await call('GET', '/api/licenses/duplicates')).json();
    assert.equal(report.scope, 'global');
    assert.equal(typeof report.scanned, 'number');
    assert.ok(Array.isArray(report.groups));
  });
});
