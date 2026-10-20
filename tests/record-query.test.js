'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create } = require('../public/record-query');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function harness() {
  const query = { page: 1, limit: 50, sort: 'id_desc', q: '', status: '全部', reveal: false, sensitiveEpoch: 0 };
  const requests = [], results = [], phases = [], renders = [], errors = [], timers = new Map();
  let timerID = 0;
  const controller = create({
    readQuery: () => query,
    request(path, options) { const pending = deferred(); requests.push({ path, ...options, ...pending }); return pending.promise; },
    onPhase: (...value) => phases.push(value), onResult: value => results.push(value),
    onRender: value => renders.push(value), onError: value => errors.push(value),
    clock: { setTimeout(callback) { timers.set(++timerID, callback); return timerID; }, clearTimeout(id) { timers.delete(id); } },
  });
  const flush = async () => { for (const [id, callback] of timers) { timers.delete(id); callback(); } await Promise.resolve(); };
  return { controller, query, requests, results, phases, renders, errors, timers, flush };
}
const data = (id, total = 1) => ({ items: [{ id }], total });

test('superseded successes and failures cannot replace the newest result or feedback', async () => {
  for (const fail of [false, true]) {
    const h = harness();
    const old = h.controller.load({ renderMode: 'full' });
    h.query.q = ' newest ';
    const newest = h.controller.load({ renderMode: 'table' });
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(new URL(h.requests[1].path, 'https://fixture.test').searchParams.get('q'), 'newest');
    h.requests[1].resolve(data(2));
    assert.equal(await newest, true);
    if (fail) h.requests[0].reject(new Error('obsolete failure'));
    else h.requests[0].resolve(data(1, 999));
    assert.equal(await old, false);
    assert.deepEqual(h.results, [{ ...data(2), page: 1 }]);
    assert.deepEqual(h.renders, ['table']);
    assert.deepEqual(h.phases.at(-1), ['ready', '', '']);
  }
});

test('debounce cancels immediately, coalesces changes and reports only the active failure', async () => {
  const h = harness();
  const old = h.controller.load();
  h.query.q = 'first'; h.controller.schedule({ renderMode: 'table' });
  assert.equal(h.requests[0].signal.aborted, true);
  h.requests[0].resolve(data(0));
  assert.equal(await old, false, 'old responses are invalid even before the new fetch starts');
  h.query.q = 'final'; h.controller.schedule({ renderMode: 'table' });
  assert.equal(h.timers.size, 1);
  await h.flush();
  assert.equal(h.requests.length, 2);
  assert.match(h.requests[1].path, /q=final/);
  const failure = new Error('maintenance');
  h.requests[1].reject(failure);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.phases.at(-1), ['error', 'maintenance', '']);
  assert.deepEqual(h.errors, [failure]);
  assert.deepEqual(h.results, []);
  const retry = h.controller.load({ renderMode: 'table' });
  h.requests[2].resolve(data(3));
  assert.equal(await retry, true);
  assert.deepEqual(h.phases.at(-1), ['ready', '', '']);
});

test('page correction publishes one complete result and uses one cancellation signal', async () => {
  const h = harness(); h.query.page = 4;
  const loading = h.controller.load({ renderMode: 'table' });
  h.requests[0].resolve({ items: [], total: 61 });
  await Promise.resolve();
  assert.equal(h.query.page, 4, 'caller state is not changed before the corrected page arrives');
  assert.deepEqual(h.results, []);
  assert.match(h.requests[1].path, /offset=50/);
  assert.equal(h.requests[0].signal, h.requests[1].signal);
  h.requests[1].resolve(data(61, 61));
  assert.equal(await loading, true);
  assert.deepEqual(h.results, [{ ...data(61, 61), page: 2 }]);
  assert.deepEqual(h.renders, ['table']);
});

test('a replacement query also cancels a page-correction request', async () => {
  const h = harness(); h.query.page = 3;
  const old = h.controller.load();
  h.requests[0].resolve({ items: [], total: 1 });
  await Promise.resolve();
  h.query.page = 1; h.query.q = 'new';
  const newest = h.controller.load();
  h.requests[2].resolve(data(7));
  await newest;
  h.requests[1].resolve(data(6));
  assert.equal(await old, false);
  assert.deepEqual(h.results, [{ ...data(7), page: 1 }]);
});

test('all query fields and the sensitive epoch guard response ownership', async () => {
  for (const [key, value] of Object.entries({ page: 2, limit: 100, sort: 'id_asc', q: 'different', status: '异常', reveal: true, sensitiveEpoch: 1 })) {
    const h = harness();
    const pending = h.controller.load();
    h.query[key] = value;
    h.requests[0].resolve(data('late-secret'));
    assert.equal(await pending, false, key);
    assert.deepEqual(h.results, [], key);
  }
});

test('malformed pagination preserves existing data and can be retried', async () => {
  for (const total of [null, '1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const h = harness();
    const pending = h.controller.load();
    h.requests[0].resolve({ items: [], total });
    await assert.rejects(pending, /记录分页数据格式不正确/);
    assert.deepEqual(h.results, []);
    assert.equal(h.phases.at(-1)[0], 'error');
  }
});

test('invalidating a scheduled query prevents it from starting', async () => {
  const h = harness();
  h.controller.schedule();
  h.controller.invalidate({ reason: 'composition' });
  await h.flush();
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.phases.at(-1), ['loading', '', 'composition']);
});
