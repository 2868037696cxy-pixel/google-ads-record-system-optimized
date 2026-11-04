'use strict';

// A bounded maintenance controller, separate from the main workbench renderer.
globalThis.RecordIntegrity = (() => {
  const details = issue => issue.fields?.length ? `<table class="integrity-diff"><thead><tr><th scope="col">字段</th><th scope="col">记录快照</th><th scope="col">关联资源</th></tr></thead><tbody>${issue.fields.map(field => `<tr><th scope="row">${esc(field.label)}</th><td>${esc(field.before || '（空）')}</td><td>${esc(field.after || '（空）')}</td></tr>`).join('')}</tbody></table>` : '';
  const payload = (record, issue) => ({ action: issue.action, prefix: issue.prefix, record_id: record.id, record_version: record.version, resource_id: issue.resource_id, resource_version: issue.resource_version });

  async function openRecord(record) {
    closeModal();
    state.page = 'records'; state.q = record.fingerprint; state.rstatus = '全部'; state.recordPage = 1;
    render();
    try {
      if (!await loadRecordsPage({ renderMode: 'table' })) return;
      if (state.page !== 'records' || state.q !== record.fingerprint || document.querySelector('#modal-root .modal')) return;
      if (state.records.some(row => row.id === record.id)) openEditRecord(record.id);
      else toast('这条记录已变化或已删除，请重新检查', 'warn');
    } catch (error) { toast(error.message, 'error'); }
  }

  async function confirmRepair(record, issue, context, source) {
    if (source.disabled) return;
    WorkbenchUI.busy(source, true, '正在授权…');
    let authorized;
    try { authorized = await ensureSensitive('修复会更新本人记录快照或资源占用状态。请授权后核对差异，凭据原文不会显示。'); }
    finally { WorkbenchUI.busy(source, false); }
    if (!authorized || (window.desktop && !source.isConnected)) return;
    const label = issue.action === 'sync_snapshot' ? '同步快照' : '修正占用状态';
    openModal(`<div class="modal-head"><h3>核对${label}</h3><button class="modal-close" data-action="close-modal">✕</button></div>
      <div class="modal-body stack"><p><b>${esc(record.fingerprint)}</b> · ${esc(issue.label)} #${esc(issue.resource_id)}<br>${esc(issue.resource_label)}</p>
        <p class="settings-hint">${issue.action === 'sync_snapshot' ? '按当前关联资源覆盖这条记录的对应快照，关联编号保持不变。若原本想更换资源，请返回检查并打开记录重新选择。' : '该资源已有本人记录关联，将从“未使用”改为“已使用”。不修改停用状态或任何关联编号。'}</p>
        ${details(issue)}<label class="restore-confirm"><input type="checkbox" id="integrity-consent"><span>我已核对上述关联和差异，确认执行${label}</span></label>
      </div><div class="modal-foot"><button class="btn btn-ghost" id="integrity-back" data-autofocus>返回检查</button><span class="grow"></span><button class="btn btn-primary" id="integrity-apply" disabled>确认${label}</button></div>`, { large: true });
    const button = document.getElementById('integrity-apply');
    const consent = document.getElementById('integrity-consent');
    let stale = false;
    document.getElementById('integrity-back').onclick = () => open(context);
    consent.onchange = () => { button.disabled = stale || !consent.checked; };
    button.onclick = async () => {
      if (button.disabled || !consent.checked) return;
      WorkbenchUI.dialog.pending(button, true, '正在修复…');
      try {
        const result = await api('/api/data-integrity/repair', { method: 'POST', body: payload(record, issue) });
        toast(result.changed ? `${label}已保存` : '该项已一致，无需修改');
        await refreshAfterCommit('修复已保存，但工作台刷新失败；请重新连接，不要重复提交');
        if (button.isConnected) open(context);
      } catch (error) {
        stale = [403, 404, 409, 428].includes(error.status);
        WorkbenchUI.dialog.error(button, error.message + (stale ? '。请返回检查，重新核对后再操作。' : ''));
      } finally {
        WorkbenchUI.dialog.pending(button, false);
        if (stale) button.disabled = true;
      }
    };
  }

  function open(context = {}) {
    let after = context.after || 0;
    let upper = context.upper;
    let previous = [...(context.previous || [])];
    let checkedBefore = context.checkedBefore || 0;
    let report = null;
    let request = 0;
    openModal(`<div class="modal-head"><h3>记录关联检查</h3><button class="modal-close" data-action="close-modal">✕</button></div>
      <div class="modal-body stack"><p class="settings-hint">检查仅涉及本人的记录与资源，不修改数据。凭据只比较是否一致，结果不显示原文。独立快照或缺失关联需要人工核对。</p><div id="integrity-results" role="region" aria-label="关联检查结果"></div></div>
      <div class="modal-foot"><button class="btn btn-ghost" id="integrity-reset">重新检查</button><span class="grow" id="integrity-range" role="status"></span><button class="btn btn-ghost" id="integrity-prev" disabled>上一批</button><button class="btn btn-ghost" id="integrity-next" disabled>下一批</button></div>`, { large: true });
    const box = document.getElementById('integrity-results');
    const range = document.getElementById('integrity-range');
    const prev = document.getElementById('integrity-prev');
    const next = document.getElementById('integrity-next');
    const reset = document.getElementById('integrity-reset');
    const signal = WorkbenchUI.dialog.signal();
    const currentContext = () => ({ after, upper, previous: [...previous], checkedBefore });
    const load = async () => {
      const sequence = ++request;
      box.setAttribute('aria-busy', 'true');
      box.innerHTML = '<p class="integrity-loading" role="status">正在逐项核对本批记录…</p>';
      prev.disabled = true; next.disabled = true; reset.disabled = true;
      try {
        const params = new URLSearchParams({ limit: '100', after: String(after) });
        if (upper !== undefined) params.set('upper_bound', String(upper));
        const result = await api('/api/data-integrity?' + params, { signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
        if (signal.aborted || !box.isConnected || sequence !== request) return;
        report = result; upper = result.upper_bound;
        range.textContent = result.total ? `本批 ${checkedBefore + (result.checked ? 1 : 0)}–${checkedBefore + result.checked} / ${result.total} 条` : '暂无记录';
        box.innerHTML = result.findings.length ? `<p class="integrity-summary" role="status">本批检查 ${result.checked} 条，${result.findings.length} 条需要核对。修复前再次验证版本，不按名称猜测历史归属。</p>${result.findings.map((record, rowIndex) => `<section class="integrity-record"><div class="integrity-heading"><div><b class="mono">${esc(record.fingerprint)}</b><p>${esc(record.domain || '未填写域名')}</p></div><button class="btn btn-ghost btn-sm" data-integrity-record="${rowIndex}">打开记录核对</button></div>${record.issues.map((issue, issueIndex) => `<div class="integrity-issue"><b>${esc(issue.label)}${issue.resource_id ? ' #' + esc(issue.resource_id) : ''}</b><p>${esc(issue.message)}</p>${issue.resource_label ? `<p class="settings-hint">当前关联：${esc(issue.resource_label)}</p>` : ''}${details(issue)}${issue.repairable ? `<button class="btn btn-ghost btn-sm" data-integrity-repair="${rowIndex}:${issueIndex}">${issue.action === 'sync_snapshot' ? '核对并同步快照' : '核对占用状态'}</button>` : '<p class="settings-hint">请打开记录，核对后选择正确资源；不会自动改写。</p>'}</div>`).join('')}</section>`).join('')}`
          : WorkbenchUI.emptyState({ title: result.checked ? '本批未发现关联差异' : '没有待检查的记录', description: result.has_more ? '后面还有记录，请继续检查下一批。' : '本批范围已检查完毕；新建记录可点“重新检查”。' });
        prev.disabled = !previous.length;
        next.disabled = !result.has_more;
      } catch (error) {
        if (signal.aborted || !box.isConnected || sequence !== request) return;
        range.textContent = '本批尚未完成';
        box.innerHTML = `<div class="integrity-error" role="alert"><b>暂时无法完成检查</b><p>${esc(error.message)}</p><button class="btn btn-ghost" id="integrity-retry">重试本批</button></div>`;
        box.querySelector('#integrity-retry').onclick = load;
        prev.disabled = !previous.length;
      } finally {
        if (box.isConnected && sequence === request) { box.setAttribute('aria-busy', 'false'); reset.disabled = false; }
      }
    };
    box.onclick = event => {
      const recordButton = event.target.closest('[data-integrity-record]');
      const repairButton = event.target.closest('[data-integrity-repair]');
      if (recordButton) { event.stopPropagation(); openRecord(report.findings[Number(recordButton.dataset.integrityRecord)]); }
      if (repairButton) {
        event.stopPropagation();
        const [rowIndex, issueIndex] = repairButton.dataset.integrityRepair.split(':').map(Number);
        confirmRepair(report.findings[rowIndex], report.findings[rowIndex].issues[issueIndex], currentContext(), repairButton).catch(error => toast(error.message, 'error'));
      }
    };
    prev.onclick = () => { const page = previous.pop(); after = page.after; checkedBefore = page.checkedBefore; load(); };
    next.onclick = () => { if (!report?.has_more) return; previous.push({ after, checkedBefore }); after = report.next_after; checkedBefore += report.checked; load(); };
    reset.onclick = () => { after = 0; upper = undefined; previous = []; checkedBefore = 0; load(); };
    load();
  }
  return Object.freeze({ open });
})();
