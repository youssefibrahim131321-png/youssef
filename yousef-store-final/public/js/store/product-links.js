/* مُولَّد من storefront.js القديم — نفس المنطق، مقسّم لموديولات ES. */
/* (إصلاح 10) روابط منتجات حقيقية /product/<id>/<slug> بدل /?p=ID */
export function productSlug(name) {
  return String(name || '').trim().replace(/\u0640/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 70).toLowerCase() || 'product';
}
export function productUrlPath(p) { return p && p.id ? `/product/${p.id}/${productSlug(p.name)}` : '/'; }
export function currentProductId() {
  const m = /^\/product\/(\d+)/.exec(location.pathname);
  if (m) return Number(m[1]);
  const q = new URLSearchParams(location.search).get('p');
  return q ? Number(q) : null;
}
/* (إصلاح 7) الـ API بقى صفحات؛ بنجيب الصفحات ورا بعض بدل طلب واحد ضخم. */
export async function fetchAllProducts(limit = 100, maxPages = 25) {
  let page = 1; let all = []; let categories = [];
  for (; page <= maxPages; page += 1) {
    const res = await fetch(`/api/products?limit=${limit}&page=${page}`);
    if (!res.ok) throw new Error('products');
    const data = await res.json();
    all = all.concat(data.products || []);
    if (page === 1) categories = data.categories || [];
    if (!data.hasMore) break;
  }
  return { products: all, categories };
}
