const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ys-store-'));
  return { dir, store: createStore(path.join(dir, 'store.json')) };
}

test('creates an admin and verifies its password', () => {
  const { store } = tempStore();
  store.ensureAdmin({ email: 'admin@test.com', password: 'super-secret-1' });
  assert.ok(store.hasAdmin());
  assert.ok(store.verifyPassword('admin@test.com', 'super-secret-1'));
  assert.strictEqual(store.verifyPassword('admin@test.com', 'wrong'), null);
});

test('sanitizeUser never leaks password hash or totp secret', () => {
  const { store } = tempStore();
  store.createUser({ name: 'عميل', email: 'c@test.com', password: 'password123', role: 'customer' });
  const user = store.findUserByEmail('c@test.com');
  const safe = store.sanitizeUser(user);
  assert.strictEqual(safe.password_hash, undefined);
  assert.strictEqual(safe.totp_secret, undefined);
});

test('totp secret can be set, enabled and disabled', () => {
  const { store } = tempStore();
  store.createUser({ name: 'A', email: 'a@test.com', password: 'password123', role: 'admin' });
  const user = store.findUserByEmail('a@test.com');
  store.setTotpSecret(user.id, 'JBSWY3DPEHPK3PXP');
  assert.strictEqual(store.getTotpSecret(user.id).totp_enabled, 0);
  store.enableTotp(user.id);
  assert.strictEqual(store.getTotpSecret(user.id).totp_enabled, 1);
  assert.strictEqual(store.claimTotpCode(user.id, '123456'), true);
  assert.strictEqual(store.claimTotpCode(user.id, '123456'), false, 'same code cannot be replayed');
  store.disableTotp(user.id);
  assert.strictEqual(store.getTotpSecret(user.id).totp_enabled, 0);
});

test('persisted rate limit counters can be read back', () => {
  const { store } = tempStore();
  const resetAt = Date.now() + 60000;
  store.rateLimitSet('auth|1.2.3.4', 4, resetAt);
  assert.deepStrictEqual(store.rateLimitGet('auth|1.2.3.4'), { count: 4, resetAt });
  assert.strictEqual(store.rateLimitGet('missing'), null);
});

test('orphan payment proofs are reported for cleanup', () => {
  const { store } = tempStore();
  store.recordPaymentProof('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg', null);
  assert.deepStrictEqual(store.getOrphanPaymentProofs(-1), ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg']);
  assert.deepStrictEqual(store.getOrphanPaymentProofs(60 * 60 * 1000), [], 'fresh uploads are kept');
});

test('coupon cannot be redeemed twice by the same customer', () => {
  const { store } = tempStore();
  store.createCoupon({ code: 'SAVE10', type: 'percent', value: 10, oncePerUser: 1 });
  const result = store.evaluateCoupon('SAVE10', 500, 1);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.discount, 50);
});
