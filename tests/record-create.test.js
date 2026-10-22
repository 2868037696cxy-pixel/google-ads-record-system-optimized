'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { draft, parseStart, createSubmitter } = require('../public/record-create');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const fixture = () => ({
  form: { domains: 'https://ONE.example/path\nTWO.example', start_seq: '10.20ads7', country: '波兰', product: '测试', proxy_mode: 'shared', proxy_id: '4', id_card: 'SYNTHETIC-PRIVATE' },
  picked: { emails: new Set([3]), cards: new Set(), licenses: new Set() },
  resources: Object.fromEntries(['emails','cards','licenses','proxies'].map(kind => [kind, { total: 0, available: 0, label: kind }])),
  dateKey: '10.20', nextSeq: 15,
});

test('draft rules normalize domains, preserve selected IDs and do not mutate the source', () => {
  const source = fixture(), result = draft(source);
  assert.equal(result.error, '');
  assert.deepEqual(result.body.domains, ['one.example', 'two.example']);
  assert.deepEqual(result.body.email_ids, [3]);
  assert.equal(result.body.proxy_id, 4);
  assert.equal(result.fp.seq, 7);
  result.body.domains.push('another.example'); result.body.email_ids.push(9);
  assert.equal(source.form.domains, 'https://ONE.example/path\nTWO.example');
  assert.deepEqual([...source.picked.emails], [3]);
  assert.deepEqual(parseStart('', { dateKey: '10.20', nextSeq: 15 }), { prefix: '10.20ads', seq: 15, display: '10.20ads15' });
});

test('draft validation keeps duplicate, count, sequence and inventory boundaries', () => {
  let source = fixture(); source.form.domains = 'https://same.example/a\nSAME.EXAMPLE';
  assert.match(draft(source).error, /重复/);
  source.form.domains = Array.from({ length: 501 }, (_, i) => `${i}.example`).join('\n');
  assert.match(draft(source).error, /500/);
  source = fixture(); source.form.start_seq = '0'; assert.equal(draft(source).field, 'f-start');
  source.form.start_seq = String(Number.MAX_SAFE_INTEGER); assert.equal(draft(source).field, 'f-start');
  source = fixture(); source.resources.emails = { total: 2, available: 1, label: '邮箱库' };
  assert.match(draft(source).error, /邮箱库可用资源不足/);
  source.resources.emails.total = 0; assert.equal(draft(source).error, '', 'empty pools retain the existing unlinked creation behavior');
});

test('a lost response retries the exact snapshot with the same key; changed drafts use a new key', async () => {
  const requests = []; let keys = 0;
  const submitter = createSubmitter({ newKey: () => `key-${++keys}`, request: async (path, options) => {
    requests.push(options);
    if (requests.length === 1) throw new Error('response lost');
    return { created: [{ id: 1 }] };
  } });
  const body = draft(fixture()).body;
  await assert.rejects(submitter.submit(body), /response lost/);
  await submitter.submit(body);
  assert.equal(requests[0].headers['idempotency-key'], requests[1].headers['idempotency-key']);
  await submitter.submit({ ...body, domains: ['different.example'] });
  assert.notEqual(requests[1].headers['idempotency-key'], requests[2].headers['idempotency-key']);
  assert.ok(Object.isFrozen(submitter));
  assert.deepEqual(Object.keys(submitter), ['submit'], 'no serialized draft or credentials are exposed as retained application state');
});

test('double submit is ignored while hashing and later mutations cannot change the reviewed payload', async () => {
  const gate = deferred(), requests = [];
  const submitter = createSubmitter({ hash: () => gate.promise, newKey: () => 'key', request: async (_, options) => { requests.push(options); return {}; } });
  const body = draft(fixture()).body;
  const first = submitter.submit(body);
  assert.equal(await submitter.submit(body), null);
  body.domains[0] = 'changed.example'; body.id_card = 'changed';
  gate.resolve('digest'); await first;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.domains[0], 'one.example');
  assert.equal(requests[0].body.id_card, 'SYNTHETIC-PRIVATE');
});

test('closing during digest preparation prevents a new write, but cannot undo an already sent write', async () => {
  const gate = deferred(), abort = new AbortController(); let writes = 0;
  const submitter = createSubmitter({ hash: () => gate.promise, request: async () => { writes++; } });
  const pending = submitter.submit({}, { signal: abort.signal }); abort.abort(); gate.resolve('digest');
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(writes, 0);
  const sent = deferred();
  const live = createSubmitter({ hash: async () => 'digest', request: () => { writes++; return sent.promise; } });
  const result = live.submit({}); await Promise.resolve();
  sent.resolve({ created: [1] });
  assert.deepEqual(await result, { created: [1] }); assert.equal(writes, 1);
});
