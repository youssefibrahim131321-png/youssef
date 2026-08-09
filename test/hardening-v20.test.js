const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../store');
const { createSessionLayer } = require('../lib/session-layer');
const crypto = require('crypto');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-test-'));
  process.env.BACKUP_DIR = path.join(dir, 'backups');
  return createStore(path.join(dir, 'store.json'));
}

test('إبطال الجلسة: الجلسة اللي اتعمل لها خروج بترفض بعدها', () => {
  const store = freshStore();
  const jti = crypto.randomUUID();
  assert.equal(store.isSessionRevoked(jti), false);
  store.revokeSession(jti, 1, Date.now() + 60000);
  assert.equal(store.isSessionRevoked(jti), true);
  store.revokeSession('old', 1, Date.now() - 1000);
  assert.equal(store.isSessionRevoked('old'), false, 'الجلسة المنتهية مالهاش لزوم');
  assert.ok(store.purgeExpiredRevokedSessions() >= 1);
});

test('توكن الجلسة بياخد jti فريد', () => {
  const layer = createSessionLayer({
    sessionKey: Buffer.alloc(32, 1),
    csrfKey: Buffer.alloc(32, 2),
    sessionMaxAgeMs: 60000,
    adminSessionMaxAgeMs: 60000,
  });
  const a = layer.createSessionToken({ userId: 1, role: 'customer', sv: 0 });
  const b = layer.createSessionToken({ userId: 1, role: 'customer', sv: 0 });
  assert.notEqual(a, b);
  const parsed = layer.parseSessionToken(a);
  assert.ok(parsed.jti && parsed.jti.length > 10);
  assert.equal(layer.parseSessionToken(a.slice(0, -2) + 'xx'), null);
});

test('تشفير كلمة المرور غير المعطِّل بيشتغل صح', async () => {
  const store = freshStore();
  await store.createUserAsync({ name: 'عميل', email: 'a@example.com', password: 'password123' });
  assert.ok(await store.verifyPasswordAsync('a@example.com', 'password123'));
  assert.equal(await store.verifyPasswordAsync('a@example.com', 'wrong-pass'), null);
  assert.equal(await store.verifyPasswordAsync('nobody@example.com', 'password123'), null);
  const user = store.findUserByEmail('a@example.com');
  await store.setUserPasswordAsync(user.id, 'brand-new-pass');
  assert.ok(await store.verifyPasswordAsync('a@example.com', 'brand-new-pass'));
});

test('رقم عملية التحويل ما يتكررش', async () => {
  const store = freshStore();
  await store.createUserAsync({ name: 'عميل', email: 'b@example.com', password: 'password123' });
  const user = store.findUserByEmail('b@example.com');
  const product = store.createProduct({ name: 'فلتر زيت', price: 100, stock: 5, category: 'صيانة' });
  const base = {
    userId: user.id, customerName: 'عميل', customerPhone: '01000000000',
    customerAddress: 'القاهرة', paymentMethod: 'vodafone_cash',
    items: [{ productId: product.id, quantity: 1 }],
  };
  store.createOrder({ ...base, transferRef: 'REF123456' });
  assert.ok(store.getOrderByTransferRef('ref123456'), 'البحث غير حسّاس لحالة الحروف');
  assert.equal(store.getOrderByTransferRef('REF999999'), null);
});
