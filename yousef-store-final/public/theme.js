/**
 * تبديل المظهر (فاتح/غامق) — مصدر واحد لكل صفحات الموقع.
 *
 * قبل كده كان كل صفحة فيها نسخة inline مختلفة، وصفحات كتير (الأدمن، تسجيل
 * دخول الأدمن، استعادة كلمة المرور، الشحن/الاسترجاع/الخصوصية، التفعيل) مكانش
 * فيها أي كود ثيم أصلًا — فلما المستخدم يختار الفاتح ويفتح أي صفحة منهم
 * يلاقيها غامقة، ولا فيه زرار يبدّل. الملف ده بيحل ده كله:
 *   - بيطبّق الثيم المحفوظ قبل أول رسم للصفحة (بدون وميض).
 *   - لو مفيش اختيار محفوظ، بيتبع إعداد النظام (prefers-color-scheme).
 *   - بيركّب زرار تبديل تلقائيًا في أي صفحة مالهاش زرار.
 *   - بيزامن <meta name="theme-color"> وبين التابات المفتوحة.
 *
 * لازم يتحمّل في <head> من غير defer عشان الثيم يتطبّق قبل الرسم.
 */
(function () {
  var KEY = 'siteTheme';
  var root = document.documentElement;

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function systemTheme() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch (e) { return 'dark'; }
  }
  function current() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function syncMeta(theme) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      if (!document.head) return;
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', theme === 'light' ? '#f6f6f7' : '#101114');
  }

  function syncButtons(theme) {
    var light = theme === 'light';
    var btns = document.querySelectorAll('#themeToggleBtn, .theme-toggle');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', String(light));
      btns[i].setAttribute('title', light ? 'التبديل للمظهر الغامق' : 'التبديل للمظهر الفاتح');
    }
  }

  function apply(theme, persist) {
    if (theme === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    if (persist) { try { localStorage.setItem(KEY, theme); } catch (e) {} }
    syncMeta(theme);
    syncButtons(theme);
  }

  // (1) تطبيق فوري قبل الرسم — من غير انتظار DOMContentLoaded.
  apply(stored() || systemTheme(), false);

  // (إصلاح) لو الصفحة نسيت تحمّل /ui-utils.js قبل السطر ده (زي ما حصل في
  // 404/shipping/returns/privacy)، window.YousefUI بيبقى undefined وأي قراية
  // منه بترمي TypeError وتوقف باقي theme.js (زرار الثيم نفسه ما يترّكبش).
  // الـ Fallback هنا بسيط وآمن بما يكفي لاستخدام theme.js الداخلي فقط (ICONS
  // ثابت في الكود، مفيش أي مدخلات مستخدم بتتمرّر هنا).
  var ui = window.YousefUI || {
    setHTML: function (el, html) { if (el) el.innerHTML = String(html); },
    trustedHtml: function (value) { return value; }
  };
  var setHTML = function (el, content) { return ui.setHTML(el, content); };
  var trustedHtml = function (value) { return ui.trustedHtml(value); };
  var ICONS = '<svg class="icon-sun" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2.4M12 19.1v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    + '<svg class="icon-moon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

  var CSS = ''
    + '#themeToggleBtn svg,.theme-toggle svg{width:19px;height:19px;color:currentColor}'
    + '#themeToggleBtn .icon-moon,.theme-toggle .icon-moon{display:block}'
    + '#themeToggleBtn .icon-sun,.theme-toggle .icon-sun{display:none}'
    + '[data-theme="light"] #themeToggleBtn .icon-moon,[data-theme="light"] .theme-toggle .icon-moon{display:none}'
    + '[data-theme="light"] #themeToggleBtn .icon-sun,[data-theme="light"] .theme-toggle .icon-sun{display:block}'
    + '.theme-fab{position:fixed;inset-block-end:20px;inset-inline-end:20px;z-index:120;width:46px;height:46px;'
    + 'border-radius:50%;display:grid;place-items:center;cursor:pointer;'
    + 'background:#141821;color:#f1f2f6;border:1px solid rgba(255,255,255,.12);'
    + 'box-shadow:0 8px 24px rgba(0,0,0,.25);transition:transform .2s ease,background .2s ease}'
    + '[data-theme="light"] .theme-fab{background:#ffffff;color:#14171d;border-color:rgba(15,18,25,.12);box-shadow:0 8px 24px rgba(15,18,25,.14)}'
    + '.theme-fab:hover{transform:translateY(-2px)}'
    + '@media print{.theme-fab{display:none}}';

  function injectStyle() {
    if (document.getElementById('themeToggleStyles')) return;
    var style = document.createElement('style');
    if (window.__CSP_NONCE__) { style.setAttribute('nonce', window.__CSP_NONCE__); style.nonce = window.__CSP_NONCE__; }
    style.id = 'themeToggleStyles';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureButton() {
    if (document.getElementById('themeToggleBtn') || document.querySelector('.theme-toggle')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'themeToggleBtn';
    btn.className = 'theme-fab theme-toggle';
    btn.setAttribute('aria-label', 'تبديل المظهر (فاتح/غامق)');
    setHTML(btn, trustedHtml(ICONS));
    document.body.appendChild(btn);
  }

  function fillIcons() {
    var btns = document.querySelectorAll('#themeToggleBtn, .theme-toggle');
    for (var i = 0; i < btns.length; i++) {
      if (!btns[i].querySelector('svg')) setHTML(btns[i], trustedHtml(ICONS));
    }
  }

  // (أداء) ملفات الخطوط بتتحمّل بـ media="print" عشان ما تحجبش أول رسم،
  // وهنا بنحوّلها لـ all بعد ما الصفحة تبقى تفاعلية فالنص يظهر فورًا بخط
  // النظام ثم يتبدّل (font-display: swap).
  function activateLazyFonts() {
    var links = document.querySelectorAll('link[data-lazy-font]');
    for (var i = 0; i < links.length; i++) links[i].media = 'all';
  }

  function init() {
    activateLazyFonts();
    injectStyle();
    ensureButton();
    fillIcons();
    syncButtons(current());
    // تفويض الحدث: أي زرار ثيم (حتى لو اتضاف بعدين) بيشتغل من غير ربط جديد.
    document.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest && event.target.closest('#themeToggleBtn, .theme-toggle');
      if (!btn) return;
      event.preventDefault();
      apply(current() === 'light' ? 'dark' : 'light', true);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // (2) لو المستخدم غيّر الثيم في تاب تاني، باقي التابات تتحدّث فورًا.
  window.addEventListener('storage', function (event) {
    if (event.key !== KEY) return;
    apply(event.newValue === 'light' ? 'light' : 'dark', false);
  });

  // (3) لو مفيش اختيار صريح، نتابع إعداد النظام لو اتغيّر.
  try {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var onChange = function (e) { if (!stored()) apply(e.matches ? 'light' : 'dark', false); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (e) {}

  window.setSiteTheme = function (theme) { apply(theme === 'light' ? 'light' : 'dark', true); };
})();
