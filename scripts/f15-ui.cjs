'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron}=require('playwright');

(async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ads-f15-ui-'));
  let electron,page;
  try {
    electron=await _electron.launch({
      executablePath:require('electron'),
      args:[...(process.platform==='linux'?['--no-sandbox']:[]),'.'],
      env:{...process.env,ADS_WORKBENCH_MODE:'local',ADS_DESKTOP_DATA_DIR:path.join(directory,'userdata')},
    });
    page=await electron.firstWindow();
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.locator('#main[data-connection="ready"]').waitFor();

    await page.evaluate(async()=>{
      const domains=Array.from({length:123},(_,i)=>`f15-${i+1}.example`);
      const result=await api('/api/records',{
        method:'POST',
        body:{
          country:'PL',
          product:'分页回归',
          domains,
          proxy_mode:'none',
          email_ids:[],
          card_ids:[],
          license_ids:[],
        },
      });
      if(result.created.length!==123) throw new Error('expected 123 records');
      await refresh();
    });

    await page.locator('#nav [data-page="records"]').click();
    await page.waitForFunction(()=>state.recordStats.total===123 && state.recordFilteredTotal===123 && state.recordPage===1);
    assert.equal(await page.locator('#recordsPanel tbody tr[data-id]').count(),50,'第一页必须只渲染 50 条');
    await page.getByText('共 123 条 · 第 1 / 3 页 · 每页 50 条',{exact:true}).waitFor();
    console.log('PASS F15 page 1: 50/123 records rendered from server page');

    const firstPageChecks=page.locator('#recordsPanel input[data-action="sel-row"]');
    await firstPageChecks.nth(0).check();
    await firstPageChecks.nth(1).check();
    assert.equal(await page.evaluate(()=>state.sel.size),2);

    await page.locator('#recordsPanel [data-action="table-page"][data-kind="records"]').filter({hasText:'下一页'}).click();
    await page.waitForFunction(()=>state.recordPage===2 && state.records.length===50);
    assert.equal(await page.evaluate(()=>state.sel.size),2,'翻页不能清除上一页选中项');
    assert.equal(await page.locator('#recordsPanel tbody tr[data-id]').count(),50);
    await page.getByText('共 123 条 · 第 2 / 3 页 · 每页 50 条',{exact:true}).waitFor();

    await page.locator('#recordsPanel input[data-action="sel-row"]').first().check();
    assert.equal(await page.evaluate(()=>state.sel.size),3);
    const all=page.locator('#recordsPanel input[data-action="sel-all"]');
    await all.check();
    assert.equal(await page.evaluate(()=>state.sel.size),52,'全选只能增加当前页 50 条，并保留上一页 2 条');
    await all.uncheck();
    assert.equal(await page.evaluate(()=>state.sel.size),2,'取消全选只能移除当前页，不能清掉上一页选择');
    console.log('PASS F15 cross-page selection and current-page select-all semantics');

    await page.locator('#recordsPanel [data-action="table-page"][data-kind="records"]').filter({hasText:'下一页'}).click();
    await page.waitForFunction(()=>state.recordPage===3 && state.records.length===23);
    assert.equal(await page.locator('#recordsPanel tbody tr[data-id]').count(),23);
    await page.getByText('共 123 条 · 第 3 / 3 页 · 每页 50 条',{exact:true}).waitFor();

    const search=page.locator('#rec-q');
    await search.fill('f15-123.example');
    await page.waitForFunction(()=>state.recordFilteredTotal===1 && state.records.length===1);
    assert.equal(await page.locator('#recordsPanel tbody tr[data-id]').count(),1);
    assert.equal(await page.locator('#recordsPanel tbody tr[data-id]').first().innerText().then(t=>t.includes('f15-123.example')),true);
    console.log('PASS F15 server-side search returns one matching record');

    await page.locator('[data-action="clear-record-filter"]').click();
    await page.waitForFunction(()=>state.recordFilteredTotal===123 && state.recordPage===1 && state.records.length===50);

    await page.evaluate(async()=>{
      await api('/api/import/emails',{method:'POST',body:{items:[{user:'offpage-linked@example.test',pass:'secret'}]}});
      const email=(await api('/api/bootstrap?summary=1')).pools.emails.find(x=>x.user==='offpage-linked@example.test');
      const tail=await api('/api/records?limit=1&offset=122&sort=id_desc');
      const oldest=tail.items[0];
      if(!email||!oldest) throw new Error('missing F15 off-page fixtures');
      await api(`/api/records/${oldest.id}`,{method:'PATCH',body:{email_id:email.id,version:oldest.version}});
      await refresh();
    });

    assert.equal(await page.evaluate(()=>state.records.some(r=>r.email_user==='offpage-linked@example.test')),false,
      '前提：引用邮箱的最老记录不能出现在当前第一页');
    await page.locator('#nav [data-page="emails"]').click();
    const row=page.locator('.pool-table tbody tr').filter({hasText:'offpage-linked@example.test'});
    await row.waitFor();
    assert.equal(await row.locator('[data-action="del-pool"]').isDisabled(),true,
      '页外记录占用的资源也必须禁用删除');
    const unused=row.locator('select[data-action="pool-item-status"] option').filter({hasText:'未使用'});
    assert.equal(await unused.isDisabled(),true,
      '页外记录占用的资源也必须禁用标记为未使用');
    assert.equal(await page.evaluate(()=>state.pools.emails.find(x=>x.user==='offpage-linked@example.test').linked_record_count),1);
    console.log('PASS F16 resource occupancy remains authoritative when linked record is off-page');

    assert.deepEqual(errors,[]);
    if(process.env.UI_SCREENSHOT_DIR){
      fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'f15-pagination.png')});
    }
  }catch(error){
    if(page&&process.env.UI_SCREENSHOT_DIR){
      fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'f15-pagination-failure.png')}).catch(()=>{});
    }
    throw error;
  }finally{
    if(electron)await electron.close();
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
