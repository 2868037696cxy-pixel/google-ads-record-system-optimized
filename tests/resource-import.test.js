'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createPreview } = require('../public/resource-import');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness() {
  const abort = new AbortController(), requests = [], reads = [], results = [], states = [], timers = new Map();
  let text = 'initial', connected = true, timer = 0;
  const controller = createPreview({
    readText: () => text, writeText: value => { text = value; }, isActive: () => connected, signal: abort.signal,
    request(value, signal) { const pending = deferred(); requests.push({ text: value, signal, ...pending }); return pending.promise; },
    loadText(file, signal) { const pending = deferred(); reads.push({ file, signal, ...pending }); return pending.promise; },
    onResult: result => results.push(result), onReset() {}, onState: (...state) => states.push(state),
    timers: { setTimeout(callback) { timers.set(++timer, callback); return timer; }, clearTimeout(id) { timers.delete(id); } },
  });
  return { controller, abort, requests, reads, results, states, timers, setText(value) { text = value; }, getText: () => text, disconnect() { connected = false; } };
}

test('closed dialogs cancel debounce and active parsing, even when I/O ignores cancellation', async () => {
  const h = harness(); h.controller.schedule(); h.abort.abort();
  assert.equal(h.timers.size, 0); assert.equal(await h.controller.parse(), false); assert.equal(h.requests.length, 0);
  const live = harness(), pending = live.controller.parse(); live.abort.abort();
  assert.equal(live.requests[0].signal.aborted, true);
  live.requests[0].resolve({ items: [1] });
  assert.equal(await pending, false); assert.deepEqual(live.results, []);
});

test('late parse successes and failures cannot overwrite the newest preview', async () => {
  for (const fail of [false, true]) {
    const h = harness(), old = h.controller.parse();
    h.setText('new'); const newest = h.controller.parse();
    h.requests[1].resolve({ items: ['new'] }); assert.equal(await newest, true);
    if (fail) h.requests[0].reject(new Error('old error')); else h.requests[0].resolve({ items: ['old'] });
    assert.equal(await old, false);
    assert.deepEqual(h.results, [{ items: ['new'] }]); assert.deepEqual(h.states.at(-1), ['ready']);
  }
});

test('old file errors cannot replace a newer valid file and its parsed candidate', async () => {
  const h = harness(), old = h.controller.loadFile({ size: 10, name: 'old.txt' });
  const newest = h.controller.loadFile({ size: 10, name: 'new.txt' });
  assert.equal(h.reads[0].signal.aborted, true);
  h.reads[1].resolve('new@example.test'); await Promise.resolve();
  h.requests[0].resolve({ items: ['new'] }); assert.equal(await newest, true);
  h.reads[0].reject(new Error('old file failed')); assert.equal(await old, false);
  assert.equal(h.getText(), 'new@example.test'); assert.deepEqual(h.states.at(-1), ['ready']);
});

test('editing and reverting text still invalidate a pending file read', async () => {
  const h = harness(), pending = h.controller.loadFile({ size: 10 });
  h.setText('edited'); h.controller.schedule(); h.setText('initial'); h.controller.schedule();
  h.reads[0].resolve('obsolete file contents');
  assert.equal(await pending, false); assert.equal(h.getText(), 'initial'); assert.equal(h.requests.length, 0);
});

test('oversized files and file reads after close cannot create a parsed candidate', async () => {
  const h = harness();
  assert.equal(await h.controller.loadFile({ size: 10 * 1024 * 1024 + 1 }), false);
  assert.equal(h.reads.length, 0); assert.match(h.states.at(-1)[1], /10 MB/);
  const pending = h.controller.loadFile({ size: 10 }); h.abort.abort(); h.reads[0].resolve('late');
  assert.equal(await pending, false); assert.equal(h.getText(), 'initial'); assert.equal(h.requests.length, 0);
});

test('a current parse failure retains text and supports an explicit retry', async () => {
  const h = harness(), failed = h.controller.parse();
  h.requests[0].reject(new Error('maintenance')); assert.equal(await failed, false);
  assert.deepEqual(h.states.at(-1), ['error', 'maintenance']); assert.equal(h.getText(), 'initial');
  const retry = h.controller.parse(); h.requests[1].resolve({ items: [1] });
  assert.equal(await retry, true); assert.equal(h.requests[1].text, 'initial');
});
