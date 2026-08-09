/* ═══ YOUSEF STORE — CSRF client helper ═══
 * السيرفر بيحط كوكي yousef_csrf (مقروء من الجافاسكريبت عمدًا). أي طلب
 * POST/PUT/PATCH/DELETE لازم يبعت نفس القيمة في هيدر X-CSRF-Token.
 * بنغلّف fetch مرة واحدة هنا، فكل الصفحات محمية أوتوماتيكيًا من غير أي تعديل.
 */
(function () {
  if (window.__yousefCsrfReady) return;
  window.__yousefCsrfReady = true;

  function readCookie(name) {
    return document.cookie.split(';').reduce(function (found, pair) {
      var idx = pair.indexOf('=');
      if (idx === -1) return found;
      var key = pair.slice(0, idx).trim();
      if (key !== name) return found;
      return decodeURIComponent(pair.slice(idx + 1).trim());
    }, '');
  }

  window.getCsrfToken = function () { return readCookie('yousef_csrf'); };

  var SAFE = { GET: 1, HEAD: 1, OPTIONS: 1 };
  var originalFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    var isSameOrigin = (function () {
      // Protocol-relative URLs ("//host/...") and any absolute URL not on
      // window.location.origin must never get the CSRF header/credentials.
      if (/^\/\//.test(url)) return false;
      if (/^https?:\/\//i.test(url)) return url.indexOf(window.location.origin + '/') === 0 || url === window.location.origin;
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false; // other schemes (e.g. javascript:, data:)
      return true; // relative path -> same origin
    })();

    if (!SAFE[method] && isSameOrigin) {
      var token = readCookie('yousef_csrf');
      var headers = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
      if (token && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
      init = Object.assign({}, init, { headers: headers, credentials: init.credentials || 'same-origin' });
    }
    return originalFetch(input, init);
  };
})();
