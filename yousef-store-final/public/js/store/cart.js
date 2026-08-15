/* مُولَّد من storefront.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, safeImageUrl, fmt, showToast, announce, html, setHTML } from './core.js';
import { PRODUCTS, cart, cartNames, storeSettings, WHATSAPP_NUMBER, currentUser } from './state.js';
import { loadUser } from './auth.js';

export function stockOf(id) {
  const p = PRODUCTS.find((pp) => pp.id === Number(id));
  return p ? Math.max(0, Number(p.stock || 0)) : 0;
}

export function addToCart(id) {
  const available = stockOf(id);
  const current = cart[id] || 0;
  // (6) بدل ما نقلل الكمية بصمت، بنمنع الزيادة ونبلّغ العميل بالمتاح
  if (available <= 0) { showToast('المنتج ده نفد من المخزون حاليًا'); return false; }
  if (current + 1 > available) { showToast(`المتاح من المنتج ده ${available} قطعة فقط`); return false; }
  cart[id] = current + 1;
  updateCart();
  return true;
}

export function changeQty(id, delta) {
  if (!cart[id]) return;
  const next = cart[id] + delta;
  // (7) الكميات السالبة أو الصفرية تعني إزالة المنتج، مش قيمة سالبة في السلة
  if (next <= 0) { delete cart[id]; updateCart(); return; }
  const available = stockOf(id);
  if (next > available) { showToast(`المتاح من المنتج ده ${available} قطعة فقط`); return; }
  if (next > 999) { showToast('الحد الأقصى 999 قطعة'); return; }
  cart[id] = next;
  updateCart();
}

/** بيشيل من السلة أي منتج مابقاش موجود/متاح في المتجر، مع إشعار واضح. */
export function pruneMissingCartItems() {
  if (!Array.isArray(PRODUCTS) || !PRODUCTS.length) return;
  const gone = Object.keys(cart).filter((id) => !PRODUCTS.some((p) => p.id === Number(id)));
  if (!gone.length) return;
  const names = gone.map((id) => cartNames[id]).filter(Boolean);
  gone.forEach((id) => { delete cart[id]; delete cartNames[id]; });
  try { localStorage.setItem('yousefCart', JSON.stringify(cart)); } catch (e) {}
  try { localStorage.setItem('yousefCartNames', JSON.stringify(cartNames)); } catch (e) {}
  const label = names.length ? `«${names.join('»، «')}»` : 'منتج';
  const msg = names.length === 1
    ? `${label} مابقاش متاح واتشال من السلة.`
    : `${label} مابقوش متاحين واتشالوا من السلة.`;
  showToast(msg);
  if (typeof announce === 'function') announce(msg);
}

export function removeItem(id) {
  delete cart[id];
  updateCart();
}

export function updateCart() {
  // (إصلاح) لو منتج اتشال من المتجر بعد ما العميل حطه في السلة، كان بيختفي
  // بصمت وبيتحسب في العدّاد. دلوقتي بنشيله فعليًا وبنقول للعميل ليه.
  pruneMissingCartItems();
  // (أمان) الكميات المحفوظة في localStorage ممكن تكون متلاعب فيها. بنثبّتها
  // على المتاح في المخزون (وبحد أقصى 999) قبل أي عرض أو حساب.
  Object.keys(cart).forEach((id) => {
    const max = Math.min(999, stockOf(id));
    const q = Math.floor(Number(cart[id]));
    if (!Number.isFinite(q) || q < 1) { delete cart[id]; return; }
    if (q > max) { if (max < 1) delete cart[id]; else cart[id] = max; }
    else cart[id] = q;
  });
  const ids = Object.keys(cart);
  const count = ids.reduce((s, id) => s + cart[id], 0);
  const cartBtn = $('cartBtn');
  if (cartBtn) cartBtn.setAttribute('aria-label', count ? `السلة (${count} قطعة)` : 'السلة (فاضية)');
  const badge = $('cartBadge');
  if (badge) {
    badge.textContent = count;
    badge.classList.remove('bump');
    void badge.offsetWidth;
    badge.classList.add('bump');
  }
  try { localStorage.setItem('yousefCart', JSON.stringify(cart)); } catch (e) {}

  const el = $('cartItems');
  const totalEl = $('cartTotal');
  if (!el) return;

  if (!ids.length) {
    setHTML(el, html`<div class="cart-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h2l2.4 12.2a2 2 0 002 1.8h8.6a2 2 0 002-1.7L21 8H6"/></svg>السلة فاضية — ضيف حاجة من المنتجات.</div>`);
  } else {
    setHTML(el, ids.map((id) => {
      const p = PRODUCTS.find((pp) => pp.id === Number(id));
      if (!p) return '';
      cartNames[id] = p.name;
      return html`<div class="cart-item">
        <div class="cart-item-icon"><img data-fallback="1" alt="${p.name}" loading="lazy" data-img-id="${p.id}"></div>
        <div class="cart-item-info">
          <div class="cart-item-name">${p.name}</div>
          <div class="cart-item-price">${fmt(p.price)}</div>
          <div class="qty-control">
            <button class="qty-btn" data-dec="${p.id}">−</button>
            <span class="qty-val">${cart[id]}</span>
            <button class="qty-btn" data-inc="${p.id}">+</button>
            <button type="button" class="remove-btn" data-remove="${p.id}" aria-label="إزالة ${p.name} من السلة">إزالة</button>
          </div>
        </div>
      </div>`;
    }));
    // (أمان) رابط صورة السلة بيتحط عبر setAttribute بدل تضمينه في سلسلة innerHTML.
    el.querySelectorAll('img[data-img-id]').forEach((img) => {
      const p = PRODUCTS.find((pp) => pp.id === Number(img.dataset.imgId));
      if (p) img.setAttribute('src', safeImageUrl(p.image_url));
    });
  }

  const total = ids.reduce((s, id) => {
    const p = PRODUCTS.find((pp) => pp.id === Number(id));
    return p ? s + p.price * cart[id] : s;
  }, 0);
  if (totalEl) totalEl.textContent = fmt(total);

  const orderLines = ids.map((id) => {
    const p = PRODUCTS.find((pp) => pp.id === Number(id));
    return p ? `• ${p.name} × ${cart[id]} = ${fmt(p.price * cart[id])}` : '';
  }).filter(Boolean).join('\n');
  const msg = `السلام عليكم، عايز أطلب من يوسف:\n${orderLines}\n\nالإجمالي: ${fmt(total)}`;
  const waBtn = $('whatsappOrderBtn');
  // (إصلاح) من غير رقم مضبوط في الإعدادات بنخفي الزر بدل رقم وهمي مش شغّال.
  const waNumber = String(storeSettings.whatsappNumber || WHATSAPP_NUMBER || '').replace(/\D/g, '');
  if (waBtn) {
    if (waNumber) {
      waBtn.hidden = false;
      waBtn.href = `https://wa.me/${waNumber}?text=${encodeURIComponent(msg)}`;
    } else {
      waBtn.hidden = true;
      waBtn.removeAttribute('href');
    }
  }
  try { localStorage.setItem('yousefCartSummary', msg); } catch (e) {}
}

let cartPreviousFocus = null;
export function openCart() {
  cartPreviousFocus = document.activeElement;
  const drawer = $('cartDrawer');
  drawer?.setAttribute('aria-hidden', 'false');
  $('cartBtn')?.setAttribute('aria-expanded', 'true');
  $('cartDrawer')?.classList.add('open');
  $('cartOverlay')?.classList.add('open');
  document.body.classList.add('no-scroll');
}
export function closeCartFn() {
  const drawer = $('cartDrawer');
  drawer?.setAttribute('aria-hidden', 'true');
  $('cartBtn')?.setAttribute('aria-expanded', 'false');
  $('cartDrawer')?.classList.remove('open');
  $('cartOverlay')?.classList.remove('open');
  document.body.classList.remove('no-scroll');
  if (cartPreviousFocus && typeof cartPreviousFocus.focus === 'function') cartPreviousFocus.focus();
}

export function wireCart() {
$('cartBtn')?.addEventListener('click', openCart);
document.addEventListener('keydown', (e) => {
  const drawer = $('cartDrawer');
  if (e.key === 'Escape' && drawer?.classList.contains('open')) closeCartFn();
  if (e.key === 'Tab' && drawer?.classList.contains('open')) {
    const focusables = [...drawer.querySelectorAll('button, a, input, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
$('closeCart')?.addEventListener('click', closeCartFn);
$('cartOverlay')?.addEventListener('click', closeCartFn);
$('cartItems')?.addEventListener('click', (e) => {
  const inc = e.target.closest('[data-inc]');
  const dec = e.target.closest('[data-dec]');
  const rem = e.target.closest('[data-remove]');
  if (inc) changeQty(Number(inc.dataset.inc), 1);
  if (dec) changeQty(Number(dec.dataset.dec), -1);
  if (rem) removeItem(Number(rem.dataset.remove));
});

$('checkoutBtn')?.addEventListener('click', async (e) => {
  if (!Object.keys(cart).length) { e.preventDefault(); showToast('أولاً أضف منتج للسلة'); return; }
  e.preventDefault();
  await loadUser();
  window.location.href = currentUser ? '/checkout.html' : '/account.html?next=checkout.html';
});
}
