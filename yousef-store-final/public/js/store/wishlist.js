/* مُولَّد من storefront.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, showToast } from './core.js';
import { currentUser, wishlistIds, setWishlistIds, wishlistFilterActive } from './state.js';
import { renderProducts } from './catalog.js';

export async function loadWishlist() {
  if (!currentUser) return;
  try {
    const res = await fetch('/api/wishlist', { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    // المفضلة ميزة ثانوية: فشلها لا ينبغي أن يغطي المتجر كله بشريط خطأ أحمر.
    if (res.status === 401 || res.status === 403) {
      setWishlistIds(new Set());
      updateWishlistUI();
      return;
    }
    if (!res.ok) throw new Error('wishlist failed');
    setWishlistIds(new Set((data.products || []).map((p) => p.id)));
    updateWishlistUI();
  } catch (e) {
    // لا نعرض Network Error عام بسبب المفضلة؛ نحتفظ بالمتجر شغالًا بشكل طبيعي.
    console.warn('[wishlist] تعذر تحميل المفضلة:', e);
    setWishlistIds(new Set());
    updateWishlistUI();
  }
}

export function updateWishlistUI() {
  const badge = $('wishlistBadge');
  const btn = $('wishlistBtn');
  if (badge) {
    badge.textContent = wishlistIds.size;
    badge.classList.toggle('hidden', wishlistIds.size === 0);
  }
  if (btn) {
    btn.classList.toggle('active', wishlistIds.size > 0);
    btn.setAttribute('aria-label', wishlistIds.size ? `المفضلة (${wishlistIds.size} منتج)` : 'المفضلة');
  }
  // (a11y) الوصف بيتغير مع الحالة، فقارئ الشاشة يعرف إن المنتج محفوظ فعلًا.
  document.querySelectorAll('.wish-toggle').forEach((el) => {
    const on = wishlistIds.has(Number(el.dataset.wish));
    el.classList.toggle('active', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.setAttribute('aria-label', on ? 'إزالة من المفضلة' : 'أضف للمفضلة');
  });
  const modalWish = $('modalWishBtn');
  if (modalWish && modalWish.dataset.id) {
    const on = wishlistIds.has(Number(modalWish.dataset.id));
    modalWish.setAttribute('aria-pressed', on ? 'true' : 'false');
    modalWish.setAttribute('aria-label', on ? 'إزالة من المفضلة' : 'أضف للمفضلة');
  }
}

export async function toggleWishlist(id) {
  if (!currentUser) { window.location.href = '/account.html?next=index.html'; return; }
  try {
    const res = await fetch(`/api/wishlist/${id}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'حدث خطأ'); return; }
    if (data.inWishlist) { wishlistIds.add(Number(id)); showToast('أضيف للمفضلة ❤'); }
    else { wishlistIds.delete(Number(id)); showToast('تمت الإزالة من المفضلة'); }
    updateWishlistUI();
    if ($('modalWishBtn')?.dataset.id === String(id)) {
      $('modalWishBtn').classList.toggle('active', data.inWishlist);
      $('modalWishBtn').setAttribute('aria-pressed', data.inWishlist ? 'true' : 'false');
      $('modalWishBtn').setAttribute('aria-label', data.inWishlist ? 'إزالة من المفضلة' : 'أضف للمفضلة');
    }
    if (wishlistFilterActive) renderProducts();
  } catch (e) {
    showToast('تعذر الاتصال بالخادم');
  }
}
