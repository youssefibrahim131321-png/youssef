/* مُولَّد من storefront.js القديم — نفس المنطق، مقسّم لموديولات ES. */
/* الحالة المشتركة للمتجر. الـ ES modules ما بتسمحش بإعادة تعيين متغيّر
   مستورد، فأي تغيير بيمرّ على الدوال set* دي. */
export let currentUser = null;
export let PRODUCTS = [];
export let storeSettings = {};
export let wishlistIds = new Set();
export let wishlistFilterActive = false;
export let currentFilter = 'الكل';
// (إصلاح) مفيش رقم واتساب افتراضي: الرقم الوهمي القديم كان بيظهر للعملاء لو
// إعدادات المتجر ما حمّلتش، فقناة الطلب الأساسية كانت بتبوظ في صمت.
export const WHATSAPP_NUMBER = '';

export function setCurrentUser(v) { currentUser = v || null; }
export function setProducts(v) { PRODUCTS = Array.isArray(v) ? v : []; }
export function setStoreSettings(v) { storeSettings = v || {}; }
export function setWishlistIds(v) { wishlistIds = v instanceof Set ? v : new Set(v || []); }
export function setWishlistFilter(v) { wishlistFilterActive = !!v; }
export function setCurrentFilter(v) { currentFilter = v; }

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { return {}; }
}
// السلة وأسماء منتجاتها كائنات ثابتة بتتعدّل في محلها، فمحتاجة setter.
export const cart = readJson('yousefCart');
export const cartNames = readJson('yousefCartNames');

// (7) تنضيف السلة من أي كميات سالبة/صفر/غير صحيحة محفوظة قبل كده
(function sanitizeCart() {
  Object.keys(cart).forEach((id) => {
    const qty = Math.floor(Number(cart[id]));
    if (!Number.isInteger(Number(id)) || !Number.isFinite(qty) || qty < 1) { delete cart[id]; return; }
    cart[id] = Math.min(999, qty);
  });
})();

export function replaceCart(next) {
  Object.keys(cart).forEach((id) => delete cart[id]);
  Object.entries(next || {}).forEach(([id, qty]) => {
    const n = Math.floor(Number(qty));
    if (/^\d+$/.test(id) && n > 0) cart[id] = Math.min(999, n);
  });
  try { localStorage.setItem('yousefCart', JSON.stringify(cart)); } catch (e) {}
}
