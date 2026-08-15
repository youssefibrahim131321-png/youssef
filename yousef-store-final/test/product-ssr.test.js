/**
 * test/product-ssr.test.js
 * ---------------------------------------------------------------------------
 * (إصلاح SEO) صفحة المنتج لازم تتولّد على السيرفر: HTML كامل فيه H1 باسم
 * المنتج، سعر، وصف، صورة مع alt، JSON-LD، و breadcrumb، من غير أي جافاسكربت.
 * الاختبار كله على قاعدة بيانات في الذاكرة (helpers/test-db).
 */
require('./helpers/test-db');
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { testEnv } = require('./helpers/test-db');
const { productPath } = require('../lib/slug');
const { renderProductSection } = require('../lib/product-ssr');

const PORT = 5200 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let product;

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
  const data = await (await fetch(`${BASE}/api/products`)).json();
  product = (data.products || []).find((p) => p.active !== 0);
  assert.ok(product, 'لازم يكون فيه منتج نشط في البيانات الافتراضية');
});

test.after(() => { if (child) child.kill('SIGKILL'); });

test('SSR: صفحة المنتج فيها H1 بالاسم وسعر ووصف في HTML الخام', async () => {
  const res = await fetch(`${BASE}${productPath(product)}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<section class="ssr-product" id="ssrProduct"/);
  assert.ok(html.includes(`<h1 class="ssr-product-title">${product.name}</h1>`), 'H1 لازم يحتوي اسم المنتج');
  assert.match(html, /class="ssr-product-price mono">[^<]*ج\.م/);
  assert.match(html, /class="ssr-product-avail">(متوفر|غير متوفر)/);
  assert.match(html, /class="ssr-crumbs"/);
  // الصورة لازم يكون معاها alt (a11y + SEO)
  const media = /<div class="ssr-product-media">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(media && /<img[^>]+alt="[^"]+"/.test(media[1]), 'صورة المنتج لازم يكون معاها alt');
});

test('SSR: JSON-LD من النوع Product مع سعر وتوفّر', async () => {
  const html = await (await fetch(`${BASE}${productPath(product)}`)).text();
  const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1].replace(/\\u003c/g, '<')));
  const data = blocks.find((b) => b['@type'] === 'Product');
  assert.ok(data, 'لازم يكون فيه JSON-LD من النوع Product');
  assert.equal(data.name, product.name);
  assert.ok(data.offers && data.offers.priceCurrency === 'EGP');
  assert.match(data.offers.availability, /InStock|OutOfStock/);
});

test('SSR: الميتا وcanonical بتتغير حسب المنتج والـ slug محفوظ', async () => {
  const html = await (await fetch(`${BASE}${productPath(product)}`)).text();
  assert.ok(html.includes(`<title>${product.name} —`), 'العنوان لازم يبدأ باسم المنتج');
  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html);
  assert.ok(canonical, 'لازم يكون فيه canonical');
  assert.ok(decodeURIComponent(canonical[1]).endsWith(productPath(product)), 'canonical لازم يستخدم نفس الـ slug');
});

test('SSR: رابط بslug غلط بيعمل redirect 301 للرابط الصحيح', async () => {
  const res = await fetch(`${BASE}/product/${product.id}/wrong-slug`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(decodeURIComponent(res.headers.get('location')), productPath(product));
});

test('SSR: فيه لينكات داخلية لمنتجات مشابهة (روابط حقيقية للأرشفة)', async () => {
  const html = await (await fetch(`${BASE}${productPath(product)}`)).text();
  const links = [...html.matchAll(/<a class="ssr-related-card" href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.length >= 1, 'لازم يكون فيه منتج مشابه واحد على الأقل');
  for (const href of links) assert.match(href, /^\/product\/\d+\//);
});

test('SSR: الصفحة الرئيسية مفيهاش كتلة المنتج', async () => {
  const html = await (await fetch(`${BASE}/`)).text();
  assert.ok(!html.includes('id="ssrProduct"'));
});

test('SSR: العرض بيهرّب HTML في اسم/وصف المنتج (مفيش XSS)', () => {
  const html = renderProductSection(
    { id: 7, name: '<img src=x onerror=alert(1)>', description: '"><script>alert(2)</script>', price: 10, stock: 1, category: 'x' },
    []
  );
  assert.ok(!html.includes('<script>'), 'ممنوع أي سكربت خارج من بيانات المنتج');
  assert.ok(!/<img src=x/.test(html), 'الوسم لازم يبقى نص مهرّب مش عنصر حقيقي');
  assert.match(html, /&lt;img src=x/);
});
