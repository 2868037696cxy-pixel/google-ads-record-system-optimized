'use strict';
const service=require('../../server');
service.start({port:0}).then(origin=>process.send({origin})).catch(()=>process.exit(1));
process.on('message',async message=>{if(message==='close'){await service.close();process.exit(0);}});
