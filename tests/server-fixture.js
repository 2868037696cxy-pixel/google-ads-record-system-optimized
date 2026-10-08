'use strict';
const service = require('../server');
service.start({ port: 0, token: process.env.TEST_DESKTOP_TOKEN || '' })
  .then((origin) => process.send({ origin }))
  .catch((error) => { process.send({ error: error.message }); process.exitCode = 1; });
process.on('message', async (message) => {
  if (message.restore) {
    try { service.restore(message.restore); process.send({ restored: true }); }
    catch (error) { process.send({ error: error.message }); }
  }
});
process.on('disconnect', () => service.close().finally(() => process.exit()));
