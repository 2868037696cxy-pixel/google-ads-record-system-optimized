'use strict';

// A panel owns exactly one renderer and fetch. Replacing/closing it cancels both.
globalThis.WorkbenchDocumentViewer = (() => {
  let modulePromise;
  const loadModule = () => modulePromise ||= import('/vendor/file-viewer/viewer.js').catch(error => { modulePromise = null; throw error; });
  function markup() {
    return `<section class="document-preview" aria-label="营业执照原件预览" data-state="empty">
      <header class="document-preview-head"><span class="document-file-mark" aria-hidden="true">PDF</span><div><strong>原件预览</strong><span class="document-preview-name">与右侧资料对照校对</span></div><span class="document-preview-badge">原始文件</span><button type="button" class="btn btn-ghost btn-sm document-jump-fields">查看资料 ↓</button></header>
      <div class="document-viewer-stage"><div class="document-viewer-host" hidden></div>
        <div class="document-preview-message" role="status" aria-live="polite"><span class="document-empty-symbol" aria-hidden="true">▤</span><strong>在这里查看营业执照</strong><p>选择 PDF 后即可一边看原件，一边校对资料。</p><button type="button" class="btn btn-ghost btn-sm document-retry" hidden>重新加载原件</button></div>
      </div><footer class="document-preview-note">原件用于核对 · 资料保留证书原文</footer>
    </section>`;
  }
  function attach(panel, signal) {
    const host = panel.querySelector('.document-viewer-host');
    const message = panel.querySelector('.document-preview-message');
    const title = message.querySelector('strong'), description = message.querySelector('p');
    const retry = panel.querySelector('.document-retry'), name = panel.querySelector('.document-preview-name');
    let renderer, request, loadingTimer, version = 0, source = null, disposed = false;
    function cleanup() { clearTimeout(loadingTimer); request?.abort(); request = null; renderer?.destroy(); renderer = null; }
    function paint(phase, heading, detail = '') {
      panel.dataset.state = phase;
      panel.setAttribute('aria-busy', String(phase === 'loading'));
      host.hidden = phase !== 'ready'; message.hidden = phase === 'ready';
      title.textContent = heading; description.textContent = detail;
      retry.hidden = phase !== 'error';
      if (phase !== 'loading') clearTimeout(loadingTimer);
    }
    async function show(next) {
      if (disposed) return;
      source = next; const current = ++version; cleanup();
      name.textContent = next?.name || '与资料对照校对';
      if (!next) { paint('empty', '在这里查看营业执照', '选择 PDF 后即可一边看原件，一边校对资料。'); return; }
      if (next.file?.size > 10 * 1024 * 1024) { paint('error', '文件超过 10 MB', '请选择较小的 PDF 后继续。'); retry.hidden = true; return; }
      paint('loading', '正在打开原件…', '首次打开需加载预览组件，请稍候。');
      request = new AbortController();
      const currentRequest = request;
      const active = () => !disposed && current === version && panel.isConnected;
      loadingTimer = setTimeout(() => {
        if (active()) { version++; cleanup(); paint('error', '预览加载超时', '可重新加载原件，已填写的资料会保留。'); }
      }, 30000);
      try {
        const mod = await loadModule();
        if (!active()) return;
        let file = next.file;
        if (!file) {
          const response = await fetch(`/api/licenses/${next.id}/pdf`, { credentials: 'same-origin', signal: AbortSignal.any([currentRequest.signal, AbortSignal.timeout(20000)]) });
          if (!response.ok) throw new Error(response.status === 401 ? '登录已过期，请重新登录后查看原件。' : response.status === 404 ? '原件不存在或您无权查看。' : '原件读取失败，请重试。');
          if (!String(response.headers.get('content-type')).startsWith('application/pdf')) throw new Error('服务器未返回 PDF 原件，请重新连接后重试。');
          const blob = await response.blob();
          if (blob.size > 10 * 1024 * 1024) throw new Error('原件超过预览大小限制。');
          file = new File([blob], next.name || '营业执照.pdf', { type: 'application/pdf' });
        }
        if (!active()) return;
        // Keep a measurable canvas surface during loading; the status overlays it.
        host.hidden = false;
        renderer = mod.mountDocument(host, file, state => {
          if (!active()) return;
          if (state.error) paint('error', '暂时无法预览', '文件可能已损坏、加密或网络中断。可重试，也可以继续校对资料。');
          else if (state.ready) paint('ready', '原件已就绪');
        });
      } catch (error) {
        if (active()) paint('error', '暂时无法打开原件', error.name === 'TimeoutError' ? '读取超时，请重试；已填写的资料会保留。' : error.message || '请检查连接后重试。');
      }
    }
    retry.onclick = () => void show(source);
    panel.querySelector('.document-jump-fields').onclick = () => {
      const fields = panel.closest('.document-review-layout').querySelector('.document-fields');
      fields?.scrollIntoView({ block: 'start' });
      const target = fields?.querySelector('input:not(:disabled), button');
      target?.focus({ preventScroll: true });
    };
    const destroy = () => { if (disposed) return; disposed = true; version++; cleanup(); signal?.removeEventListener('abort', destroy); };
    signal?.addEventListener('abort', destroy, { once: true });
    if (signal?.aborted) destroy();
    return Object.freeze({ show, destroy });
  }
  return Object.freeze({ markup, attach });
})();
