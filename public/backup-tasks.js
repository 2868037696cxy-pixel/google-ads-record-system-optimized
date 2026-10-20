'use strict';

// Task state lives on the server. Closing a dialog only stops its UI requests.
globalThis.BackupTasks = (() => {
  const endpoint = id => '/api/backup-jobs/' + encodeURIComponent(id);
  const sizes = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  const names = { records: '记录', emails: '邮箱', proxies: '代理', cards: '银行卡', licenses: '营业执照', documents: 'PDF' };
  const labels = { building: '正在打包', ready: '可下载', uploading: '等待上传 / 可续传', checking: '正在校验', review: '待核对恢复', complete: '恢复完成', failed: '任务失败' };
  const head = title => `<div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" data-action="close-modal">✕</button></div>`;
  const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  const requestSignal = signal => AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const current = element => element.isConnected;
  function continuation() {
    const modal = document.querySelector('#modal-root .modal'), epoch = state.sensitiveEpoch;
    return () => epoch === state.sensitiveEpoch && (modal ? modal.isConnected : !document.querySelector('#modal-root .modal'));
  }

  async function authorize(button, reason) {
    const epoch = state.sensitiveEpoch;
    const prompt = !window.desktop && state.unlockedUntil <= Date.now() + 1000;
    WorkbenchUI.busy(button, true, '正在授权…');
    try {
      const granted = await ensureSensitive(reason);
      return granted && epoch === state.sensitiveEpoch && (current(button) || (prompt && !document.querySelector('#modal-root .modal')));
    } finally { WorkbenchUI.busy(button, false); }
  }

  async function identify(file) {
    if (!file || file.size < 128 || file.size > 512 * 1024 * 1024) throw new Error('请选择不超过 512 MiB 的 .awbp 备份文件');
    if (new TextDecoder().decode(await file.slice(0, 5).arrayBuffer()) !== 'WBPK3') throw new Error('此入口需要 .awbp 文件；旧版 JSON 请使用设置中的“恢复备份”');
    // A bounded local fingerprint only helps select the same source for resume.
    // Server-side authenticated decryption verifies every byte before any restore.
    const sample = new Blob([String(file.size), file.slice(0, 65536), file.slice(Math.max(0, file.size - 65536))]);
    return sha(await sample.arrayBuffer());
  }

  function selectFile(input, message, button, signal, expected) {
    let sequence = 0, selected = null;
    input.onchange = async () => {
      const turn = ++sequence;
      selected = null; button.disabled = true;
      const file = input.files[0];
      if (!file) { message.textContent = '尚未选择文件'; return; }
      message.textContent = '正在识别文件…';
      try {
        const tag = await identify(file);
        if (signal.aborted || sequence !== turn) return;
        if (expected && (file.size !== expected.size || tag !== expected.source_tag)) throw new Error('文件与此上传任务不一致，请选择原文件或建立新任务');
        selected = { file, tag }; button.disabled = false;
        message.textContent = `${file.name} · ${sizes(file.size)} · 可继续上传`;
      } catch (error) { if (!signal.aborted && sequence === turn) message.textContent = error.message; }
    };
    return () => selected;
  }

  function open() {
    openModal(`${head('大文件备份与恢复')}<div class="modal-body stack">
      <p class="settings-hint">加密保存本人的记录、资源与 PDF。单包上限 512 MiB，每类最多 10 万条；临时任务保留 24 小时，同时最多 2 个。文件依赖原服务器密钥与原账号，请妥善保存文件并另外保管服务器密钥。</p>
      <section class="backup-create"><div><b>保存当前数据</b><p>后台打包，完成后下载加密文件。关闭窗口后仍继续打包。</p></div><button class="btn btn-primary" id="package-export">建立备份</button></section>
      <section class="backup-create backup-upload-new"><label for="package-new-file"><b>从加密文件恢复</b><span>先分块上传并校验，再核对覆盖范围。</span></label><input id="package-new-file" type="file" accept=".awbp,application/octet-stream"><p id="package-file-message" role="status">尚未选择文件</p><button class="btn btn-ghost" id="package-new-upload" disabled>建立上传任务</button></section>
      <div class="backup-list-head"><b>临时任务</b><button class="btn btn-ghost btn-sm" id="package-reload">刷新任务</button></div><p id="package-list-error" class="field-error" role="alert" hidden></p><div id="package-jobs" aria-label="备份任务列表">正在读取任务…</div>
      </div><div class="modal-foot"><span class="settings-hint grow">下载完成后再删除临时任务；任务过期不影响已下载文件。</span><button class="btn btn-ghost" data-action="close-modal">关闭</button></div>`, { large: true });
    const signal = WorkbenchUI.dialog.signal();
    const box = document.getElementById('package-jobs');
    const errorBox = document.getElementById('package-list-error');
    const exportButton = document.getElementById('package-export');
    const uploadButton = document.getElementById('package-new-upload');
    const selected = selectFile(document.getElementById('package-new-file'), document.getElementById('package-file-message'), uploadButton, signal);
    let jobs = [], timer, loading = false, busy = false, previous = '';
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    const load = async () => {
      if (loading || busy || signal.aborted) return;
      clearTimeout(timer); loading = true;
      try {
        const result = await api('/api/backup-jobs', { signal: requestSignal(signal) });
        if (signal.aborted || busy) return;
        jobs = result.jobs; errorBox.hidden = true;
        const html = jobs.length ? jobs.map(job => `<section class="backup-job" data-job="${esc(job.id)}"><div class="backup-job-heading"><b>${job.kind === 'export' ? '导出备份' : '恢复上传'} <span class="backup-state">${esc(labels[job.status] || job.status)}</span></b><span class="settings-hint">${esc(new Date(job.created_at).toLocaleString())}</span></div><p class="settings-hint">${job.kind === 'restore' ? `服务器已接收 ${sizes(job.offset)} / ${sizes(job.size)}` : job.size ? sizes(job.size) : '正在读取一致的数据快照'} · ${esc(new Date(job.expires_at).toLocaleString())} 到期</p>${job.error ? `<p class="field-error">${esc(job.error)}</p>` : ''}${job.sha256 ? `<details><summary>文件 SHA-256 校验值</summary><code class="backup-hash">${esc(job.sha256)}</code></details>` : ''}<div class="backup-job-actions">${job.status === 'ready' ? '<button class="btn btn-primary btn-sm" data-package-action="download">下载加密文件</button>' : ''}${job.status === 'uploading' ? '<button class="btn btn-ghost btn-sm" data-package-action="upload">继续上传 / 校验</button>' : ''}${job.status === 'review' ? '<button class="btn btn-danger btn-sm" data-package-action="review">核对恢复范围</button>' : ''}<button class="btn btn-ghost btn-sm" data-package-action="delete">删除临时任务</button></div></section>`).join('') : WorkbenchUI.emptyState({ title: '暂无临时任务', description: '建立备份，或选择已下载的 .awbp 文件开始恢复。' });
        if (html !== previous) {
          const active = box.contains(document.activeElement) ? { id: document.activeElement.closest('[data-job]')?.dataset.job, action: document.activeElement.dataset.packageAction } : null;
          box.innerHTML = html; previous = html;
          if (active?.action) box.querySelector(`[data-job="${active.id}"] [data-package-action="${active.action}"]`)?.focus({ preventScroll: true });
        }
      } catch (error) { if (!signal.aborted) { errorBox.textContent = error.message; errorBox.hidden = false; } }
      finally { loading = false; if (!signal.aborted) timer = setTimeout(load, 1500); }
    };
    const run = async (button, action) => {
      if (busy || button.disabled) return;
      busy = true; WorkbenchUI.busy(button, true, '正在处理…');
      try { await action(); }
      catch (error) { if (current(button)) WorkbenchUI.dialog.error(button, error.message); else toast(error.message, 'error'); }
      finally { busy = false; WorkbenchUI.busy(button, false); if (!signal.aborted) void load(); }
    };
    exportButton.onclick = () => run(exportButton, async () => {
      if (!await authorize(exportButton, '授权后建立本人的加密备份。')) return;
      const owns = continuation();
      await api('/api/backup-jobs', { method: 'POST', body: { kind: 'export' } });
      if (!owns()) return;
      if (current(exportButton)) await load(); else open();
    });
    uploadButton.onclick = () => run(uploadButton, async () => {
      const source = selected(); if (!source) return;
      if (!await authorize(uploadButton, '授权建立恢复上传任务；上传不会修改当前数据。')) return;
      const owns = continuation();
      const job = await api('/api/backup-jobs', { method: 'POST', body: { kind: 'restore', size: source.file.size, source_tag: source.tag } });
      if (owns()) openUpload(job, source.file);
    });
    document.getElementById('package-reload').onclick = () => load();
    box.onclick = event => {
      const button = event.target.closest('[data-package-action]'); if (!button) return;
      event.stopPropagation();
      const job = jobs.find(item => item.id === button.closest('[data-job]').dataset.job); if (!job) return;
      run(button, async () => {
        switch (button.dataset.packageAction) {
          case 'upload': openUpload(job); break;
          case 'review':
            if (await authorize(button, '请授权后核对备份与当前账号的数据数量。')) {
              const owns = continuation();
              const review = await api(endpoint(job.id) + '/review', { method: 'POST', body: {} });
              if (owns()) openReview(review);
            }
            break;
          case 'download': {
            if (!await authorize(button, '请授权下载本人的加密备份。')) return;
            const link = document.createElement('a'); link.href = endpoint(job.id) + '/file'; link.download = `AdsWorkbench-${job.id}.awbp`; link.click();
            if (!current(button)) open();
            toast('已发起下载，请在下载列表确认文件保存完成');
            break;
          }
          case 'delete':
            openModal(`${head('删除临时备份任务')}<div class="modal-body"><p>将删除服务器上的此任务和临时文件。当前账号的记录与资源保持原样；请确认需要的备份已经下载。</p></div><div class="modal-foot"><button class="btn btn-ghost" id="package-delete-back" data-autofocus>返回</button><span class="grow"></span><button class="btn btn-danger" id="package-delete-confirm">删除临时任务</button></div>`);
            document.getElementById('package-delete-back').onclick = open;
            const confirm = document.getElementById('package-delete-confirm');
            confirm.onclick = async () => {
              if (confirm.disabled) return;
              WorkbenchUI.dialog.pending(confirm, true, '正在删除…');
              try { await api(endpoint(job.id), { method: 'DELETE' }); if (current(confirm)) open(); }
              catch (error) { WorkbenchUI.dialog.error(confirm, error.message); }
              finally { WorkbenchUI.dialog.pending(confirm, false); }
            };
            break;
        }
      });
    };
    void load();
  }

  function openUpload(initial, sourceFile) {
    let job = initial, running = false, controller;
    openModal(`${head('上传加密备份')}<div class="modal-body stack"><p class="settings-hint">每块 1 MiB，收到确认后推进进度。暂停、关闭或断线后，可从任务列表重新选择原文件续传。上传完整后仍需校验与明确确认才会恢复。</p><label for="package-resume-file">选择此任务的原备份文件</label><input id="package-resume-file" type="file" accept=".awbp,application/octet-stream"><p id="package-resume-message" role="status">${sourceFile ? esc(sourceFile.name) : '尚未选择文件'}</p><progress id="package-progress" aria-label="服务器已确认的上传进度" max="${job.size}" value="${job.offset}"></progress><p id="package-progress-text" role="status"></p><p id="package-upload-error" class="field-error" role="alert" hidden></p></div><div class="modal-foot"><button class="btn btn-ghost" id="package-upload-back">返回任务</button><span class="grow"></span><button class="btn btn-ghost" id="package-pause" hidden>暂停上传</button><button class="btn btn-primary" id="package-upload-start" ${sourceFile ? '' : 'disabled'}>开始 / 继续上传</button><button class="btn btn-primary" id="package-verify" hidden>校验完整文件</button></div>`, { large: true });
    const signal = WorkbenchUI.dialog.signal(), input = document.getElementById('package-resume-file');
    const start = document.getElementById('package-upload-start'), pause = document.getElementById('package-pause'), verify = document.getElementById('package-verify');
    const message = document.getElementById('package-resume-message'), progress = document.getElementById('package-progress'), text = document.getElementById('package-progress-text'), errorBox = document.getElementById('package-upload-error');
    const selected = selectFile(input, message, start, signal, job);
    const update = () => {
      progress.value = job.offset; text.textContent = `服务器已确认 ${sizes(job.offset)} / ${sizes(job.size)}（${Math.floor(job.offset / job.size * 100)}%）`;
      input.disabled = running || job.offset === job.size; start.hidden = job.offset === job.size; start.disabled = running || !(sourceFile || selected());
      pause.hidden = !running; verify.hidden = job.offset !== job.size;
    };
    input.addEventListener('change', () => { sourceFile = null; });
    const fail = error => { errorBox.textContent = error.message; errorBox.hidden = false; };
    document.getElementById('package-upload-back').onclick = open;
    pause.onclick = () => controller?.abort();
    start.onclick = async () => {
      if (running || start.disabled) return;
      const file = sourceFile || selected()?.file; if (!file) return;
      running = true; controller = new AbortController(); errorBox.hidden = true; update();
      const uploadSignal = AbortSignal.any([signal, controller.signal]);
      try {
        job = await api(endpoint(job.id), { signal: requestSignal(uploadSignal) });
        while (!uploadSignal.aborted && job.offset < job.size) {
          const offset = job.offset;
          const bytes = await file.slice(offset, offset + job.chunk_bytes).arrayBuffer();
          const hash = await sha(bytes); if (uploadSignal.aborted) break;
          const response = await fetch(endpoint(job.id) + '/chunk?offset=' + offset, { method: 'PUT', headers: { 'x-workbench': '1', 'content-type': 'application/octet-stream', 'x-chunk-sha256': hash }, body: bytes, signal: requestSignal(uploadSignal) });
          if (response.status === 401) { location.replace('/login.html'); throw new Error('请重新登录'); }
          const result = await response.json();
          if (!response.ok) throw new Error(result.message || result.error || '此分块未确认，请暂停后重试');
          if (!Number.isSafeInteger(result.offset) || result.offset <= offset || result.offset > job.size) throw new Error('上传确认位置无效，请重新读取任务');
          job.offset = result.offset; if (!signal.aborted) update();
        }
      } catch (error) { if (!uploadSignal.aborted && !signal.aborted) fail(error); }
      finally {
        running = false;
        if (!signal.aborted) {
          try { job = await api(endpoint(job.id), { signal: requestSignal(signal) }); } catch (error) { if (!signal.aborted) fail(error); }
          if (!signal.aborted) { update(); if (job.offset < job.size) text.textContent += ' · 已暂停，可继续上传'; }
        }
      }
    };
    verify.onclick = async () => {
      if (verify.disabled) return;
      if (!await authorize(verify, '授权校验上传文件的归属、加密完整性、记录关联和 PDF。')) return;
      WorkbenchUI.busy(verify, true, '正在启动校验…');
      const owns = continuation();
      try { await api(endpoint(job.id) + '/verify', { method: 'POST', body: {} }); if (owns()) open(); }
      catch (error) { if (current(verify)) fail(error); else toast(error.message, 'error'); }
      finally { WorkbenchUI.busy(verify, false); }
    };
    update();
  }

  function openReview(job) {
    openModal(`${head('核对恢复范围')}<div class="modal-body stack"><p>将替换当前账号的全部记录与资源。请先保存当前备份，再逐项核对。原账号、登录密码和其他成员的数据保持原样。</p><div class="backup-count-wrap"><table class="integrity-diff"><thead><tr><th scope="col">数据</th><th scope="col">当前账号</th><th scope="col">备份恢复后</th></tr></thead><tbody>${Object.entries(names).map(([key, label]) => `<tr><th scope="row">${label}</th><td>${esc(job.current_counts[key] || 0)}</td><td>${esc(job.counts[key] || 0)}</td></tr>`).join('')}</tbody></table></div><p class="settings-hint">文件已通过加密认证、归属、字段、资源关联与 PDF 校验。核对后若当前数据变化，提交会停止，需要重新核对。</p><label class="restore-confirm"><input type="checkbox" id="package-consent"><span>我已保存需要的当前备份，并核对上述范围，确认替换本人全部数据</span></label></div><div class="modal-foot"><button class="btn btn-ghost" id="package-review-back" data-autofocus>返回任务</button><button class="btn btn-ghost" id="package-review-again">重新核对</button><span class="grow"></span><button class="btn btn-danger" id="package-apply" disabled>确认恢复</button></div>`, { large: true });
    const consent = document.getElementById('package-consent'), button = document.getElementById('package-apply');
    let stale = false;
    consent.onchange = () => { button.disabled = stale || !consent.checked; };
    document.getElementById('package-review-back').onclick = open;
    const again = document.getElementById('package-review-again');
    again.onclick = async () => {
      if (again.disabled) return;
      if (!await authorize(again, '请重新授权并核对最新覆盖范围。')) return;
      WorkbenchUI.busy(again, true, '正在核对…');
      const owns = continuation();
      try { const review = await api(endpoint(job.id) + '/review', { method: 'POST', body: {} }); if (owns()) openReview(review); }
      catch (error) { if (current(again)) WorkbenchUI.dialog.error(again, error.message); else toast(error.message, 'error'); }
      finally { WorkbenchUI.busy(again, false); }
    };
    button.onclick = async () => {
      if (button.disabled || !consent.checked) return;
      // An expired grant opens a different dialog: return to a fresh review after
      // authentication so a previous checkbox cannot silently authorize a write.
      if (state.unlockedUntil <= Date.now() + 1000) { again.click(); return; }
      WorkbenchUI.dialog.pending(button, true, '正在恢复，请等待结果…');
      try {
        await api(endpoint(job.id) + '/apply', { method: 'POST', body: { revision: job.revision }, signal: AbortSignal.timeout(10 * 60 * 1000) });
        await refreshAfterCommit('恢复已完成，但列表刷新失败；请重新连接，不要重复恢复');
        toast('本人数据已恢复完成'); if (current(button)) open();
      } catch (error) {
        stale = true; WorkbenchUI.dialog.error(button, error.message + '。请返回任务查询结果，或重新核对后再操作。');
      } finally { WorkbenchUI.dialog.pending(button, false); if (stale) button.disabled = true; }
    };
  }
  return Object.freeze({ open });
})();
