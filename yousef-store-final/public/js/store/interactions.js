/* مُولَّد من storefront.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, showToast, announce } from './core.js';
import { PRODUCTS, wishlistFilterActive, setWishlistFilter, setCurrentFilter } from './state.js';
import { addToCart } from './cart.js';
import { toggleWishlist } from './wishlist.js';
import { openProductModal } from './product-modal.js';
import { renderProducts } from './catalog.js';

/* كل ربط الضغطات على الشبكة/الفلاتر/البحث. */
export function wireInteractions() {
$('productGrid')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-add]');
  if (btn) {
    e.stopPropagation();
    const added = addToCart(Number(btn.dataset.add));
    btn.classList.remove('pulse'); void btn.offsetWidth; btn.classList.add('pulse');
    const p = PRODUCTS.find((x) => x.id === Number(btn.dataset.add));
    if (added && p) showToast(`اتضاف "${p.name}" للسلة ✓`);
    return;
  }
  const wish = e.target.closest('[data-wish]');
  if (wish) {
    e.stopPropagation();
    toggleWishlist(Number(wish.dataset.wish));
    return;
  }
  const card = e.target.closest('[data-open]');
  if (card) openProductModal(card.dataset.open);
});

// (SSR) زرار "أضف للسلة" في كتلة المنتج المرسومة من السيرفر.
document.getElementById('ssrProduct')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ssr-add]');
  if (!btn) return;
  const id = Number(btn.dataset.ssrAdd);
  const added = addToCart(id);
  const p = PRODUCTS.find((x) => x.id === id);
  if (added && p) showToast(`اتضاف "${p.name}" للسلة ✓`);
});

$('wishlistBtn')?.addEventListener('click', () => {
  setWishlistFilter(!wishlistFilterActive);
  $('wishlistBtn')?.classList.toggle('filtering', wishlistFilterActive);
  document.getElementById('products')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  renderProducts();
});

$('featuredScroll')?.addEventListener('click', (e) => {
  const card = e.target.closest('[data-open]');
  if (card) openProductModal(card.dataset.open);
});

$('filterTabs')?.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  tab.classList.add('active');
  setCurrentFilter(tab.dataset.filter);
  renderProducts();
});

let productSearchDebounce = null;
$('productSearch')?.addEventListener('input', () => {
  clearTimeout(productSearchDebounce);
  productSearchDebounce = setTimeout(renderProducts, 250);
});

document.querySelectorAll('.cat-card').forEach((card) => {
  const activate = () => {
    const f = card.dataset.filter;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.filter === f));
    setCurrentFilter(f);
    renderProducts();
    announce(`تم عرض قسم ${f}`);
    $('products')?.scrollIntoView({ behavior: 'smooth' });
  };
  card.addEventListener('click', activate);
  // (إتاحة) الكروت دي كانت div مش قابل للتشغيل بالكيبورد — دلوقتي Enter/Space.
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      activate();
    }
  });
});
}
