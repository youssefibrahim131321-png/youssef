const { truthy } = require('./core/bool');
/**
 * (إصلاح SEO) عرض صفحة المنتج على السيرفر (SSR).
 *
 * قبل كده صفحة /product/<id>/<slug> كانت بتبعت نفس index.html والمحتوى كله
 * بيتبني بجافاسكربت بعد ما الـ API يرجّع، يعني أي زاحف (crawler) ما بينفّذش JS
 * كان بيشوف صفحة فاضية — الميتا و JSON-LD بس. هنا بنولّد كتلة HTML كاملة
 * للمنتج (اسم، سعر، وصف، صورة، توفّر، breadcrumb، منتجات مرتبطة كلينكات حقيقية)
 * وبنحقنها جوه <main> قبل الإرسال. الـ slug وبيانات المنتج بتفضل زي ما هي.
 */
const { productPath } = require('./slug');

function esc(value) {
  return String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function money(value) {
  const n = Number(value || 0);
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} ج.م`;
}

function imageOf(product) {
  const raw = String(product.image_url || product.image || '').trim();
  if (!raw || /^(javascript|data):/i.test(raw)) return '/icon-512.png';
  return raw;
}

function stars(rating) {
  const r = Math.round(Number(rating || 0));
  return '★'.repeat(Math.max(0, Math.min(5, r))) + '☆'.repeat(Math.max(0, 5 - Math.max(0, Math.min(5, r))));
}

function relatedCard(p) {
  return `<a class="ssr-related-card" href="${esc(productPath(p))}">
      <img src="${esc(imageOf(p))}" alt="${esc(p.name)}" width="240" height="240" loading="lazy" decoding="async">
      <span class="ssr-related-name">${esc(p.name)}</span>
      <span class="ssr-related-price mono">${esc(money(p.price))}</span>
    </a>`;
}

/**
 * @param {object} product المنتج المطلوب
 * @param {Array<object>} allProducts كل المنتجات النشطة (للمنتجات المرتبطة)
 * @returns {string} كتلة HTML جاهزة للحقن
 */
function renderProductSection(product, allProducts = []) {
  const image = imageOf(product);
  const price = money(product.price);
  const oldPrice = Number(product.old_price || 0) > Number(product.price || 0) ? money(product.old_price) : '';
  const inStock = Number(product.stock || 0) > 0;
  const description =
    String(product.description || '').trim() ||
    `${product.name} متوفر في متجر يوسف لمستلزمات العربيات بسعر ${price} مع توصيل لحد باب البيت.`;
  const category = String(product.category || '').trim();
  const reviews = Number(product.reviews_count || 0);
  const rating = Number(product.rating || 0);

  const pool = (Array.isArray(allProducts) ? allProducts : []).filter(
    (p) => p && p.id !== product.id && truthy(p.active)
  );
  const sameCategory = category ? pool.filter((p) => String(p.category || '') === category) : [];
  // لو القسم فيه منتج واحد بس، بنكمّل من باقي المنتجات عشان الصفحة يفضل فيها
  // لينكات داخلية تساعد الأرشفة.
  const related = [...sameCategory, ...pool.filter((p) => !sameCategory.includes(p))].slice(0, 6);

  return `<section class="ssr-product" id="ssrProduct" data-product-id="${esc(product.id)}">
  <div class="container">
    <nav class="ssr-crumbs" aria-label="مسار التنقل">
      <a href="/">الرئيسية</a>
      <span aria-hidden="true">/</span>
      <a href="/#products">المنتجات</a>
      ${category ? `<span aria-hidden="true">/</span><span>${esc(category)}</span>` : ''}
    </nav>
    <div class="ssr-product-grid">
      <div class="ssr-product-media">
        <img src="${esc(image)}" alt="${esc(product.name)}" width="720" height="720" fetchpriority="high" decoding="async" data-fallback="1">
      </div>
      <div class="ssr-product-info">
        ${category ? `<div class="ssr-product-cat">${esc(category)}</div>` : ''}
        <h1 class="ssr-product-title">${esc(product.name)}</h1>
        <div class="ssr-product-price mono">${esc(price)}${oldPrice ? `<span class="ssr-old-price">${esc(oldPrice)}</span>` : ''}</div>
        <p class="ssr-product-avail">${inStock ? 'متوفر الآن · جاهز للشحن' : 'غير متوفر حاليًا'}</p>
        ${
          reviews
            ? `<p class="ssr-product-rating"><span aria-hidden="true">${stars(rating)}</span> ${rating.toFixed(1)} من 5 (${reviews} تقييم)</p>`
            : ''
        }
        <div class="ssr-product-desc">${esc(description)
          .split(/\n+/)
          .map((line) => `<p>${line}</p>`)
          .join('')}</div>
        <div class="ssr-product-actions">
          <button type="button" class="btn btn-primary" data-ssr-add="${esc(product.id)}"${inStock ? '' : ' disabled'}>
            ${inStock ? 'أضف للسلة' : 'غير متوفر'}
          </button>
          <a class="btn btn-ghost" href="/#products">تصفّح باقي المنتجات</a>
        </div>
      </div>
    </div>
    ${
      related.length
        ? `<div class="ssr-related">
      <h2 class="ssr-related-title">منتجات مشابهة</h2>
      <div class="ssr-related-grid">${related.map(relatedCard).join('')}</div>
    </div>`
        : ''
    }
  </div>
</section>`;
}

/** يحقن كتلة المنتج أول ما يفتح <main> ويشيل الهيرو من نتيجة السيرفر. */
function injectProductSection(html, product, allProducts) {
  if (!product) return html;
  const section = renderProductSection(product, allProducts);
  if (!/<main[^>]*>/i.test(html)) return html;
  return html
    .replace(/<main([^>]*)>/i, (m) => `${m}\n${section}`)
    .replace(/<body([^>]*)>/i, (m, attrs) =>
      /\bclass="/i.test(attrs)
        ? m.replace(/\bclass="([^"]*)"/i, (mm, cls) => `class="${cls} is-product-page"`)
        : `<body${attrs} class="is-product-page">`
    );
}

module.exports = { renderProductSection, injectProductSection };
