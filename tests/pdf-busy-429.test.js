'use strict';
// 审计 F17（P2）：PDF 并发繁忙被错误改写为"文件损坏"。
//
// extractPdfText 在并发超限时抛 statusCode=429「识别任务较多，请稍后重试」，
// 但 /api/parse/licenses-pdf 的 catch 只放行 statusCode===400，429 被吞掉后
// 改写成 400「PDF 解析失败，请选择可读取的 PDF」—— 服务器忙被报成"文件坏了"，
// 用户会反复重试一份其实完好的文件。
//
// 第 71 轮想靠"同时发 6 个请求"触发闸门，两次真并发都没命中（闸门要求 >=2 份
// 同时在解析，构造不出该时序）。本轮改为让上限可配置：设 0 即"暂停解析"，
// 单个请求就能确定性地走到 429 分支，不依赖任何时序巧合。
process.env.PDF_PARSE_CONCURRENCY = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-f17-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');
let origin, cookie;

test.before(async () => {
  origin = await service.start({ port: 0 });
  const r = await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: 'f17', password: 'Secure-Test-1234' }),
  });
  assert.equal(r.status, 201);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

// 一份结构最小的合法 PDF（能通过 decodePdf 的头校验与 F09 的 %%EOF 校验）
const pdf = (() => {
  const body = 'BT /F1 12 Tf 72 720 Td (Hello) Tj ET';
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    `4 0 obj<</Length ${body.length}>>stream\n${body}\nendstream endobj`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) { offsets.push(out.length); out += o + '\n'; }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
  out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
})();

const parse = async () => {
  const r = await fetch(`${origin}/api/parse/licenses-pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench': '1', cookie },
    body: JSON.stringify({ pdf: Buffer.from(pdf).toString('base64'), filename: 'busy.pdf' }),
  });
  const t = await r.text();
  let v; try { v = JSON.parse(t); } catch { v = t.slice(0, 160); }
  return { status: r.status, v };
};

test('解析繁忙时必须如实返回 429「稍后重试」，不能报成文件损坏', async () => {
  const r = await parse();
  const msg = JSON.stringify(r.v);

  assert.notEqual(r.status, 200, `解析被暂停时仍返回 200，前提不成立：${msg}`);
  assert.equal(r.status, 429,
    `应返回 429（繁忙），实际 ${r.status}：${msg} —— 若这里是 400，说明 429 被改写成了"文件损坏"（审计 F17）`);
  assert.ok(/稍后重试|识别任务/.test(msg), `429 的提示应说明"稍后重试"，实际：${msg}`);
  assert.ok(!/解析失败|损坏|可读取的 PDF/.test(msg),
    `429 被改写成了"文件损坏"类提示：${msg}`);
});
