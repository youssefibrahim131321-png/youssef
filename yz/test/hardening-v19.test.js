// اختبارات تراجع للإصلاحات: منع إعادة استخدام إيصال الدفع (على مستوى القاعدة)
// واستعلامات لوحة التحكم اللي بقت في SQL.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ys-hard-'));
  return createStore(path.join(dir, 'store.json'));
}

function seed(store) {
  store.createUser({ name: 'عميل', email: 'c@test.com', password: 'password123', role: 'customer' });
  const user = store.findUserByEmail('c@test.com');
  const product = store.createProduct({ name: 'فلتر زيت', price: 100, stock: 50, category: 'زيوت', active: 1 });
  return { user, product };
}

test('نفس صورة الإيصال ما تتسجّلش مرتين ببصمتين متطابقتين', () => {
  const store = tempStore();
  const { user } = seed(store);
  assert.ok(store.recordPaymentProof('a.jpg', user.id, 'hash-1'));
  assert.throws(() => store.recordPaymentProof('b.jpg', user.id, 'hash-1'), (e) => e.code === 'DUPLICATE_PROOF');
  assert.ok(store.recordPaymentProof('c.jpg', user.id, 'hash-2'));
});

test('نفس رابط الإيصال ما يموّلش طلبين', () => {
  const store = tempStore();
  const { user, product } = seed(store);
  const base = {
    userId: user.id,
    customerName: 'عميل',
    customerPhone: '01000000000',
    customerAddress: 'القاهرة',
    paymentMethod: 'vodafone_cash',
    items: [{ productId: product.id, quantity: 1 }],
    paymentProofUrl: '/api/payment-proof/a.jpg',
    transferRef: 'REF12345'
  };
  const first = store.createOrder(base);
  assert.ok(first.id);
  assert.throws(() => store.createOrder(base), (e) => e.code === 'PROOF_REUSED');
});

test('queryOrders بيفلتر ويرقّم الصفحات في SQL', () => {
  const store = tempStore();
  const { user, product } = seed(store);
  for (let i = 0; i < 7; i += 1) {
    store.createOrder({
      userId: user.id,
      customerName: `عميل ${i}`,
      customerPhone: '01000000000',
      customerAddress: 'القاهرة',
      paymentMethod: 'cod',
      items: [{ productId: product.id, quantity: 1 }]
    });
  }
  const page1 = store.queryOrders({ page: 1, perPage: 5 });
  assert.strictEqual(page1.total, 7);
  assert.strictEqual(page1.orders.length, 5);
  assert.strictEqual(page1.pages, 2);
  assert.strictEqual(store.queryOrders({ q: 'عميل 3' }).total, 1);
  assert.strictEqual(store.queryOrders({ status: 'done' }).total, 0);
});

test('getUsersWithStats بيحسب عدد الطلبات والإجمالي من غير تسريب الهاش', () => {
  const store = tempStore();
  const { user, product } = seed(store);
  store.createOrder({
    userId: user.id,
    customerName: 'عميل',
    customerPhone: '01000000000',
    customerAddress: 'القاهرة',
    paymentMethod: 'cod',
    items: [{ productId: product.id, quantity: 2 }]
  });
  const row = store.getUsersWithStats().find((u) => u.id === user.id);
  assert.strictEqual(row.orders_count, 1);
  assert.ok(row.total_spent >= 200);
  assert.strictEqual(row.password_hash, undefined);
});
