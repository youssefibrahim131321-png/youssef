const test = require('node:test');
const assert = require('node:assert');
const { productSlug, productPath, parseProductPath } = require('../lib/slug');

test('arabic names become url safe slugs', () => {
  assert.strictEqual(productSlug('زيت محرك 5W-30'), 'زيت-محرك-5w-30');
});

test('product path and parser round trip', () => {
  const p = { id: 12, name: 'فلتر هواء' };
  const url = productPath(p);
  assert.strictEqual(url, '/product/12/فلتر-هواء');
  assert.strictEqual(parseProductPath(url), 12);
});

test('parser ignores unrelated paths', () => {
  assert.strictEqual(parseProductPath('/'), null);
  assert.strictEqual(parseProductPath('/products/12'), null);
});
