/**
 * اختبارات API حقيقية على السيرفر وهو شغال: الصلاحيات، CSRF، دورة الطلب،
 * المخزون، والكوبونات. بتشتغل على بورت عشوائي ومجلد بيانات مؤقت.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yousef-api-test-'));
const PORT = 4300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'AdminPass!2026';

let child;

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        DATA_DIR,
        UPLOADS_DIR: path.join(DATA_DIR, 'uploads'),
        BACKUP_DIR: path.join(DATA_DIR, '..', 'yousef-api-test-backups'),
        ADMIN_EMAIL,
        ADMIN_PASSWORD,
        ALLOW_EPHEMERAL_STORAGE: '1',
        REQUIRE_EMAIL_VERIFICATION: '0',
        EMAIL_GUARD_MX: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.on('error', reject);
    const deadline = Date.now() + 20000;
    const poll = async () => {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) return resolve();
      } catch (_) { /* لسه بيقوم */ }
      if (Date.now() > deadline) return reject(new Error('السيرفر ما قامش في الوقت المحدد'));
      setTimeout(poll, 200);
    };
    poll();
  });
}

/** عميل بسيط بيحتفظ بالكوكيز ويبعت هيدر CSRF زي المتصفح بالظبط. */
function createClient() {
  const jar = new Map();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const absorb = (res) => {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  };
  const request = async (method, url, body, { csrf = true } = {}) => {
    const headers = { cookie: cookieHeader(), origin: BASE };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf && jar.has('yousef_csrf')) headers['x-csrf-token'] = jar.get('yousef_csrf');
    const res = await fetch(BASE + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual'
    });
    absorb(res);
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, body: json };
  };
  return {
    jar,
    warmup: () => request('GET', '/api/health'),
    get: (url) => request('GET', url),
    post: (url, body, opts) => request('POST', url, body, opts),
    put: (url, body, opts) => request('PUT', url, body, opts),
    del: (url, body, opts) => request('DELETE', url, body, opts)
  };
}

async function makeCustomer(suffix) {
  const client = createClient();
  await client.warmup();
  const email = `buyer${suffix}@test.local`;
  const res = await client.post('/api/auth/register', {
    name: `عميل ${suffix}`, email, password: 'CustomerPass!2026', phone: '01000000001', address: 'القاهرة'
  });
  assert.strictEqual(res.status, 200, `فشل إنشاء الحساب: ${JSON.stringify(res.body)}`);
  return { client, email };
}

test.before(async () => { await startServer(); });
test.after(() => {
  if (child) child.kill('SIGKILL');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* تم */ }
});

test('نقاط الأدمن مرفوضة من غير تسجيل دخول', async () => {
  const anon = createClient();
  for (const url of ['/api/admin/users', '/api/admin/dashboard', '/api/admin/export.json', '/api/admin/products']) {
    const res = await anon.get(url);
    assert.strictEqual(res.status, 401, `${url} لازم يرجع 401`);
  }
});

test('أي طلب كتابة من غير توكن CSRF بيتمنع', async () => {
  const anon = createClient();
  await anon.warmup();
  const res = await anon.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { csrf: false });
  assert.strictEqual(res.status, 403);
});

test('كلمة مرور غلط ما بتديش جلسة', async () => {
  const client = createClient();
  await client.warmup();
  const res = await client.post('/api/auth/login', { email: ADMIN_EMAIL, password: 'wrong-password' });
  assert.strictEqual(res.status, 401);
  const me = await client.get('/api/auth/me');
  assert.strictEqual(me.body.loggedIn, false);
});

test('العميل العادي ما يقدرش يوصل لنقاط الأدمن', async () => {
  const { client } = await makeCustomer('role');
  const res = await client.get('/api/admin/users');
  assert.ok(res.status === 401 || res.status === 403, `المفروض 401/403 مش ${res.status}`);
  const del = await client.del('/api/admin/products/1');
  assert.ok(del.status === 401 || del.status === 403);
});

test('الطلب بيتأكد بأسعار السيرفر مش بأسعار العميل', async () => {
  const { client } = await makeCustomer('price');
  const products = (await client.get('/api/products')).body.products;
  const product = products.find((p) => p.stock > 0);
  assert.ok(product, 'لازم يكون فيه منتج متاح');

  const res = await client.post('/api/orders', {
    customerName: 'عميل الاختبار',
    customerPhone: '01000000001',
    customerAddress: 'القاهرة',
    paymentMethod: 'cash-on-delivery',
    items: [{ productId: product.id, quantity: 2, price: 1 }]
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.subtotal, product.price * 2);
});

test('الكميات السالبة أو الكسرية مرفوضة', async () => {
  const { client } = await makeCustomer('qty');
  const product = (await client.get('/api/products')).body.products.find((p) => p.stock > 0);
  for (const quantity of [-3, 0, 1.5, 5000]) {
    const res = await client.post('/api/orders', {
      customerName: 'عميل', customerPhone: '01000000001', customerAddress: 'القاهرة',
      paymentMethod: 'cash-on-delivery', items: [{ productId: product.id, quantity }]
    });
    assert.strictEqual(res.status, 400, `الكمية ${quantity} كان لازم تترفض`);
  }
});

test('الطلب الأكبر من المخزون بيترفض بـ 409', async () => {
  const { client } = await makeCustomer('stock');
  const product = (await client.get('/api/products')).body.products.find((p) => p.stock > 0);
  const res = await client.post('/api/orders', {
    customerName: 'عميل', customerPhone: '01000000001', customerAddress: 'القاهرة',
    paymentMethod: 'cash-on-delivery',
    items: [{ productId: product.id, quantity: product.stock + 50 }]
  });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'INSUFFICIENT_STOCK');
});

test('طرق الدفع بالتحويل لازم معاها إيصال', async () => {
  const { client } = await makeCustomer('proof');
  const product = (await client.get('/api/products')).body.products.find((p) => p.stock > 0);
  const res = await client.post('/api/orders', {
    customerName: 'عميل', customerPhone: '01000000001', customerAddress: 'القاهرة',
    paymentMethod: 'vodafone-cash', items: [{ productId: product.id, quantity: 1 }]
  });
  assert.strictEqual(res.status, 400);
});

test('عميل ما يقدرش يشوف أو يلغي طلب عميل تاني (IDOR)', async () => {
  const a = await makeCustomer('idor-a');
  const b = await makeCustomer('idor-b');
  const product = (await a.client.get('/api/products')).body.products.find((p) => p.stock > 1);
  const created = await a.client.post('/api/orders', {
    customerName: 'عميل أ', customerPhone: '01000000001', customerAddress: 'القاهرة',
    paymentMethod: 'cash-on-delivery', items: [{ productId: product.id, quantity: 1 }]
  });
  assert.strictEqual(created.status, 200, JSON.stringify(created.body));
  const orderId = created.body.orderId;

  const peek = await b.client.get(`/api/orders/${orderId}`);
  assert.strictEqual(peek.status, 403);
  const cancel = await b.client.post(`/api/orders/${orderId}/cancel`, {});
  assert.strictEqual(cancel.status, 403);
  const mine = await b.client.get('/api/orders/mine');
  assert.ok(!mine.body.orders.some((o) => o.id === orderId));
});

test('كود خصم غير موجود بيترفض', async () => {
  const client = createClient();
  await client.warmup();
  const res = await client.post('/api/coupons/validate', { code: 'NOT-A-REAL-CODE', subtotal: 500 });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.valid, false);
});

test('صفحات الإدارة الثابتة مش مكشوفة لغير المسجّلين', async () => {
  const res = await fetch(`${BASE}/admin.js`, { redirect: 'manual' });
  assert.ok(res.status === 302 || res.status === 401 || res.status === 403);
});

test('رؤوس الأمان الأساسية موجودة على الصفحة الرئيسية', async () => {
  const res = await fetch(`${BASE}/`);
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok((res.headers.get('content-security-policy') || '').includes("default-src 'self'"));
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});

test('صفحات السياسات شغالة وموجودة في خريطة الموقع', async () => {
  for (const page of ['/shipping.html', '/returns.html', '/privacy.html']) {
    const res = await fetch(BASE + page);
    assert.strictEqual(res.status, 200, `${page} لازم يفتح`);
  }
  const xml = await (await fetch(`${BASE}/sitemap.xml`)).text();
  assert.ok(xml.includes('/privacy.html'));
});
