'use strict';
let secretTimer;
const protectedKeys=new Set(['pass','fakey','email_pass','email_fakey','proxy_pass','id_card']);
function wipeSecrets(value) {
  if(Array.isArray(value)) {value.forEach(wipeSecrets);return;}
  if(!value||typeof value!=='object') return;
  for(const key of Object.keys(value)) {
    if(protectedKeys.has(key)) value[key]=value[key]?'[protected]':'';
    else wipeSecrets(value[key]);
  }
}
async function lockSensitive() {
  clearTimeout(secretTimer);state.unlockedUntil=0;state.reveal=false;
  // Abort in-flight revealed queries as well as clearing already-rendered values.
  ++refreshRequestSeq;
  invalidateRecordQuery();
  state.recordsPhase='ready';state.recordError='';
  wipeSecrets(state.pools);wipeSecrets(state.records);wipeSecrets(state.recentRecords);
  // 审计 F02：render() 只重绘主区域，弹窗不在其中 —— 锁定后 state.reveal 已是 false、
  // 两个池也已脱敏，但弹窗 input 里仍然是明文，而编辑弹窗恰恰是最集中显示明文的地方。
  // 因此锁定时直接关掉弹窗，并把编辑态表单里的敏感字段一并擦掉。
  // closeModal() 是 app.js 的全局助手（内部就是清空 #modal-root），不另造一套。
  closeModal();
  if(state.form&&typeof state.form==='object') wipeSecrets(state.form);
  if(state.loaded) render();
  await api('/api/security/lock',{method:'POST',keepalive:true}).catch(()=>{});
}
async function ensureSensitive(reason='\u8bf7\u9a8c\u8bc1\u767b\u5f55\u5bc6\u7801\u3002\u6388\u6743\u6709\u6548\u671f60\u79d2\uff0c\u4ec5\u53ef\u67e5\u770b\u672c\u4eba\u8d44\u6599\u3002') {
  if(state.unlockedUntil>Date.now()+1000) return true;
  if(window.desktop) {
    const result=await api('/api/security/unlock',{method:'POST',body:{}});
    state.unlockedUntil=result.unlocked_until;secretTimer=setTimeout(lockSensitive,60000);return true;
  }
  return new Promise(resolve=>{
    openModal(`<div class="modal-head"><h3>\u9a8c\u8bc1\u654f\u611f\u64cd\u4f5c</h3><button class="modal-close" data-action="close-modal" aria-label="\u5173\u95ed">\u00d7</button></div>
      <form id="unlock-form"><div class="modal-body"><p>${esc(reason)}</p><label for="unlock-password">\u5f53\u524d\u767b\u5f55\u5bc6\u7801</label><input id="unlock-password" type="password" autocomplete="current-password" required maxlength="200" style="width:100%"><p id="unlock-error" role="alert"></p></div>
      <div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="close-modal">\u53d6\u6d88</button><button class="btn btn-primary" type="submit">\u9a8c\u8bc1</button></div></form>`);
    const form=document.getElementById('unlock-form');let done=false;
    const observer=new MutationObserver(()=>{if(!form.isConnected&&!done){done=true;observer.disconnect();resolve(false);}});
    observer.observe(document.getElementById('modal-root'),{childList:true});
    form.onsubmit=async e=>{
      e.preventDefault();const button=form.querySelector('[type=submit]');if(button.disabled)return;button.disabled=true;
      try {
        const result=await api('/api/security/unlock',{method:'POST',body:{password:document.getElementById('unlock-password').value}});
        if(!form.isConnected||done)return;
        form.querySelector('#unlock-password').value='';
        state.unlockedUntil=result.unlocked_until;clearTimeout(secretTimer);secretTimer=setTimeout(lockSensitive,Math.max(0,result.unlocked_until-Date.now()));
        done=true;observer.disconnect();closeModal();resolve(true);
      } catch(error){if(form.isConnected){document.getElementById('unlock-error').textContent=error.message;button.disabled=false;}}
    };
  });
}
async function showMyAudit() {
  openModal(`<div class="modal-head"><h3>\u6211\u7684\u5b89\u5168\u64cd\u4f5c\u8bb0\u5f55</h3><button class="modal-close" data-action="close-modal" aria-label="\u5173\u95ed">\u00d7</button></div><div class="modal-body" id="my-audit">\u52a0\u8f7d\u4e2d\u2026</div>`);
  const box=document.getElementById('my-audit');
  try {
    const {events}=await api('/api/audit');if(!box.isConnected)return;
    const labels={'secrets.unlock':'\u9a8c\u8bc1\u654f\u611f\u64cd\u4f5c','export.credentials':'\u5bfc\u51fa\u51ed\u636e','backup.export':'\u5bfc\u51fa\u52a0\u5bc6\u5907\u4efd','backup.restore':'\u6062\u590d\u5907\u4efd','password.change':'\u4fee\u6539\u5bc6\u7801','records.create':'\u521b\u5efa\u8bb0\u5f55'};
    box.innerHTML=events.length?`<p>\u4ec5\u663e\u793a\u672c\u4eba\u6700\u8fd1100\u6761\u8bb0\u5f55\uff0c\u4e0d\u5305\u542b\u5bc6\u7801\u539f\u6587\u3002</p><table><thead><tr><th>\u64cd\u4f5c</th><th>\u6570\u91cf</th><th>\u65f6\u95f4</th></tr></thead><tbody>${events.map(e=>`<tr><td>${esc(labels[e.action]||e.action)}</td><td>${esc(e.subject)}</td><td>${esc(new Date(e.created_at).toLocaleString())}</td></tr>`).join('')}</tbody></table>`:'<p>\u6682\u65e0\u64cd\u4f5c\u8bb0\u5f55</p>';
  }catch(e){if(box.isConnected)box.innerHTML=WorkbenchUI.emptyState({title:'暂时无法读取操作记录',description:e.message,action:'my-audit',actionLabel:'重新加载'});}
}
function showChangePassword() {
  openModal(`<div class="modal-head"><h3>\u4fee\u6539\u767b\u5f55\u5bc6\u7801</h3><button class="modal-close" data-action="close-modal">\u00d7</button></div><form id="password-form"><div class="modal-body stack">
    <label for="old-password">\u539f\u5bc6\u7801</label><input id="old-password" type="password" autocomplete="current-password" required maxlength="200">
    <label for="new-password">\u65b0\u5bc6\u7801</label><input id="new-password" type="password" autocomplete="new-password" required minlength="8" maxlength="200">
    <label for="repeat-password">\u786e\u8ba4\u65b0\u5bc6\u7801</label><input id="repeat-password" type="password" autocomplete="new-password" required maxlength="200"><p role="alert" id="password-error"></p>
    <p>\u4fee\u6539\u540e\u6240\u6709\u8bbe\u5907\u9700\u91cd\u65b0\u767b\u5f55\u3002</p></div><div class="modal-foot"><button class="btn btn-primary" type="submit">\u786e\u8ba4\u4fee\u6539</button></div></form>`);
  const form=document.getElementById('password-form');form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;
    try {
      const next=document.getElementById('new-password').value;
      if(next!==document.getElementById('repeat-password').value) throw new Error('\u4e24\u6b21\u65b0\u5bc6\u7801\u4e0d\u4e00\u81f4');
      await api('/api/account/password',{method:'POST',body:{current_password:document.getElementById('old-password').value,new_password:next}});
      location.replace('/login.html');
    }catch(error){if(form.isConnected){form.querySelector('#password-error').textContent=error.message;button.disabled=false;}}
  };
}
document.addEventListener('visibilitychange',()=>{if(document.hidden && state.unlockedUntil) void lockSensitive();});
window.addEventListener('offline',()=>{if(state.unlockedUntil) void lockSensitive();const el=document.getElementById('connectionStatus');if(el){el.textContent='\u7f51\u7edc\u65ad\u5f00\uff0c\u65b0\u63d0\u4ea4\u5c1a\u672a\u4fdd\u5b58';el.className='connection-status disconnected';}});
window.addEventListener('online',()=>{void connect();});
