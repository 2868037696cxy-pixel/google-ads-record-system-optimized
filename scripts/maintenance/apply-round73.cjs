'use strict';
// Development-only, deterministic patch application. Never run on a live checkout.
// The follow-up workflow commits the resulting source only after verification.
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
process.chdir(root);
if (!fs.existsSync('.git')) throw new Error('A disposable git checkout is required');
cp.execFileSync('git', ['merge-base', '--is-ancestor', 'b2f5e98f5a5bb2bc2121290f334b459277993e48', 'HEAD']);
const staged = new Map();
function replace(file, before, after) {
  let text = staged.has(file) ? staged.get(file) : fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (text.includes(after) && !text.includes(before)) return;
  if (text.split(before).length !== 2) throw new Error(`Patch precondition failed for ${file}: ${before.slice(0,90)}`);
  staged.set(file, text.replace(before, after));
}
// F08: registration labels participate both in extraction and in field boundaries.
replace('server.js',
  "  city: '市(?:/区)?|城市|(?:city|town|municipality)',",
  "  city: '市(?:/区)?|城市|(?:city|town|municipality)',\n  cvr: '公司注册号|企业注册号|商业注册号|注册号|登记号|统一社会信用代码|CVR(?:[\\\\s.-]*(?:number|nr\\\\.?|no\\\\.?|注册号))?|(?:company\\\\s+|business\\\\s+)?registration\\\\s*(?:number|no\\\\.?|nr\\\\.?)',");
replace('server.js',
  "      city: licGrab(flat, LIC_LABELS.city),",
  "      city: licGrab(flat, LIC_LABELS.city),\n      cvr: licGrab(flat, LIC_LABELS.cvr),");
// Boundary prevents 'city:' inside 'electricity:' from becoming the city field.
replace('server.js',
  "const re = new RegExp(`(?:${labels})\\\\s*[:：=]\\\\s*(.*?)(?=[，,;；、\\\\s]*(?:${LIC_STOP})\\\\s*[:：=]|$)`, 'i');",
  "const re = new RegExp(`(?:^|[，,;；、\\\\s])(?:${labels})\\\\s*[:：=]\\\\s*(.*?)(?=[，,;；、\\\\s]+(?:${LIC_STOP})\\\\s*[:：=]|$)`, 'i');");
// F13: do not stringify objects/arrays into apparently valid business fields.
replace('server.js',
  "  assertNoCardSecrets(item);\n  const row = Object.fromEntries(IMPORT_FIELDS[type].map((key) => [key, String(item[key] ?? '').trim()]));",
  "  assertNoCardSecrets(item);\n  for (const key of IMPORT_FIELDS[type]) {\n    const value = item[key];\n    if (value != null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return reply400('导入字段必须为文本或有限数字');\n    if (String(value ?? '').length > 8192) return reply400('单个导入字段过长');\n  }\n  const row = Object.fromEntries(IMPORT_FIELDS[type].map((key) => [key, String(item[key] ?? '').trim()]));");
replace('server.js',
  "  const raw = String(text || '').trim();\n  if (!raw) return [];\n\n  // 检测是否为带标签的结构化文本",
  "  if (text != null && typeof text !== 'string') return reply400('待解析内容必须为文本');\n  const raw = String(text || '').trim();\n  if (!raw) return [];\n\n  // 检测是否为带标签的结构化文本");
replace('server.js',
  "    const n = Number(raw);\n    if (!Number.isInteger(n) || n < min || n > max) {",
  "    const n = Number(raw);\n    if (typeof raw !== 'string' || !/^(?:0|[1-9]\\d*)$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {");
// F04: importing an incomplete payload enriches, never silently clears fields.
replace('server.js',
  "const updatedLicense = store.updatePoolRow(db, ownerId, 'licenses', mine.id, { ...store.toPublic(mine), ...it });",
  "const updates = Object.fromEntries(Object.entries(it).filter(([, value]) => value !== ''));\n          const updatedLicense = store.updatePoolRow(db, ownerId, 'licenses', mine.id, { ...store.toPublic(mine), ...updates });");
replace('server.js',
  "      const mineMatched = byDocument[0] || byName || null;\n\n      // 关键一步",
  "      const mineMatched = byDocument[0] || byName || null;\n      // The PDF entry point must enforce the same identity rule as text imports.\n      const previousCvr = mineMatched && dedup.licenseKeys(mineMatched).dup_cvr;\n      const submittedCvr = dedup.licenseKeys(item).dup_cvr;\n      if (previousCvr && submittedCvr && previousCvr !== submittedCvr) {\n        return replyConflict('该公司名称已存在但注册号不同，请核对后再处理', [{name:item.name,field:'cvr',label:'注册号',message:'同名资料的注册号不一致，未保存'}]);\n      }\n\n      // 关键一步");
replace('server.js',
  "const merged = normalizeImport('licenses', { ...store.toPublic(license), ...items[0] });",
  "const updates = Object.fromEntries(Object.entries(item).filter(([, value]) => value !== ''));\n        const merged = normalizeImport('licenses', { ...store.toPublic(license), ...updates });");
// F09: file signatures are not structural validation. Reuse the bounded parser
// at the FINAL write boundary, before entering the synchronous DB transaction.
replace('server.js',
  "    const bytes = decodePdf(req.body.pdf);\n    const item = normalizeImport('licenses', items[0]);",
  "    const bytes = decodePdf(req.body.pdf);\n    if (checkDuplicatePdf(bytes).exists) rejectDuplicatePdf();\n    try {\n      await extractPdfText(bytes);\n    } catch (error) {\n      if (error.statusCode) throw error;\n      return reply400('PDF 结构无效、已损坏或需要密码，未保存原件');\n    }\n    const item = normalizeImport('licenses', items[0]);");
// F23: successful original-file import/replace/read must be attributable;
// audit subjects are internal IDs only, never document text or credentials.
replace('server.js',
  "      syncResource(ownerId, 'licenses', license);\n      store.pruneDocuments(db);",
  "      syncResource(ownerId, 'licenses', license);\n      audit(db, ownerId, added ? 'pdf.import' : 'pdf.replace', String(license.id));\n      store.pruneDocuments(db);");
replace('server.js',
  "  if (!document) throw new Error('这份营业执照尚未保存原 PDF');\n  return {",
  "  if (!document) throw new Error('这份营业执照尚未保存原 PDF');\n  audit(db, owner, 'pdf.read', String(id));\n  return {");
// F18: draft picker changes are committed only by the explicit OK action.
replace('public/app.js',
  "function openPicker(kind) {\n  const conf = KINDS.find((k) => k.key === kind);\n  const picked = state.picked[kind];",
  "function openPicker(kind) {\n  const conf = KINDS.find((k) => k.key === kind);\n  const picked = new Set(state.picked[kind]);");
replace('public/app.js',
  "  document.getElementById('picker-ok').onclick = async () => {\n    closeModal();",
  "  document.getElementById('picker-ok').onclick = async () => {\n    const available = new Set(state.pools[kind].filter(item => item.status === '未使用').map(item => item.id));\n    state.picked[kind] = new Set([...picked].filter(id => available.has(id)));\n    closeModal();");
// F19/F33: distinguish a successful save followed by a refresh failure and
// diagnose HTML maintenance/proxy errors without echoing response bodies.
replace('public/app.js',
  "  const data = await res.json().catch(() => { throw new Error('服务响应异常，请重新连接'); });",
  "  let data;\n  try { data = await res.json(); } catch {\n    const messages = {403:'访问被拦截，可能处于维护期或当前出口 IP 未获放行，请联系管理员',413:'请求过大，请减少文件或批次大小',429:'请求过于频繁，请稍后重试',502:'后台暂时不可用，请稍后重试',503:'服务维护中，请稍后重试',504:'后台响应超时，提交结果待确认，请勿重复新建'};\n    const error = new Error(messages[res.status] || '服务响应格式异常，请重新连接或联系管理员');\n    error.status = res.status; throw error;\n  }");
replace('public/app.js',
  "      toast('✅ 已保存');\n      if (form.isConnected) closeModal();\n      await refresh();",
  "      toast('✅ 已保存');\n      if (form.isConnected) closeModal();\n      await refresh().catch(() => toast('修改已保存，但列表刷新失败；请重新连接，不要重复提交', 'warn'));");
replace('public/licenses.js',
  "      if (form.isConnected) closeModal();\n      await refresh();",
  "      if (form.isConnected) closeModal();\n      await refresh().catch(() => toast('资料已保存，但列表刷新失败；请重新连接，不要重复导入', 'warn'));");
// Keep this operation all-or-nothing at file level: validate every replacement
// in memory first. No unknown source revision is overwritten on a mismatch.
for (const [file, text] of staged) fs.writeFileSync(file, text);
for (const file of staged.keys()) cp.execFileSync(process.execPath, ['--check', file], {stdio:'inherit'});
console.log('round73 patched source:', [...staged.keys()].join(', '));
