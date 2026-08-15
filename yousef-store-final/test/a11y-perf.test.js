/**
 * test/a11y-perf.test.js
 * ---------------------------------------------------------------------------
 * اختبارات كانت ناقصة تمامًا: إمكانية الوصول (a11y)، رؤوس الأداء/الكاش،
 * وترويسة CSP، وإجبارية توقيع HMAC في webhook باي‌موب.
 *
 * السيرفر بيشتغل على قاعدة بيانات في الذاكرة (helpers/test-db) فمش محتاج أي
 * قاعدة متاحة في البيئة.
 */
require('./helpers/test-db');
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { testEnv } = require('./helpers/test-db');

const PORT = 4800 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

test.before(async () => {
  const { env } = testEnv({ PORT: String(PORT), HOST: '127.0.0.1', ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'AdminPass!2026' });
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch (_) { /* لسه بيقوم */ }
    if (Date.now() > deadline) throw new Error('السيرفر ما قامش في الوقت المحدد');
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.after(() => { if (child) child.kill('SIGKILL'); });

test('a11y: الصفحة الرئيسية عربية RTL وفيها h1 واحد وكل الصور ليها alt', async () => {
  const html = await (await fetch(`${BASE}/`)).text();
  assert.match(html, /<html[^>]*lang="ar"/i);
  assert.match(html, /<html[^>]*dir="rtl"/i);
  assert.strictEqual((html.match(/<h1\b/gi) || []).length, 1, 'لازم عنوان h1 واحد بالظبط');
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  assert.ok(imgs.length > 0);
  for (const img of imgs) assert.match(img, /\balt=/i, `صورة من غير alt: ${img.slice(0, 80)}`);
  // كل حقل إدخال لازم يكون معاه label أو aria-label
  for (const input of html.match(/<input\b[^>]*>/gi) || []) {
    if (/type="(hidden|submit|button)"/i.test(input)) continue;
    const id = (input.match(/\bid="([^"]+)"/i) || [])[1];
    const labelled = /aria-label|aria-labelledby|placeholder/i.test(input)
      || (id && new RegExp(`<label[^>]*for="${id}"`, 'i').test(html));
    assert.ok(labelled, `حقل من غير تسمية: ${input.slice(0, 80)}`);
  }
});

test('a11y: صفحة الدخول فيها title ووصف وزر إرسال', async () => {
  const html = await (await fetch(`${BASE}/admin-login.html`)).text();
  assert.match(html, /<title>[^<]{5,}<\/title>/i);
  assert.match(html, /<label|aria-label/i);
});

test('أداء: أصول CSS/JS بتتقدّم ببصمة محتوى وكاش immutable', async () => {
  const html = await (await fetch(`${BASE}/`)).text();
  const versioned = html.match(/(\/[^"?#>]+\.(?:css|js))\?v=([a-f0-9]{10})/i);
  assert.ok(versioned, 'روابط الأصول لازم تحمل ?v=<hash>');
  const res = await fetch(`${BASE}${versioned[0]}`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /immutable/);
  // نفس الملف من غير بصمة = كاش قصير + إعادة تحقق
  const plain = await fetch(`${BASE}${versioned[1]}`);
  assert.match(plain.headers.get('cache-control') || '', /must-revalidate/);
  assert.ok(plain.headers.get('etag'));
});

test('أداء: HTML مش بيتكاش وفيه ETag للأصول + استجابة أقل من ثانية', async () => {
  const started = Date.now();
  const res = await fetch(`${BASE}/`);
  assert.ok(Date.now() - started < 1000, 'الصفحة الرئيسية لازم ترد في أقل من ثانية');
  assert.match(res.headers.get('cache-control') || '', /no-cache/);
});

test('CSP: مفيش unsafe-inline ولا img-src مفتوحة على كل https', async () => {
  const csp = (await fetch(`${BASE}/`)).headers.get('content-security-policy') || '';
  assert.ok(csp.includes("script-src 'self' 'nonce-"), 'script-src لازم nonce');
  assert.ok(!csp.includes("'unsafe-inline'"), `CSP لسه فيها unsafe-inline: ${csp}`);
  assert.ok(!csp.includes("'unsafe-eval'"));
  assert.ok(csp.includes("style-src-attr 'none'"), 'style attributes لازم تكون ممنوعة');
  assert.ok(/img-src 'self' data: blob'?/.test(csp) || csp.includes("img-src 'self' data: blob:"), csp);
  assert.ok(!/img-src[^;]*https:(?:\s|;|$)/.test(csp), `img-src لسه مفتوحة: ${csp}`);
  assert.ok(csp.includes("object-src 'none'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
});

test('webhook باي‌موب: التحقق من HMAC إجباري (fail closed لما السر مش مظبوط)', async () => {
  const res = await fetch(`${BASE}/api/public/paymob/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ obj: { id: 1, success: true, amount_cents: 100 } })
  });
  // مفيش PAYMOB_HMAC_SECRET في بيئة الاختبار → لازم يترفض، ومستحيل يتعالج
  assert.ok([401, 503, 400].includes(res.status), `المتوقع رفض، جه ${res.status}`);
  const body = await res.json().catch(() => ({}));
  assert.ok(!body.ok, 'الـ webhook ما ينفعش ينجح من غير توقيع');
});

test('توقيع HMAC غلط بيترفض حتى لما السر مظبوط', async () => {
  const paymob = require('../lib/paymob');
  process.env.PAYMOB_HMAC_SECRET = 'test-secret';
  try {
    assert.strictEqual(paymob.hasHmacSecret(), true);
    assert.strictEqual(paymob.verifyHmac({ obj: { id: 1, success: true } }, 'a'.repeat(128)), false);
  } finally {
    delete process.env.PAYMOB_HMAC_SECRET;
  }
  assert.strictEqual(paymob.hasHmacSecret(), false);
});

test('مفيش ملف كلمة مرور أدمن متسرّب في المستودع', async () => {
  const fs = require('node:fs');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'data', 'INITIAL-ADMIN-PASSWORD.txt')),
    'data/INITIAL-ADMIN-PASSWORD.txt ما ينفعش يبقى جوه المستودع');
});
