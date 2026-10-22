'use strict';

// One policy for browser validation, API registration and account administration.
// Count Unicode characters rather than UTF-16 units, including extended Han names.
(function (root, factory) {
  const rules = factory();
  if (typeof module === 'object' && module.exports) module.exports = rules;
  else root.WorkbenchUsername = rules;
})(globalThis, function () {
  const MIN_LENGTH = 2;
  const MAX_LENGTH = 32;
  const CHARACTERS = /^[\p{Script=Han}A-Za-z0-9_.-]+$/u;
  const PATTERN = new RegExp(`^[\\p{Script=Han}A-Za-z0-9_.-]{${MIN_LENGTH},${MAX_LENGTH}}$`, 'u');

  function errorFor(value, { minLength = MIN_LENGTH, maxLength = MAX_LENGTH } = {}) {
    const name = String(value ?? '').trim();
    const length = Array.from(name).length;
    if (!length) return '请输入用户名';
    if (length < minLength) return `用户名至少 ${minLength} 个字符`;
    if (length > maxLength) return `用户名最多 ${maxLength} 个字符`;
    if (!CHARACTERS.test(name)) return '用户名仅支持中文、英文字母、数字、下划线、点和短横线';
    return '';
  }
  return Object.freeze({ MIN_LENGTH, MAX_LENGTH, PATTERN, errorFor });
});
