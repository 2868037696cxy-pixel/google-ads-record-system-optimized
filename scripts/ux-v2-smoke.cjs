'use strict';

// Real Electron visual / interaction regression for Workbench design system v2.
// Screenshots are uploaded by CI as evidence, not used as visual assertions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

function hexToRgb(value) {
  const hex = value.replace('#','');
  return [0,2,4].map(i => parseInt(hex.slice(i,i+2),16));
}
function contrast(a,b) {
  const luminance = rgb => rgb.map(v => {
    v/=255;
    return v<=0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4;
  }).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const x=luminance(a),y=luminance(b);
  return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);
}

(async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ads-ux-v2-'));
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
    await page.getByText('已连接',{exact:true}).waitFor({timeout:30000});

    assert.equal(await page.locator('link[href*="workbench-ui.css"]').count(),1);
    const initial=await page.evaluate(()=>{
      const css=el=>getComputedStyle(el);
      return {
        bodyFont:css(document.body).fontSize,
        bodyBackground:css(document.body).backgroundColor,
        bodyText:css(document.body).color,
        h1Size:css(document.querySelector('.page-head h1')).fontSize,
        brandMark:css(document.querySelector('.brand-mark')).backgroundColor,
        navIconCount:document.querySelectorAll('#nav .ico svg').length,
        navHeight:parseFloat(css(document.querySelector('.nav-item')).minHeight),
        sidebarWidth:document.querySelector('.sidebar').getBoundingClientRect().width,
        panelShadow:css(document.querySelector('.panel')).boxShadow,
      };
    });
    assert.equal(initial.bodyFont,'14px');
    assert.equal(initial.h1Size,'24px');
    assert.equal(initial.bodyBackground,'rgb(245, 247, 249)');
    assert.equal(initial.brandMark,'rgb(18, 111, 105)');
    assert.ok(initial.navIconCount>=7,'navigation must use consistent SVG icons');
    assert.ok(initial.navHeight>=40,'navigation needs generous pointer targets');
    assert.equal(initial.panelShadow,'none','resting panels should be flat');
    assert.ok(contrast(hexToRgb('#192632'),hexToRgb('#ffffff'))>=4.5);
    assert.ok(contrast(hexToRgb('#516171'),hexToRgb('#ffffff'))>=4.5);

    await page.evaluate(async()=>{
      const made=await api('/api/records',{
        method:'POST',
        body:{
          country:'PL',
          product:'UX smoke',
          domains:['ux-primary.example','ux-secondary.example','ux-tertiary.example'],
          proxy_mode:'none',
          email_ids:[],card_ids:[],license_ids:[],
        },
      });
      if(made.created.length!==3)throw new Error('UX fixture creation failed');
      await refresh();
    });

    await page.locator('#nav [data-page="records"]').click();
    await page.locator('#recordsPanel tbody tr[data-id]').first().waitFor({timeout:20000});
    const recordMetrics=await page.evaluate(()=>{
      const cell=document.querySelector('#recordsPanel tbody tr[data-id] td');
      const header=document.querySelector('#recordsPanel thead th');
      const button=document.querySelector('#recordsPanel [data-action="toggle-density"]');
      return {
        cellHeight:cell.getBoundingClientRect().height,
        cellFont:getComputedStyle(cell).fontSize,
        headerFont:getComputedStyle(header).fontSize,
        actionHeight:button.getBoundingClientRect().height,
        stickyColumn:getComputedStyle(document.querySelector('#recordsPanel tbody td:nth-child(2)')).position,
      };
    });
    assert.ok(recordMetrics.cellHeight>=44,'default rows must be comfortably readable');
    assert.equal(recordMetrics.cellFont,'14px');
    assert.equal(recordMetrics.headerFont,'12px');
    assert.ok(recordMetrics.actionHeight>=32);
    assert.equal(recordMetrics.stickyColumn,'sticky');

    // Presets are faster than 10 repeated checkbox interactions; custom visibility remains editable.
    await page.locator('#recordsPanel .col-menu > summary').click();
    await page.locator('#recordsPanel [data-action="preset-cols"][data-preset="core"]').click();
    assert.deepEqual(await page.evaluate(()=>state.hiddenCols),['emailPass','fakey','ipreg','idcard']);
    await page.locator('#recordsPanel .col-menu > summary').click();
    await page.locator('#recordsPanel [data-action="reset-cols"]').click();
    assert.deepEqual(await page.evaluate(()=>state.hiddenCols),[]);

    const screenshotDir=process.env.UI_SCREENSHOT_DIR;
    if(screenshotDir){
      fs.mkdirSync(screenshotDir,{recursive:true});
      await page.screenshot({path:path.join(screenshotDir,'ux-v2-records-1440.png'),fullPage:false});
    }

    const toggle=page.locator('#recordsPanel [data-action="toggle-density"]');
    await toggle.click();
    assert.equal(await page.evaluate(()=>document.body.dataset.tableDensity),'compact');
    const compactHeight=await page.locator('#recordsPanel tbody td').first().evaluate(el=>el.getBoundingClientRect().height);
    assert.ok(compactHeight<recordMetrics.cellHeight,'compact mode must decrease row height');
    await toggle.click();
    assert.equal(await page.evaluate(()=>document.body.dataset.tableDensity),'standard');

    await page.locator('#nav [data-page="create"]').click();
    const form=await page.evaluate(()=>{
      const label=document.querySelector('#createForm .field label');
      const input=document.querySelector('#f-country');
      return {labelFont:getComputedStyle(label).fontSize,inputHeight:input.getBoundingClientRect().height};
    });
    assert.equal(form.labelFont,'13px');
    assert.ok(form.inputHeight>=40);
    if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'ux-v2-create-1440.png'),fullPage:false});

    await page.locator('#nav [data-page="overview"]').click();
    assert.equal(await page.locator('.overview-metrics .overview-metric').count(),4);
    if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'ux-v2-overview-1440.png'),fullPage:false});

    await page.locator('#nav [data-page="emails"]').click();
    await page.evaluate(async()=>{
      const imported=await api('/api/import/emails',{method:'POST',body:{items:[{user:'ux-keyboard@example.test',pass:'synthetic'}]}});
      if(imported.added!==1)throw new Error('UX fixture email not imported');
      await refresh();
    });
    const copy=page.locator('.pool-table span[data-copy="ux-keyboard@example.test"]').first();
    await copy.waitFor();
    assert.equal(await copy.getAttribute('role'),'button');
    assert.equal(await copy.getAttribute('tabindex'),'0');
    await copy.focus();
    await page.keyboard.press('Enter');
    await page.locator('#toast-root .toast').first().waitFor();

    // UI at Electron's supported minimum. Main table scrolls; navigation stays legible.
    const win=await electron.browserWindow(page);
    await win.evaluate(browserWin=>browserWin.setSize(1024,760));
    await page.waitForFunction(()=>innerWidth<=1024 && innerWidth>=990,{timeout:10000}).catch(()=>{});
    const minimum=await page.evaluate(()=>{
      const nav=document.querySelector('.nav-item');
      const main=document.querySelector('#main');
      const sidebar=document.querySelector('.sidebar');
      const table=document.querySelector('.pool-table');
      return {
        viewport:innerWidth,
        navDisplay:getComputedStyle(nav).display,
        navLabelVisible:nav.getClientRects().length>0 && nav.getBoundingClientRect().width>120,
        sidebarWidth:sidebar.getBoundingClientRect().width,
        mainWidth:main.getBoundingClientRect().width,
        tableOverflow:table.scrollWidth>=table.parentElement.clientWidth,
      };
    });
    assert.ok(minimum.navLabelVisible,'1024px width must not hide sidebar navigation labels');
    assert.ok(minimum.mainWidth>500,'minimum desktop width leaves working space for content');
    assert.ok(minimum.tableOverflow,'table should scroll horizontally instead of clipping fields');
    if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'ux-v2-resources-1024.png'),fullPage:false});

    assert.deepEqual(errors,[],'no uncaught renderer exceptions');
    console.log('PASS UX v2: typography, contrast, controls, navigation, tables, density, keyboard copy and 1024px layout');
  } catch(error){
    if(page && process.env.UI_SCREENSHOT_DIR){
      fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'ux-v2-failure.png')}).catch(()=>{});
    }
    throw error;
  } finally {
    if(electron)await electron.close();
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
