'use strict';

/**
 * 多用户服务器版回归：账号、数据隔离、跨用户判重、资源生命周期。
 *
 * 这些用例直接在本进程内启动服务（不走子进程），因此可以直接断言数据库行为。
 * 数据目录是临时目录，不会碰到任何真实数据。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { certificate } = require('./pdf-fixture');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-multiuser-'));
process.env.DATA_DIR = DATA_DIR;
process.env.DB_FILE = path.join(DATA_DIR, 'test.sqlite');
process.env.LOG_LEVEL = 'silent';
process.env.REGISTRATION = 'open';
// 确保不会误读仓库根目录的 data.json
process.env.DATA_FILE = path.join(DATA_DIR, 'absent.json');

const service = require('../server');

let origin = '';
const sessions = {};

test.before(async () => {
  origin = await service.start({ port: 0, host: '127.0.0.1' });
});

test.after(async () => {
  await service.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

function cookieFrom(response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const session = raw.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('wb_session='));
  return session || '';
}

async function raw(method, url, { body, cookie, headers = {} } = {}) {
  const init = { method, headers: { 'x-workbench': '1', ...headers } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (cookie) init.headers.cookie = cookie;
  const response = await fetch(origin + url, init);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, body: data, cookie: cookieFrom(response), response };
}

// 与 raw 保持同样的调用形式（选项对象），否则调用处写成 { body } 时会被当成请求体本身
const api = (who, method, url, options = {}) => raw(method, url, { ...options, cookie: sessions[who] });

async function register(who, username) {
  const res = await raw('POST', '/api/auth/register', { body: { username, password: 'secret-pass-1' } });
  assert.equal(res.status, 201, `注册 ${username} 应成功：${JSON.stringify(res.body)}`);
  sessions[who] = res.cookie;
  assert.ok(sessions[who], '注册后应下发会话 Cookie');
  return res.body.user;
}

/* ---------------- 账号 ---------------- */

test('注册后可以读取自己的身份，未登录会被拒绝', async () => {
  const user = await register('a', 'alice');
  assert.equal(user.username, 'alice');

  const me = await api('a', 'GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'alice');

  const anonymous = await raw('GET', '/api/bootstrap');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.authRequired, true);
});

test('写操作缺少来源标记头会被拒绝（CSRF 防护）', async () => {
  const res = await raw('POST', '/api/import/emails', {
    body: { items: [{ user: 'nope@example.com' }] },
    cookie: sessions.a,
    headers: { 'x-workbench': '0' },
  });
  assert.equal(res.status, 403);
});

test('登录失败不区分「用户不存在」与「密码错误」，成功后签发新会话', async () => {
  const wrongPassword = await raw('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong-pass-1' } });
  const noSuchUser = await raw('POST', '/api/auth/login', { body: { username: 'nobody', password: 'wrong-pass-1' } });
  assert.equal(wrongPassword.status, 401);
  assert.equal(noSuchUser.status, 401);
  assert.equal(wrongPassword.body.error, noSuchUser.body.error);

  const ok = await raw('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret-pass-1' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie);

  const loggedOut = await raw('POST', '/api/auth/logout', { cookie: ok.cookie });
  assert.equal(loggedOut.status, 200);
  const after = await raw('GET', '/api/auth/me', { cookie: ok.cookie });
  assert.equal(after.status, 401, '登出后原会话必须立即失效');
});

test('用户名重复会被拒绝，短密码会被拒绝', async () => {
  const dup = await raw('POST', '/api/auth/register', { body: { username: 'ALICE', password: 'secret-pass-1' } });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /已被注册/);

  const weak = await raw('POST', '/api/auth/register', { body: { username: 'weakling', password: 'short' } });
  assert.equal(weak.status, 400);
  assert.match(weak.body.error, /至少/);
});

/* ---------------- 数据隔离 ---------------- */

test('资源与记录完全按账号隔离', async () => {
  await register('b', 'bob');

  const imported = await api('a', 'POST', '/api/import/emails', {
    body: { items: [{ user: 'alice@example.com', pass: 'p1', fakey: 'k1' }] },
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.added, 1);

  const aBoot = await api('a', 'GET', '/api/bootstrap');
  const bBoot = await api('b', 'GET', '/api/bootstrap');
  assert.equal(aBoot.body.pools.emails.length, 1);
  assert.equal(bBoot.body.pools.emails.length, 0, 'bob 不应看到 alice 的邮箱');
  assert.equal(bBoot.body.records.length, 0);

  // bob 不能通过编号直接命中 alice 的资源
  const aliceEmailId = aBoot.body.pools.emails[0].id;
  const patch = await api('b', 'PATCH', `/api/pool/emails/${aliceEmailId}`, { body: { status: '停用' } });
  assert.equal(patch.status, 400);
  assert.match(patch.body.error, /不存在/);
});

test('导出只包含自己的记录', async () => {
  await api('a', 'POST', '/api/import/cards', { body: { items: [{ number: '4111111111111111', expiry: '12/28', cvv: '123' }] } });
  await api('a', 'POST', '/api/import/proxies', { body: { items: [{ host: '10.0.0.1', port: '8080', user: 'u1', pass: 'p1' }] } });
  await api('a', 'POST', '/api/import/licenses', { body: { items: [{ name: 'Alice Holding ApS', cvr: '11111111' }] } });

  const created = await api('a', 'POST', '/api/records', { body: { country: 'DK', product: 'Ads', domains: ['alice-shop.com'] } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.created.length, 1);

  const csv = await api('a', 'POST', '/api/export/csv', { body: {} });
  assert.equal(csv.status, 200);
  assert.match(csv.body.text, /alice@example\.com/);

  const bobCsv = await api('b', 'POST', '/api/export/csv', { body: {} });
  assert.equal(bobCsv.status, 400, 'bob 没有记录，导出应提示为空');
});

/* ---------------- 跨用户判重（本次改造的核心） ---------------- */

test('其他用户已导入的公司会被拒绝，并说明是谁在什么时候导入的', async () => {
  const res = await api('b', 'POST', '/api/import/licenses', {
    body: { items: [{ name: 'Alice Holding ApS', cvr: '11111111' }] },
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /alice/, '提示里应包含导入者的用户名');
  assert.match(res.body.error, /判重依据/);
  assert.equal(res.body.conflicts.length, 1);
  assert.equal(res.body.conflicts[0].owner.display_name || res.body.conflicts[0].owner.username, 'alice');

  const bBoot = await api('b', 'GET', '/api/bootstrap');
  assert.equal(bBoot.body.pools.licenses.length, 0, '重复的营业执照不能落库');
});

test('判重忽略大小写、空格与公司后缀', async () => {
  for (const name of ['alice holding', 'ALICE  HOLDING   APS', 'Alice Holding A/S']) {
    const res = await api('b', 'POST', '/api/import/licenses', { body: { items: [{ name }] } });
    assert.equal(res.status, 409, `"${name}" 应被判为重复`);
  }
});

test('CVR 相同即判重（即使公司名不同）', async () => {
  const res = await api('b', 'POST', '/api/import/licenses', {
    body: { items: [{ name: 'Totally Different Name ApS', cvr: 'DK-11111111' }] },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /CVR/);
});

test('地址相同即判重', async () => {
  const first = await api('a', 'POST', '/api/import/licenses', {
    body: { items: [{ name: 'Address Test One ApS', address: 'Følfodvej 1, 9310 Vodskov', cvr: '22222222' }] },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const second = await api('b', 'POST', '/api/import/licenses', {
    body: { items: [{ name: 'Address Test Two ApS', address: 'Folfodvej 1 9310 Vodskov', cvr: '33333333' }] },
  });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /地址/);
});

test('批量导入中只要有一条全局重复，整批拒绝并列出原因', async () => {
  const res = await api('b', 'POST', '/api/import/licenses', {
    body: {
      items: [
        { name: 'Brand New Company ApS', cvr: '44444444' },
        { name: 'Alice Holding ApS', cvr: '99999999' },
      ],
    },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /导入已取消/);
  const bBoot = await api('b', 'GET', '/api/bootstrap');
  assert.equal(bBoot.body.pools.licenses.length, 0, '整批都不应落库');
});

test('同一账号自己重复导入同一家公司只更新，不报错', async () => {
  const res = await api('a', 'POST', '/api/import/licenses', {
    body: { items: [{ name: 'Alice Holding ApS', cvr: '11111111', city: 'Aalborg' }] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const boot = await api('a', 'GET', '/api/bootstrap');
  const matched = boot.body.pools.licenses.filter((l) => /alice holding/i.test(l.name));
  assert.equal(matched.length, 1);
  assert.equal(matched[0].city, 'Aalborg');
});

/* ---------------- 资源生命周期 ---------------- */

test('创建记录会占用资源，删除记录会释放资源', async () => {
  const before = await api('a', 'GET', '/api/bootstrap');
  const record = before.body.records[0];
  assert.ok(record, 'alice 应已有一条记录');

  const del = await api('a', 'DELETE', `/api/records/${record.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, 1);

  const after = await api('a', 'GET', '/api/bootstrap');
  for (const kind of ['emails', 'cards', 'licenses']) {
    const used = after.body.pools[kind].filter((x) => x.status === '已使用');
    assert.equal(used.length, 0, `${kind} 应全部释放`);
  }
});

/* ---------------- 附件与全局体检 ---------------- */

test('PDF 原件跨用户不受影响，附件清理是全局判断', async () => {
  const pdf = certificate().toString('base64');
  const imported = await api('a', 'POST', '/api/import/licenses', {
    body: { pdf, filename: 'alice-cert.pdf', items: [{ name: 'PDF Owner ApS', legal_name: 'PDF Owner ApS', cvr: '55555555' }] },
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const licenseId = imported.body.license_id;

  const download = await api('a', 'GET', `/api/licenses/${licenseId}/pdf`);
  assert.equal(download.status, 200);

  // bob 做一次会触发附件清理的操作：他删掉自己刚导入的资源
  await api('b', 'POST', '/api/import/emails', { body: { items: [{ user: 'bob@example.com' }] } });
  const bBoot = await api('b', 'GET', '/api/bootstrap');
  await api('b', 'DELETE', `/api/pool/emails/${bBoot.body.pools.emails[0].id}`);

  const stillThere = await api('a', 'GET', `/api/licenses/${licenseId}/pdf`);
  assert.equal(stillThere.status, 200, 'bob 的操作不得删掉 alice 的附件');

  const bobAccess = await api('b', 'GET', `/api/licenses/${licenseId}/pdf`);
  assert.equal(bobAccess.status, 404, 'bob 不能下载 alice 的附件');
});

test('全体成员重复体检能发现存量重复', async () => {
  const empty = await api('a', 'GET', '/api/licenses/duplicates');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.scope, 'global');
  assert.equal(empty.body.groups.length, 0, '正常情况下不应有重复');

  // 直接写入一条只靠地址重复的历史数据，模拟旧数据迁移后的情形
  const db = service.db;
  const ownerId = empty.body.users ? db.prepare('SELECT id FROM users WHERE username = ?').get('alice').id : null;
  db.prepare(`INSERT INTO licenses (owner_id, status, created_at, name, legal_name, address, dup_addr)
              VALUES (?, '未使用', '2026-01-01 00:00:00', 'Legacy One', 'Legacy One', 'Legacy Road 1', 'legacy road 1')`)
    .run(ownerId);
  db.prepare(`INSERT INTO licenses (owner_id, status, created_at, name, legal_name, address, dup_addr)
              VALUES (?, '未使用', '2026-01-01 00:00:00', 'Legacy Two', 'Legacy Two', 'Legacy Road 1', 'legacy road 1')`)
    .run(ownerId);

  const report = await api('a', 'GET', '/api/licenses/duplicates');
  assert.equal(report.status, 200);
  const addressGroup = report.body.groups.find((g) => g.field === 'address');
  assert.ok(addressGroup, '应报告地址重复组');
  assert.equal(addressGroup.members.length, 2);
  assert.ok(report.body.duplicate_licenses >= 2);
});
