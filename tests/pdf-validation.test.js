'use strict';
// 审计 F09（P1，已复现·HTTP）：最终 PDF 入库仅验文件头，可以存入无效原件。
//
// 原实现只比对前 5 字节 "%PDF-"，所以 "%PDF-" 后面跟任意垃圾都被当作有效原件
// 收进库。等到有人点开才发现打不开时，它已经被当成凭证存下来了。
//
// 现在额外要求在末尾 1 KB 内出现 %%EOF（真实 PDF 必有，阅读器据此判断完整性）。
// 本用例同时验「挡得住」和「不误伤」——只堵不疏会把正常上传一起堵死。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pdfvalid-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');
const { certificate } = require('./pdf-fixture');
let origin, cookie;

const upload = async (bytes, filename) => {
  const r = await fetch(origin + '/api/import/licenses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench': '1', cookie },
    body: JSON.stringify({
      pdf: Buffer.from(bytes).toString('base64'),
      filename,
      items: [{ name: 'Example ApS', cvr: 'DK99999999' }],
    }),
  });
  const text = await r.text();
  let value = null; try { value = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, value, text };
};

test.before(async () => {
  origin = await service.start({ port: 0 });
  const r = await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: 'pdfvalid', password: 'Secure-Test-1234' }),
  });
  assert.equal(r.status, 201);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('只有文件头、没有 %%EOF 的伪 PDF 不得入库', async () => {
  // 前提：这正是旧实现会放过的形态
  const fake = Buffer.from('%PDF-1.4\nthis is not a pdf at all\n');
  assert.equal(fake.subarray(0, 5).toString(), '%PDF-', '前提：伪装件必须带正确文件头，否则测的就不是 F09');
  assert.ok(!fake.toString().includes('%%EOF'), '前提：伪装件必须缺少 %%EOF');

  const res = await upload(fake, 'fake.pdf');
  assert.equal(res.status, 400,
    `伪 PDF 返回 ${res.status} —— 旧实现返回 200 并把它当作有效原件收下（审计 F09）`);
  assert.match(res.value?.error ?? '', /不完整|EOF/, `拒绝理由不明确：${res.text.slice(0, 120)}`);

  // 前提校验：确认它确实没被存进去，否则「返回 400」可能只是表面拒绝
  const boot = await (await fetch(`${origin}/api/bootstrap`, { headers: { cookie, 'x-workbench': '1' } })).json();
  assert.equal(boot.pools.licenses.length, 0, `伪 PDF 被存进了库（执照数 ${boot.pools.licenses.length}）`);
});

test('截断的真实 PDF（尾部被切掉）同样拒绝', async () => {
  const real = certificate(['CERTIFICATE OF REGISTRATION', 'Truncated ApS']);
  const truncated = real.subarray(0, real.length - 12); // 切掉 %%EOF 一带
  const res = await upload(truncated, 'truncated.pdf');
  assert.equal(res.status, 400, `截断 PDF 返回 ${res.status}，应拒绝`);
});

test('结构完整的 PDF 仍然正常入库 —— 不能只堵不疏', async () => {
  const real = certificate(['CERTIFICATE OF REGISTRATION', 'Valid ApS']);
  const res = await upload(real, 'valid.pdf');
  assert.equal(res.status, 200, `正常 PDF 返回 ${res.status}，修复不应误伤真实上传`);
  assert.equal(res.value.added, 1, `正常 PDF 应记为新增，实际 ${JSON.stringify(res.value?.added)}`);

  const boot = await (await fetch(`${origin}/api/bootstrap`, { headers: { cookie, 'x-workbench': '1' } })).json();
  assert.equal(boot.pools.licenses.length, 1, `执照数应为 1，实际 ${boot.pools.licenses.length}`);
});
