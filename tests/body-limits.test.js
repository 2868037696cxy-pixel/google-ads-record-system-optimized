'use strict';
// 入口体积上限（方案 WP01「入口保护」）。
//
// server.js 里的上限是**分路由、有意设置**的：全局 16 MB 够放扫描件，而鉴权类路由
// 压到 4 KB 以挡住口令填充这类大体积请求，备份恢复单独放到 64 MB。
// 但这些数字此前没有任何测试锁定 —— 有人把全局改回 Fastify 默认的 1 MiB 时不会有人发现，
// 直到用户上传一张普通扫描件被 413 拒掉为止。
//
// 同时断言「上限确实被执行」：只证明配置写在那行代码上是不够的。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-limit-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');
const { certificate } = require('./pdf-fixture');
let origin, cookie;

/** 造一份大约 targetKb 大小的真实 PDF（用填充行撑开，保持可解析）。 */
const pdfOfSize = (targetKb, cvr) => {
  const lines = ['CERTIFICATE OF REGISTRATION', 'Limit Probe ApS', `CVR ${cvr}`];
  const fillers = Math.max(1, Math.round(targetKb / 1.1));
  for (let i = 0; i < fillers; i += 1) lines.push(`FILLER-${i}-` + 'X'.repeat(1000));
  return certificate(lines);
};

test.before(async () => {
  origin = await service.start({ port: 0 });
  const r = await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' },
    body: JSON.stringify({ username: 'limiter', password: 'Secure-Test-1234' }),
  });
  assert.equal(r.status, 201);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

const post = (route, body, extraHeaders = {}) => fetch(origin + route, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-workbench': '1', ...(cookie ? { cookie } : {}), ...extraHeaders },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('普通扫描件必须能上传，超限请求必须被拒', async () => {
  // (a) 约 1.8 MB 的 PDF（请求体约 2.4 MB）：远小于全局上限，必须成功。
  //     若有人把全局 bodyLimit 改回默认的 1 MiB，这里会变成 413。
  const normalPdf = pdfOfSize(1800, 80000001);
  const normalBody = JSON.stringify({ pdf: normalPdf.toString('base64'), filename: 'normal.pdf', items: [{ name: 'Normal Probe', cvr: '80000001' }] });
  assert.ok(normalBody.length > 2 * 1024 * 1024, `前提：请求体应超过 2 MB，实际 ${Math.round(normalBody.length / 1024)} KB`);
  const normal = await post('/api/import/licenses', normalBody);
  assert.equal(normal.status, 200,
    `约 ${Math.round(normalBody.length / 1024)} KB 的请求体返回 ${normal.status}，应为 200。413 说明全局上限被调到了默认的 1 MiB 以下`);

  // (b) 超过 16 MB 全局上限：必须被拒。
  //     实测不是返回 413，而是**直接重置连接** —— 服务端拒绝读取整个请求体。
  //     这比返回 413 更好（不会先把 16 MB 读进内存），所以断言的是
  //     「没有成功、也没有落库」，而不是某个具体状态码：
  //     写死 413 等于把我对实现的猜想当成要求，那是我的错，不是代码的错。
  const postExpectRejection = async (route, body) => {
    try {
      const r = await post(route, body);
      return { rejected: r.status >= 400, status: r.status };
    } catch {
      return { rejected: true, status: 'ECONNRESET' }; // 连接被重置，同样算拒绝
    }
  };

  const hugePdf = pdfOfSize(18000, 80000002);
  const hugeBody = JSON.stringify({ pdf: hugePdf.toString('base64'), filename: 'huge.pdf', items: [{ name: 'Huge Probe', cvr: '80000002' }] });
  assert.ok(hugeBody.length > 16 * 1024 * 1024, `前提：请求体应超过 16 MB，实际 ${Math.round(hugeBody.length / 1024 / 1024)} MB`);
  const huge = await postExpectRejection('/api/import/licenses', hugeBody);
  assert.ok(huge.rejected,
    `约 ${Math.round(hugeBody.length / 1024 / 1024)} MB 的请求体没有被拒（HTTP ${huge.status}），说明上限没有生效，这是一个无界的内存消耗面`);

  // (c) 鉴权路由的 4 KB 上限：8 KB 的口令体必须被拒（挡住口令填充这类大体积请求）
  const fatLogin = await postExpectRejection('/api/auth/login', JSON.stringify({ username: 'limiter', password: 'X'.repeat(8000) }));
  assert.ok(fatLogin.rejected, `8 KB 的登录请求体没有被拒（HTTP ${fatLogin.status}），鉴权路由的 4 KB 上限未生效`);

  // 最要紧的一条：超限请求不得留下任何数据
  const boot = await (await fetch(`${origin}/api/bootstrap`, { headers: { cookie } })).json();
  assert.equal(boot.pools.licenses.length, 1,
    `超限请求留下了数据：营业执照 ${boot.pools.licenses.length} 条，应仍为 1 条（只有 (a) 那份普通扫描件）`);
});
