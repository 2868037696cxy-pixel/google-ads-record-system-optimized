'use strict';
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
process.chdir(path.resolve(__dirname,'../..'));
let source=fs.readFileSync('server.js','utf8');
function replace(before,after) {
  if(source.includes(after)&&!source.includes(before))return;
  if(source.split(before).length!==2)throw new Error('Unexpected source at '+before.slice(0,80));
  source=source.replace(before,after);
}
replace("  items = items.map((item) => normalizeImport(type, item));", "  const submittedItems = items;\n  items = items.map((item) => normalizeImport(type, item));");
replace("  const label = dupLabel(type);\n  for (const it of items) {", "  const label = dupLabel(type);\n  for (const [itemIndex, it] of items.entries()) {");
replace("const updates = Object.fromEntries(Object.entries(it).filter(([, value]) => value !== ''));", "const updates = Object.fromEntries(Object.entries(it).filter(([key, value]) => Object.hasOwn(submittedItems[itemIndex], key) && value !== ''));" );
replace("const updates = Object.fromEntries(Object.entries(item).filter(([, value]) => value !== ''));", "const updates = Object.fromEntries(Object.entries(item).filter(([key, value]) => Object.hasOwn(items[0], key) && value !== ''));" );
fs.writeFileSync('server.js',source);
cp.execFileSync(process.execPath,['--check','server.js'],{stdio:'inherit'});
console.log('round73 import preservation: applied');
