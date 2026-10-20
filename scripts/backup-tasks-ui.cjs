'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {_electron}=require('playwright');
const largePdf=require('../tests/large-pdf-fixture');

(async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wb-package-ui-'));
  const archive=path.join(directory,'personal.awbp');
  let electron,page,fixture;
  const stop=()=>{try{electron?.process()?.kill();}finally{process.exit(1);}};
  const watchdog=setTimeout(()=>{console.error('FAIL backup UI exceeded 180 seconds');stop();},180000);watchdog.unref();
  const shot=async name=>{if(!process.env.UI_SCREENSHOT_DIR)return;fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,`backup${process.env.WORKBENCH_TEST_EXECUTABLE?'-packaged':''}-${name}.png`),animations:'disabled',timeout:5000});};
  try{
    if(process.env.WORKBENCH_TEST_EXECUTABLE)fixture=await require('./packaged-backup-fixture.cjs')(directory,process.env.WORKBENCH_TEST_EXECUTABLE);
    electron=await _electron.launch({executablePath:fixture?.executable||require('electron'),args:[...(process.platform==='linux'?['--no-sandbox']:[]),...(process.env.WORKBENCH_TEST_EXECUTABLE?[]:['.'])],env:{...process.env,ADS_WORKBENCH_MODE:'local',ADS_DESKTOP_DATA_DIR:path.join(directory,'userdata')}});
    page=await electron.firstWindow();page.setDefaultTimeout(20000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    if(fixture){
      await page.locator('#loginUsername').fill(fixture.username);await page.locator('#loginPassword').fill(fixture.password);await page.locator('#loginSubmit').click();
      assert.equal(new URL(page.url()).origin,fixture.remote,'packaged test must stay on the isolated HTTPS origin');
      assert.equal(fs.existsSync(path.join(directory,'userdata','workbench.sqlite')),false,'packaged remote client never creates a local database');
    }
    await page.getByText('已连接',{exact:true}).waitFor();await page.setViewportSize({width:1280,height:800});
    await electron.evaluate(({BrowserWindow},filename)=>{
      globalThis.packageDownloadStatus='waiting';globalThis.packageWorkerErrors=[];
      process.on('worker',worker=>worker.on('error',error=>packageWorkerErrors.push(error.message)));
      BrowserWindow.getAllWindows()[0].webContents.session.on('will-download',(_event,item)=>{
        if(!item.getFilename().endsWith('.awbp'))return;
        item.setSavePath(filename);item.once('done',(_event,status)=>{globalThis.packageDownloadStatus=status;});
      });
    },archive);
    await page.evaluate(async pdf=>{
      await api('/api/import/emails',{method:'POST',body:{items:[{user:'package-ui@example.test',pass:'SYNTHETIC-PACKAGE-UI'}]}});
      await api('/api/import/licenses',{method:'POST',body:{pdf,filename:'large-certificate.pdf',items:[{name:'Desktop backup company'}]}});
      await api('/api/records',{method:'POST',body:{domains:['package-ui.example'],proxy_mode:'none'}});
      await refresh();
    },largePdf(90).toString('base64'));
    const authorizedClick=async selector=>{
      const needs=await page.evaluate(()=>!window.desktop&&state.unlockedUntil<=Date.now()+1000);
      await page.locator(selector).click();
      if(needs){await page.locator('#unlock-password').fill(fixture.password);await page.locator('#unlock-form [type="submit"]').click();}
    };
    await page.locator('#nav [data-page="settings"]').click();await page.locator('[data-action="backup-tasks"]').click();
    await authorizedClick('#package-export');await page.locator('[data-package-action="download"]').waitFor();
    const exported=await page.evaluate(async()=>(await api('/api/backup-jobs')).jobs.find(job=>job.kind==='export'));
    assert.equal(exported.counts.records,1);assert.equal(exported.counts.documents,1);
    await shot('ready');await page.locator('[data-package-action="download"]').click();
    for(let i=0;i<400;i++){if(await electron.evaluate(()=>globalThis.packageDownloadStatus)==='completed')break;await new Promise(resolve=>setTimeout(resolve,25));}
    assert.equal(await electron.evaluate(()=>globalThis.packageDownloadStatus),'completed');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),exported.sha256,'native download must save the exact encrypted package');
    console.log('PASS native .awbp save, worker progress, verified counts and exact file checksum');

    await page.locator('#package-new-file').setInputFiles(archive);await page.waitForFunction(()=>!document.getElementById('package-new-upload').disabled);await authorizedClick('#package-new-upload');
    // Intercept the real renderer fetch response rather than issuing a new
    // Playwright API request, which does not traverse desktop source headers.
    await page.evaluate(()=>{
      globalThis.packageOriginalFetch=fetch;globalThis.packageHeldResponse=null;
      fetch=async(...args)=>{
        const response=await packageOriginalFetch(...args);
        if(String(args[0]).includes('/chunk?offset=1048576')&&!packageHeldResponse){
          packageHeldResponse={status:response.status,body:await response.clone().json()};
          await new Promise((resolve,reject)=>{
            const signal=args[1]?.signal;
            const abort=()=>reject(new DOMException('Paused','AbortError'));
            globalThis.releasePackageResponse=()=>{signal?.removeEventListener('abort',abort);resolve();};
            if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
          });
        }
        return response;
      };
    });
    await page.locator('#package-upload-start').click();await page.waitForFunction(()=>globalThis.packageHeldResponse);
    const held=await page.evaluate(()=>packageHeldResponse);assert.equal(held.status,200,JSON.stringify(held));assert.equal(held.body.offset,2097152);
    assert.equal(await page.locator('#package-progress').evaluate(element=>element.value),1048576);
    await page.locator('#package-pause').click();
    await page.waitForFunction(()=>!document.getElementById('package-upload-start').disabled);
    await page.evaluate(()=>{releasePackageResponse();fetch=packageOriginalFetch;});
    const uploaded=await page.evaluate(async()=>(await api('/api/backup-jobs')).jobs.find(job=>job.kind==='restore'));
    assert.equal(uploaded.offset,2097152,'pause reconciles an already committed chunk whose response was not received');
    assert.equal(await page.locator('#package-progress').evaluate(element=>element.value),uploaded.offset);
    await shot('paused');await page.locator('#package-upload-back').click();
    await page.locator(`[data-job="${uploaded.id}"] [data-package-action="upload"]`).click();
    const wrong=path.join(directory,'wrong.awbp');const altered=Buffer.from(fs.readFileSync(archive));altered[64]^=1;fs.writeFileSync(wrong,altered);
    await page.locator('#package-resume-file').setInputFiles(wrong);await page.getByText('文件与此上传任务不一致，请选择原文件或建立新任务',{exact:true}).waitFor();assert.equal(await page.locator('#package-upload-start').isDisabled(),true);
    await page.locator('#package-resume-file').setInputFiles(archive);await page.waitForFunction(()=>!document.getElementById('package-upload-start').disabled);await page.locator('#package-upload-start').click();
    await page.locator('#package-verify').waitFor();
    await authorizedClick('#package-verify');await page.locator(`[data-job="${uploaded.id}"] [data-package-action="review"]`).waitFor();
    console.log('PASS lost chunk response, pause reconciled to server offset, reopen, wrong-file rejection, resume and authenticated verification');
    await authorizedClick(`[data-job="${uploaded.id}"] [data-package-action="review"]`);assert.equal(await page.locator('#package-apply').isDisabled(),true);
    assert.match(await page.locator('.backup-count-wrap').innerText(),/记录\s+1\s+1/);
    await shot('review');
    await page.evaluate(async()=>{
      const record=(await api('/api/records?limit=10&offset=0')).items[0];
      await api(`/api/records/${record.id}`,{method:'PATCH',body:{version:record.version,product:'LIVE CHANGE AFTER REVIEW'}});
    });
    await page.locator('#package-consent').check();await page.locator('#package-apply').click();await page.locator('.dialog-error').waitFor();assert.match(await page.locator('.dialog-error').innerText(),/已变化/);assert.equal(await page.locator('#package-apply').isDisabled(),true);
    assert.equal(await page.evaluate(async()=>(await api('/api/records?limit=10&offset=0')).items[0].product),'LIVE CHANGE AFTER REVIEW');
    await shot('stale-protection');
    await authorizedClick('#package-review-again');await page.waitForFunction(()=>document.getElementById('package-consent')?.checked===false);assert.equal(await page.locator('#package-consent').isChecked(),false);assert.equal(await page.locator('#package-apply').isDisabled(),true);
    await page.locator('#package-consent').check();await page.locator('#package-apply').click();await page.getByText('恢复完成',{exact:true}).waitFor();
    assert.equal(await page.evaluate(async()=>{const r=await api('/api/records?limit=10&offset=0');return r.items[0].product;}),'');
    const events=await page.evaluate(async()=>(await api('/api/audit')).events);assert.equal(events.filter(event=>event.action==='backup.package.restore').length,1);
    console.log('PASS unchecked restore consent, stale-version refusal, explicit re-review and single committed restore');

    // A late result must never reopen a dialog that has been closed by locking.
    await page.evaluate(()=>{
      globalThis.packageOriginalFetch=fetch;globalThis.packageReviewStatus=null;
      fetch=async(...args)=>{
        const response=await packageOriginalFetch(...args);
        if(String(args[0]).endsWith('/review')){
          packageReviewStatus=response.status;
          await new Promise(resolve=>{globalThis.releasePackageReview=resolve;});
        }
        return response;
      };
    });
    // The completed upload cannot be reviewed again, so create one more verified task.
    await page.locator(`[data-job="${exported.id}"] [data-package-action="delete"]`).click();await page.locator('#package-delete-confirm').click();
    await page.locator('#package-new-file').setInputFiles(archive);await page.waitForFunction(()=>!document.getElementById('package-new-upload').disabled);await authorizedClick('#package-new-upload');await page.locator('#package-upload-start').click();await page.locator('#package-verify').waitFor();await authorizedClick('#package-verify');await page.locator('[data-package-action="review"]').waitFor();
    await authorizedClick('[data-package-action="review"]');await page.waitForFunction(()=>globalThis.packageReviewStatus!==null);assert.equal(await page.evaluate(()=>packageReviewStatus),200);await page.evaluate(()=>lockSensitive());await page.evaluate(()=>{releasePackageReview();fetch=packageOriginalFetch;});
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,100)));assert.equal(await page.locator('.modal').count(),0);
    console.log('PASS lock invalidates late backup review response');

    await page.locator('[data-action="backup-tasks"]').click();await authorizedClick('[data-package-action="review"]');await page.locator('#package-consent').waitFor();
    for(const zoom of [1,1.25,1.5]){
      await electron.evaluate(({BrowserWindow},value)=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value),zoom);
      assert.equal(await page.locator('.modal-foot').evaluate(element=>element.getBoundingClientRect().bottom<=innerHeight+1),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1),false);
      const counts=page.locator('.backup-count-wrap');
      if(await counts.evaluate(element=>element.scrollHeight>element.clientHeight+1)){
        await counts.focus();await page.keyboard.press('End');assert.ok(await counts.evaluate(element=>element.scrollTop>0),'all counts remain reachable by keyboard at zoom');
        await shot(`counts-bottom-zoom-${zoom*100}`);await page.keyboard.press('Home');
      }
      await shot(`review-zoom-${zoom*100}`);
    }
    await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    assert.deepEqual(errors,[]);console.log('PASS 1280px layout, 125/150% Electron zoom and no renderer errors');
  }catch(error){
    if(page){console.error('Backup UI state:',await page.evaluate(async()=>({title:document.querySelector('.modal h3')?.textContent,error:document.querySelector('.dialog-error')?.textContent,jobs:await api('/api/backup-jobs')})).catch(()=>({})));await shot('failure').catch(()=>{});}
    if(electron)console.error('Worker errors:',await electron.evaluate(()=>globalThis.packageWorkerErrors).catch(()=>[]));
    throw error;
  }
  finally{
    clearTimeout(watchdog);
    try{
      if(electron){const cleanup=setTimeout(()=>{console.error('FAIL backup UI did not shut down within 5 seconds');stop();},5000);try{await electron.close();}finally{clearTimeout(cleanup);}}
    }finally{try{if(fixture)await fixture.close();}finally{fs.rmSync(directory,{recursive:true,force:true});}}
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
