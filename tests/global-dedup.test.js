'use strict';
// 全员查重（方案 WP03，用户强调的核心需求「要能检查到所有人的文件信息是否有重复的」）：
// 同一份营业执照被**不同账号**、以**不同文件字节**上传时，也必须被判重。
//
// 为什么专测这一点：只按文件 SHA-256 去重的话，原文件重新保存/重新导出一次字节就变了，
// 于是「同一家公司」能重复入库 —— 而按 sha256 去重看起来是"已经做了查重"的。
// 因此本用例刻意让第二份 PDF 的行内容与文件名都不同，只有 CVR 相同。
//
// 同时带一条反向断言：真正不同的营业执照必须能正常导入。
// 没有它，一个「一律返回 409」的实现也会让本用例通过。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-globaldedup-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';
process.env.DEDUP_ADDRESS_MODE = 'warn';

const service = require('../server');
const { certificate } = require('./pdf-fixture');
let origin;
const cookie = {};
const api = async (who, method, route, body) => {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-workbench': '1', cookie: cookie[who] },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let value = null;
  try { value = JSON.parse(await r.text()); } catch { /* 非 JSON */ }
  return { status: r.status, value };
};
test.before(async () => {
  origin = await service.start({ port: 0 });
  for (const who of ['firm-a', 'firm-b']) {
    const r = await fetch(`${origin}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' },
      body: JSON.stringify({ username: who, password: 'Secure-Test-1234' }),
    });
    assert.equal(r.status, 201);
    cookie[who] = r.headers.get('set-cookie').split(';')[0];
  }
});
test.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

const upload = (who, lines, filename, item) => api(who, 'POST', '/api/import/licenses', {
  pdf: certificate(lines).toString('base64'), filename, items: [item],
});

test('不同账号、不同文件字节、同一 CVR 必须跨账号判重', async () => {
  const first = await upload('firm-a',
    ['CERTIFICATE OF REGISTRATION', 'Alpha Holding ApS', 'CVR 31415926'],
    'alpha-original.pdf', { name: 'Alpha Holding ApS', cvr: '31415926' });
  assert.equal(first.status, 200, '前提：第一个账号应能成功导入');

  // 只有 CVR 相同：行内容不同、文件名不同 → 字节不同
  const second = await upload('firm-b',
    ['CERTIFICATE OF REGISTRATION', 'Alpha Holding ApS (resaved copy)', 'CVR 31415926'],
    'alpha-resaved.pdf', { name: 'Alpha Holding ApS', cvr: '31415926' });
  assert.equal(second.status, 409,
    `第二个账号上传同一 CVR 返回 ${second.status}，应为 409。若返回 200，说明查重只按文件哈希，重新保存过的同一份执照可以重复入库`);

  // 反向断言：不同的执照必须能导入，否则本用例会因为「一律判重」而假通过
  const third = await upload('firm-b',
    ['CERTIFICATE OF REGISTRATION', 'Beta Holding ApS', 'CVR 27182818'],
    'beta.pdf', { name: 'Beta Holding ApS', cvr: '27182818' });
  assert.equal(third.status, 200,
    `不同的营业执照返回 ${third.status}，应能正常导入。若被拒，说明是「一律判重」而非真正的查重`);

  // 全局落库情况：同一 CVR 只应存在一条，且不同 CVR 各一条
  const a = await api('firm-a', 'GET', '/api/bootstrap');
  const b = await api('firm-b', 'GET', '/api/bootstrap');
  const licences = [...a.value.pools.licenses, ...b.value.pools.licenses];
  assert.equal(licences.length, 2,
    `全局应只有 2 条营业执照（Alpha 一条 + Beta 一条），实际 ${licences.length} 条 —— 说明重复的 Alpha 入库了`);
});

test('判重维度与地址模式：名称相同一律硬拒，仅地址相同在 warn 模式下放行', async () => {
  // 契约取自 lib/dedup.js:53 的 chosen 链：
  //   (dup_cvr && m_cvr) || (dup_name && m_name) || (dup_legal && m_legal)
  //   || (addressMode === 'reject' && dup_addr && m_addr) || null
  // 即 CVR / 组织名称 / 法定名称在任何模式下都硬拒；地址只在 reject 模式下硬拒。
  // 本文件设的是 warn，因此「仅地址相同」应当放行，由巡检事后标出，而不是硬拒。
  const nameSameA = await upload('firm-a',
    ['CERTIFICATE OF REGISTRATION', 'Omega Holdings ApS', 'CVR 11110000'],
    'omega.pdf', { name: 'Omega Holdings ApS', cvr: '11110000' });
  assert.equal(nameSameA.status, 200, '前提：第一个 Omega 应能导入');
  const nameSameB = await upload('firm-b',
    ['CERTIFICATE OF REGISTRATION', 'Omega Holdings ApS', 'CVR 22220000'],
    'omega-resaved.pdf', { name: 'Omega Holdings ApS', cvr: '22220000' });
  assert.equal(nameSameB.status, 409,
    `组织名称相同但 CVR 不同，返回 ${nameSameB.status}，应为 409（名称维度在任何模式下都硬拒）`);

  const addrA = await upload('firm-a',
    ['CERTIFICATE OF REGISTRATION', 'Sigma Holdings ApS', 'CVR 33330000'],
    'sigma.pdf', { name: 'Sigma Holdings ApS', cvr: '33330000', address: 'Same Street 1' });
  assert.equal(addrA.status, 200, '前提：第一个 Sigma 应能导入');
  const addrB = await upload('firm-b',
    ['CERTIFICATE OF REGISTRATION', 'Tau Holdings ApS', 'CVR 44440000'],
    'tau.pdf', { name: 'Tau Holdings ApS', cvr: '44440000', address: 'Same Street 1' });
  assert.equal(addrB.status, 200,
    `仅地址相同、名称与 CVR 都不同，在 warn 模式下返回 ${addrB.status}，应为 200（放行并由巡检事后标出，而不是硬拒）`);
});
