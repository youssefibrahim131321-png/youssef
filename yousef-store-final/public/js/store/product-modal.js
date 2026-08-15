/* مُولَّد من storefront.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, safeImageUrl, fmt, html, setHTML, trustedHtml } from './core.js';
import { PRODUCTS, currentUser, wishlistIds } from './state.js';
import { currentProductId, productUrlPath } from './product-links.js';
import { starString, setProductSchema } from './catalog.js';
import { toggleWishlist } from './wishlist.js';
import { addToCart } from './cart.js';

export function openProductModal(id) {
  const p = PRODUCTS.find((x) => x.id === Number(id));
  if (!p) return;
  const modal = $('productModal');
  if (!modal) return;
  modal.__previousFocus = document.activeElement;
  $('modalImg').src = safeImageUrl(p.image_url);
  $('modalImg').dataset.fallback = '1';
  $('modalImg').alt = p.name;
  $('modalTitle').textContent = p.name;
  $('modalCat').textContent = p.category || '';
  $('modalDesc').textContent = p.description || 'منتج مميز من متجر يوسف لمستلزمات العربيات.';
  setHTML($('modalPrice'), html`${p.old_price ? html`<span class="old" style="font-size:16px;color:var(--text-3);text-decoration:line-through;margin-inline-start:8px">${fmt(p.old_price)}</span>` : ''}${fmt(p.price)}`);
  $('modalAddBtn').onclick = () => { if (addToCart(p.id)) closeProductModal(); };

  const wishBtn = $('modalWishBtn');
  if (wishBtn) {
    wishBtn.dataset.id = String(p.id);
    wishBtn.classList.toggle('active', wishlistIds.has(p.id));
    wishBtn.onclick = () => toggleWishlist(p.id);
  }

  const ratingCount = Number(p.reviews_count || 0);
  const ratingAvg = Number(p.rating || 0);
  setHTML($('modalRating'), ratingCount
    ? html`<span class="stars">${starString(ratingAvg)}</span><span class="count">${ratingAvg.toFixed(1)} (${ratingCount} تقييم)</span>`
    : html`<span class="count">لسه مفيش تقييمات لهذا المنتج</span>`);

  loadReviews(p.id);
  resetReviewForm(p.id);
  setProductSchema(p);
  if (currentProductId() !== Number(p.id)) {
    history.pushState({ productId: p.id }, '', productUrlPath(p));
  }

  modal.setAttribute('aria-hidden', 'false');
  modal.classList.add('open');
  document.body.classList.add('no-scroll');
  setTimeout(() => $('modalClose')?.focus(), 0);
}

export async function loadReviews(productId) {
  const list = $('reviewsList');
  if (!list) return;
  setHTML(list, trustedHtml('<div class="reviews-empty">جاري التحميل...</div>'));
  try {
    const res = await fetch(`/api/products/${productId}/reviews`);
    const data = await res.json();
    const reviews = data.reviews || [];
    setHTML(list, reviews.length
      ? reviews.map((r) => html`
        <div class="review-item">
          <div class="r-head"><span class="r-name">${r.user_name || 'عميل'}</span><span class="r-stars">${starString(r.rating)}</span></div>
          ${r.comment ? html`<div class="r-comment">${r.comment}</div>` : ''}
          <div class="r-date">${new Date(r.created_at).toLocaleDateString('ar-EG')}</div>
        </div>`)
      : trustedHtml('<div class="reviews-empty">لسه مفيش تقييمات — كن أول من يقيّم المنتج.</div>'));
  } catch (e) {
    setHTML(list, trustedHtml('<div class="reviews-empty">تعذر تحميل التقييمات.</div>'));
  }
}

export function resetReviewForm(productId) {
  const starsInput = $('reviewStarsInput');
  const comment = $('reviewComment');
  const msg = $('reviewMsg');
  if (starsInput) { starsInput.dataset.value = '0'; starsInput.querySelectorAll('span').forEach((s) => s.classList.remove('on')); }
  if (comment) comment.value = '';
  if (msg) { msg.textContent = ''; msg.className = 'review-msg'; }
  const submitBtn = $('submitReviewBtn');
  if (submitBtn) submitBtn.onclick = () => submitReview(productId);
}

export async function submitReview(productId) {
  if (!currentUser) { window.location.href = '/account.html?next=index.html'; return; }
  const rating = Number($('reviewStarsInput')?.dataset.value || 0);
  const msg = $('reviewMsg');
  if (!rating) { msg.textContent = 'اختار تقييم بالنجوم أولاً'; msg.className = 'review-msg err'; return; }
  const btn = $('submitReviewBtn');
  btn.disabled = true; btn.textContent = 'جاري الإرسال...';
  try {
    const res = await fetch(`/api/products/${productId}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating, comment: $('reviewComment')?.value.trim() })
    });
    const data = await res.json();
    if (!res.ok) {
      msg.textContent = data.error || 'تعذر إرسال التقييم';
      msg.className = 'review-msg err';
    } else {
      msg.textContent = 'تم إرسال تقييمك، شكرًا لك 🙏';
      msg.className = 'review-msg ok';
      loadReviews(productId);
    }
  } catch (e) {
    msg.textContent = 'تعذر الاتصال بالخادم';
    msg.className = 'review-msg err';
  }
  btn.disabled = false; btn.textContent = 'إرسال التقييم';
}

export function closeProductModal() {
  const modal = $('productModal');
  modal?.setAttribute('aria-hidden', 'true');
  modal?.classList.remove('open');
  document.body.classList.remove('no-scroll');
  if (modal?.__previousFocus && typeof modal.__previousFocus.focus === 'function') modal.__previousFocus.focus();
  if (currentProductId()) {
    history.pushState({}, '', '/');
  }
  document.getElementById('schema-product')?.remove();
}

export function wireProductModal() {
$('reviewStarsInput')?.addEventListener('click', (e) => {
  const star = e.target.closest('[data-star]');
  if (!star) return;
  const val = Number(star.dataset.star);
  const input = $('reviewStarsInput');
  input.dataset.value = String(val);
  input.querySelectorAll('span').forEach((s) => s.classList.toggle('on', Number(s.dataset.star) <= val));
});
$('modalClose')?.addEventListener('click', closeProductModal);
// (4) بدل onclick داخل الـ HTML — عشان الـ CSP يقدر يمنع السكريبتات المضمّنة تمامًا.
$('modalClose2')?.addEventListener('click', closeProductModal);
$('productModal')?.addEventListener('click', (e) => { if (e.target === $('productModal')) closeProductModal(); });
document.addEventListener('keydown', (e) => {
  const modal = $('productModal');
  if (!modal?.classList.contains('open')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeProductModal(); return; }
  if (e.key !== 'Tab') return;
  const focusables = [...modal.querySelectorAll('button, a, input, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
}
