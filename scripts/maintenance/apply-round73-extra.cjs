'use strict';
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
process.chdir(path.resolve(__dirname,'../..'));
let source=fs.readFileSync('server.js','utf8').replace(/\r\n/g,'\n');
function replace(before,after) {
  if(source.includes(after)&&!source.includes(before))return;
  if(source.split(before).length!==2)throw new Error('Unexpected source at '+before.slice(0,80));
  source=source.replace(before,after);
}
replace("  items = items.map((item) => normalizeImport(type, item));", "  const submittedItems = items;\n  items = items.map((item) => normalizeImport(type, item));");
replace("  const label = dupLabel(type);\n  for (const it of items) {", "  const label = dupLabel(type);\n  for (const [itemIndex, it] of items.entries()) {");
replace("const updates = Object.fromEntries(Object.entries(it).filter(([, value]) => value !== ''));", "const updates = Object.fromEntries(Object.entries(it).filter(([key, value]) => Object.hasOwn(submittedItems[itemIndex], key) && value !== ''));" );
replace("const updates = Object.fromEntries(Object.entries(item).filter(([, value]) => value !== ''));", "const updates = Object.fromEntries(Object.entries(item).filter(([key, value]) => Object.hasOwn(items[0], key) && value !== ''));" );
// F11: never hand out a JSON backup which the same server is unable to accept.
replace("  const filename = `账号工作台-${user.username}-${new Date().toISOString().slice(0, 10)}.json`;", "  requireUnlocked(req);\n  const envelope = encryptedSnapshot(ownerId);\n  const filename = `账号工作台-${user.username}-${new Date().toISOString().slice(0, 10)}.json`;");
replace("return reply.send(JSON.stringify(encryptedSnapshot(ownerId)));", "return reply.send(JSON.stringify(envelope));");
replace("fastify.post('/api/backup/restore', { bodyLimit: 64 * 1024 * 1024 },", "fastify.post('/api/backup/restore', { bodyLimit: require('./lib/personal-backup-policy').RESTORE_BODY_LIMIT },");
replace("  const value=snapshot(owner),vault=getVault(db);\n  return {format:'adsworkbench-backup',version:2,owner_id:owner,key_id:vault.keyId,created_at:new Date().toISOString(),\n    counts:{records:value.records.length,licenses:value.licenses.length},\n    payload:vault.seal(JSON.stringify(value),`backup:${owner}`)};", "  const policy = require('./lib/personal-backup-policy');\n  policy.assertDocumentBudget(db, owner);\n  const value=snapshot(owner),vault=getVault(db);\n  return policy.assertEnvelopeBudget({format:'adsworkbench-backup',version:2,owner_id:owner,key_id:vault.keyId,created_at:new Date().toISOString(),\n    counts:{records:value.records.length,licenses:value.licenses.length},\n    payload:vault.seal(JSON.stringify(value),`backup:${owner}`)});");
fs.writeFileSync('server.js',source);
cp.execFileSync(process.execPath,['--check','server.js'],{stdio:'inherit'});
function patchFile(file,before,after){
  const text=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');
  if(text.includes(after)&&!text.includes(before))return;
  if(text.split(before).length!==2)throw new Error('Unexpected test source: '+file+' '+before.slice(0,60));
  fs.writeFileSync(file,text.replace(before,after));
}
// F30: creation and record interactions no longer share a single page.
// Keep the assertions; navigate to the actual UI that owns each action.
patchFile('scripts/desktop-smoke.cjs',
  "    await page.locator('[data-sensitive=\"true\"]').click();",
  "    await page.locator('#nav [data-page=\"records\"]').click();\n    await page.locator('[data-sensitive=\"true\"]').click();");
patchFile('scripts/desktop-smoke.cjs',
  "    await page.locator('[data-action=\"open-picker\"][data-kind=\"cards\"]').click();",
  "    await page.locator('#nav [data-page=\"create\"]').click();\n    await page.locator('[data-action=\"open-picker\"][data-kind=\"cards\"]').click();");
patchFile('scripts/desktop-smoke.cjs',
  "    await page.locator('[data-action=\"edit-record\"]').first().click();",
  "    await page.locator('#nav [data-page=\"records\"]').click();\n    await page.locator('[data-action=\"edit-record\"]').first().click();");
patchFile('scripts/remote-smoke.cjs',
  "  await page.screenshot({path:path.join(shots,'records.png'),animations:'disabled'});",
  "  await page.locator('#nav [data-page=\"records\"]').click();\n  await page.locator('.rec-table').waitFor();\n  await page.screenshot({path:path.join(shots,'records.png'),animations:'disabled'});");
for(const file of ['scripts/desktop-smoke.cjs','scripts/remote-smoke.cjs'])cp.execFileSync(process.execPath,['--check',file],{stdio:'inherit'});
console.log('round73 sparse import, backup boundary and split-page regression fixes: applied');
