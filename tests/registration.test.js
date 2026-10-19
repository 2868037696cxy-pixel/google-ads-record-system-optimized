'use strict';
// 注册策略与口令校验：REGISTRATION=open|invite|closed 必须真的被执行。
// 这些是模块级常量，所以每种策略都要清缓存后重新加载 server.js。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const SERVER = require.resolve('../server');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 以给定的注册策略启动一个隔离实例，跑完即关闭并清理。 */
async function withPolicy(setup, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-reg-'));
  Object.assign(process.env, {
    DATA_DIR: directory,
    DB_FILE: path.join(directory, 'workbench.sqlite'),
    DATA_FILE: path.join(directory, 'absent.json'),
    LOG_LEVEL: 'silent',
    ...setup,
  });
  delete require.cache[SERVER];
  const service = require('../server');
  const origin = await service.start({ port: 0, host: '127.0.0.1' });
  try {
    return await run(origin);
  } finally {
    await service.close();
    await sleep(120);
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* 句柄释放有延迟，交给系统清理临时目录 */ }
  }
}

const register = (origin, body) => fetch(origin + '/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-workbench': '1' },
  body: JSON.stringify(body),
});

const configOf = async (origin) => (await fetch(origin + '/api/auth/config')).json();

describe('注册策略', () => {
  it('open：不设门槛，任何人都能注册', async () => {
    await withPolicy({ REGISTRATION: 'open', INVITE_CODE: '' }, async (origin) => {
      const config = await configOf(origin);
      assert.equal(config.registration, 'open');
      assert.equal(config.inviteRequired, false);
      assert.equal((await register(origin, { username: 'anyone', password: 'anyone-pass-1' })).status, 201);
    });
  });

  it('invite：无邀请码或邀请码错误都拒绝，正确才放行', async () => {
    await withPolicy({ REGISTRATION: 'invite', INVITE_CODE: 'secret-code' }, async (origin) => {
      const config = await configOf(origin);
      assert.equal(config.registration, 'invite');
      assert.equal(config.inviteRequired, true);

      assert.ok((await register(origin, { username: 'outsider1', password: 'outsider-pass-1' })).status >= 400);
      assert.ok((await register(origin, { username: 'outsider2', password: 'outsider-pass-1', invite_code: 'guessing' })).status >= 400);
      // 被拒绝的注册不能留下半个账号
      assert.equal((await fetch(origin + '/api/bootstrap')).status, 401);

      assert.equal((await register(origin, { username: 'member', password: 'member-pass-1', invite_code: 'secret-code' })).status, 201);
    });
  });

  it('closed：即使邀请码正确也拒绝注册', async () => {
    await withPolicy({ REGISTRATION: 'closed', INVITE_CODE: 'secret-code' }, async (origin) => {
      assert.equal((await configOf(origin)).registration, 'closed');
      const response = await register(origin, { username: 'later', password: 'later-pass-1', invite_code: 'secret-code' });
      assert.ok(response.status >= 400, `期望被拒绝，实际 ${response.status}`);
    });
  });
});

describe('账号校验', () => {
  it('口令过短、用户名含非法字符都被拒绝', async () => {
    await withPolicy({ REGISTRATION: 'open', INVITE_CODE: '' }, async (origin) => {
      assert.ok((await register(origin, { username: 'weak', password: 'short' })).status >= 400);
      assert.ok((await register(origin, { username: 'a b', password: 'long-enough-1' })).status >= 400);
    });
  });

  it('用户名不区分大小写地判重', async () => {
    await withPolicy({ REGISTRATION: 'open', INVITE_CODE: '' }, async (origin) => {
      assert.equal((await register(origin, { username: 'Dup', password: 'long-enough-1' })).status, 201);
      assert.ok((await register(origin, { username: 'dup', password: 'long-enough-1' })).status >= 400);
    });
  });
});
