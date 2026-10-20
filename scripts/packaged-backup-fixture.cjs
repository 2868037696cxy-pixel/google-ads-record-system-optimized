'use strict';
// A private copy of the packaged client points ONLY to an ephemeral HTTPS
// service. The actual installable candidate and its configured origin stay intact.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const http=require('node:http');const https=require('node:https');const {spawnSync}=require('node:child_process');
const asar=require('@electron/asar');
const hashFile=async filename=>{const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(filename))hash.update(bytes);return hash.digest('hex');};

module.exports=async function packagedFixture(root,executable){
  if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true')throw new Error('Packaged HTTPS fixture runs only on a disposable Windows Actions runner');
  const originalAsar=path.join(path.dirname(executable),'resources','app.asar');
  const originalHash=await hashFile(originalAsar);
  const certFile=path.join(root,'localhost-cert.pem'),keyFile=path.join(root,'localhost-key.pem');
  const openssl=['openssl','C:\\Program Files\\Git\\usr\\bin\\openssl.exe'].find(candidate=>spawnSync(candidate,['version'],{stdio:'ignore',timeout:5000}).status===0);
  if(!openssl)throw new Error('OpenSSL is required for an ephemeral test certificate');
  const generated=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'],{stdio:'ignore',timeout:10000});
  if(generated.status!==0)throw new Error('Could not create the localhost test certificate');
  const cert=fs.readFileSync(certFile),key=fs.readFileSync(keyFile);
  const fingerprint=new crypto.X509Certificate(cert).fingerprint256;
  let front,service,backend;
  const close=async()=>{
    try{console.log('PACKAGED FIXTURE: close HTTPS');if(front)await new Promise(resolve=>{front.closeAllConnections();front.close(resolve);});}
    finally{
      try{console.log('PACKAGED FIXTURE: close backend');if(service)await service.close();}
      finally{
        assert.equal(await hashFile(originalAsar),originalHash,'the shipped candidate must remain byte-for-byte unchanged');
      }
    }
  };
  try{
    console.log('PACKAGED FIXTURE: start isolated HTTPS service');
    front=https.createServer({cert,key},(req,res)=>{
      const outgoing=http.request(backend+req.url,{method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
      outgoing.on('error',()=>{res.writeHead(502);res.end();});req.pipe(outgoing);
    });
    await new Promise(resolve=>front.listen(0,'127.0.0.1',resolve));
    const remote=`https://127.0.0.1:${front.address().port}`;
    Object.assign(process.env,{DATA_DIR:path.join(root,'server'),DB_FILE:path.join(root,'server','test.sqlite'),DATA_FILE:path.join(root,'absent.json'),REGISTRATION:'open',LOG_LEVEL:'silent',SESSION_SECURE:'1',PUBLIC_ORIGIN:remote});
    service=require('../server');backend=await service.start({port:0,host:'127.0.0.1'});
    const username='packaged-backup',password='Packaged-Backup-123456';
    const registered=await fetch(backend+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json','x-workbench':'1'},body:JSON.stringify({username,password})});assert.equal(registered.status,201);
    console.log('PACKAGED FIXTURE: copy packaged candidate');
    const copy=path.join(root,'packaged-client');fs.cpSync(path.dirname(executable),copy,{recursive:true});
    console.log('PACKAGED FIXTURE: extract private ASAR');
    const unpacked=path.join(root,'test-package-source');asar.extractAll(path.join(copy,'resources','app.asar'),unpacked);
    fs.writeFileSync(path.join(unpacked,'desktop','client-config.json'),JSON.stringify({serverUrl:remote}));
    console.log('PACKAGED FIXTURE: package isolated configuration');
    const replacement=path.join(copy,'resources','fixture.asar');await asar.createPackage(unpacked,replacement);
    assert.equal(JSON.parse(asar.extractFile(replacement,'desktop/client-config.json').toString()).serverUrl,remote,'verify the private copy points to the isolated HTTPS service before launch');
    fs.renameSync(replacement,path.join(copy,'resources','app.asar'));
    console.log('PACKAGED FIXTURE: ready');
    return {executable:path.join(copy,path.basename(executable)),username,password,remote,fingerprint,close};
  }catch(error){await close();throw error;}
};
