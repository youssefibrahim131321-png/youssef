/**
 * اختبار انحدار (regression) لثغرة Host Header Injection.
 * الثغرة الأصلية: رابط استعادة كلمة المرور كان بيتبني من هيدر Host الخام،
 * فمهاجم يبعت Host: evil.com فيوصل للضحية رابط استعادة على دومين المهاجم.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'core', 'public-url.js');

function load(env = {}) {
  delete require.cache[require.resolve(MODULE_PATH)];
  const saved = {};
  for (const key of ['SITE_URL', 'PUBLIC_BASE_URL', 'ALLOWED_HOSTS', 'NODE_ENV']) {
    saved[key] = process.env[key];
    if (key in env) process.env[key] = env[key];
    else delete process.env[key];
  }
  const mod = require(MODULE_PATH);
  return {
    mod,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

const evilReq = { protocol: 'http', headers: { host: 'evil-attacker.com' }, get: () => 'evil-attacker.com' };
const goodReq = { protocol: 'https', headers: { host: 'shop.example.com' }, get: () => 'shop.example.com' };

test('SITE_URL بيتغلب على هيدر Host المزوّر', () => {
  const { mod, restore } = load({ SITE_URL: 'https://shop.example.com' });
  assert.strictEqual(mod.publicBaseUrl(evilReq), 'https://shop.example.com');
  restore();
});

test('PUBLIC_BASE_URL بيشتغل كبديل لو SITE_URL مش مضبوط', () => {
  const { mod, restore } = load({ PUBLIC_BASE_URL: 'https://shop.example.com/' });
  assert.strictEqual(mod.publicBaseUrl(evilReq), 'https://shop.example.com');
  restore();
});

test('ALLOWED_HOSTS بترفض هوست غير موثوق وترجع الموثوق', () => {
  const { mod, restore } = load({ ALLOWED_HOSTS: 'shop.example.com' });
  assert.strictEqual(mod.publicBaseUrl(goodReq), 'https://shop.example.com');
  assert.strictEqual(mod.publicBaseUrl(evilReq), 'https://shop.example.com');
  restore();
});

test('في الإنتاج بدون أي إعداد: مفيش سقوط على هيدر Host', () => {
  const { mod, restore } = load({ NODE_ENV: 'production' });
  assert.strictEqual(mod.publicBaseUrl(evilReq), null);
  assert.strictEqual(mod.publicBaseUrl(evilReq, { fallbackToHost: true }), null);
  restore();
});

test('خارج الإنتاج بدون إعداد: الهوست المحلي مسموح للتطوير', () => {
  const { mod, restore } = load({ NODE_ENV: 'development' });
  assert.strictEqual(mod.publicBaseUrl({ protocol: 'http', headers: { host: 'localhost:3000' }, get: () => 'localhost:3000' }), 'http://localhost:3000');
  restore();
});

test('خارج الإنتاج: دومين خارجي من هيدر Host مرفوض برضه', () => {
  const { mod, restore } = load({ NODE_ENV: 'development' });
  assert.strictEqual(mod.publicBaseUrl(evilReq), null);
  restore();
});

test('هوست بصيغة خبيثة (مسار/userinfo) مرفوض تمامًا', () => {
  const { mod, restore } = load({ NODE_ENV: 'development' });
  const weird = { protocol: 'http', headers: { host: 'good.com/@evil.com' }, get: () => 'good.com/@evil.com' };
  assert.strictEqual(mod.publicBaseUrl(weird), null);
  restore();
});

test('سياسة كلمة المرور: طول + حرف + رقم + رفض الشائع', () => {
  const { passwordPolicyError } = require('../lib/core/password-policy');
  assert.ok(passwordPolicyError('123'));
  assert.ok(passwordPolicyError('12345678'));
  assert.ok(passwordPolicyError('abcdefgh'));
  assert.ok(passwordPolicyError('password1'));
  assert.strictEqual(passwordPolicyError('Ahmed2026x'), null);
});
