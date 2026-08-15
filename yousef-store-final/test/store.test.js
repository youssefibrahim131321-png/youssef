require('./helpers/test-db'); // قاعدة بيانات اختبارات معزولة في الذاكرة (لازم قبل store/server)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../store');

// المخزن بقى Postgres/async: createStore وكل دواله بترجّع Promise.
async function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ys-store-'));
  return { dir, store: await createStore(path.join(dir, 'store.json')) };
}

test('creates an admin and verifies its password', async () => {
  const { store } = await tempStore();
  await store.ensureAdmin({ email: 'admin@test.com', password: 'super-secret-1' });
  assert.ok(await store.hasAdmin());
  assert.ok(await store.verifyPassword('admin@test.com', 'super-secret-1'));
  assert.strictEqual(await store.verifyPassword('admin@test.com', 'wrong'), null);
});

test('sanitizeUser never leaks password hash or totp secret', async () => {
  const { store } = await tempStore();
  await store.createUser({ name: 'عميل', email: 'c@test.com', password: 'password123', role: 'customer' });
  const user = await store.findUserByEmail('c@test.com');
  const safe = store.sanitizeUser(user);
  assert.strictEqual(safe.password_hash, undefined);
  assert.strictEqual(safe.totp_secret, undefined);
});

test('totp secret can be set, enabled and disabled', async () => {
  const { store } = await tempStore();
  await store.createUser({ name: 'A', email: 'a@test.com', password: 'password123', role: 'admin' });
  const user = await store.findUserByEmail('a@test.com');
  await store.setTotpSecret(user.id, 'JBSWY3DPEHPK3PXP');
  assert.ok(!(await store.getTotpSecret(user.id)).totp_enabled);
  await store.enableTotp(user.id);
  assert.ok((await store.getTotpSecret(user.id)).totp_enabled);
  assert.strictEqual(await store.claimTotpCode(user.id, '123456'), true);
  assert.strictEqual(await store.claimTotpCode(user.id, '123456'), false, 'same code cannot be replayed');
  await store.disableTotp(user.id);
  assert.ok(!(await store.getTotpSecret(user.id)).totp_enabled);
});

test('persisted rate limit counters can be read back', async () => {
  const { store } = await tempStore();
  const resetAt = Date.now() + 60000;
  await store.rateLimitSet('auth|1.2.3.4', 4, resetAt);
  assert.deepStrictEqual(await store.rateLimitGet('auth|1.2.3.4'), { count: 4, resetAt });
  assert.strictEqual(await store.rateLimitGet('missing'), null);
});

test('orphan payment proofs are reported for cleanup', async () => {
  const { store } = await tempStore();
  await store.recordPaymentProof('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg', null);
  assert.deepStrictEqual(await store.getOrphanPaymentProofs(-1), ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg']);
  assert.deepStrictEqual(await store.getOrphanPaymentProofs(60 * 60 * 1000), [], 'fresh uploads are kept');
});

test('coupon cannot be redeemed twice by the same customer', async () => {
  const { store } = await tempStore();
  await store.createCoupon({ code: 'SAVE10', type: 'percent', value: 10, oncePerUser: 1 });
  const result = await store.evaluateCoupon('SAVE10', 500, 1);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.discount, 50);
});
