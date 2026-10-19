'use strict';
const cp=require('node:child_process');
const fs=require('node:fs');
fs.mkdirSync('test-artifacts/round73',{recursive:true});
const probes=[
  ['F08: CVR after city','tests/round73-regressions.test.js'],
  ['F04-PDF: direct PDF upload','tests/round73-regressions.test.js'],
  ['F04: incomplete import','tests/round73-regressions.test.js'],
  ['F09-STRUCTURE: forged header','tests/round73-regressions.test.js'],
  ['F13: structured field objects','tests/round73-regressions.test.js'],
  ['F13: duplicated paging values','tests/round73-regressions.test.js'],
  ['F23: successful PDF','tests/round73-regressions.test.js'],
  ['F11-LARGE:','tests/round73-backup-boundary.test.js'],
];
for(let i=0;i<probes.length;i++){
  const [name,file]=probes[i];
  const result=cp.spawnSync(process.execPath,['--test','--test-reporter=tap','--test-name-pattern',name,file],{encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024});
  const text=(result.stdout||'')+(result.stderr||'');
  fs.writeFileSync(`test-artifacts/round73/baseline-${i}.txt`,text);
  if(result.status!==1 || !text.includes('ERR_ASSERTION'))throw new Error(`Baseline ${name} failed for an unrelated reason or did not reproduce.\n${text.slice(-5000)}`);
  if(name==='F11-LARGE:' && !text.includes('F11 reproduced: export returned 200'))throw new Error('Large-backup probe did not reach the actual export/restore size mismatch');
  console.log('CONFIRMED unpatched failure:',name);
}
