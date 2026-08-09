/** (إصلاح 10) روابط منتجات حقيقية /product/<id>/<slug> بدل /?p=ID */
function productSlug(name) {
  return String(name || '')
    .trim()
    .replace(/[\u0640]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .toLowerCase() || 'product';
}
function productPath(product) {
  if (!product || !product.id) return '/';
  return `/product/${product.id}/${productSlug(product.name)}`;
}
function parseProductPath(pathname) {
  const m = /^\/product\/(\d+)(?:\/[^/]*)?\/?$/.exec(String(pathname || ''));
  return m ? Number(m[1]) : null;
}
module.exports = { productSlug, productPath, parseProductPath };
