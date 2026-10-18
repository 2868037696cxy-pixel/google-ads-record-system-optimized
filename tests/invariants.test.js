'use strict';

/**
 * 行为不变量回归：断言服务器版（SQLite + 多用户）的真实行为，替代已经消失的
 * data.json 存储模型用例（原 tests/workbench.test.js）。
 *
 * 顶部的辅助代码（临时目录、启动服务、Cookie、raw/api）是从 tests/multiuser.test.js
 * 复制过来的 —— 有意重复，不做「公共 harness」抽取，避免互相牵动。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { certificate } = require('./pdf-fixture');
const { validateSnapshot } = require('../lib/storage');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-invariants-'));
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

/* ---------------- 本文件专用的资料准备辅助 ---------------- */

let uniq = 0;

/**
 * 导入 n 组互不重复的邮箱 / 信用卡 / 营业执照，返回它们在库里的 id。
 * 创建记录时显式指定这些 id，避免被资料库里已「已使用」的历史资源影响
 * （pickPool 在「池子非空但可用数不足」时会直接报错）。
 */
async function seed(n = 1, tag = 'seed') {
  const items = { emails: [], cards: [], licenses: [] };
  for (let i = 0; i < n; i++) {
    const k = ++uniq;
    items.emails.push({ user: `${tag}-${k}@example.com`, pass: `pw-${k}`, fakey: '' });
    items.cards.push({ number: String(4000000000000 + k), expiry: '12/28', cvv: String(100 + (k % 800)) });
    items.licenses.push({ name: `${tag} Company ${k} ApS`, cvr: String(71000000 + k) });
  }
  for (const kind of ['emails', 'cards', 'licenses']) {
    const res = await api('a', 'POST', `/api/import/${kind}`, { body: { items: items[kind] } });
    assert.equal(res.status, 200, `导入 ${kind} 失败：${JSON.stringify(res.body)}`);
  }
  const boot = (await api('a', 'GET', '/api/bootstrap')).body;
  const find = {
    emails: (x) => boot.pools.emails.find((r) => r.user === x.user),
    cards: (x) => boot.pools.cards.find((r) => r.number === x.number),
    licenses: (x) => boot.pools.licenses.find((r) => r.name === x.name),
  };
  const out = { emailIds: [], cardIds: [], licenseIds: [], emails: [], cards: [], licenses: [] };
  for (const kind of ['emails', 'cards', 'licenses']) {
    const rows = items[kind].map(find[kind]);
    rows.forEach((row, i) => assert.ok(row, `${kind} 未落库：${JSON.stringify(items[kind][i])}`));
    out[kind] = rows;
  }
  out.emailIds = out.emails.map((r) => r.id);
  out.cardIds = out.cards.map((r) => r.id);
  out.licenseIds = out.licenses.map((r) => r.id);
  return out;
}

/** 用刚备好的资源建记录：默认不挂代理，资源 id 显式给全。 */
function recordBody(body, resources) {
  return {
    proxy_mode: 'none',
    ...body,
    email_ids: body.email_ids ?? resources.emailIds,
    card_ids: body.card_ids ?? resources.cardIds,
    license_ids: body.license_ids ?? resources.licenseIds,
  };
}

const encode = (value) => JSON.stringify(value);

/* ---------------- 记录创建的不变量 ---------------- */

test('重复指纹会拒绝整批记录，且不消耗任何资源', async () => {
  await register('a', 'invariants');
  const res = await seed(3, 'fp');

  const first = await api('a', 'POST', '/api/records', {
    body: recordBody({ domains: ['fp-first.example'], fp_prefix: 'fptest', start_seq: 1 }, {
      emailIds: [res.emailIds[0]], cardIds: [res.cardIds[0]], licenseIds: [res.licenseIds[0]],
    }),
  });
  assert.equal(first.status, 200, encode(first.body));
  assert.equal(first.body.created.length, 1);

  const before = (await api('a', 'GET', '/api/bootstrap')).body;
  // 同一个起始编号 → 指纹 fptest1 已存在，整批（2 条）拒绝
  const second = await api('a', 'POST', '/api/records', {
    body: recordBody({ domains: ['fp-second.example', 'fp-third.example'], fp_prefix: 'fptest', start_seq: 1 }, {
      emailIds: res.emailIds.slice(1), cardIds: res.cardIds.slice(1), licenseIds: res.licenseIds.slice(1),
    }),
  });
  assert.equal(second.status, 400, encode(second.body));
  assert.match(second.body.error, /指纹名称已存在/);

  const after = (await api('a', 'GET', '/api/bootstrap')).body;
  assert.equal(after.records.length, before.records.length, '被拒绝的批次不得写入任何记录');
  assert.deepEqual(
    after.pools.emails.map((e) => [e.id, e.status]),
    before.pools.emails.map((e) => [e.id, e.status]),
    '被拒绝的批次不得消耗任何资源',
  );
  assert.equal(
    after.pools.emails.filter((e) => e.status === '未使用').length,
    before.pools.emails.filter((e) => e.status === '未使用').length,
  );
});

test('被记录占用的资源不能再被别的记录选用、不能删除、不能标记为未使用', async () => {
  const res = await seed(1, 'occupied');
  const email = res.emails[0];

  const created = await api('a', 'POST', '/api/records', {
    body: recordBody({ domains: ['occupied.example'], email_ids: [email.id] }, {
      cardIds: [res.cardIds[0]], licenseIds: [res.licenseIds[0]],
    }),
  });
  assert.equal(created.status, 200, encode(created.body));

  const boot1 = (await api('a', 'GET', '/api/bootstrap')).body;
  const countBefore = boot1.records.length;
  assert.equal(boot1.pools.emails.find((e) => e.id === email.id).status, '已使用');

  // 不能再被别的记录选用
  const again = await api('a', 'POST', '/api/records', {
    body: { domains: ['occupied-again.example'], email_ids: [email.id], proxy_mode: 'none' },
  });
  assert.equal(again.status, 400, encode(again.body));
  assert.match(again.body.error, /可用邮箱/);

  // 不能删除
  const removed = await api('a', 'DELETE', `/api/pool/emails/${email.id}`);
  assert.equal(removed.status, 400, encode(removed.body));
  assert.match(removed.body.error, /仍关联记录/);

  // 不能标记为「未使用」
  const freed = await api('a', 'PATCH', `/api/pool/emails/${email.id}`, { body: { status: '未使用' } });
  assert.equal(freed.status, 400, encode(freed.body));
  assert.match(freed.body.error, /不能标记为未使用/);

  // 其余类型（信用卡 / 营业执照）走同一套判断，同样不能删除或释放
  for (const [kind, id] of [['cards', res.cardIds[0]], ['licenses', res.licenseIds[0]]]) {
    const del = await api('a', 'DELETE', `/api/pool/${kind}/${id}`);
    assert.equal(del.status, 400, `${kind} 被占用时不能删除：${encode(del.body)}`);
    assert.match(del.body.error, /仍关联记录/);
    const free = await api('a', 'PATCH', `/api/pool/${kind}/${id}`, { body: { status: '未使用' } });
    assert.equal(free.status, 400, `${kind} 被占用时不能标记为未使用：${encode(free.body)}`);
    assert.match(free.body.error, /不能标记为未使用/);
  }

  const boot2 = (await api('a', 'GET', '/api/bootstrap')).body;
  assert.equal(boot2.records.length, countBefore, '失败的选用不得留下部分写入');
  assert.equal(boot2.pools.emails.find((e) => e.id === email.id).status, '已使用');
  assert.equal(boot2.pools.cards.find((c) => c.id === res.cardIds[0]).status, '已使用');
  assert.equal(boot2.pools.licenses.find((l) => l.id === res.licenseIds[0]).status, '已使用');
});

test('批次超过 500 条或域名列表内有重复都会被拒绝', async () => {
  const before = (await api('a', 'GET', '/api/bootstrap')).body;

  const tooMany = await api('a', 'POST', '/api/records', {
    body: { domains: Array.from({ length: 501 }, (_, i) => `many-${i}.example`) },
  });
  assert.equal(tooMany.status, 400, encode(tooMany.body));
  assert.match(tooMany.body.error, /最多创建 500 条/);

  const duplicated = await api('a', 'POST', '/api/records', {
    body: { domains: ['dup-domain.example', 'dup-domain.example'] },
  });
  assert.equal(duplicated.status, 400, encode(duplicated.body));
  assert.match(duplicated.body.error, /域名列表存在重复/);

  // 归一化（去协议、转小写）之后重复，同样拒绝
  const normalized = await api('a', 'POST', '/api/records', {
    body: { domains: ['Dup-Domain.Example', 'https://dup-domain.example/path'] },
  });
  assert.equal(normalized.status, 400, encode(normalized.body));
  assert.match(normalized.body.error, /域名列表存在重复/);

  const after = (await api('a', 'GET', '/api/bootstrap')).body;
  assert.equal(after.records.length, before.records.length);
  assert.deepEqual(after.pools.emails.map((e) => e.status), before.pools.emails.map((e) => e.status));
});

test('畸形的数量与资源编号会被拒绝，且没有部分写入', async () => {
  const countBefore = (await api('a', 'GET', '/api/bootstrap')).body.records.length;

  for (const count of [501, 0, -1, 1.5, '2invalid', true, {}]) {
    const res = await api('a', 'POST', '/api/records', { body: { count } });
    assert.equal(res.status, 400, `count=${encode(count)} 应被拒绝：${encode(res.body)}`);
  }

  const res = await seed(1, 'malformed');
  for (const emailIds of ['nope', 42, {}, true, [1.5], [0], [-1], ['1']]) {
    const bad = await api('a', 'POST', '/api/records', {
      body: { domains: [`bad-select-${++uniq}.example`], email_ids: emailIds },
    });
    assert.equal(bad.status, 400, `email_ids=${encode(emailIds)} 应被拒绝：${encode(bad.body)}`);
  }

  const created = await api('a', 'POST', '/api/records', {
    body: recordBody({ domains: ['malformed.example'], country: '丹麦', card_ids: [res.cardIds[0]] }, {
      emailIds: [res.emailIds[0]], licenseIds: [res.licenseIds[0]],
    }),
  });
  assert.equal(created.status, 200, encode(created.body));
  const recordId = created.body.created[0].id;

  for (const cardId of [true, [], {}, '1invalid', 1.5, 0, -1]) {
    const patch = await api('a', 'PATCH', `/api/records/${recordId}`, {
      body: { card_id: cardId, country: '必须不变' },
    });
    assert.equal(patch.status, 400, `card_id=${encode(cardId)} 应被拒绝：${encode(patch.body)}`);
  }

  const after = (await api('a', 'GET', '/api/bootstrap')).body;
  assert.equal(after.records.length, countBefore + 1, '被拒绝的请求不得写入任何记录');
  const record = after.records.find((r) => r.id === recordId);
  assert.equal(record.country, '丹麦', '被拒绝的编辑不得改动记录字段');
  assert.equal(record.card_id, res.cardIds[0]);
  assert.equal(after.pools.cards.find((c) => c.id === res.cardIds[0]).status, '已使用');
});

test('共享代理要等最后一条记录删除后才释放', async () => {
  const proxyRes = await api('a', 'POST', '/api/import/proxies', {
    body: { items: [{ host: 'shared.proxy.example', port: '1080', user: 'shared' }] },
  });
  assert.equal(proxyRes.status, 200, encode(proxyRes.body));
  const boot = (await api('a', 'GET', '/api/bootstrap')).body;
  const proxy = boot.pools.proxies.find((p) => p.host === 'shared.proxy.example');
  assert.ok(proxy);

  const res = await seed(2, 'sharedproxy');
  const created = await api('a', 'POST', '/api/records', {
    body: recordBody({
      domains: ['shared-a.example', 'shared-b.example'], proxy_mode: 'shared', proxy_id: proxy.id,
    }, res),
  });
  assert.equal(created.status, 200, encode(created.body));
  assert.equal(created.body.created.length, 2);
  for (const record of created.body.created) assert.equal(record.proxy_id, proxy.id);

  const [first, second] = created.body.created.map((r) => r.id);
  assert.equal((await api('a', 'DELETE', `/api/records/${first}`)).status, 200);
  const half = (await api('a', 'GET', '/api/bootstrap')).body.pools.proxies.find((p) => p.id === proxy.id);
  assert.equal(half.status, '已使用', '还有一条记录在用，代理不能释放');

  assert.equal((await api('a', 'DELETE', `/api/records/${second}`)).status, 200);
  const released = (await api('a', 'GET', '/api/bootstrap')).body.pools.proxies.find((p) => p.id === proxy.id);
  assert.equal(released.status, '未使用', '最后一条记录删除后才释放');
});

/* ---------------- 资料池编辑 ---------------- */

test('编辑资源时重复值被拒绝，正常改名会同步到记录的导出快照', async () => {
  const res = await seed(2, 'edit');

  // 把第二条邮箱改成与第一条重复（大小写不同）→ 拒绝
  const dup = await api('a', 'PATCH', `/api/pool/emails/${res.emails[1].id}`, {
    body: { user: res.emails[0].user.toUpperCase() },
  });
  assert.equal(dup.status, 400, encode(dup.body));
  assert.match(dup.body.error, /重复/);
  const stillThere = (await api('a', 'GET', '/api/bootstrap')).body.pools.emails
    .find((e) => e.id === res.emails[1].id);
  assert.equal(stillThere.user, res.emails[1].user, '被拒绝的编辑不得改动资源');

  const created = await api('a', 'POST', '/api/records', {
    body: recordBody({ domains: ['edit.example'] }, {
      emailIds: [res.emails[0].id], cardIds: [res.cards[0].id], licenseIds: [res.licenses[0].id],
    }),
  });
  assert.equal(created.status, 200, encode(created.body));
  const recordId = created.body.created[0].id;

  // 正常改名（不重复）→ 200
  const renamedEmail = await api('a', 'PATCH', `/api/pool/emails/${res.emails[0].id}`, {
    body: { pass: 'new-email-pass' },
  });
  assert.equal(renamedEmail.status, 200, encode(renamedEmail.body));
  const newName = `Renamed Company ${++uniq} ApS`;
  const renamedLicense = await api('a', 'PATCH', `/api/pool/licenses/${res.licenses[0].id}`, {
    body: { name: newName },
  });
  assert.equal(renamedLicense.status, 200, encode(renamedLicense.body));

  const record = (await api('a', 'GET', '/api/bootstrap')).body.records.find((r) => r.id === recordId);
  assert.equal(record.email_pass, 'new-email-pass', '改名应同步到记录快照');
  assert.equal(record.license_name, newName, '改名应同步到记录快照');

  // 导出用的就是快照字段
  const csv = await api('a', 'POST', '/api/export/csv', { body: { ids: [recordId] } });
  assert.equal(csv.status, 200, encode(csv.body));
  assert.ok(csv.body.text.includes('new-email-pass'));
  assert.ok(csv.body.text.includes(newName));
  const adspower = await api('a', 'POST', '/api/export/adspower', { body: { ids: [recordId] } });
  assert.equal(adspower.status, 200, encode(adspower.body));
  assert.ok(adspower.body.text.includes('password=new-email-pass\n'));
});

/* ---------------- 导出 ---------------- */

test('CSV 导出会给公式型取值加前缀，并保留长卡号与零开头的 CVV', async () => {
  const special = await api('a', 'POST', '/api/import/cards', {
    body: { items: [{ number: '4367970152619097', expiry: '06/29', cvv: '007' }] },
  });
  assert.equal(special.status, 200, encode(special.body));
  const specialCard = (await api('a', 'GET', '/api/bootstrap')).body.pools.cards
    .find((c) => c.number === '4367970152619097');
  assert.ok(specialCard, '特殊卡号应已落库');

  const res = await seed(4, 'csv');
  const formulas = ['=1+1', '+1+1', '-1-1', '@SUM(A1)'];
  const ids = [];
  for (let i = 0; i < formulas.length; i++) {
    const created = await api('a', 'POST', '/api/records', {
      body: recordBody({ domains: [`csv-${++uniq}.example`], id_card: formulas[i] }, {
        emailIds: [res.emailIds[i]],
        cardIds: [i === 0 ? specialCard.id : res.cardIds[i]],
        licenseIds: [res.licenseIds[i]],
      }),
    });
    assert.equal(created.status, 200, encode(created.body));
    ids.push(created.body.created[0].id);
  }

  const csv = await api('a', 'POST', '/api/export/csv', { body: { ids } });
  assert.equal(csv.status, 200, encode(csv.body));
  const text = csv.body.text;
  for (const formula of formulas) {
    assert.ok(text.includes(`'${formula}`), `以 ${formula[0]} 开头的值应加上 ' 前缀`);
  }
  assert.ok(text.includes("'4367970152619097"), '长卡号应加前缀，避免被当成数字');
  assert.ok(text.includes("'007"), '零开头的 CVV 应加前缀');
  assert.ok(!text.includes('E+'), '导出文本里不应出现科学计数法');
});

test('AdsPower 导出会转义字段里的换行，不会多出注入行', async () => {
  const res = await seed(1, 'adspower');
  const injected = 'secret\nname=injected';
  const patched = await api('a', 'PATCH', `/api/pool/emails/${res.emails[0].id}`, { body: { pass: injected } });
  assert.equal(patched.status, 200, encode(patched.body));

  const created = await api('a', 'POST', '/api/records', {
    body: recordBody({ domains: ['adspower.example'], email_ids: [res.emails[0].id] }, {
      cardIds: [res.cardIds[0]], licenseIds: [res.licenseIds[0]],
    }),
  });
  assert.equal(created.status, 200, encode(created.body));

  const exported = await api('a', 'POST', '/api/export/adspower', { body: { ids: [created.body.created[0].id] } });
  assert.equal(exported.status, 200, encode(exported.body));
  const lines = exported.body.text.split('\n');
  assert.equal(lines.filter((line) => line.startsWith('name=')).length, 1, '不得多出 name= 行');
  assert.equal(lines.filter((line) => line.trim() === 'name=injected').length, 0, '换行不能被当成新字段行');
  assert.ok(lines.includes('password=secret name=injected'), '换行应被替换为空格写在同一行');
  assert.equal(lines.filter(Boolean).length, 19, '一条记录仍应正好是 19 行字段');
});

/* ---------------- 营业执照导入 ---------------- */

test('没有 PDF 的营业执照也能手动填写导入', async () => {
  const name = `Manual License ${++uniq} ApS`;
  const imported = await api('a', 'POST', '/api/import/licenses', {
    body: {
      items: [{
        name, legal_name: name, address: `Manual Road ${uniq}`, apt: '', zip: '9310', city: 'Vodskov',
        type: '组织', cvr: String(72000000 + uniq),
      }],
    },
  });
  assert.equal(imported.status, 200, encode(imported.body));
  assert.equal(imported.body.added, 1);

  const boot = (await api('a', 'GET', '/api/bootstrap')).body;
  const row = boot.pools.licenses.find((l) => l.name === name);
  assert.ok(row, '手动填写的营业执照应落库');
  assert.equal(row.status, '未使用');
  assert.ok(!row.document_id, '手动填写不应关联任何 PDF 原件');

  const download = await api('a', 'GET', `/api/licenses/${row.id}/pdf`);
  assert.equal(download.status, 404, '没有 PDF 时下载应返回 404');
});

test('一个 PDF 只能对应一份营业执照，items 传两条会被拒绝', async () => {
  const pdf = certificate().toString('base64');
  const licensesBefore = (await api('a', 'GET', '/api/bootstrap')).body.pools.licenses.length;

  const rejected = await api('a', 'POST', '/api/import/licenses', {
    body: {
      pdf, filename: 'two.pdf',
      items: [{ name: `Pdf First ${++uniq} ApS` }, { name: `Pdf Second ${++uniq} ApS` }],
    },
  });
  assert.equal(rejected.status, 400, encode(rejected.body));
  assert.match(rejected.body.error, /一个 PDF 请对应一份营业执照/);

  const after = (await api('a', 'GET', '/api/bootstrap')).body;
  assert.equal(after.pools.licenses.length, licensesBefore, '被拒绝时不得落库');
  assert.equal(after.pools.licenses.filter((l) => l.document_id).length, 0);

  // 单条 + 同一个 PDF 则成功，并且原件可下载
  const name = `Pdf Single ${++uniq} ApS`;
  const imported = await api('a', 'POST', '/api/import/licenses', {
    body: { pdf, filename: 'one.pdf', items: [{ name }] },
  });
  assert.equal(imported.status, 200, encode(imported.body));
  assert.equal(imported.body.added, 1);
  assert.equal(imported.body.attached, 1);
  const download = await api('a', 'GET', `/api/licenses/${imported.body.license_id}/pdf`);
  assert.equal(download.status, 200);
});

/* ---------------- 直接单元测试：快照校验（不启动服务） ---------------- */

test('validateSnapshot 拒绝悬空引用、重复分配与缺失 PDF', () => {
  const base = {
    counters: {},
    documents: {},
    emails: [{ id: 1, user: 'snap@example.com', pass: '', fakey: '', status: '未使用' }],
    proxies: [],
    cards: [],
    licenses: [],
    records: [{ id: 1, fingerprint: 'snap1', email_id: 1 }],
  };

  const validated = validateSnapshot(base);
  assert.equal(validated.emails[0].status, '已使用', '被记录占用的资源在校验后应标记为已使用');
  assert.equal(base.emails[0].status, '未使用', '校验不得改动调用方传入的对象');

  assert.throws(
    () => validateSnapshot({ ...base, records: [{ id: 1, fingerprint: 'snap1', email_id: 999 }] }),
    /资源不存在/,
  );
  assert.throws(
    () => validateSnapshot({
      ...base,
      records: [{ id: 1, fingerprint: 'snap1', email_id: 1 }, { id: 2, fingerprint: 'snap2', email_id: 1 }],
    }),
    /多条记录占用/,
  );
  assert.throws(
    () => validateSnapshot({ ...base, records: [{ id: 1, fingerprint: 'snap1' }, { id: 2, fingerprint: 'snap1' }] }),
    /重复指纹/,
  );
  assert.throws(
    () => validateSnapshot({ ...base, licenses: [{ id: 1, name: 'Ghost ApS', document_id: 'a'.repeat(64) }] }),
    /原 PDF 缺失/,
  );
});

test('损坏或非法的快照不会被接受', () => {
  assert.throws(() => validateSnapshot(null), /格式不正确/);
  assert.throws(() => validateSnapshot('{corrupted'), /格式不正确/);
  assert.throws(() => validateSnapshot([]), /格式不正确/);
  assert.throws(() => validateSnapshot({ records: [] }), /缺少 emails 列表/);
  assert.throws(
    () => validateSnapshot({ emails: [{ id: 0 }], proxies: [], cards: [], licenses: [], records: [] }),
    /无效或重复编号/,
  );
  assert.throws(
    () => validateSnapshot({ emails: [{ id: 1 }, { id: 1 }], proxies: [], cards: [], licenses: [], records: [] }),
    /无效或重复编号/,
  );
  assert.throws(
    () => validateSnapshot({ emails: [], proxies: [], cards: [], licenses: [], records: [], documents: [] }),
    /PDF 附件列表格式不正确/,
  );
  assert.throws(
    () => validateSnapshot({
      emails: [], proxies: [], cards: [], licenses: [], records: [],
      documents: {
        ['b'.repeat(64)]: { base64: Buffer.from('%PDF-1.4 fake\n%%EOF').toString('base64'), filename: 'fake.pdf' },
      },
    }),
    /PDF 附件校验失败/,
  );
});
