'use strict';
// 无头 Edge 渲染各个页面并截图，用于核对 UI 改动的真实效果（不依赖人工点击）。
// 用法：node scripts/ui-render.cjs —— 在临时数据库里灌入示例数据，截图输出到 .shots/。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-render-'));
process.env.DATA_DIR = DIR;
process.env.DB_FILE = path.join(DIR, 'workbench.sqlite');
process.env.DATA_FILE = path.join(DIR, 'absent.json');
process.env.LOG_LEVEL = 'silent';

const OUT = path.join(__dirname, '..', '.shots');
fs.mkdirSync(OUT, { recursive: true });
service_placeholder: {
  // 只清理本轮要覆盖的文件
  for (const name of ['r1-登录页.png', 'r2-登录页-注册.png', 'r3-工作台.png', 'r4-邮箱库.png', 'r5-窄屏登录页.png']) {
    const file = path.join(OUT, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

const service = require('../server');
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('找不到 Edge'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const origin = await service.start({ port: 0, host: '127.0.0.1' });
  const PORT = 9355;
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(DIR, 'edge')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* 未就绪 */ }
  }
  if (!target) throw new Error('CDP 未就绪');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 300));
    return res.result?.result?.value;
  };
  const waitFor = async (expression, label, tries = 40) => {
    for (let i = 0; i < tries; i++) { if (await evaluate(expression)) return; await sleep(250); }
    throw new Error(`等待超时: ${label}`);
  };
  const shot = async (name, width, height, scale = 1) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: width < 600 });
    await sleep(350);
    const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(res.result.data, 'base64'));
    console.log('  ', name);
  };
  const goto = async (url) => { await send('Page.navigate', { url }); await waitFor('document.readyState === "complete"', url); await sleep(900); };

  await send('Page.enable');
  await send('Runtime.enable');

  await goto(origin + '/login.html');
  await shot('r1-登录页.png', 1440, 900);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '注册')?.click()`);
  await sleep(600);
  await shot('r2-登录页-注册.png', 1440, 900);

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await goto(origin + '/login.html');
  await shot('r5-窄屏登录页.png', 390, 844, 2);

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`fetch('/api/auth/register',{method:'POST',headers:{'content-type':'application/json','x-workbench':'1'},body:JSON.stringify({username:'render',password:'render-pass-1',display_name:'渲染账号'})}).then(r=>r.status)`);
  await evaluate(`(async () => {
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench': '1' }, body: JSON.stringify(body) }).then((r) => r.status);
    await post('/api/import/emails', { items: Array.from({ length: 12 }, (_, i) => ({ user: 'ads' + (i + 1) + '@gmail.com', pass: 'Passw0rd!' + i, fakey: 'JBSWY3DPEHPK3PXP' })) });
    await post('/api/import/cards', { items: Array.from({ length: 6 }, (_, i) => ({ number: '43679701526190' + (10 + i), expiry: '0' + (i % 9 + 1) + '/28', cvv: '00' + i })) });
    await post('/api/import/licenses', { items: [{ name: 'Nordlys Handel ApS', legal_name: 'Nordlys Handel ApS', address: 'Nørregade 12', city: 'Aarhus', zip: '8000', cvr: '41234567' }] });
    await post('/api/records', { domains: ['nordlys-shop.com', 'fjord-market.dk', 'kbh-tech.eu'], country: '丹麦', product: '呼吸机' });
    return true;
  })()`);

  await goto(origin + '/');
  await waitFor('document.querySelectorAll("#nav .nav-item").length >= 5', '工作台');
  await sleep(800);
  await shot('r3-工作台.png', 1440, 1000);
  // 精确校验吸底操作条：主按钮必须落在视口内，而不是滚到底才看得到
  const sticky = await evaluate(`(() => {
    const el = document.querySelector('.create-preview');
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, pinned: r.bottom <= window.innerHeight + 1 };
  })()`);
  console.log('   吸底操作条:', JSON.stringify(sticky));
  await evaluate(`document.querySelectorAll('#nav .nav-item')[1]?.click()`);
  await sleep(700);
  await shot('r4-邮箱库.png', 1440, 1000);

  // 弹窗①：批量导入（选择器要用真实动作名，之前写错导致截的是页面本身）
  await evaluate(`document.querySelector('[data-action="open-import"][data-kind="emails"]')?.click()`);
  await sleep(1000);
  console.log('   导入弹窗已打开:', await evaluate(`!!document.querySelector('.modal')`));
  await shot('r6-导入弹窗.png', 1440, 1000);
  await evaluate(`document.querySelector('.modal-close')?.click()`);
  await sleep(500);

  // 弹窗②：智能导入
  await evaluate(`document.querySelector('[data-action="open-auto-import"]')?.click()`);
  await sleep(1200);
  console.log('   智能导入已打开:', await evaluate(`!!document.querySelector('.modal')`));
  await shot('r7-智能导入弹窗.png', 1440, 1000);
  await evaluate(`document.querySelector('.modal-close')?.click()`);
  await sleep(500);

  ws.close();
  edge.kill();
  await service.close();
  await sleep(400);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* Edge 可能还占着 profile */ }
  console.log('完成');
})().catch((error) => {
  console.error('渲染失败:', error.message);
  process.exitCode = 1;
});
