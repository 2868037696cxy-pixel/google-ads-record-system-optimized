'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');

test('Chinese usernames, credentials and sessions across server restarts', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-account-lifecycle-'));
  const durable = path.join(root, 'preserved');
  const empty = path.join(root, 'new-filesystem');
  const password = 'Identity-Test-987!';
  let child, origin, originalCookie, originalId;

  const start = async directory => {
    child = fork(path.join(__dirname, 'fixtures/package-server.cjs'), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, DATA_DIR: directory, DB_FILE: path.join(directory, 'workbench.sqlite'), DATA_FILE: path.join(directory, 'absent.json'), PUBLIC_ORIGIN: '', ADS_SECRETS_KEY_FILE: '', REGISTRATION: 'open', SESSION_SECURE: '0', LOG_LEVEL: 'silent' },
    });
    origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('account fixture startup timed out')), 10000);
      child.once('message', message => { clearTimeout(timer); resolve(message.origin); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('account fixture exited before ready')); });
    });
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.send('close');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  const request = async (method, route, body, cookie) => {
    const response = await fetch(origin + route, {
      method,
      headers: { 'x-workbench': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, status: response.status, data: await response.json() };
  };
  const cookieFrom = response => response.headers.getSetCookie().find(value => value.startsWith('wb_session=')).split(';')[0];

  try {
    await start(durable);
    await t.test('registration advertises two to thirty-two characters and accepts Chinese, mixed and legacy ASCII names', async () => {
      const config = await request('GET', '/api/auth/config');
      assert.equal(config.data.minUsernameLength, 2);
      assert.equal(config.data.maxUsernameLength, 32);
      assert.equal(config.data.minPasswordLength, 8);
      for (const username of ['羽陌', '张三', 'ab', '12', '中A', '𠀀𠀁', '中'.repeat(32), '𠀀'.repeat(32), 'legacy_User-01']) {
        const result = await request('POST', '/api/auth/register', { username, password });
        assert.equal(result.status, 201, JSON.stringify(result.data));
        assert.equal(result.data.user.username, username);
        assert.equal((await request('GET', '/api/auth/me', undefined, cookieFrom(result.response))).data.user.username, username);
        if (username === '羽陌') {
          originalCookie = cookieFrom(result.response);
          originalId = result.data.user.id;
          assert.match(result.response.headers.get('set-cookie'), /HttpOnly.*SameSite=Lax.*Max-Age=2592000/);
        }
      }
    });

    await t.test('one character, more than thirty-two characters and unsupported symbols fail without weakening passwords', async () => {
      for (const username of ['中', 'a', '𠀀', '中'.repeat(33), '𠀀'.repeat(33), '张 三', '张🙂', '张\u200b三', '<script>', 'a/b', '中\u0301文']) {
        const result = await request('POST', '/api/auth/register', { username, password });
        assert.equal(result.status, 400, username);
        assert.match(result.data.error, /用户名/);
      }
      const shortPassword = await request('POST', '/api/auth/register', { username: '短密', password: '12' });
      assert.equal(shortPassword.status, 400);
      assert.equal(shortPassword.data.error, '密码至少 8 位');
    });

    await t.test('duplicate names are rejected and ASCII logins retain case-insensitive compatibility', async () => {
      assert.equal((await request('POST', '/api/auth/register', { username: ' 羽陌 ', password })).status, 400);
      assert.equal((await request('POST', '/api/auth/register', { username: 'AB', password })).status, 400);
      const login = await request('POST', '/api/auth/login', { username: 'AB', password });
      assert.equal(login.status, 200);
      assert.equal(login.data.user.username, 'ab');
    });

    await t.test('logout and another login with a two-character Chinese username work', async () => {
      assert.equal((await request('POST', '/api/auth/logout', {}, originalCookie)).status, 200);
      assert.equal((await request('GET', '/api/auth/me', undefined, originalCookie)).status, 401);
      const login = await request('POST', '/api/auth/login', { username: ' 羽陌 ', password });
      assert.equal(login.status, 200);
      assert.equal(login.data.user.id, originalId);
      originalCookie = cookieFrom(login.response);
      const created = await request('POST', '/api/records', { domains: ['identity.example'], proxy_mode: 'none' }, originalCookie);
      assert.equal(created.status, 200);
    });

    await t.test('a Chinese account can change its password and invalidate the previous session', async () => {
      const login = await request('POST', '/api/auth/login', { username: '张三', password });
      assert.equal(login.status, 200);
      const cookie = cookieFrom(login.response);
      const nextPassword = 'Identity-Changed-987!';
      const changed = await request('POST', '/api/account/password', { current_password: password, new_password: nextPassword }, cookie);
      assert.equal(changed.status, 200);
      assert.equal(changed.data.loginRequired, true);
      assert.equal((await request('GET', '/api/auth/me', undefined, cookie)).status, 401);
      assert.equal((await request('POST', '/api/auth/login', { username: '张三', password })).status, 401);
      assert.equal((await request('POST', '/api/auth/login', { username: '张三', password: nextPassword })).status, 200);
    });

    await t.test('preserving the database keeps the account, session and owned records after process restart', async () => {
      await stop();
      await start(durable);
      const me = await request('GET', '/api/auth/me', undefined, originalCookie);
      assert.equal(me.status, 200);
      assert.equal(me.data.user.id, originalId);
      const login = await request('POST', '/api/auth/login', { username: '羽陌', password });
      assert.equal(login.status, 200);
      assert.equal(login.data.user.id, originalId);
      const records = await request('GET', '/api/records?limit=10', undefined, cookieFrom(login.response));
      assert.equal(records.status, 200);
      assert.equal(records.data.items[0].domain, 'identity.example');
    });

    await t.test('unknown accounts and incorrect passwords keep the same non-enumerating error', async () => {
      const wrong = await request('POST', '/api/auth/login', { username: '羽陌', password: 'wrong-password' });
      const missing = await request('POST', '/api/auth/login', { username: '不存在', password });
      assert.equal(wrong.status, 401);
      assert.equal(missing.status, 401);
      assert.deepEqual(wrong.data, missing.data);
      assert.equal(wrong.data.error, '用户名或密码不正确');
    });

    await t.test('a new empty filesystem reproduces the login error; the original database still retains the account', async () => {
      await stop();
      await start(empty);
      assert.equal((await request('POST', '/api/auth/login', { username: '羽陌', password })).status, 401);
      assert.equal((await request('GET', '/api/auth/me', undefined, originalCookie)).status, 401);
      await stop();
      await start(durable);
      assert.equal((await request('POST', '/api/auth/login', { username: '羽陌', password })).status, 200);
    });
  } finally {
    await stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
