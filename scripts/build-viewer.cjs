'use strict';
// Local, pinned packages only. No CDN, remote conversion, or user documents at build time.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public/vendor/file-viewer');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
require('esbuild').buildSync({
  entryPoints: [path.join(root, 'scripts/viewer-entry.mjs')],
  outdir: output, entryNames: 'viewer', chunkNames: '[name]-[hash]',
  bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'linked', logLevel: 'warning',
});
const pdfRoot = path.dirname(require.resolve('@file-viewer/renderer-pdf/package.json'));
fs.cpSync(path.join(pdfRoot, 'dist/vendor/pdfjs'), path.join(output, 'pdfjs'), { recursive: true });
const fontRoot = path.dirname(require.resolve('@fontsource-variable/noto-sans-sc/package.json'));
fs.cpSync(fontRoot, path.join(output, 'cjk'), { recursive: true });
fs.copyFileSync(path.join(fontRoot, 'LICENSE'), path.join(output, 'cjk-LICENSE.txt'));
for (const [name, packageName] of [['web', '@file-viewer/web'], ['core', '@file-viewer/core'], ['pdf', '@file-viewer/renderer-pdf']]) {
  const packageRoot = path.dirname(require.resolve(packageName + '/package.json'));
  for (const file of ['LICENSE', 'dist/THIRD_PARTY_LICENSES.txt']) {
    const source = path.join(packageRoot, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(output, `${name}-${path.basename(file)}.txt`));
  }
}
console.log('File Viewer PDF assets built locally.');
