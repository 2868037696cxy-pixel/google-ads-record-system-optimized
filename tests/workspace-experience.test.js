'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const experience = require('../public/workspace-experience');

test('readiness ignores disabled and linked resources even when their displayed status was reset', () => {
  const pools = Object.fromEntries(experience.resources.map(resource => [resource.key, [
    { status: '未使用', linked_record_count: 0 }, { status: '已使用', linked_record_count: 1 },
    { status: '未使用', linked_record_count: 2 }, { status: '停用' },
  ]]));
  const result = experience.inventory(pools);
  assert.equal(result.capacity, 1);
  assert.deepEqual(result.items.map(item => item.available), [1, 1, 1, 1]);
  assert.deepEqual(result.items.map(item => item.occupied), [2, 2, 2, 2]);
  pools.licenses = [];
  assert.equal(experience.inventory(pools).capacity, 0);
  assert.deepEqual(experience.inventory(pools).missing.map(item => item.key), ['licenses']);
});

test('command filtering supports multiple Chinese terms, aliases and fullwidth input; commands contain no record data', () => {
  assert.equal(experience.filterCommands('导入 邮箱').length, 1);
  assert.equal(experience.filterCommands('ＩＰ').find(item => item.key === 'proxies').type, 'nav');
  assert.ok(experience.filterCommands('pdf').some(item => item.key === 'licenses'));
  assert.equal(experience.filterCommands('<img onerror=alert(1)>').length, 0);
  assert.ok(experience.filterCommands('').every(item => ['nav', 'import'].includes(item.type)));
  assert.ok(Object.isFrozen(experience));
});
