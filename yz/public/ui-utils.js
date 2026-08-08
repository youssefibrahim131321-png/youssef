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
    announce: announce,
    installImageFallback: installImageFallback
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installImageFallback);
  } else {
    installImageFallback();
  }
})(window);
