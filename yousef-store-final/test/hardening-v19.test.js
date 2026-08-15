// اختبارات تراجع للإصلاحات: منع إعادة استخدام إيصال الدفع (على مستوى القاعدة)
// واستعلامات لوحة التحكم اللي بقت في SQL. المخزن async دلوقتي.
require('./helpers/test-db'); // قاعدة بيانات اختبارات معزولة في الذاكرة (لازم قبل store/server)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../store');

async function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ys-hard-'));
  return createStore(path.join(dir, 'store.json'));
}

async function seed(store) {
  await store.createUser({ name: 'عميل', email: 'c@test.com', password: 'password123', role: 'customer' });
  const user = await store.findUserByEmail('c@test.com');
  const product = await store.createProduct({ name: 'فلتر زيت', price: 100, stock: 50, category: 'زيوت', active: 1 });
  return { user, product };
}

test('نفس صورة الإيصال ما تتسجّلش مرتين ببصمتين متطابقتين', async () => {
  const store = await tempStore();
  const { user } = await seed(store);
  assert.ok(await store.recordPaymentProof('a.jpg', user.id, 'hash-1'));
  await assert.rejects(() => store.recordPaymentProof('b.jpg', user.id, 'hash-1'), (e) => e.code === 'DUPLICATE_PROOF');
  assert.ok(await store.recordPaymentProof('c.jpg', user.id, 'hash-2'));
});

test('نفس رابط الإيصال ما يموّلش طلبين', async () => {
  const store = await tempStore();
  const { user, product } = await seed(store);
  const base = {
    userId: user.id,
    customerName: 'عميل',
    customerPhone: '01000000000',
    customerAddress: 'القاهرة',
    paymentMethod: 'vodafone-cash',
    items: [{ productId: product.id, quantity: 1 }],
    paymentProofUrl: '/api/payment-proof/a.jpg',
    transferRef: 'REF12345'
  };
  await store.recordPaymentProof('a.jpg', user.id, 'hash-order');
  const first = await store.createOrder(base);
  assert.ok(first.id);
  await assert.rejects(() => store.createOrder(base), (e) => e.code === 'PROOF_REUSED');
});

test('queryOrders بيفلتر ويرقّم الصفحات في SQL', async () => {
  const store = await tempStore();
  const { user, product } = await seed(store);
  for (let i = 0; i < 7; i += 1) {
    await store.createOrder({
      userId: user.id,
      customerName: `عميل ${i}`,
      customerPhone: '01000000000',
      customerAddress: 'القاهرة',
      paymentMethod: 'cash-on-delivery',
      items: [{ productId: product.id, quantity: 1 }]
    });
  }
  const page1 = await store.queryOrders({ page: 1, perPage: 5 });
  assert.strictEqual(page1.total, 7);
  assert.strictEqual(page1.orders.length, 5);
  assert.strictEqual(page1.pages, 2);
  assert.strictEqual((await store.queryOrders({ q: 'عميل 3' })).total, 1);
  assert.strictEqual((await store.queryOrders({ status: 'done' })).total, 0);
});

test('getUsersWithStats بيحسب عدد الطلبات والإجمالي من غير تسريب الهاش', async () => {
  const store = await tempStore();
  const { user, product } = await seed(store);
  await store.createOrder({
    userId: user.id,
    customerName: 'عميل',
    customerPhone: '01000000000',
    customerAddress: 'القاهرة',
    paymentMethod: 'cash-on-delivery',
    items: [{ productId: product.id, quantity: 2 }]
  });
  const row = (await store.getUsersWithStats()).find((u) => Number(u.id) === Number(user.id));
  assert.strictEqual(Number(row.orders_count), 1);
  assert.ok(Number(row.total_spent) >= 200);
  assert.strictEqual(row.password_hash, undefined);
});
