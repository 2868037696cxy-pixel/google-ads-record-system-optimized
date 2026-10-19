'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron}=require('playwright');
const {certificate}=require('../tests/pdf-fixture');
(async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ads-round73-ui-'));
  let electron,page;
  const watchdog=setTimeout(()=>{
    console.error('FAIL round73 watchdog: test exceeded 120 seconds; terminating the isolated test application');
    electron?.process()?.kill();
    process.exitCode=1;
  },120000);
  watchdog.unref();
  try {
    electron=await _electron.launch({executablePath:require('electron'),args:[...(process.platform==='linux'?['--no-sandbox']:[]),'.'],env:{...process.env,ADS_WORKBENCH_MODE:'local',ADS_DESKTOP_DATA_DIR:path.join(directory,'userdata')}});
    page=await electron.firstWindow();
    page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.getByText('已连接',{exact:true}).waitFor();
    await page.evaluate(async()=>{
      await api('/api/import/emails',{method:'POST',body:{items:[{user:'picker-a@example.test'},{user:'picker-b@example.test'}]}});
      await refresh();
    });
    await page.locator('#nav [data-page="create"]').click();
    const picker=page.locator('[data-action="open-picker"][data-kind="emails"]');
    await picker.click();
    await page.locator('#picker-list input[type="checkbox"]').first().check();
    assert.equal(await page.evaluate(()=>state.picked.emails.size),0,'F18: changing an unconfirmed picker must not modify the committed selection');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>state.picked.emails.size),0,'F18: ESC cancels the draft');
    await picker.click();
    assert.equal(await page.locator('#picker-list input:checked').count(),0);
    await page.locator('#picker-list input[type="checkbox"]').first().check();
    await page.locator('#picker-ok').click();
    assert.equal(await page.evaluate(()=>state.picked.emails.size),1,'F18: OK commits the draft');
    await picker.click();
    await page.locator('#picker-clear').click();
    await page.locator('.modal-close').click();
    assert.equal(await page.evaluate(()=>state.picked.emails.size),1,'F18: clear then cancel must retain the previous selection');
    await picker.click();
    await page.locator('#picker-clear').click();
    await page.locator('#picker-ok').click();
    assert.equal(await page.evaluate(()=>state.picked.emails.size),0,'F18: explicit clear then OK commits');
    console.log('PASS F18 real picker: changes/ESC/X/clear/confirm isolation');

    await page.route('**/api/round73-probe',route=>route.fulfill({status:403,contentType:'text/html',body:'<html>synthetic maintenance page</html>'}));
    const denial=await page.evaluate(async()=>{try{await api('/api/round73-probe');return null;}catch(e){return {message:e.message,status:e.status};}});
    assert.equal(denial.status,403);
    assert.match(denial.message,/维护|拦截/);
    assert.ok(!denial.message.includes('<html>'));
    console.log('PASS F33 HTTP maintenance rejection keeps status and safe guidance');

    const id=await page.evaluate(async()=>{
      const r=await api('/api/records',{method:'POST',body:{domains:['round73-refresh.example'],country:'Before'}});
      await refresh();return r.created[0].id;
    });
    await page.locator('#nav [data-page="records"]').click();
    await page.locator(`[data-action="edit-record"][data-id="${id}"]`).click();
    await page.locator('#edit-form [name="country"]').fill('After saved');
    let failRefresh=false;
    await page.route('**/api/bootstrap*',async route=>{
      if(failRefresh){failRefresh=false;await route.fulfill({status:503,contentType:'text/html',body:'<html>synthetic refresh outage</html>'});}
      else await route.continue();
    });
    failRefresh=true;
    await page.locator('#edit-ok').click();
    await page.getByText('修改已保存，但列表刷新失败；请重新连接，不要重复提交',{exact:true}).waitFor();
    assert.equal(await page.locator('#edit-form').count(),0);
    assert.equal(await page.evaluate(async id=>(await api('/api/bootstrap')).records.find(r=>r.id===id).country,id),'After saved');
    console.log('PASS F19 edit persisted once despite subsequent bootstrap failure');

    await page.locator('#nav [data-page="licenses"]').click();
    await page.locator('[data-action="open-import"][data-kind="licenses"]').click();
    const file=path.join(directory,'refresh-probe.pdf');
    fs.writeFileSync(file,certificate());
    await page.locator('#license-file').setInputFiles(file);
    await page.getByText('已提取信息，请核对后保存。原 PDF 将一并保存。',{exact:true}).waitFor();
    failRefresh=true;
    await page.locator('#license-import').click();
    await page.getByText('资料已保存，但列表刷新失败；请重新连接，不要重复导入',{exact:true}).waitFor();
    assert.equal(await page.locator('#license-form').count(),0);
    assert.equal(await page.evaluate(async()=>(await api('/api/bootstrap')).pools.licenses.length),1);
    console.log('PASS F19 PDF persisted once despite subsequent bootstrap failure');

    const statusId=await page.evaluate(async()=>{
      const r=await api('/api/records',{method:'POST',body:{domains:['round73-status.example'],country:'Status before',proxy_mode:'none',email_ids:[],card_ids:[],license_ids:[]}});
      await refresh();return r.created[0].id;
    });
    await page.locator('#nav [data-page="records"]').click();
    failRefresh=true;
    await page.locator(`select[data-action="rec-status"][data-id="${statusId}"]`).selectOption('异常');
    await page.getByText('状态已更新，但列表刷新失败；请重新连接，不要重复修改',{exact:true}).waitFor();
    assert.equal(await page.evaluate(async()=>{const r=await api('/api/records?q=round73-status.example&limit=10&offset=0');return r.items[0]?.status;}),'异常');
    console.log('PASS F19 status mutation is not reported as failed when only refresh fails');

    const deleteId=await page.evaluate(async(statusFixtureId)=>{
      // 独立建立删除用例：状态用例已占用唯一 PDF，先解除测试关联，
      // 避免在待测删除之前因库存不足而提前失败；前面的状态持久化断言保留。
      const previous=(await api('/api/records?q=round73-status.example&limit=10&offset=0')).items.find(record=>record.id===statusFixtureId);
      if(previous?.license_id) await api(`/api/records/${previous.id}`,{method:'PATCH',body:{license_id:null,version:previous.version}});
      await api('/api/import/emails',{method:'POST',body:{items:[{user:'round73-delete-fixture@example.test'}]}});
      const r=await api('/api/records',{method:'POST',body:{domains:['round73-delete.example'],country:'Delete me',proxy_mode:'none',email_ids:[],card_ids:[],license_ids:[]}});
      await refresh();return r.created[0].id;
    },statusId);
    await page.locator('#nav [data-page="records"]').click();
    failRefresh=true;
    await page.locator(`[data-action="del-record"][data-id="${deleteId}"]`).click();
    await page.locator('#confirm-ok-btn').click();
    await page.getByText('记录已删除，但列表刷新失败；请重新连接，不要重复删除',{exact:true}).waitFor();
    assert.equal(await page.locator('#confirm-ok-btn').count(),0,'successful delete must close the confirmation even if refresh fails');
    assert.equal(await page.evaluate(async()=>{const r=await api('/api/records?q=round73-delete.example&limit=10&offset=0');return r.total;}),0);
    console.log('PASS F19 delete mutation closes cleanly when only refresh fails');

    assert.deepEqual(errors,[]);
    if(process.env.UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'round73-picker.png')});}
  }catch(error){
    console.error('FAIL round73:',error.message);
    if(page&&process.env.UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'round73-failure.png'),timeout:5000}).catch(()=>{});}
    throw error;
  }finally{
    clearTimeout(watchdog);
    if(electron){
      // A failed renderer/request must not keep CI waiting indefinitely in app.quit.
      const cleanup=setTimeout(()=>{console.error('round73: forcing isolated Electron cleanup');electron.process()?.kill();},5000);
      try{await electron.close();}catch{/* The watchdog may already have stopped it. */}finally{clearTimeout(cleanup);}
    }
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
