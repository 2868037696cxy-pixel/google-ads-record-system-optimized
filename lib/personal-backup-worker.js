'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const packages=require('./personal-package');
const progress=value=>parentPort.postMessage({progress:value});
(async()=>{
  try{const result=await packages[workerData.operation]({...workerData,progress});parentPort.postMessage({result});}
  catch{parentPort.postMessage({error:'备份打包或完整性校验未完成。请核对文件、账号密钥与记录关联后重试；现有数据未改变。'});}
})();
