'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Fastify = require('fastify');
const installStatic = require('../lib/static');

test('viewer serves only enumerated assets with worker/font/wasm MIME; no arbitrary path or symlink exposure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-viewer-assets-'));
  const app = Fastify();
  try {
    fs.writeFileSync(path.join(root, 'index.html'), '<p>test</p>');
    const output = path.join(root, 'vendor/file-viewer'); fs.mkdirSync(output, { recursive: true });
    for (const name of ['worker.mjs', 'decoder.wasm', 'font.woff2']) fs.writeFileSync(path.join(output, name), 'synthetic asset');
    fs.writeFileSync(path.join(root, 'private.txt'), 'must never be served');
    if (process.platform !== 'win32') fs.symlinkSync(path.join(root, 'private.txt'), path.join(output, 'link.txt'));
    installStatic(app, root);
    for (const [name, type] of [['worker.mjs', 'text/javascript'], ['decoder.wasm', 'application/wasm'], ['font.woff2', 'font/woff2']]) {
      const response = await app.inject('/vendor/file-viewer/' + name);
      assert.equal(response.statusCode, 200); assert.ok(response.headers['content-type'].startsWith(type));
      assert.equal(response.body, 'synthetic asset');
    }
    for (const name of ['private.txt', 'link.txt', 'package.json', 'missing.mjs', '%2e%2e/private.txt']) {
      assert.notEqual((await app.inject('/vendor/file-viewer/' + name)).statusCode, 200);
    }
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
