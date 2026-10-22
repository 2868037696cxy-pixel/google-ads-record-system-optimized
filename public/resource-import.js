'use strict';

globalThis.WorkbenchResourceImport = (() => {
  const clock = { setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms), clearTimeout: id => globalThis.clearTimeout(id) };
  function readFileText(file, signal) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const abort = () => { reader.abort(); finish(reject, new DOMException('已取消', 'AbortError')); };
      const finish = (settle, value) => {
        signal.removeEventListener('abort', abort);
        reader.onload = reader.onerror = null;
        settle(value);
      };
      reader.onload = () => finish(resolve, String(reader.result || ''));
      reader.onerror = () => finish(reject, new Error('文件读取失败，请重新选择'));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      reader.readAsText(file);
    });
  }
  function createPreview({ readText, writeText, request, isActive, onState, onResult, onReset, signal, timers = clock, loadText = readFileText }) {
    let revision = 0, timer = null, active = null, closed = false;
    const alive = () => !closed && !signal.aborted && isActive();
    const cancel = () => { ++revision; timers.clearTimeout(timer); timer = null; active?.abort(); active = null; onReset(); };
    function invalidate(reason = 'input') {
      cancel();
      if (alive()) onState(readText().trim() ? reason : 'empty');
    }
    async function parse() {
      cancel();
      if (!alive()) return false;
      const text = readText(), id = revision;
      if (!text.trim()) { onState('empty'); return false; }
      const controller = new AbortController(); active = controller;
      onState('parsing');
      const current = () => alive() && id === revision && readText() === text;
      try {
        const result = await request(text, AbortSignal.any([controller.signal, signal, AbortSignal.timeout(20000)]));
        if (!current()) return false;
        onResult(result);
        onState('ready');
        return true;
      } catch (error) {
        if (current()) { onReset(); onState('error', error.name === 'TimeoutError' ? '识别超时，请重试或减少文本内容' : error.message || '识别失败，请重试'); }
        return false;
      } finally { if (active === controller) active = null; }
    }
    function schedule() {
      invalidate();
      if (alive() && readText().trim()) timer = timers.setTimeout(parse, 350);
    }
    async function loadFile(file) {
      cancel();
      if (!alive()) return false;
      if (file.size > 10 * 1024 * 1024) { onState('file-error', '文本文件不能超过 10 MB，请重新选择'); return false; }
      const id = revision, controller = new AbortController(); active = controller;
      const current = () => alive() && id === revision;
      onState('reading');
      try {
        const text = await loadText(file, controller.signal);
        if (!current()) return false;
        writeText(text);
        return await parse();
      } catch (error) {
        if (current()) onState('file-error', error.message || '文件读取失败，请重新选择');
        return false;
      } finally { if (active === controller) active = null; }
    }
    function dispose() { closed = true; cancel(); signal.removeEventListener('abort', dispose); }
    signal.addEventListener('abort', dispose, { once: true });
    return Object.freeze({ parse, schedule, invalidate, loadFile, dispose });
  }

  function create({ api, ui, openModal, closeModal, esc, kinds, formats, toast, dupNote, refreshAfterCommit, openLicenseImport }) {
    function bindImportPreview(textarea, button, resultBox, route, onResult, onReset) {
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'btn btn-ghost btn-sm parse-retry';
      retry.textContent = '重试识别'; retry.hidden = true; resultBox.after(retry);
      const preview = createPreview({
        readText: () => textarea.value, writeText: text => { textarea.value = text; },
        request: (text, signal) => api(route, { method: 'POST', body: { text }, signal }),
        isActive: () => textarea.isConnected, signal: ui.dialog.signal(), onResult,
        onReset: () => { button.disabled = true; onReset(); },
        onState(phase, error) {
          resultBox.dataset.phase = phase;
          resultBox.setAttribute('aria-busy', String(['parsing', 'reading'].includes(phase)));
          textarea.setAttribute('aria-invalid', String(phase === 'error'));
          retry.hidden = phase !== 'error';
          if (phase !== 'ready') resultBox.textContent = error || ({
            empty: '等待粘贴内容…', input: '正在识别最新内容…', parsing: '正在识别最新内容…',
            composing: '确认输入后自动识别…', reading: '正在读取文件…',
          })[phase];
        },
      });
      let composing = false;
      textarea.addEventListener('compositionstart', () => { composing = true; preview.invalidate('composing'); });
      textarea.addEventListener('compositionend', () => { composing = false; preview.schedule(); });
      textarea.addEventListener('input', event => { if (composing || event.isComposing) preview.invalidate('composing'); else preview.schedule(); });
      retry.onclick = () => preview.parse();
      return preview;
    }
    async function openImportModal(kind) {
      if (kind === 'licenses') return openLicenseImport();
      const conf = kinds.find((k) => k.key === kind);
      openModal(`
        <div class="modal-head"><h3>批量导入 · ${conf.label}</h3><button class="modal-close" data-action="close-modal">✕</button></div>
        <div class="modal-body">
          <div class="format-hint">
            <p class="format-rule">${esc(formats[kind].rule)}</p>
            ${formats[kind].sample ? `<pre class="format-sample">${esc(formats[kind].sample)}</pre>` : ''}
          </div>
          <label for="import-text">粘贴资源文本</label><textarea id="import-text" aria-describedby="parse-result" class="mono" rows="9" style="width:100%" placeholder="粘贴到此处，一行一条…"></textarea>
          <div class="parse-result" role="status" aria-live="polite" id="parse-result">等待粘贴内容…</div>
        </div>
        <div class="modal-foot">
          <span class="grow"></span>
          <button class="btn btn-ghost" data-action="close-modal">取消</button>
          <button class="btn btn-primary" id="import-ok" disabled>确认导入</button>
        </div>`, { large: true });

      const ta = document.getElementById('import-text');
      const resultBox = document.getElementById('parse-result');
      const okBtn = document.getElementById('import-ok');
      let parsed = [];
      let saving = false;
      bindImportPreview(ta, okBtn, resultBox, `/api/parse/${kind}`, (res) => {
        if (!Array.isArray(res?.items)) throw new Error('识别结果格式不正确，请重试');
        parsed = res.items;
        if (!parsed.length) {
          resultBox.innerHTML = '⚠ 未识别到有效内容，请检查格式';
          okBtn.disabled = true;
        } else {
          const preview = parsed
            .slice(0, 5)
            .map((it) => `<li>${esc(Object.entries(it).filter(([k,v])=>v&&!['pass','fakey'].includes(k)).map(([,v])=>v).join(' · '))}</li>`)
            .join('');
          resultBox.innerHTML = `识别到 <b>${parsed.length}</b> 条${parsed.length > 5 ? '（预览前 5 条）' : ''}<ul class="parse-preview-list">${preview}</ul>`;
          okBtn.disabled = false;
        }
      }, () => { parsed = []; });

      okBtn.onclick = async () => {
        if (saving || okBtn.disabled || !parsed.length) return;
        saving = true; ui.dialog.pending(okBtn, true, '正在导入…'); ta.readOnly = true;
        try {
          const res = await api(`/api/import/${kind}`, { method: 'POST', body: { items: parsed } });
          toast(`✅ 导入成功：新增 ${res.added} 条${dupNote(res)}`);
          if (ta.isConnected) closeModal();
          await refreshAfterCommit('已保存，但列表刷新失败；请点击重新连接');
        } catch (e) {
          ui.dialog.error(okBtn, e.message);
        } finally {
          saving = false; ui.dialog.pending(okBtn, false); ta.readOnly = false;
        }
      };

      ta.focus();
    }

    /* ============ 智能导入（自动识别邮箱 / 代理） ============ */

    function openAutoImport() {
      openModal(`
        <div class="modal-head"><h3>智能导入 · 邮箱 + 代理</h3><button class="modal-close" data-action="close-modal">✕</button></div>
        <div class="modal-body">
          <div class="auto-hint">粘贴任意格式，自动识别并拆分（可混合）：<br>
            ① <b>AdsPower 导入 TXT</b>（key=value，星号线分块）<br>
            ② 邮箱：<span class="mono">账号——密码——2FA</span>，分隔符支持 —、|、Tab、冒号、分号、逗号、空格，或「邮箱：xxx 密码：yyy 2FA：zzz」标签形式（顺序任意）<br>
            ③ 一行代理：<span class="mono">socks5://user:pass@host:port</span>、<span class="mono">user:pass@host:port</span>、<span class="mono">host:port:user:pass</span>、<span class="mono">user:pass:host:port</span>、<span class="mono">host,port,user,pass</span> 等<br>
            ④ 代理商多行文本块（账号/密码/主机/端口/国家等标签行，中英文均可）<br>
            识别后邮箱进「邮箱库」、代理进「代理库」，重复自动跳过。</div>
          <div class="auto-toolbar">
            <button type="button" class="btn btn-ghost btn-sm" id="auto-file-btn">选择 TXT 文件</button>
            <input type="file" id="auto-file" accept=".txt,.csv,text/plain" hidden>
            <span class="mini faint" id="auto-file-name"></span>
          </div>
          <label for="auto-text">粘贴需要识别的文本</label><textarea id="auto-text" aria-describedby="auto-result" class="mono" rows="9" style="width:100%" placeholder="粘贴 AdsPower TXT / 邮箱 / 代理，任意混合…"></textarea>
          <div class="parse-result" role="status" aria-live="polite" id="auto-result">等待粘贴内容…</div>
        </div>
        <div class="modal-foot">
          <span class="grow"></span>
          <button class="btn btn-ghost" data-action="close-modal">取消</button>
          <button class="btn btn-primary" id="auto-ok" disabled>确认导入</button>
        </div>`, { large: true });

      const ta = document.getElementById('auto-text');
      const resultBox = document.getElementById('auto-result');
      const okBtn = document.getElementById('auto-ok');
      const fileInput = document.getElementById('auto-file');
      const fileName = document.getElementById('auto-file-name');
      let parsed = { emails: [], proxies: [] };
      let saving = false;

      const renderPreview = () => {
        const { emails, proxies } = parsed;
        if (!emails.length && !proxies.length) {
          resultBox.innerHTML = '⚠ 未识别到有效内容，请检查格式';
          okBtn.disabled = true;
          okBtn.textContent = '确认导入';
          return;
        }
        const sec = (title, ico, items, fmt) => (!items.length ? '' : `
          <div class="auto-section">
            <div class="auto-sec-head"><span class="ico">${ico}</span>${title} <b>${items.length}</b> 条${items.length > 5 ? '<span class="mini faint">（预览前 5 条）</span>' : ''}</div>
            <ul class="parse-preview-list">${items.slice(0, 5).map((it) => `<li>${esc(fmt(it))}</li>`).join('')}</ul>
          </div>`);
        resultBox.innerHTML =
          sec('邮箱', '✉', emails, (e) => [e.user,e.pass?'密码已识别':'',e.fakey?'2FA已识别':''].filter(Boolean).join(' · ')) +
          sec('代理', '⇅', proxies, (p) => [p.host ? `${p.host}:${p.port}` : '', p.user, p.sn, p.ip].filter(Boolean).join(' · '));
        okBtn.disabled = false;
        okBtn.textContent = `确认导入（邮箱 ${emails.length} · 代理 ${proxies.length}）`;
      };

      const preview = bindImportPreview(ta, okBtn, resultBox, '/api/parse/auto', (result) => {
        if (!Array.isArray(result?.emails) || !Array.isArray(result?.proxies)) throw new Error('识别结果格式不正确，请重试');
        parsed = result;
        renderPreview();
      }, () => { parsed = { emails: [], proxies: [] }; });

      document.getElementById('auto-file-btn').onclick = () => fileInput.click();
      fileInput.addEventListener('change', () => {
        const f = fileInput.files[0];
        if (!f) return;
        fileName.textContent = f.name;
        fileInput.value = ''; // Allow choosing the same file again after a read error.
        void preview.loadFile(f);
      });

      okBtn.onclick = async () => {
        if (saving || okBtn.disabled || (!parsed.emails.length && !parsed.proxies.length)) return;
        const payload = parsed;
        const counts = { emails: payload.emails.length, proxies: payload.proxies.length };
        saving = true; ta.readOnly = true; fileInput.disabled = true;
        document.getElementById('auto-file-btn').disabled = true;
        ui.dialog.pending(okBtn, true, '正在导入…');
        try {
          const res = await api('/api/import/auto', { method: 'POST', body: payload });
          const parts = [];
          if (counts.emails) parts.push(`邮箱 +${res.emails.added}${dupNote(res.emails)}`);
          if (counts.proxies) parts.push(`代理 +${res.proxies.added}${dupNote(res.proxies)}`);
          toast(`✅ 导入成功：${parts.join('，')}`);
          if (ta.isConnected) closeModal();
          await refreshAfterCommit('已保存，但列表刷新失败；请点击重新连接');
        } catch (e) {
          ui.dialog.error(okBtn, e.message);
        } finally {
          saving = false; ui.dialog.pending(okBtn, false); ta.readOnly = false; fileInput.disabled = false;
          const fileButton = document.getElementById('auto-file-btn');
          if (ta.isConnected && fileButton) fileButton.disabled = false;
        }
      };

      ta.focus();
    }

    return Object.freeze({ open: openImportModal, openAuto: openAutoImport });
  }

  return Object.freeze({ createPreview, create });
})();
if (typeof module !== 'undefined') module.exports = globalThis.WorkbenchResourceImport;
