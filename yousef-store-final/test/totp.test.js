const test = require('node:test');
const assert = require('node:assert');
const totp = require('../lib/totp');

test('base32 encode/decode round trip', () => {
  const buf = Buffer.from('hello world');
  assert.deepStrictEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
});

test('RFC 6238 style code is 6 digits and stable per window', () => {
  const secret = totp.generateSecret();
  const at = 1700000000000;
  const code = totp.totp(secret, { at });
  assert.match(code, /^\d{6}$/);
  assert.strictEqual(totp.totp(secret, { at: at + 5000 }), code);
});

test('verify accepts current code and rejects wrong one', () => {
  const secret = totp.generateSecret();
  const at = Date.now();
  assert.strictEqual(totp.verify(secret, totp.totp(secret, { at }), { at }), true);
  assert.strictEqual(totp.verify(secret, '000000', { at }), totp.totp(secret, { at }) === '000000');
});

test('verify tolerates one step of clock drift but not two', () => {
  const secret = totp.generateSecret();
  const at = 1700000000000;
  const previous = totp.totp(secret, { at: at - 30000 });
  const old = totp.totp(secret, { at: at - 120000 });
  assert.strictEqual(totp.verify(secret, previous, { at }), true);
  assert.strictEqual(totp.verify(secret, old, { at }), false);
});

test('otpauth url carries issuer and secret', () => {
  const url = totp.otpauthUrl({ secret: 'ABCDEF', label: 'a@b.com', issuer: 'Yousef Store' });
  assert.ok(url.startsWith('otpauth://totp/'));
  assert.ok(url.includes('secret=ABCDEF'));
});
