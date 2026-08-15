const test = require('node:test');
const assert = require('node:assert');

process.env.TOTP_ENCRYPTION_KEY = process.env.TOTP_ENCRYPTION_KEY || 'test-encryption-key-for-unit-tests';
const { encryptSecret, decryptSecret } = require('../lib/secret-crypto');

test('secret is stored encrypted and round-trips', () => {
  const plain = 'JBSWY3DPEHPK3PXP';
  const enc = encryptSecret(plain);
  assert.ok(enc.startsWith('enc:v1:'), 'يبدأ ببادئة التشفير');
  assert.ok(!enc.includes(plain), 'السر الصريح مش ظاهر في القيمة المخزّنة');
  assert.strictEqual(decryptSecret(enc), plain);
});

test('two encryptions of the same secret differ (random IV)', () => {
  assert.notStrictEqual(encryptSecret('SAME'), encryptSecret('SAME'));
});

test('legacy plaintext secrets still decrypt as-is', () => {
  assert.strictEqual(decryptSecret('JBSWY3DPEHPK3PXP'), 'JBSWY3DPEHPK3PXP');
});

test('tampered ciphertext fails closed', () => {
  const enc = encryptSecret('JBSWY3DPEHPK3PXP');
  const broken = enc.slice(0, -4) + 'AAAA';
  assert.strictEqual(decryptSecret(broken), null);
});
