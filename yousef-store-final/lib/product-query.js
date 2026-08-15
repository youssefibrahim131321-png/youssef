const { truthy } = require('./core/bool');
/**
 * فلترة/ترتيب/تقسيم صفحات المنتجات — دالة نقية قابلة للاختبار.
 * (إصلاح 7) /api/products بقى بيرجّع صفحة واحدة بس بدل الكتالوج كله.
 */
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

const SORTERS = {
  'price-asc': (a, b) => a.price - b.price,
  'price-desc': (a, b) => b.price - a.price,
  name: (a, b) => String(a.name).localeCompare(String(b.name), 'ar'),
  rating: (a, b) => (b.rating || 0) - (a.rating || 0),
  'best-selling': (a, b) => (b.sold || 0) - (a.sold || 0),
  discount: (a, b) => ((b.old_price || 0) - b.price) - ((a.old_price || 0) - a.price),
  newest: (a, b) => b.id - a.id
};

function parsePrice(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function parsePaging(query = {}) {
  const rawLimit = Number(query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(MAX_LIMIT, Math.trunc(rawLimit)) : DEFAULT_LIMIT;
  const rawPage = Number(query.page);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.trunc(rawPage) : 1;
  return { page, limit };
}

function queryProducts(all, query = {}) {
  let products = Array.isArray(all) ? all.slice() : [];
  const { q, category, sort, minPrice, maxPrice, inStock, featured } = query;

  if (q) {
    const needle = String(q).toLowerCase();
    products = products.filter((p) => `${p.name} ${p.category} ${p.description} ${p.tag}`.toLowerCase().includes(needle));
  }
  if (category && category !== 'الكل') products = products.filter((p) => p.category === category);

  let min = parsePrice(minPrice);
  let max = parsePrice(maxPrice);
  if (min !== null && max !== null && min > max) { const t = min; min = max; max = t; }
  if (min !== null) products = products.filter((p) => Number(p.price) >= min);
  if (max !== null) products = products.filter((p) => Number(p.price) <= max);
  if (inStock === '1') products = products.filter((p) => Number(p.stock) > 0);
  if (featured === '1') products = products.filter((p) => truthy(p.featured));

  products.sort(SORTERS[sort] || SORTERS.newest);

  const total = products.length;
  const { page, limit } = parsePaging(query);
  const pages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, pages);
  const offset = (safePage - 1) * limit;
  return {
    items: products.slice(offset, offset + limit),
    total,
    page: safePage,
    limit,
    pages,
    hasMore: offset + limit < total
  };
}

module.exports = { queryProducts, parsePaging, DEFAULT_LIMIT, MAX_LIMIT };
