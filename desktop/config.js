'use strict';
function resolveConfiguration({isPackaged=false,env=process.env,config=require('./client-config.json')}={}) {
  if(!isPackaged && env.ADS_WORKBENCH_MODE==='local') return {mode:'local',origin:''};
  const value=String((!isPackaged && env.ADS_WORKBENCH_SERVER_URL)||config.serverUrl||'').trim();
  let url;try{url=new URL(value);}catch{throw new Error('Invalid configured server address');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/') throw new Error('Server address must be an HTTPS origin');
  return {mode:'remote',origin:url.origin};
}
module.exports={resolveConfiguration};
