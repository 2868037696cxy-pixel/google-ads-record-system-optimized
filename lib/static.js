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
  // Only enumerate the generated viewer subtree. Request text never becomes a file path.
  const viewerRoot=path.join(root,'vendor','file-viewer');
  const viewerTypes={'.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.wasm':'application/wasm','.woff2':'font/woff2','.ttf':'font/ttf','.pfb':'application/octet-stream','.bcmap':'application/octet-stream','.txt':'text/plain; charset=utf-8'};
  const assets=new Map();
  function visit(directory,prefix='') {
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const relative=prefix+entry.name, file=path.join(directory,entry.name);
      if(entry.isDirectory()) visit(file,relative+'/');
      else if(entry.isFile() && viewerTypes[path.extname(entry.name)]) assets.set(relative,{file,type:viewerTypes[path.extname(entry.name)]});
    }
  }
  if(fs.existsSync(viewerRoot)) visit(viewerRoot);
  app.get('/vendor/file-viewer/*',(req,reply)=>{
    const asset=assets.get(req.params['*']);
    if(!asset) return reply.code(404).send({error:'not found'});
    return reply.header('Content-Type',asset.type).header('Cache-Control','no-cache').send(fs.createReadStream(asset.file));
  });
};
