/**
 * ---------------------------------------------------------------------------
 * ui-utils.js — دوال الواجهة المشتركة (ملف واحد بدل تكرارها في كل صفحة)
 * ---------------------------------------------------------------------------
 * كانت escapeHtml / safeImage متكررة في storefront.js و checkout.html و
 * admin.html و dashboard.html بنسخ مختلفة (وواحدة منها كانت بترجع '' فتكسر
 * الصور في صفحة الدفع). دلوقتي مصدر واحد لكل الصفحات.
 */
(function (global) {
  var PLACEHOLDER_IMAGE = '/uploads/products/placeholder.jpg';

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }

  /** رابط صورة آمن — وأي حاجة غير صالحة بترجع الصورة الافتراضية (مش نص فاضي). */
  function safeImageUrl(url) {
    var value = String(url === null || url === undefined ? '' : url).trim();
    if (!value) return PLACEHOLDER_IMAGE;
    var ok = /^\/(?!\/)[^"'<>\s]*$/.test(value)
      || /^https?:\/\/[^"'<>\s]+$/i.test(value)
      || /^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i.test(value);
    return ok ? value : PLACEHOLDER_IMAGE;
  }

  function safeImage(url) {
    return escapeHtml(safeImageUrl(url));
  }

  /**
   * -------------------------------------------------------------------------
   * قوالب HTML آمنة افتراضيًا (html`` + setHTML)
   * -------------------------------------------------------------------------
   * قبل كده كل الواجهة كانت بتتبني بـ `el.innerHTML = `...`` مع الاعتماد على إن
   * المبرمج يفتكر يلفّ كل قيمة بـ escapeHtml. أول حقل يتنسي = ثغرة XSS مخزّنة.
   * دلوقتي: أي `${...}` جوّه html`` بيتهرّب تلقائيًا، والـ innerHTML اتشال من
   * كل ملفات الواجهة وبقى موجود في مكان واحد بس (setHTML) — سهل تدقيقه.
   *
   *   setHTML(el, html`<b>${userName}</b>`)   // userName مهرّب تلقائيًا
   *   html`<div>${rows}</div>`                // مصفوفة قوالب = بتتجمع لوحدها
   *   trustedHtml('<svg .../>')               // HTML ثابت في الكود (لا مدخلات)
   */
  function SafeHtml(value) { this.value = value; }
  SafeHtml.prototype.toString = function () { return this.value; };

  /** علّم نص HTML ثابت (مكتوب في الكود، من غير أي مدخلات) إنه آمن. */
  function trustedHtml(value) { return new SafeHtml(String(value)); }

  function renderHtmlValue(value) {
    if (value === null || value === undefined || value === false || value === true) return '';
    if (value instanceof SafeHtml) return value.value;
    if (Array.isArray(value)) {
      var out = '';
      for (var i = 0; i < value.length; i += 1) out += renderHtmlValue(value[i]);
      return out;
    }
    return escapeHtml(value);
  }

  /** قالب مُهرَّب افتراضيًا. */
  function html(strings) {
    var out = strings[0];
    for (var i = 1; i < arguments.length; i += 1) {
      out += renderHtmlValue(arguments[i]) + strings[i];
    }
    return new SafeHtml(out);
  }

  /** نقطة الكتابة الوحيدة في التطبيق كله (المكان الوحيد اللي بيلمس innerHTML). */
  function setHTML(element, content) {
    if (!element) return element;
    element.innerHTML = renderHtmlValue(content);
    return element;
  }

  /** إفراغ عنصر من غير innerHTML = '' متكرر في كل مكان. */
  function clearNode(element) {
    if (!element) return element;
    while (element.firstChild) element.removeChild(element.firstChild);
    return element;
  }

  /** رابط داخلي آمن: بيمنع أي إعادة توجيه لدومين خارجي (open redirect). */
  function safeInternalPath(value, fallback) {
    var fb = fallback || '/';
    var raw = String(value === null || value === undefined ? '' : value).trim();
    if (!raw) return fb;
    // لازم يبدأ بـ / واحدة بس، ومن غير \ ولا // ولا scheme.
    if (!/^\/(?!\/)/.test(raw) || raw.indexOf('\\') !== -1) return fb;
    try {
      var url = new URL(raw, global.location.origin);
      if (url.origin !== global.location.origin) return fb;
      return url.pathname + url.search + url.hash;
    } catch (e) {
      return fb;
    }
  }

  /** تنسيق السعر بالجنيه — مصدر واحد بدل fmt() المتكرّرة في كل صفحة. */
  function formatEGP(value) {
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    return n.toLocaleString('en-US') + ' ج.م';
  }

  /** إعلان رسالة لقارئات الشاشة عبر منطقة aria-live مشتركة. */
  function announce(message) {
    var region = document.getElementById('a11yLive');
    if (!region) {
      region = document.createElement('div');
      region.id = 'a11yLive';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'true');
      region.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;';
      document.body.appendChild(region);
    }
    region.textContent = '';
    setTimeout(function () { region.textContent = String(message || ''); }, 40);
  }

  /** صورة مكسورة؟ نحط الصورة الافتراضية بدل أيقونة الكسر. */
  function installImageFallback() {
    document.addEventListener('error', function (event) {
      var el = event.target;
      if (!el || el.tagName !== 'IMG') return;
      if (el.dataset.fallbackApplied === '1') return;
      el.dataset.fallbackApplied = '1';
      el.src = PLACEHOLDER_IMAGE;
    }, true);
  }

  global.YousefUI = {
    PLACEHOLDER_IMAGE: PLACEHOLDER_IMAGE,
    escapeHtml: escapeHtml,
    formatEGP: formatEGP,
    safeImageUrl: safeImageUrl,
    safeImage: safeImage,
    safeInternalPath: safeInternalPath,
    html: html,
    setHTML: setHTML,
    clearNode: clearNode,
    trustedHtml: trustedHtml,
    renderHtmlValue: renderHtmlValue,
    announce: announce,
    installImageFallback: installImageFallback
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installImageFallback);
  } else {
    installImageFallback();
  }
})(window);


// (إصلاح UX) بانر واضح لما النت يقطع: الصفحات المحفوظة محدودة، فبنقول للعميل
// إنه أوفلاين بدل ما يفاجأ بصفحة أوفلاين عند أول تنقل.
(function offlineBanner() {
  if (typeof document === 'undefined') return;
  const render = () => {
    let bar = document.getElementById('offlineBanner');
    if (!navigator.onLine) {
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'offlineBanner';
        bar.setAttribute('role', 'status');
        bar.setAttribute('aria-live', 'polite');
        bar.textContent = 'أنت غير متصل بالإنترنت — التصفح محدود لحد ما النت يرجع.';
        bar.style.cssText = 'position:fixed;inset-inline:0;top:0;z-index:9999;padding:10px 14px;'
          + 'text-align:center;font-size:13.5px;font-weight:700;background:#8a3b12;color:#fff;';
        document.body.appendChild(bar);
      }
    } else if (bar) {
      bar.remove();
    }
  };
  const start = () => { render(); window.addEventListener('online', render); window.addEventListener('offline', render); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
