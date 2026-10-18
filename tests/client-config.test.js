'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {resolveConfiguration}=require('../desktop/config');
test('packaged app pins the supplied HTTPS origin and ignores local-mode environment',()=>{assert.deepEqual(resolveConfiguration({isPackaged:true,env:{ADS_WORKBENCH_MODE:'local',ADS_WORKBENCH_SERVER_URL:'http://bad.test'}}),{mode:'remote',origin:'https://ads.fbsoso.xin'});});
test('HTTP, credentials, paths and query strings are not accepted as backend origins',()=>{for(const value of ['http://a.test','https://user:pass@a.test','https://a.test/path','https://a.test/?secret=x','https://a.test/#x'])assert.throws(()=>resolveConfiguration({env:{ADS_WORKBENCH_SERVER_URL:value}}));});
test('developer-only local mode is explicit; unset env always selects remote',()=>{assert.equal(resolveConfiguration({env:{}}).mode,'remote');assert.equal(resolveConfiguration({env:{ADS_WORKBENCH_MODE:'local'}}).mode,'local');});
