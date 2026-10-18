'use strict';
// Operator-only CLI. No HTTP administrator data browser and no plaintext passwords in argv.
const fs=require('node:fs');const path=require('node:path');const {envFile}=require('./backup.cjs');
envFile();
const [action,username,passwordFile]=process.argv.slice(2);
if(!['create','disable','enable','reset'].includes(action)||!username){console.error('Usage: account.cjs create|reset USER PRIVATE_PASSWORD_FILE, or disable|enable USER');process.exit(1);}
const {openDatabase,transaction}=require('../lib/db');const store=require('../lib/store');const auth=require('../lib/auth');const {audit}=require('../lib/hardening');
let db;
try{
  db=openDatabase(process.env.DB_FILE||path.join(process.env.DATA_DIR||'/var/lib/adsworkbench','workbench.sqlite'));
  transaction(db,()=>{
    let user=store.findUserByUsername(db,username);
    if(action==='create'||action==='reset'){
      if(!passwordFile)throw new Error('Private password file is required');const stat=fs.statSync(passwordFile);
      if(process.platform!=='win32' && (stat.mode & 0o077))throw new Error('Password file must have permissions 600');
      const password=fs.readFileSync(passwordFile,'utf8').replace(/\r?\n$/,'');const check=auth.validateCredentials({username,password});if(check.error)throw new Error(check.error);
      if(action==='create'){if(user)throw new Error('Username already exists');user=store.insertUser(db,{username,displayName:username,passwordHash:auth.hashPassword(password),createdAt:new Date().toISOString()});}
      else {if(!user)throw new Error('User not found');db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(password),user.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);}
    }else{if(!user)throw new Error('User not found');db.prepare('UPDATE users SET disabled=? WHERE id=?').run(action==='disable'?1:0,user.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);}
    audit(db,user.id,'operator.'+action);
  });console.log('Account action completed. No records or PDFs were listed.');
}catch(e){console.error(e.message);process.exitCode=1;}finally{if(db)db.close();}
