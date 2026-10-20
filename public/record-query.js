'use strict';

// Request ownership only. Rendering, selection, account state and storage belong
// to the caller; this module never reads the DOM or retains previous results.
globalThis.WorkbenchRecordQuery = (() => {
  const snapshot = query => Object.freeze({
    page: query.page, limit: query.limit, sort: query.sort,
    q: query.q.trim(), status: query.status,
    reveal: query.reveal, sensitiveEpoch: query.sensitiveEpoch,
  });
  const sameQuery = (left, right) => Object.keys(left).every(key => left[key] === right[key]);
  const pathFor = query => {
    const params = new URLSearchParams({
      limit: String(query.limit), offset: String((query.page - 1) * query.limit), sort: query.sort,
    });
    if (query.q) params.set('q', query.q);
    if (query.status !== '全部') params.set('status', query.status);
    if (query.reveal) params.set('reveal', '1');
    return '/api/records?' + params;
  };

  function create({ readQuery, request, onPhase, onResult, onRender, onError, delay = 250, clock = { setTimeout, clearTimeout } }) {
    let generation = 0, timer = null, active = null;
    const cancel = () => {
      clock.clearTimeout(timer);
      timer = null;
      ++generation;
      active?.abort();
      active = null;
    };
    function invalidate({ reason = 'input' } = {}) {
      cancel();
      onPhase('loading', '', reason);
    }
    async function load({ renderMode = 'none' } = {}) {
      cancel();
      const id = generation;
      const original = snapshot(readQuery());
      const controller = new AbortController();
      active = controller;
      const current = () => id === generation && !controller.signal.aborted && sameQuery(original, snapshot(readQuery()));
      onPhase('loading', '', 'request');
      let query = original, result;
      try {
        // One timeout and owner cover page correction as well as the first fetch.
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
        while (true) {
          const data = await request(pathFor(query), { signal });
          if (!current()) return false;
          if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0) {
            throw new Error('记录分页数据格式不正确');
          }
          const pages = Math.max(1, Math.ceil(data.total / query.limit));
          if (query.page > pages) {
            // Do not publish a temporary empty page, or mutate the caller before
            // the corrected result arrives. Further deletions can shrink again.
            query = { ...query, page: pages };
            continue;
          }
          result = { items: data.items, total: data.total, page: query.page };
          break;
        }
      } catch (error) {
        if (!current()) return false;
        onPhase('error', error.message || '无法读取记录，请重试', '');
        throw error;
      } finally {
        if (active === controller) active = null;
      }
      onResult(result);
      onPhase('ready', '', '');
      onRender(renderMode);
      return true;
    }
    function schedule(options = {}) {
      invalidate({ reason: 'debounce' });
      timer = clock.setTimeout(() => {
        timer = null;
        load(options).catch(onError);
      }, delay);
    }
    return Object.freeze({ load, schedule, invalidate });
  }
  return Object.freeze({ create });
})();

if (typeof module !== 'undefined') module.exports = globalThis.WorkbenchRecordQuery;
