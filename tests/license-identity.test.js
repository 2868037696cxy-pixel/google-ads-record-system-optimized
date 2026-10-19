'use strict';
// F04 的回归护栏：同账号导入「名称相近但注册号不同」的公司时，
// 既有执照的注册号与地址必须原样保留。
//
// 背景：审计《AdsWorkbench_Repository_Audit_0359dd6》F04（P1）称第二次导入会
// 返回 updated=1、把注册号换成新的、并把地址清空。第 36 轮用探针实测该症状在
// 当前提交上**不复现**（走 /api/import/licenses 时被 409 拦下，行未改动），
// 所以这里不写「修复前失败」的用例，而是把**实测到的正确行为**固定住，
// 防止将来重构把冲突检查挪到 `mine` 更新分支之后 —— 那样就会退化成静默覆盖。
//
// 断言写的是不变量而非具体状态码：无论走 409 还是 200+conflicts，
// 只要「没有静默接受」且「原行不变」就算通过。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-license-identity-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');
const { certificate } = require('./pdf-fixture');
let origin, cookie;

const api = async (method, route, body) => {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-workbench': '1', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let value = null;
  try { value = JSON.parse(await r.text()); } catch { /* 非 JSON */ }
  return { status: r.status, value };
};

/** 每次换 PDF 内容，避免命中「PDF 原始字节」的全局查重。 */
const upload = (marker, item) => api('POST', '/api/import/licenses', {
  pdf: certificate(['CERTIFICATE OF REGISTRATION', marker]).toString('base64'),
  filename: `${marker}.pdf`,
  items: [item],
});

const licences = async () => (await api('GET', '/api/bootstrap')).value.pools.licenses;

test.before(async () => {
  origin = await service.start({ port: 0 });
  const r = await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: 'identity', password: 'Secure-Test-1234' }),
  });
  assert.equal(r.status, 201);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('名称相近但注册号不同：拒绝入库，且既有执照资料不变', async () => {
  const first = await upload('alpha', { name: 'Example Orchid Ltd', cvr: 'AB123456', address: 'Original Road' });
  assert.equal(first.status, 200, '前提：第一张执照应能导入');
  assert.equal(first.value.added, 1, '前提：第一张应记为新增');

  // 记录基线：用深比较，而不是逐个字段手写，避免漏掉被悄悄改掉的列
  const before = (await licences());
  assert.equal(before.length, 1, `前提：库里应只有 1 张执照，实际 ${before.length}`);
  assert.equal(before[0].cvr, 'AB123456');
  assert.equal(before[0].address, 'Original Road');
  const baseline = JSON.stringify(before);

  // 名称去后缀后同为 exampleorchid、注册号不同、且不提供地址
  const second = await upload('beta', { name: 'Example Orchid LLC', cvr: 'CD654321' });

  // 不得「静默接受」。409 或 200+conflicts 都算拒绝；added/updated 为 1 则算接受。
  const accepted = second.value?.added === 1 || second.value?.updated === 1;
  assert.equal(accepted, false,
    `第二次导入被接受了（added=${second.value?.added} updated=${second.value?.updated}，status=${second.status}）—— 名称相近不能作为覆盖依据`);

  const after = JSON.stringify(await licences());
  assert.equal(after, baseline,
    `导入前后的执照资料发生了变化 —— 审计 F04 的症状（注册号被换、地址被清空）复现了。\n前：${baseline}\n后：${after}`);
});
