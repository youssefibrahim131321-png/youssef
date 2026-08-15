/* مُولَّد من storefront.js القديم — نفس المنطق، مقسّم لموديولات ES. */
export const $ = (id) => document.getElementById(id);
/* الدوال المشتركة (escape / صور آمنة / تنسيق السعر / إعلان لقارئ الشاشة) بقت
   في ui-utils.js بدل ما تتكرر في كل صفحة بنسخ مختلفة. */
export const { escapeHtml, safeImageUrl, safeImage, announce, formatEGP } = window.YousefUI;
/* (أمان) قوالب مُهرَّبة افتراضيًا: مفيش innerHTML في أي ملف واجهة تاني. */
export const { html, setHTML, clearNode, trustedHtml } = window.YousefUI;
export const fmt = formatEGP;

/* ─── (إصلاح) فشل الشبكة مش مبلوع بالسكوت: رسالة واضحة + زر إعادة محاولة ─── */
export function showNetworkError(message, retry) {
  let bar = $('netErrorBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'netErrorBar';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;inset-inline:0;top:0;z-index:9999;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;padding:10px 14px;background:#7f1d1d;color:#fff;font:inherit;font-size:14px;';
    document.body.appendChild(bar);
  }
  clearNode(bar);
  const text = document.createElement('span');
  text.textContent = message;
  bar.appendChild(text);
  if (typeof retry === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'إعادة المحاولة';
    btn.style.cssText = 'padding:6px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.6);background:transparent;color:#fff;cursor:pointer;font:inherit;min-height:36px;';
    btn.addEventListener('click', () => { clearNetworkError(); retry(); });
    bar.appendChild(btn);
  }
  if (typeof announce === 'function') announce(message);
}
export function clearNetworkError() { $('netErrorBar')?.remove(); }

/* ─── Toast ─── */
export let toastTimer;
export function showToast(msg) {
  const t = $('toast');
  const txt = $('toastText');
  if (!t || !txt) return;
  txt.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
