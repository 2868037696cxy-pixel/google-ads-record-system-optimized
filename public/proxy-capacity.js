/* Shared IP allocation policy: a use is a current record association. */
'use strict';
(function (root) {
  const MAX_LIMIT = 100000;
  function valid(value) { return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT; }
  function limit(item) { return Number(item.usage_limit ?? 1); }
  function remaining(item) {
    const used = Number(item.linked_record_count || 0);
    if (item.status === '停用' || (item.status === '已使用' && !used)) return 0;
    return Math.max(0, limit(item) - used);
  }
  function allocate(pool, ids, count) {
    if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id < 1))) return { error: 'IP 选择格式不正确' };
    const selected = [...new Set(ids || [])].map(id => pool.find(item => item.id === id));
    if (selected.some(item => !item || !remaining(item))) return { error: '所选 IP 不存在或使用次数已满，请刷新后重新选择' };
    const items = [], used = new Map();
    const take = item => { items.push(item); used.set(item.id, (used.get(item.id) || 0) + 1); };
    for (const item of selected) { if (items.length < count) take(item); }
    for (const item of [...selected, ...pool.filter(item => !selected.includes(item))]) {
      const slots = remaining(item) - (used.get(item.id) || 0);
      for (let i = 0; i < slots && items.length < count; i++) take(item);
      if (items.length === count) break;
    }
    if (items.length < count && (pool.length || selected.length)) return { error: `IP 剩余使用次数不足：需要 ${count} 次，剩余 ${items.length} 次` };
    return { items };
  }
  const policy = Object.freeze({ MAX_LIMIT, valid, limit, remaining, allocate });
  if (typeof module !== 'undefined' && module.exports) module.exports = policy;
  root.WorkbenchProxyCapacity = policy;
})(globalThis);
