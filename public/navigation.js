'use strict';

// Native disclosure behavior stays independent of account and data state.
(() => {
  const sidebar = document.getElementById('workspaceSidebar');
  if (!sidebar || typeof sidebar.hidePopover !== 'function') return;
  const compact = matchMedia('(max-width: 700px)');
  const close = () => {
    if (sidebar.matches(':popover-open')) sidebar.hidePopover();
  };
  sidebar.addEventListener('beforetoggle', event => {
    document.getElementById('mobileNavToggle')?.setAttribute('aria-expanded', String(event.newState === 'open'));
  });
  sidebar.addEventListener('click', event => {
    if (compact.matches && event.target.closest('[data-action]')) close();
  });
  compact.addEventListener('change', close);
})();
