'use strict';

/* Shared native components. No API access, account state, secrets or persistence. */
globalThis.WorkbenchUI = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const paths = Object.freeze({
    records: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/>',
    create: '<path d="M12 5v14M5 12h14"/>',
    overview: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
    emails: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    proxies: '<path d="M7 4v16m-4-4 4 4 4-4M17 20V4m-4 4 4-4 4 4"/>',
    cards: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/>',
    licenses: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5"/>',
    settings: '<path d="m9 3-1 3-3 1 1 4-2 2 2 4 3-1 3 2 3-2 3 1 2-4-2-2 1-4-3-1-1-3z"/><circle cx="12" cy="11" r="3"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    import: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  });
  function icon(name) {
    return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.records}</svg>`;
  }
  function button({ label, action, variant = 'secondary', size = 'md', data = {}, disabled = false }) {
    const style = ({ primary: 'btn-primary', secondary: 'btn-ghost', danger: 'btn-danger' })[variant] || 'btn-ghost';
    const attributes = Object.entries(data).filter(([key]) => /^[a-z][a-z0-9-]*$/.test(key)).map(([key, value]) => `data-${key}="${escape(value)}"`).join(' ');
    return `<button type="button" class="btn ${style}${size === 'sm' ? ' btn-sm' : ''}" data-action="${escape(action)}" ${attributes}${disabled ? ' disabled' : ''}>${escape(label)}</button>`;
  }
  function emptyState({ title, description, iconName = 'records', action, actionLabel, data = {} }) {
    return `<div class="empty"><div class="empty-ico">${icon(iconName)}</div><h3>${escape(title)}</h3><p>${escape(description)}</p>${action ? button({ label: actionLabel, action, data }) : ''}</div>`;
  }
  function status(label, tone = 'neutral') {
    const safeTone = ['success', 'danger', 'warning', 'neutral'].includes(tone) ? tone : 'neutral';
    return `<span class="ui-status" data-tone="${safeTone}">${escape(label)}</span>`;
  }
  function busy(button, value, label) {
    if (!button) return;
    if (value && !button.hasAttribute('aria-busy')) button.dataset.idleLabel = button.textContent;
    button.disabled = value;
    if (value) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
    if (label !== undefined) button.textContent = label;
    else if (!value && button.dataset.idleLabel !== undefined) button.textContent = button.dataset.idleLabel;
    if (!value) delete button.dataset.idleLabel;
  }
  let fieldSequence = 0;
  function positionMenu(menu) {
    const anchor = menu.querySelector('summary').getBoundingClientRect();
    const below = innerHeight - anchor.bottom - 20;
    const above = anchor.top - 20;
    const useAbove = below < 260 && above > below;
    menu.dataset.side = useAbove ? 'above' : 'below';
    menu.style.setProperty('--menu-max-height', `${Math.max(100, Math.min(480, useAbove ? above : below))}px`);
  }
  function enhance(root = document) {
    root.querySelectorAll('.field').forEach(field => {
      const label = field.querySelector('label');
      const input = field.querySelector('input, select, textarea');
      if (input && !input.id) input.id = `ui-field-${++fieldSequence}`;
      if (label && input && label.htmlFor !== input.id) label.htmlFor = input.id;
    });
    root.querySelectorAll('[data-copy], span[data-action="view-license"], .step-card[data-action]').forEach(element => {
      if (!element.matches('button, a, input, select, textarea')) {
        element.setAttribute('role', 'button');
        element.tabIndex = 0;
        if (element.hasAttribute('data-copy')) element.setAttribute('aria-label', element.title || '复制此字段');
        else if (element.dataset.action === 'view-license') element.setAttribute('aria-label', '查看营业执照详情');
      }
    });
    root.querySelectorAll('th:not([scope])').forEach(header => { header.scope = header.closest('thead') ? 'col' : 'row'; });
  }

  let opener = null;
  const focusable = modal => [...modal.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter(element => !element.disabled && element.getClientRects().length);
  const isBusy = () => Boolean(document.querySelector('#modal-root .modal[data-submitting]'));
  function closeDialog() {
    document.getElementById('modal-root').replaceChildren();
    document.querySelector('.app').inert = false;
    document.removeEventListener('keydown', onDialogKey);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    else if (opener) document.querySelector('#nav [aria-current="page"]')?.focus({ preventScroll: true });
    opener = null;
  }
  function onDialogKey(event) {
    const modal = document.querySelector('#modal-root .modal');
    if (!modal) return;
    if (event.key === 'Escape') { event.preventDefault(); if (!isBusy()) closeDialog(); }
    if (event.key !== 'Tab') return;
    const controls = focusable(modal), first = controls[0], last = controls.at(-1);
    if (!controls.length) { event.preventDefault(); modal.focus(); }
    else if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement) || document.activeElement === modal)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement) || document.activeElement === modal)) { event.preventDefault(); first.focus(); }
  }
  function openDialog(html, { large = false } = {}) {
    const previousOpener = document.getElementById('modal-root').firstElementChild ? opener : document.activeElement;
    closeDialog();
    opener = previousOpener;
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal-overlay" data-action="modal-overlay"><div class="modal${large ? ' modal-lg' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">${html}</div></div>`;
    const title = root.querySelector('h3');
    if (title) title.id = 'modal-title';
    root.querySelectorAll('.modal-close').forEach(button => button.setAttribute('aria-label', '关闭'));
    enhance(root);
    document.querySelector('.app').inert = true;
    const preferred = root.querySelector('[data-autofocus], input:not([type=file]):not([type=checkbox]):not([disabled]), textarea:not([disabled]), select:not([disabled])');
    (preferred || focusable(root)[0] || root.querySelector('.modal')).focus({ preventScroll: true });
    document.addEventListener('keydown', onDialogKey);
  }
  return Object.freeze({ escape, icon, button, emptyState, status, busy, enhance, positionMenu, dialog: Object.freeze({ open: openDialog, close: closeDialog, isBusy }) });
})();

if (typeof module !== 'undefined') module.exports = globalThis.WorkbenchUI;
