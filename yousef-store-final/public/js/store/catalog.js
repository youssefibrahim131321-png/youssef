/* مُولَّد من storefront.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, safeImageUrl, fmt, showNetworkError, clearNetworkError, html, setHTML, trustedHtml } from './core.js';
import { PRODUCTS, setProducts, storeSettings, setStoreSettings, WHATSAPP_NUMBER, currentFilter, wishlistFilterActive, wishlistIds } from './state.js';
import { fetchAllProducts, currentProductId, productUrlPath } from './product-links.js';
import { openProductModal } from './product-modal.js';
import { updateCart } from './cart.js';

export async function loadStoreData() {
  // (إصلاح) قبل كده Promise.all كان بيخلي فشل الإعدادات يمنع عرض المنتجات
  // خالص. دلوقتي كل طلب مستقل: المنتجات بتتعرض حتى لو الإعدادات فشلت،
  // وفيه إعادة محاولة تلقائية قبل ما نعرض رسالة الخطأ.
  const settingsPromise = fetch('/api/site/settings')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  let productsRes = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      productsRes = await fetchAllProducts();
      break;
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  const settingsRes = await settingsPromise;
  if (settingsRes) {
    setStoreSettings(settingsRes.settings || {});
    if (storeSettings.name) {
      document.querySelectorAll('[data-store-name]').forEach((el) => { el.textContent = storeSettings.name; });
    }
  }
  if (!productsRes) {
    console.warn('Store load failed', lastError);
    const grid = $('productGrid') || document.querySelector('.product-grid');
    if (grid && !PRODUCTS.length) {
      setHTML(grid, trustedHtml('<div class="empty-state">تعذر تحميل المنتجات — تأكد من اتصالك بالإنترنت. <button type="button" id="storeRetryBtn" class="btn btn-ghost" style="margin-inline-start:8px;min-height:44px">إعادة المحاولة</button></div>'));
      $('storeRetryBtn')?.addEventListener('click', loadStoreData);
    }
    showNetworkError('تعذر تحميل بيانات المتجر.', loadStoreData);
    return;
  }
  try {
    setProducts((productsRes.products || []).filter((p) => p.active !== 0 && p.active !== false));
    updateContactLinks();
    renderStoreStats();
    buildFilterTabs(productsRes.categories || []);
    renderFeatured();
    renderProducts();
    updateCart();
    const deepLinkId = currentProductId();
    // (إصلاح SEO/SSR) لو السيرفر رسم صفحة المنتج بنفسه، مفيش داعي نفتح المودال
    // فوقها — المحتوى ظاهر أصلاً. المودال يفضل للروابط القديمة وللنقر من الشبكة.
    const hasSsrProduct = document.getElementById('ssrProduct')?.dataset.productId === String(deepLinkId);
    if (deepLinkId && !hasSsrProduct && PRODUCTS.some((p) => p.id === Number(deepLinkId))) openProductModal(deepLinkId);
    if (hasSsrProduct) {
      const ssrProduct = PRODUCTS.find((p) => p.id === Number(deepLinkId));
      if (ssrProduct) setProductSchema(ssrProduct);
    }
    clearNetworkError();
  } catch (e) {
    console.error('Store render failed', e);
    showNetworkError('تعذر عرض بيانات المتجر.', loadStoreData);
  }
}

/**
 * (إصلاح) روابط التواصل: لو الإعداد ناقص أو الطلب فشل، بنخفي الزر بدل ما
 * نعرض رقم افتراضي وهمي للعميل. setWhatsAppLink مشتركة مع السلة.
 */
export function setWhatsAppLink(el, number, text) {
  if (!el) return;
  if (!number) { el.hidden = true; el.removeAttribute('href'); return; }
  el.hidden = false;
  el.href = `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export function whatsappNumber() {
  return String(storeSettings.whatsappNumber || WHATSAPP_NUMBER || '').replace(/\D/g, '');
}

export function updateContactLinks() {
  const phone = $('storePhoneLink');
  const wa = $('storeWhatsAppLink');
  const waLink = $('waLink');
  const number = whatsappNumber();
  if (phone) {
    const raw = String(storeSettings.phone || '').replace(/[^\d+]/g, '');
    if (raw) {
      phone.textContent = storeSettings.phone;
      phone.href = `tel:${raw}`;
      phone.hidden = false;
    } else {
      phone.hidden = true;
      phone.removeAttribute('href');
    }
  }
  setWhatsAppLink(wa, number, '');
  setWhatsAppLink(waLink, number, 'السلام عليكم، محتاج أستفسر عن منتج');
}

export function renderStoreStats() {
  const cats = new Set(PRODUCTS.map((p) => (p.category || '').trim()).filter(Boolean));
  const deals = PRODUCTS.filter((p) => Number(p.old_price || 0) > Number(p.price || 0)).length;
  const stock = PRODUCTS.reduce((s, p) => s + Number(p.stock || 0), 0);
  if ($('storeProductsCount')) $('storeProductsCount').textContent = `${PRODUCTS.length} منتج`;
  if ($('storeCategoryCount')) $('storeCategoryCount').textContent = `${cats.size} قسم`;
  if ($('storeDealCount')) $('storeDealCount').textContent = `${deals} عرض`;
  if ($('storeInventoryCount')) $('storeInventoryCount').textContent = `${stock} قطعة`;
}

export function buildFilterTabs(categories) {
  const tabs = $('filterTabs');
  if (!tabs) return;
  const cats = categories.length ? categories.map((c) => c.name) : [...new Set(PRODUCTS.map((p) => p.category))];
  setHTML(tabs, [html`<button class="tab active" data-filter="الكل">الكل</button>`,
    cats.map((c) => html`<button class="tab" data-filter="${c}">${c}</button>`)]);
}

export function renderFeatured() {
  const el = $('featuredScroll');
  if (!el) return;
  const featured = PRODUCTS.filter((p) => (p.featured === 1 || p.featured === true)).slice(0, 8);
  const list = featured.length ? featured : PRODUCTS.slice(0, 6);
  setHTML(el, list.map((p) => html`
    <div class="featured-card" data-open="${p.id}">
      <img data-fallback="1" alt="${p.name}" loading="lazy" data-img-id="${p.id}">
      <div class="featured-card-body">
        <h4>${p.name}</h4>
        <div class="price">${fmt(p.price)}</div>
      </div>
    </div>`));
  // (أمان) رابط الصورة بيتحط عبر setAttribute بدل تضمينه في سلسلة innerHTML.
  el.querySelectorAll('img[data-img-id]').forEach((img) => {
    const p = list.find((x) => x.id === Number(img.dataset.imgId));
    if (p) img.setAttribute('src', safeImageUrl(p.image_url));
  });
}

export function getVisibleProducts() {
  const q = ($('productSearch')?.value || '').trim().toLowerCase();
  let list = currentFilter === 'الكل' ? PRODUCTS : PRODUCTS.filter((p) => p.category === currentFilter);
  if (wishlistFilterActive) list = list.filter((p) => wishlistIds.has(p.id));
  if (!q) return list;
  return list.filter((p) => `${p.name} ${p.category || ''} ${p.description || ''}`.toLowerCase().includes(q));
}

export function renderProducts() {
  const grid = $('productGrid');
  const count = $('productCount');
  if (!grid) return;
  const list = getVisibleProducts();
  if (count) count.textContent = `${list.length} منتج`;

  injectCatalogSchema(list);

  if (!list.length) {
    const icon = trustedHtml('<svg viewBox="0 0 24 24" fill="none" width="44" height="44"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="m20 20-3.2-3.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>');
    const heartIcon = trustedHtml('<svg viewBox="0 0 24 24" fill="none" width="44" height="44"><path d="M12 20s-7.5-4.6-10-9.3C.5 7.4 2.3 4 5.7 4c2 0 3.6 1.1 4.3 2.6C10.7 5.1 12.3 4 14.3 4c3.4 0 5.2 3.4 3.7 6.7C15.5 15.4 12 20 12 20z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>');
    setHTML(grid, wishlistFilterActive
      ? html`<div class="empty-state"><span class="empty-state-icon">${heartIcon}</span><strong>مفضلتك فاضية لسه</strong><span>اضغط على ♥ في أي منتج عشان تحفظه هنا.</span></div>`
      : html`<div class="empty-state"><span class="empty-state-icon">${icon}</span><strong>مفيش منتجات مطابقة</strong><span>جرّب كلمة أخرى أو غيّر التصنيف.</span></div>`);
    return;
  }

  // (أداء) أول 3 كروت (اللي فوق الطية) صورهم eager + fetchpriority عالي عشان
  // الـ LCP، والباقي lazy عبر IntersectionObserver زي ما كان.
  const EAGER_COUNT = 3;
  setHTML(grid, list.map((p, i) => html`
    <article class="product-card" data-id="${p.id}" data-open="${p.id}">
      <div class="product-media">
        ${p.tag ? html`<span class="badge-tag">${p.tag}</span>` : (p.old_price && Number(p.old_price) > Number(p.price) ? html`<span class="badge-tag badge-discount">خصم ${Math.round((1 - Number(p.price) / Number(p.old_price)) * 100)}%</span>` : '')}
        <button class="wish-toggle${wishlistIds.has(p.id) ? ' active' : ''}" data-wish="${p.id}" aria-pressed="${wishlistIds.has(p.id) ? 'true' : 'false'}" aria-label="${wishlistIds.has(p.id) ? 'إزالة من المفضلة' : 'أضف للمفضلة'}"><svg viewBox="0 0 24 24" fill="none"><path d="M12 20s-7.5-4.6-10-9.3C.5 7.4 2.3 4 5.7 4c2 0 3.6 1.1 4.3 2.6C10.7 5.1 12.3 4 14.3 4c3.4 0 5.2 3.4 3.7 6.7C15.5 15.4 12 20 12 20z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <img width="420" height="420" class="${i < EAGER_COUNT ? 'eager-img' : 'lazy'}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-fallback="1" alt="${p.name}" loading="${i < EAGER_COUNT ? 'eager' : 'lazy'}" ${i < EAGER_COUNT ? 'fetchpriority="high"' : 'decoding="async"'} data-img-id="${p.id}">
        <div class="product-quick">عرض التفاصيل</div>
      </div>
      <div class="product-body">
        <div class="product-cat">${p.category || ''}</div>
        <div class="product-name">${p.name}</div>
        ${Number(p.reviews_count || 0) ? html`<div class="product-rating"><span class="stars">${starString(Number(p.rating || 0))}</span><span>(${p.reviews_count})</span></div>` : ''}
        <div class="product-desc">${p.description || 'منتج مميز من متجر يوسف'}</div>
        <div class="product-trust">${Number(p.stock || 0) > 0 ? html`<span class="stock-ok">متاح الآن</span>` : html`<span class="stock-out">غير متاح حاليًا</span>`}<span>توصيل سريع</span><span>إرجاع سهل</span></div>
        <div class="product-foot">
          <div class="product-price">${p.old_price ? html`<span class="old">${fmt(p.old_price)}</span>` : ''}${fmt(p.price)}</div>
          <button class="add-btn" data-add="${p.id}" aria-label="أضف ${p.name} للسلة" ${Number(p.stock || 0) <= 0 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
    </article>`));

  // (أمان) رابط الصورة (data-src) بيتحط عبر setAttribute بدل تضمينه في سلسلة innerHTML.
  grid.querySelectorAll('img[data-img-id]').forEach((img) => {
    const p = list.find((x) => x.id === Number(img.dataset.imgId));
    if (p) img.setAttribute('data-src', safeImageUrl(p.image_url));
  });

  // الصور الـ eager بتتحمّل فورًا بدون انتظار الـ observer.
  grid.querySelectorAll('img.eager-img').forEach((img) => {
    if (!img.dataset.src) return;
    img.onload = () => img.classList.add('loaded');
    img.src = img.dataset.src;
    img.classList.add('loaded');
  });

  requestAnimationFrame(() => {
    grid.querySelectorAll('.product-card').forEach((c, i) => setTimeout(() => c.classList.add('show'), i * 40));
  });

  const obs = new IntersectionObserver((entries, o) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const img = e.target;
      img.src = img.dataset.src;
      img.onload = () => img.classList.add('loaded');
      o.unobserve(img);
    });
  }, { rootMargin: '200px' });
  grid.querySelectorAll('img.lazy').forEach((img) => obs.observe(img));
}

export function setJsonLd(id, data) {
  let tag = document.getElementById(id);
  if (!tag) {
    tag = document.createElement('script');
    tag.type = 'application/ld+json';
    tag.id = id;
    document.head.appendChild(tag);
  }
  tag.textContent = JSON.stringify(data);
}

export function injectCatalogSchema(list) {
  if (!list.length) return;
  setJsonLd('schema-catalog', {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: list.slice(0, 30).map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${location.origin}${productUrlPath(p)}`,
      name: p.name
    }))
  });
}

export function setProductSchema(p) {
  setJsonLd('schema-product', {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: p.description || 'منتج مميز من متجر يوسف لمستلزمات العربيات',
    image: safeImageUrl(p.image_url),
    category: p.category || undefined,
    aggregateRating: Number(p.reviews_count || 0) ? {
      '@type': 'AggregateRating',
      ratingValue: Number(p.rating || 0),
      reviewCount: Number(p.reviews_count || 0)
    } : undefined,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'EGP',
      price: Number(p.price || 0),
      availability: Number(p.stock || 0) > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url: `${location.origin}${productUrlPath(p)}`
    }
  });
}

/* ─── نجوم التقييم ─── */
export function starString(avg) {
  // (إصلاح) تثبيت القيمة بين 0 و5 عشان أي تقييم غلط ما ينتجش نجوم مشوّهة.
  const rounded = Math.min(5, Math.max(0, Math.round(Number(avg) || 0)));
  return '★★★★★☆☆☆☆☆'.slice(5 - rounded, 10 - rounded);
}

export function wireCatalog() {
window.addEventListener('popstate', () => {
  const id = currentProductId();
  if (id && PRODUCTS.some((p) => p.id === Number(id))) openProductModal(id);
  else { $('productModal')?.classList.remove('open'); document.body.classList.remove('no-scroll'); }
});
}
