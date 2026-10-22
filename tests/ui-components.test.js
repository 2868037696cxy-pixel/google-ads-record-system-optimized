'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const UI = require('../public/ui-components');

test('shared component text and attributes cannot introduce executable markup', () => {
  const hostile = '<img src=x onerror="alert(1)"> & \'quote\'';
  const button = UI.button({ label: hostile, action: 'nav', data: { page: '\" autofocus onfocus=alert(1)', 'bad" onclick': 'ignored' } });
  assert.ok(!button.includes('<img'));
  assert.ok(button.includes('&lt;img'));
  assert.ok(button.includes('data-page="&quot; autofocus'));
  assert.ok(!button.includes('data-bad'));
  assert.ok(!UI.emptyState({ title: hostile, description: hostile }).includes('<img'));
  assert.ok(!UI.status(hostile, hostile).includes('<img'));
  assert.ok(UI.status('正常', hostile).includes('data-tone="neutral"'));
});

test('component public API is immutable and runs without a browser or application state', () => {
  assert.ok(Object.isFrozen(UI));
  assert.ok(Object.isFrozen(UI.dialog));
  assert.ok(UI.button({ label: '删除', action: 'delete', variant: 'danger', disabled: true }).includes(' disabled'));
  assert.ok(UI.icon('unknown').includes('aria-hidden="true"'));
});
