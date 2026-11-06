'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare, installKey } = require('../scripts/start-render.cjs');
const mountInfo = '20 1 0:1 / /var/data rw - ext4 /dev/example rw\n';
const environment = () => ({ DATA_DIR: '/var/data/workbench', DB_FILE: '/var/data/workbench/workbench.sqlite', ADS_SECRETS_KEY_FILE: '/var/data/private/secret.key', BACKUP_DIR: '/var/data/backups', ADS_SECRETS_KEY_HEX: 'ab'.repeat(32), RENDER_EXTERNAL_URL: 'https://example.onrender.com' });
test('Render refuses an ephemeral filesystem before creating data', () => {
  assert.throws(() => prepare(environment(), ''), /not mounted/);
});
test('Render rejects durable paths outside the disk, including traversal', () => {
  for (const name of ['DATA_DIR', 'DB_FILE', 'ADS_SECRETS_KEY_FILE', 'BACKUP_DIR']) {
    const env = environment(); env[name] = '/var/data/../temporary/file';
    assert.throws(() => prepare(env, mountInfo), /persistent disk/);
  }
});
test('Render configures the platform HTTPS origin and public listener', () => {
  const env = environment(); prepare(env, mountInfo);
  assert.equal(env.PUBLIC_ORIGIN, env.RENDER_EXTERNAL_URL);
  assert.equal(env.HOST, '0.0.0.0');
  env.PUBLIC_ORIGIN = 'https://ads.example.com'; prepare(env, mountInfo);
  assert.equal(env.PUBLIC_ORIGIN, 'https://ads.example.com');
});
test('Render rejects missing keys and invalid origins', () => {
  const env = environment(); delete env.ADS_SECRETS_KEY_HEX;
  assert.throws(() => prepare(env, mountInfo), /original/);
  for (const origin of ['http://example.com', 'https://example.com/path', 'https://example.com/']) {
    assert.throws(() => prepare({ ...environment(), PUBLIC_ORIGIN: origin }, mountInfo), /HTTPS origin/);
  }
});
test('Render preserves the original key across restarts and refuses replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-render-'));
  try {
    const keyFile = path.join(root, 'private/secret.key'), key = 'ab'.repeat(32);
    installKey({ key, keyFile }); installKey({ key, keyFile });
    assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), key);
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.throws(() => installKey({ key: 'cd'.repeat(32), keyFile }), /refusing replacement/);
    assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), key);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
