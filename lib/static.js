'use strict';
// Exact allowlist, no file path interpolation or directory listing.
const fs=require('node:fs'); const path=require('node:path');
module.exports=function installStatic(app,root) {
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
  const allowed=new Map(fs.readdirSync(root).filter(n=>types[path.extname(n)] && /^[a-z0-9-]+\.(html|js|css)$/.test(n)).map(n=>[n,fs.readFileSync(path.join(root,n))]));
  app.decorateReply('sendFile',function(name){
    if(!allowed.has(name)) return this.code(404).send({error:'not found'});
    return this.header('Content-Type',types[path.extname(name)]).header('Cache-Control','no-store').send(allowed.get(name));
  });
  app.get('/',(_req,reply)=>reply.sendFile('index.html'));
  for(const name of allowed.keys()) app.get('/'+name,(_req,reply)=>reply.sendFile(name));
};
