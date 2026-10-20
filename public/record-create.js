'use strict';

// Pure draft rules and request ownership. UI and account state are explicit callers.
globalThis.WorkbenchRecordCreate = (() => {
  function parseStart(input, { dateKey, nextSeq = 1 }) {
    const raw = String(input || '').trim(), prefix = `${dateKey}ads`;
    if (!raw) return { prefix, seq: nextSeq, display: prefix + nextSeq };
    if (/^\d+$/.test(raw)) return { prefix, seq: Number(raw), display: prefix + Number(raw) };
    const match = raw.match(/^(.+?)(\d+)$/);
    return match ? { prefix: match[1], seq: Number(match[2]), display: raw } : { prefix: raw, seq: nextSeq, display: raw + nextSeq };
  }
  function draft({ form, picked, resources, dateKey, nextSeq }) {
    const domains = form.domains.split(/\r?\n/).map(value => value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean);
    const fp = parseStart(form.start_seq, { dateKey, nextSeq });
    let error = '', field = '';
    if (!domains.length) { error = '请至少填写一个域名。'; field = 'f-domains'; }
    else if (domains.length > 500) { error = '单次最多创建 500 条记录，请减少域名数量。'; field = 'f-domains'; }
    else if (new Set(domains).size !== domains.length) { error = '域名存在重复（大小写、网址前缀和路径会先统一处理），请核对后再创建。'; field = 'f-domains'; }
    else if (!Number.isSafeInteger(fp.seq) || fp.seq < 1 || !Number.isSafeInteger(fp.seq + domains.length)) { error = '指纹起始编号必须是有效的正整数。'; field = 'f-start'; }
    for (const kind of ['emails', 'cards', 'licenses', ...(form.proxy_mode === 'auto' ? ['proxies'] : [])]) {
      const resource = resources[kind];
      if (!error && resource.total && resource.available < domains.length) error = `${resource.label}可用资源不足：需要 ${domains.length} 条，当前可用 ${resource.available} 条。请先补充资源或减少创建数量。`;
    }
    return { error, field, fp, body: {
      country: form.country, product: form.product, domains,
      start_seq: fp.seq, fp_prefix: fp.prefix, date_key: dateKey,
      ip_reg_time: form.ip_reg_time, id_card: form.id_card, proxy_mode: form.proxy_mode,
      proxy_id: form.proxy_mode === 'shared' && form.proxy_id ? Number(form.proxy_id) : undefined,
      email_ids: [...picked.emails].map(Number), card_ids: [...picked.cards].map(Number), license_ids: [...picked.licenses].map(Number),
    } };
  }
  const digest = async text => {
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  };
  function createSubmitter({ request, hash = digest, newKey = () => globalThis.crypto.randomUUID() }) {
    let pending = false, retry = null;
    async function submit(body, { signal } = {}) {
      if (pending) return null;
      pending = true;
      try {
        // The retry cache contains a digest/key only, never the serialized draft.
        const encoded = JSON.stringify(body), payload = JSON.parse(encoded);
        const fingerprint = await hash(encoded);
        if (signal?.aborted) throw Object.assign(new Error('已取消创建'), { name: 'AbortError' });
        if (retry?.fingerprint !== fingerprint) retry = { fingerprint, key: newKey() };
        const response = await request('/api/records', { method: 'POST', headers: { 'idempotency-key': retry.key }, body: payload });
        retry = null;
        return response;
      } finally { pending = false; }
    }
    return Object.freeze({ submit });
  }
  return Object.freeze({ parseStart, draft, createSubmitter });
})();
if (typeof module !== 'undefined') module.exports = globalThis.WorkbenchRecordCreate;
