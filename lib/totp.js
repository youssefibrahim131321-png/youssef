/**
 * TOTP (RFC 6238) بدون أي مكتبة خارجية — يشتغل مع Google Authenticator وAuthy.
 * (إصلاح 4) التحقق بخطوتين رجع يشتغل بدل ما يكون متعطّل بالكامل.
 */
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const bytes = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function hotp(secret, counter, digits = 6) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

function totp(secret, { step = 30, at = Date.now(), digits = 6 } = {}) {
  return hotp(secret, Math.floor(at / 1000 / step), digits);
}

/** يقبل الكود الحالي وكود قبله/بعده (انحراف ساعة بسيط). */
function verify(secret, code, { step = 30, at = Date.now(), window = 1, digits = 6 } = {}) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== digits || !secret) return false;
  const counter = Math.floor(at / 1000 / step);
  for (let i = -window; i <= window; i += 1) {
    const expected = hotp(secret, counter + i, digits);
    const a = Buffer.from(expected); const b = Buffer.from(clean);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function otpauthUrl({ secret, label, issuer }) {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(label)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, totp, verify, otpauthUrl, base32Encode, base32Decode, hotp };
