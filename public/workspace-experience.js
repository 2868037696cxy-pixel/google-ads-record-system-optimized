'use strict';

// Shared presentation rules only. Allocation and duplicate checks stay on the server.
globalThis.WorkbenchExperience = (() => {
  const resources = Object.freeze([
    { key: 'emails', label: '邮箱', unit: '个' }, { key: 'proxies', label: 'IP', unit: '个' },
    { key: 'cards', label: '信用卡', unit: '张' }, { key: 'licenses', label: '企业文件', unit: '份' },
  ].map(Object.freeze));
  const commands = Object.freeze([
    ...[{ key: 'overview', label: '运营总览', hint: '查看库存与优先处理事项', keywords: 'overview dashboard 总览 库存' },
      { key: 'records', label: '我的记录', hint: '搜索、筛选与导出账号记录', keywords: 'records 账号 列表 搜索' },
      { key: 'create', label: '新建记录', hint: '填写域名，核对资源组合', keywords: 'create 创建 自动组合' },
      { key: 'emails', label: '邮箱池', hint: '管理邮箱资源', keywords: 'emails mail 邮箱' },
      { key: 'proxies', label: 'IP 池', hint: '管理代理与 IP 资源', keywords: 'proxies ip 代理' },
      { key: 'cards', label: '信用卡', hint: '管理信用卡别名与末四位', keywords: 'cards 信用卡' },
      { key: 'licenses', label: '营业执照', hint: '查看原件、校对企业资料', keywords: 'licenses pdf 营业执照 企业 文件' },
      { key: 'settings', label: '设置', hint: '显示偏好、账号与数据管理', keywords: 'settings 设置 备份 安全' }]
      .map(page => ({ ...page, id: 'nav-' + page.key, type: 'nav', icon: page.key })),
    ...resources.map(resource => ({ id: 'import-' + resource.key, key: resource.key, type: 'import', icon: 'import', label: '导入' + resource.label, hint: '打开导入与校对面板', keywords: `import 导入 ${resource.key} ${resource.label} ${resource.key === 'licenses' ? 'PDF 营业执照' : ''}` })),
  ].map(Object.freeze));
  function inventory(pools) {
    const items = resources.map(resource => {
      const all = pools[resource.key] || [];
      const available = all.filter(item => item.status === '未使用' && !Number(item.linked_record_count)).length;
      return { ...resource, total: all.length, available, occupied: all.filter(item => Number(item.linked_record_count) > 0 || item.status === '已使用').length };
    });
    return { items, capacity: Math.min(...items.map(item => item.available)), missing: items.filter(item => !item.available) };
  }
  function filterCommands(query) {
    const terms = String(query || '').normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
    return commands.filter(command => terms.every(term => `${command.label} ${command.hint} ${command.keywords}`.toLowerCase().includes(term)));
  }
  function openCommands({ open, close, signal, select }) {
    if (document.querySelector('#modal-root .modal')) return;
    const escape = WorkbenchUI.escape;
    open(`<div class="modal-head command-heading"><div><span class="license-eyebrow">快捷操作</span><h3>下一步，直接前往</h3></div><button class="modal-close" data-action="close-modal" aria-label="关闭">✕</button></div>
      <div class="modal-body command-body"><label class="command-search-label" for="command-query">搜索页面与操作</label><div class="command-search">${WorkbenchUI.icon('search')}<input id="command-query" data-autofocus type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="command-results" autocomplete="off" placeholder="输入页面名称，例如：营业执照、导入邮箱"><kbd>Esc</kbd></div>
      <div id="command-results" class="command-results" role="listbox" aria-label="可用页面与操作"></div><p id="command-status" class="sr-only" role="status" aria-live="polite"></p></div>
      <div class="modal-foot command-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span>仅搜索页面与操作</span></div>`);
    const input = document.getElementById('command-query'), list = document.getElementById('command-results');
    let matches = [], active = 0;
    const highlight = () => {
      const options = [...list.querySelectorAll('[role="option"]')];
      options.forEach((option, index) => option.setAttribute('aria-selected', String(index === active)));
      if (options[active]) { input.setAttribute('aria-activedescendant', options[active].id); options[active].scrollIntoView({ block: 'nearest' }); }
      else input.removeAttribute('aria-activedescendant');
    };
    const paint = () => {
      matches = filterCommands(input.value); active = 0;
      list.innerHTML = matches.length ? matches.map((command, index) => `<button type="button" role="option" tabindex="-1" id="command-option-${index}" data-command="${index}" aria-selected="${index === 0}"><span class="command-icon">${WorkbenchUI.icon(command.icon)}</span><span><strong>${escape(command.label)}</strong><small>${escape(command.hint)}</small></span><span class="command-type">${command.type === 'nav' ? '前往' : '操作'} ${WorkbenchUI.icon('arrow-right')}</span></button>`).join('') : '<div class="command-empty"><strong>没有找到对应页面或操作</strong><p>试试“邮箱”“企业文件”或“设置”。</p></div>';
      document.getElementById('command-status').textContent = `找到 ${matches.length} 个页面与操作`;
      highlight();
    };
    const run = index => { const command = matches[index]; if (!command) return; close(); select(command); };
    input.addEventListener('input', paint, { signal: signal() });
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && matches.length) {
        event.preventDefault(); active = event.key === 'Home' ? 0 : event.key === 'End' ? matches.length - 1 : (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; highlight();
      } else if (event.key === 'Enter') { event.preventDefault(); run(active); }
    }, { signal: signal() });
    list.addEventListener('click', event => { const option = event.target.closest('[data-command]'); if (option) run(Number(option.dataset.command)); }, { signal: signal() });
    paint();
  }
  return Object.freeze({ resources, inventory, filterCommands, openCommands });
})();
if (typeof module !== 'undefined') module.exports = globalThis.WorkbenchExperience;
