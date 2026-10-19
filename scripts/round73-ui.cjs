'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron}=require('playwright');
(async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ads-round73-ui-'));
  let electron,page;
  try {
    electron=await _electron.launch({executablePath:require('electron'),args:[...(process.platform==='linux'?['--no-sandbox']:[]),'.'],env:{...process.env,ADS_WORKBENCH_MODE:'local',ADS_DESKTOP_DATA_DIR:path.join(directory,'userdata')}});
    page=await electron.firstWindow();
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
    assert.deepEqual(errors,[]);
    if(process.env.UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'round73-picker.png')});}
  }catch(error){
    if(page&&process.env.UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'round73-failure.png')}).catch(()=>{});}
    throw error;
  }finally{if(electron)await electron.close();fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
