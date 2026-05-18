/**
 * API Base URL Bridge
 * 允许静态前端调用独立后端
 */
(function() {
  var rawBase = (window.ADS_API_BASE || '').trim();
  var base = rawBase.replace(/\/+$/, '');
  window.ADS_API_BASE_NORMALIZED = base;
  if (!base) return;
  var originalFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    var url = input;
    var isRequest = typeof Request !== 'undefined' && input instanceof Request;
    if (isRequest) url = input.url;
    if (typeof url === 'string') {
      var nextUrl = url;
      if (url.indexOf('/api/') === 0) nextUrl = base + url;
      else if (url.indexOf(window.location.origin + '/api/') === 0) nextUrl = base + url.slice(window.location.origin.length);
      if (nextUrl !== url) input = isRequest ? new Request(nextUrl, input) : nextUrl;
    }
    return originalFetch(input, init);
  };
})();