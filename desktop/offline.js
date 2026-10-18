'use strict';
window.workbenchShell.info().then(info=>{document.getElementById('server').textContent=info.origin;document.getElementById('version').textContent='v'+info.version;}).catch(()=>{});
document.getElementById('retry').onclick=async()=>{const b=document.getElementById('retry');b.disabled=true;b.textContent='\u8fde\u63a5\u4e2d\u2026';try{await window.workbenchShell.retry();}finally{b.disabled=false;b.textContent='\u91cd\u65b0\u8fde\u63a5';}};
