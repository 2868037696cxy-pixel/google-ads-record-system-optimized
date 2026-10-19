'use strict';
// 越权写路径：攻击者不得靠猜 id 对别人的记录与资源执行任何写操作（方案 WP02 隐私隔离）。
//
// 只断言「状态码 >= 400」是不够的：如果操作先改了数据再返回错误，状态码会撒谎。
// 因此每条断言之后都要回查被攻击方的数据，确认它一个字节都没动。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-idor-'));
process.env.DATA_DIR = root;
process.env.DB_FILE = path.join(root, 'test.sqlite');
process.env.DATA_FILE = path.join(root, 'absent.json');
process.env.REGISTRATION = 'open';
process.env.LOG_LEVEL = 'silent';

const service = require('../server');
let origin;
const cookie = {};
const api = async (who, method, route, body) => {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-workbench': '1', cookie: cookie[who] },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let value = null;
  try { value = JSON.parse(await r.text()); } catch { /* 非 JSON 响应 */ }
  return { status: r.status, value };
};

test.before(async () => {
  origin = await service.start({ port: 0 });
  for (const who of ['victim', 'attacker']) {
    const r = await fetch(`${origin}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' },
      body: JSON.stringify({ username: who, password: 'Secure-Test-1234' }),
    });
    assert.equal(r.status, 201);
    cookie[who] = r.headers.get('set-cookie').split(';')[0];
  }
});
test.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('猜 id 不能对别人的记录与资源执行任何写操作', async () => {
  await api('victim', 'POST', '/api/import/emails', { items: [{ user: 'victim@example.test', pass: 'Victim-Pass-1234' }] });
  await api('victim', 'POST', '/api/import/cards', { items: [{ number: 'victim-card', last4: '4242', expiry: '12/29' }] });
  const made = await api('victim', 'POST', '/api/records', { domains: ['victim-shop.example'], proxy_mode: 'none' });
  assert.equal(made.status, 200, '前提：被攻击方应能正常创建记录');
  const recordId = made.value.created[0].id;
  const boot = await api('victim', 'GET', '/api/bootstrap');
  const emailId = boot.value.pools.emails[0].id;
  assert.ok(recordId && emailId, '前提：需要真实 id 才能模拟猜 id');
  // 与「攻击前」的基线对比，而不是和猜的字面量对比：资源池与记录的状态取值可能不同，
  // 硬编码 '正常' 会让断言因为取值猜错而失败，看起来像漏洞，实际是测试写错了。
  const baseline = {
    recordStatus: boot.value.records[0].status,
    recordName: boot.value.records[0].name,
    emailStatus: boot.value.pools.emails[0].status,
  };

  const attempts = [
    ['PATCH', `/api/records/${recordId}`, { status: '停用' }],
    ['PATCH', `/api/records/${recordId}`, { name: 'HIJACKED' }],
    ['DELETE', `/api/records/${recordId}`, undefined],
    ['POST', '/api/records/batch-delete', { ids: [recordId] }],
    ['PATCH', `/api/pool/emails/${emailId}`, { status: '停用' }],
    ['DELETE', `/api/pool/emails/${emailId}`, undefined],
  ];
  const statuses = [];
  for (const [method, route, body] of attempts) {
    const r = await api('attacker', method, route, body);
    statuses.push(`${method} ${route} → ${r.status}`);
  }

  // 先查数据，再看状态码：如果数据真的被改了，那远比「状态码不严谨」严重，
  // 必须让它先暴露。先断言状态码会把这个更严重的可能性挡在后面。
  const after = await api('victim', 'GET', '/api/bootstrap');
  assert.equal(after.value.records.length, 1, `被攻击方的记录数量被改变（越权删除？）。请求结果：${statuses.join(' | ')}`);
  assert.equal(after.value.records[0].status, baseline.recordStatus, `记录状态被越权修改：${baseline.recordStatus} → ${after.value.records[0].status}。请求结果：${statuses.join(' | ')}`);
  assert.equal(after.value.records[0].name, baseline.recordName, '记录名称被越权修改');
  assert.equal(after.value.pools.emails.length, 1, '被攻击方的资源数量被改变（越权删除？）');
  assert.equal(after.value.pools.emails[0].status, baseline.emailStatus, `资源状态被越权修改：${baseline.emailStatus} → ${after.value.pools.emails[0].status}。请求结果：${statuses.join(' | ')}`);

  // 攻击者自己也不该凭空多出数据
  const own = await api('attacker', 'GET', '/api/bootstrap');
  assert.equal(own.value.records.length, 0, 'attacker 不应因越权尝试而获得任何记录');
  assert.equal(own.value.pools.emails.length, 0, 'attacker 不应看到被攻击方的资源');

  // 数据确认完好，这时才追究状态码。按语义分两类，不混为一谈：
  //   - PATCH（修改类）必须被拒：返回 2xx 会让调用方以为改动生效了。
  //   - DELETE 对不属于自己的 id 返回 200 是可接受的幂等语义：它删除 0 条、不泄露
  //     任何信息，也省掉「重复删除报错」这一常见麻烦。真正不可接受的是「返回 200
  //     却把别人的数据删了」，那由上面几条数据断言守住（记录数、资源数、状态、名称）。
  //     这里把实测值记下来，是为了下次有人重看时不必重新判断它是不是漏洞。
  const patchLines = statuses.filter((line) => line.startsWith('PATCH'));
  assert.equal(patchLines.length, 3, `前提：应发出 3 条跨账号修改请求，实际：${statuses.join(' | ')}`);
  for (const line of patchLines) {
    assert.ok(/→ [45]\d\d$/.test(line), `${line}，跨账号修改必须被拒。全部结果：${statuses.join(' | ')}`);
  }
  assert.equal(statuses.filter((line) => line.startsWith('DELETE')).length, 2,
    `前提：应发出 2 条跨账号删除请求，实际：${statuses.join(' | ')}`);
});
