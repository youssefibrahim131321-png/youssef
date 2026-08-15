/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
// (تنظيف) نفس دالة الـ escape كانت متكررة في 4 ملفات — بقت في ui-utils.js.
export const esc = window.YousefUI.escapeHtml;
export const safeImage = window.YousefUI.safeImage;
export const safeImageUrl = window.YousefUI.safeImageUrl;
/* (أمان) قوالب مُهرَّبة افتراضيًا: مفيش innerHTML في أي ملف واجهة تاني. */
export const { html, setHTML, clearNode, trustedHtml } = window.YousefUI;

// (أمان) رابط صورة صالح: مسار داخلي، http(s)، أو data:image فقط.
export function isValidImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return true;
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(raw)) return true;
  if (/["'<>\s]/.test(raw)) return false;
  return /^\/(?!\/)/.test(raw) || /^https?:\/\/[^/]+(\/.*)?$/i.test(raw);
}
export let SETTINGS = { currency: 'ج.م' };
// (موديولات) الإعدادات بتتغيّر من settings.js عن طريق الدالة دي، لأن
// الـ ES modules ما بتسمحش بإعادة تعيين متغيّر مستورد من بره.
export function setSettings(next) { SETTINGS = next || { currency: 'ج.م' }; }
export const money = (v) => `${Number(v || 0).toLocaleString('en-US')} ${SETTINGS.currency || 'ج.م'}`;
export const dateFmt = (v) => new Date(v).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });

export function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3200);
}

export function clearPrivilegedData() {
  // (أمان) قبل ما نطرد المستخدم لصفحة الدخول، بنمسح أي بيانات حساسة معروضة
  // على الشاشة عشان ما تفضلش ظاهرة في الـ DOM بعد انتهاء الجلسة.
  ['#kpiGrid', '#recentOrders', '#lowStockList', '#topCustomers', '#topProducts',
   '#ordersBody', '#productsBody', '#inventoryBody', '#couponsBody', '#reviewsBody',
   '#usersBody', '#activityList'].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) clearNode(el);
  });
}

export async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (res.status === 401 || res.status === 403) {
    clearPrivilegedData();
    window.location.href = '/admin-login.html';
    // Never resolve/reject so callers just stop silently instead of racing
    // the redirect with more UI updates or throwing unhandled errors.
    return new Promise(() => {});
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'حدث خطأ غير متوقع');
  return data;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
let modalKeyHandler = null;
let modalLastFocused = null;

export function openModal(title, bodyHtml, onSubmit) {
  // (أمان) العنوان بيتهرّب هنا جوّه الدالة نفسها، مش في كل نداء — فأي نداء
  // جديد ينسى esc() ما يفتحش باب XSS في لوحة التحكم.
  // (إتاحة) المودال بقى dialog حقيقي: role/aria-modal + عنوان مرتبط
  // (aria-labelledby) + إغلاق بـ Escape + حصر التركيز جوّاه + رجوع التركيز
  // للعنصر اللي فتحه — زي openProofViewer بالظبط.
  closeModal();
  modalLastFocused = document.activeElement;
  setHTML($('#modalRoot'), html`<div class="modal-overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <h3 id="modalTitle">${title}</h3><form id="modalForm">${bodyHtml}
    <div class="toolbar" style="margin:18px 0 0"><button class="btn btn-primary" type="submit">حفظ</button>
    <button class="btn btn-ghost" type="button" id="modalCancel">إلغاء</button></div></form></div></div>`);
  const dialog = $('#modalRoot .modal');
  $('#modalCancel').onclick = closeModal;
  $('.modal-overlay').onclick = (e) => { if (e.target.classList.contains('modal-overlay')) closeModal(); };
  $('#modalForm').onsubmit = async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target).entries());
    try { await onSubmit(values); closeModal(); } catch (error) { toast(error.message, 'err'); }
  };
  modalKeyHandler = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (e.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  };
  document.addEventListener('keydown', modalKeyHandler);
  const firstField = dialog.querySelector(FOCUSABLE);
  if (firstField) firstField.focus();
}
export const closeModal = () => {
  if (modalKeyHandler) { document.removeEventListener('keydown', modalKeyHandler); modalKeyHandler = null; }
  clearNode($('#modalRoot'));
  if (modalLastFocused && document.contains(modalLastFocused)) modalLastFocused.focus();
  modalLastFocused = null;
};
