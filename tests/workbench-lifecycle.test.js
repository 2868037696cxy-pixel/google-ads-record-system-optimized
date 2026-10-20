'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the production event handlers with controlled I/O and deferred promises.
// Native DOM layout and focus behavior are covered separately by test:ux.
function harness() {
  const elements = new Map();
  const listeners = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, disabled: false, checked: false, textContent: '', value: '', files: [], isConnected: true, dataset: {}, querySelector: () => null, closest: () => null });
    return elements.get(id);
  };
  let modal = null;
  const document = {
    getElementById: element,
    querySelector: selector => selector === '#modal-root .modal' ? modal : selector.includes('export-scope') ? { value: 'all' } : null,
    querySelectorAll: () => [],
    addEventListener: (name, callback) => listeners.set(name, [...(listeners.get(name) || []), callback]),
    hidden: false,
  };
  const UI = { busy: (button, value) => { button.disabled = value; }, dialog: { signal: () => new AbortController().signal, pending: (button, value) => { button.disabled = value; }, error: () => {} } };
  const context = vm.createContext({ document, window: { addEventListener() {} }, WorkbenchUI: UI, MutationObserver: class { observe() {} disconnect() {} }, setTimeout, clearTimeout, AbortController, AbortSignal, URLSearchParams, Date, console });
  const run = source => vm.runInContext(source, context);
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\nconnect\(\);\s*$/, '\n');
  run(source);
  run(fs.readFileSync(path.join(__dirname, '../public/security.js'), 'utf8'));
  context.openModal = () => { modal = {}; for (const value of elements.values()) value.isConnected = true; };
  context.closeModal = () => { modal = null; for (const value of elements.values()) value.isConnected = false; };
  context.toast = () => {};
  context.renderSyncNotice = () => {};
  return { context, run, element, listeners };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('restore ignores a previous file that finishes after a newer invalid selection', async () => {
  const { context, run, element } = harness();
  run('openRestoreDialog()');
  const input = element('restore-file'), go = element('restore-go');
  const old = deferred();
  input.files = [{ size: 10, name: 'old.json', text: () => old.promise }];
  const reading = input.onchange();
  input.files = [{ size: 10, name: 'new-invalid.json', text: async () => 'invalid' }];
  await input.onchange();
  old.resolve(JSON.stringify({ format: 'adsworkbench-backup', version: 2, counts: { records: 1 } }));
  await reading;
  assert.equal(go.disabled, true, 'an obsolete valid file must never re-enable restore');
  assert.equal(element('restore-confirm').disabled, true);
  assert.match(element('restore-status').textContent, /无法读取有效备份/);
  let writes = 0;
  context.api = async () => { writes++; };
  await go.onclick();
  assert.equal(writes, 0);
});

test('a sensitive export response cannot download after locking and closing its dialog', async () => {
  const { context, run, element } = harness();
  const pending = deferred();
  context.ensureSensitive = async () => true;
  context.api = (url) => url === '/api/export/adspower' ? pending.promise : Promise.resolve({});
  let downloads = 0;
  context.download = () => { downloads++; };
  run('state.unlockedUntil = Date.now() + 60000');
  await run("openExportDialog('adspower')");
  const exporting = element('export-confirm').onclick();
  await Promise.resolve();
  await run('lockSensitive()');
  pending.resolve({ count: 1, text: 'SYNTHETIC-SECRET' });
  await exporting;
  assert.equal(downloads, 0);
});

test('a desktop unlock response cannot undo a newer sensitive lock', async () => {
  const { context, run } = harness();
  const pending = deferred();
  context.window.desktop = {};
  context.api = url => url === '/api/security/unlock' ? pending.promise : Promise.resolve({});
  const unlocking = run('ensureSensitive()');
  await run('lockSensitive()');
  pending.resolve({ unlocked_until: Date.now() + 60000 });
  const allowed = await unlocking;
  run('clearTimeout(secretTimer)');
  assert.equal(allowed, false);
  assert.equal(run('state.unlockedUntil'), 0);
});

test('Ctrl+R inside a dialog prevents reload without synchronizing its background', () => {
  const { context, run, listeners } = harness();
  context.openModal();
  let refreshes = 0, prevented = false;
  context.connect = () => { refreshes++; };
  const event = { key: 'r', ctrlKey: true, shiftKey: false, target: { matches: () => false }, preventDefault: () => { prevented = true; } };
  for (const callback of listeners.get('keydown')) callback(event);
  assert.equal(prevented, true);
  assert.equal(refreshes, 0);
  run('clearTimeout(secretTimer)');
});

test('a completed creation cannot replace a newer dialog after sensitive lock', async () => {
  const { context, run } = harness();
  const pending = deferred();
  context.crypto = { randomUUID: () => 'synthetic-request-key' };
  context.api = url => url === '/api/records' ? pending.promise : Promise.resolve({});
  context.refreshAfterCommit = async () => true;
  context.updateCreatePreview = () => {};
  context.openModal();
  run("state.form.domains = 'synthetic.example'; state.form.start_seq = 'test1'");
  const creating = run("doCreate({ domains: ['synthetic.example'], fp_prefix: 'test' })");
  await run('lockSensitive()');
  run("state.form.domains = 'next-draft.example'; state.form.start_seq = 'next100'; state.picked.emails = new Set([7])");
  let opened = 0, closed = 0;
  context.openModal = () => { opened++; };
  context.closeModal = () => { closed++; };
  context.openModal(); // The user has moved on to a different task.
  pending.resolve({ created: [{ fingerprint: 'test1', seq: 1 }] });
  await creating;
  assert.equal(opened, 1, 'the completed write must not replace the newer task');
  assert.equal(closed, 0, 'the completed write must not close the newer task');
  assert.equal(run('state.form.domains'), 'next-draft.example');
  assert.equal(run('state.form.start_seq'), 'next100');
  assert.equal(run('state.picked.emails.has(7)'), true);
});
