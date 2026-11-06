'use strict';
// Render entrypoint: validate the mounted disk before opening any production data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function prepare(env = process.env, mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8')) {
  const mount = '/var/data';
  if (!mountInfo.split('\n').some(line => line.split(' ')[4] === mount)) {
    throw new Error('Persistent disk is not mounted at /var/data; refusing ephemeral storage.');
  }
  const inside = value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value).startsWith(mount + '/');
  for (const name of ['DATA_DIR', 'DB_FILE', 'ADS_SECRETS_KEY_FILE', 'BACKUP_DIR']) {
    if (!inside(env[name])) throw new Error(name + ' must be inside the persistent disk.');
  }
  const key = String(env.ADS_SECRETS_KEY_HEX || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Set ADS_SECRETS_KEY_HEX to the original 64-character hex key in Render.');
  const origin = env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL;
  if (!origin || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin) {
    throw new Error('PUBLIC_ORIGIN or RENDER_EXTERNAL_URL must be an HTTPS origin without a trailing slash.');
  }
  env.PUBLIC_ORIGIN = origin;
  env.HOST = '0.0.0.0';
  return { key: key.toLowerCase(), keyFile: env.ADS_SECRETS_KEY_FILE };
}

function installKey({ key, keyFile }) {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  if (fs.existsSync(keyFile)) {
    const existing = fs.readFileSync(keyFile, 'utf8').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(existing) || !crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(existing, 'hex'))) {
      throw new Error('Configured key differs from the persistent key; refusing replacement.');
    }
  } else {
    fs.writeFileSync(keyFile, key + '\n', { flag: 'wx', mode: 0o600 });
  }
  fs.chmodSync(keyFile, 0o600);
}

async function main() {
  process.umask(0o077);
  const config = prepare();
  installKey(config);
  delete process.env.ADS_SECRETS_KEY_HEX;
  const app = require('../server');
  const { createBackup, verifyBackup, pruneBackups } = require('./backup.cjs');
  let stopping = false, pending = null;
  const backup = () => {
    if (stopping || pending) return pending;
    pending = (async () => {
      const file = await createBackup(process.env.DB_FILE, process.env.BACKUP_DIR, Buffer.from(config.key, 'hex'));
      await verifyBackup(file, Buffer.from(config.key, 'hex'));
      pruneBackups(process.env.BACKUP_DIR, Number(process.env.BACKUP_KEEP || 7));
      console.log('Encrypted database backup verified.');
    })().catch(() => { console.error('Encrypted backup failed; inspect disk capacity and backup configuration.'); })
      .finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(backup, 24 * 60 * 60 * 1000);
  timer.unref();
  const stop = async () => {
    if (stopping) return;
    stopping = true; clearInterval(timer);
    await pending;
    await app.close();
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stop().catch(() => process.exit(1)); });
  try { await app.start(); await backup(); }
  catch (error) { clearInterval(timer); await app.close(); throw error; }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepare, installKey };
