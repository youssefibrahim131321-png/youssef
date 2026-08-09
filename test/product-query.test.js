const test = require('node:test');
const assert = require('node:assert');
const { queryProducts } = require('../lib/product-query');

const make = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1, name: `منتج ${i + 1}`, category: i % 2 ? 'فلاتر' : 'زيوت',
  description: '', tag: '', price: (i + 1) * 10, old_price: null,
  stock: i % 3 === 0 ? 0 : 5, featured: i < 3 ? 1 : 0, sold: i, rating: 0
}));

test('paginates instead of returning the whole catalogue', () => {
  const res = queryProducts(make(120), { limit: 24, page: 2 });
  assert.strictEqual(res.items.length, 24);
  assert.strictEqual(res.total, 120);
  assert.strictEqual(res.pages, 5);
  assert.strictEqual(res.hasMore, true);
});

test('last page has no more results', () => {
  const res = queryProducts(make(30), { limit: 24, page: 2 });
  assert.strictEqual(res.items.length, 6);
  assert.strictEqual(res.hasMore, false);
});

test('limit is clamped and bad page falls back', () => {
  const res = queryProducts(make(10), { limit: 9999, page: -3 });
  assert.strictEqual(res.limit, 100);
  assert.strictEqual(res.page, 1);
});

test('filters by category, stock and price range', () => {
  const all = make(20);
  assert.ok(queryProducts(all, { category: 'فلاتر', limit: 100 }).items.every((p) => p.category === 'فلاتر'));
  assert.ok(queryProducts(all, { inStock: '1', limit: 100 }).items.every((p) => p.stock > 0));
  const priced = queryProducts(all, { minPrice: 50, maxPrice: 100, limit: 100 }).items;
  assert.ok(priced.every((p) => p.price >= 50 && p.price <= 100));
});

test('swapped price bounds still work', () => {
  const res = queryProducts(make(20), { minPrice: 100, maxPrice: 50, limit: 100 });
  assert.ok(res.items.every((p) => p.price >= 50 && p.price <= 100));
});

test('sorts by price ascending', () => {
  const items = queryProducts(make(10), { sort: 'price-asc', limit: 100 }).items;
  assert.deepStrictEqual(items.map((p) => p.price), items.map((p) => p.price).slice().sort((a, b) => a - b));
});
