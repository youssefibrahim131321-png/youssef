/**
 * ---------------------------------------------------------------------------
 * test/e2e-purchase.test.js — دورة شراء كاملة بالتحويل البنكي
 * ---------------------------------------------------------------------------
 * الاختبار ده بيغطي أخطر مسار في الموقع (الدفع اليدوي) من أول رفع الإيصال
 * لحد ما الأدمن يأكد الدفع، وبيتأكد من الحمايات الجديدة:
 *   1) رفع نفس صورة الإيصال مرتين = 409 (بصمة SHA256).
 *   2) طلب فودافون كاش من غير رقم عملية تحويل = 400.
 *   3) الطلب الصحيح بيتسجّل ورقم العملية بيوصل للأدمن مع الطلب.
 *   4) الأدمن بيأكد الدفع والمخزون بينقص فعليًا.
 */
require('./helpers/test-db'); // قاعدة بيانات اختبارات معزولة في الذاكرة (لازم قبل store/server)
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yousef-e2e-'));
const PORT = 4800 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'admin@e2e.local';
const ADMIN_PASSWORD = 'AdminPass!2026';

let child;

/** صورة PNG صغيرة صالحة (1×1) — بتعدي فحص الأنواع لأنها PNG حقيقية. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
/** نسخة تانية مختلفة بايت-بايت عشان نتأكد إن البصمة مش بتمنع صور مختلفة. */
const PNG_1PX_ALT = Buffer.concat([PNG_1PX, Buffer.from('\n<!-- variant -->')]);

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        DATABASE_URL: '',
        STORE_QUIET: '1',
        PORT: String(PORT),
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        DATA_DIR,
        UPLOADS_DIR: path.join(DATA_DIR, 'uploads'),
        PROOFS_DIR: path.join(DATA_DIR, 'payment-proofs'),
        BACKUP_DIR: path.join(DATA_DIR, 'backups'),
        ADMIN_EMAIL,
        ADMIN_PASSWORD,
        ALLOW_EPHEMERAL_STORAGE: '1',
        REQUIRE_EMAIL_VERIFICATION: '0',
        REQUIRE_ADMIN_2FA: '0',
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

/** عميل بيحتفظ بالكوكيز وبيبعت CSRF، وبيدعم رفع الملفات (multipart). */
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
  const send = async (method, url, { body, form } = {}) => {
    const headers = { cookie: cookieHeader(), origin: BASE };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (jar.has('yousef_csrf')) headers['x-csrf-token'] = jar.get('yousef_csrf');
    const res = await fetch(BASE + url, {
      method,
      headers,
      body: form || (body === undefined ? undefined : JSON.stringify(body)),
      redirect: 'manual'
    });
    absorb(res);
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, body: json };
  };
  return {
    warmup: () => send('GET', '/api/health'),
    get: (url) => send('GET', url),
    post: (url, body) => send('POST', url, { body }),
    put: (url, body) => send('PUT', url, { body }),
    uploadProof: (buffer, name = 'receipt.png') => {
      const form = new FormData();
      form.append('proof', new Blob([buffer], { type: 'image/png' }), name);
      return send('POST', '/api/payment-proof', { form });
    }
  };
}

async function makeCustomer(suffix) {
  const client = createClient();
  await client.warmup();
  const res = await client.post('/api/auth/register', {
    name: `عميل ${suffix}`,
    email: `e2e-${suffix}@test.local`,
    password: 'CustomerPass!2026',
    phone: '01000000001',
    address: 'القاهرة'
  });
  assert.strictEqual(res.status, 200, `فشل إنشاء الحساب: ${JSON.stringify(res.body)}`);
  return client;
}

async function makeAdmin() {
  const client = createClient();
  await client.warmup();
  const res = await client.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  assert.strictEqual(res.status, 200, `فشل دخول الأدمن: ${JSON.stringify(res.body)}`);
  return client;
}

test.before(async () => { await startServer(); });
test.after(() => {
  if (child) child.kill('SIGKILL');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* تم */ }
});

test('دورة شراء كاملة بفودافون كاش: إيصال + رقم عملية + تأكيد الأدمن', async () => {
  const customer = await makeCustomer('buyer');
  const product = (await customer.get('/api/products')).body.products.find((p) => p.stock > 1);
  assert.ok(product, 'لازم يكون فيه منتج متاح في المخزون');
  const stockBefore = product.stock;

  // 1) رفع الإيصال
  const upload = await customer.uploadProof(PNG_1PX);
  assert.strictEqual(upload.status, 200, JSON.stringify(upload.body));
  assert.match(upload.body.url, /^\/api\/payment-proof\/[a-f0-9-]{36}\.(?:jpg|png|webp)$/);

  // 2) نفس الصورة بالظبط مرفوضة (بصمة SHA256 بتمنع إعادة استخدام الإيصال)
  const dup = await customer.uploadProof(PNG_1PX, 'again.png');
  assert.strictEqual(dup.status, 409, `المفروض ترفض الإيصال المكرر: ${JSON.stringify(dup.body)}`);

  // 3) طلب من غير رقم عملية التحويل = مرفوض
  const noRef = await customer.post('/api/orders', {
    customerName: 'عميل الاختبار',
    customerPhone: '01000000001',
    customerAddress: 'القاهرة',
    paymentMethod: 'vodafone-cash',
    paymentProofUrl: upload.body.url,
    items: [{ productId: product.id, quantity: 1 }]
  });
  assert.strictEqual(noRef.status, 400, JSON.stringify(noRef.body));

  // رقم قصير كمان مرفوض
  const shortRef = await customer.post('/api/orders', {
    customerName: 'عميل الاختبار',
    customerPhone: '01000000001',
    customerAddress: 'القاهرة',
    paymentMethod: 'vodafone-cash',
    transferRef: '123',
    paymentProofUrl: upload.body.url,
    items: [{ productId: product.id, quantity: 1 }]
  });
  assert.strictEqual(shortRef.status, 400, JSON.stringify(shortRef.body));

  // 4) الطلب الصحيح
  const TRANSFER_REF = 'VF-90210771';
  const created = await customer.post('/api/orders', {
    customerName: 'عميل الاختبار',
    customerPhone: '01000000001',
    customerAddress: 'القاهرة',
    paymentMethod: 'vodafone-cash',
    transferRef: TRANSFER_REF,
    paymentProofUrl: upload.body.url,
    items: [{ productId: product.id, quantity: 1 }]
  });
  assert.strictEqual(created.status, 200, JSON.stringify(created.body));
  const orderId = created.body.orderId;

  // 5) الأدمن بيشوف رقم العملية والإيصال مع الطلب
  const admin = await makeAdmin();
  const adminOrders = await admin.get('/api/admin/orders');
  assert.strictEqual(adminOrders.status, 200, JSON.stringify(adminOrders.body));
  const adminOrder = adminOrders.body.orders.find((o) => o.id === orderId);
  assert.ok(adminOrder, 'الطلب لازم يظهر في لوحة التحكم');
  assert.strictEqual(adminOrder.transfer_ref, TRANSFER_REF, 'رقم عملية التحويل لازم يتسجّل مع الطلب');
  assert.ok(adminOrder.payment_proof_url, 'الإيصال لازم يبقى مربوط بالطلب');

  // 6) تأكيد الطلب والدفع + التأكد إن المخزون نقص
  const updated = await admin.put(`/api/admin/orders/${orderId}`, { status: 'confirmed', paymentStatus: 'paid' });
  assert.strictEqual(updated.status, 200, JSON.stringify(updated.body));

  const after = (await customer.get('/api/products')).body.products.find((p) => p.id === product.id);
  assert.strictEqual(after.stock, stockBefore - 1, 'المخزون لازم ينقص بعد الطلب');

  // 7) نفس الإيصال ما ينفعش يتربط بطلب تاني
  const reuse = await customer.post('/api/orders', {
    customerName: 'عميل الاختبار',
    customerPhone: '01000000001',
    customerAddress: 'القاهرة',
    paymentMethod: 'vodafone-cash',
    transferRef: TRANSFER_REF,
    paymentProofUrl: upload.body.url,
    items: [{ productId: product.id, quantity: 1 }]
  });
  assert.strictEqual(reuse.status, 400, JSON.stringify(reuse.body));
});

test('صورة إيصال مختلفة من نفس العميل مسموح بيها', async () => {
  const customer = await makeCustomer('second');
  const first = await customer.uploadProof(PNG_1PX_ALT, 'a.png');
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));
});

test('عميل ما يقدرش يستخدم إيصال عميل تاني', async () => {
  const a = await makeCustomer('owner');
  const b = await makeCustomer('thief');
  const proof = await a.uploadProof(Buffer.concat([PNG_1PX, Buffer.from('owner')]), 'own.png');
  assert.strictEqual(proof.status, 200, JSON.stringify(proof.body));
  const product = (await b.get('/api/products')).body.products.find((p) => p.stock > 1);
  const res = await b.post('/api/orders', {
    customerName: 'حرامي', customerPhone: '01000000001', customerAddress: 'القاهرة',
    paymentMethod: 'instapay', transferRef: 'IP-55512345',
    paymentProofUrl: proof.body.url,
    items: [{ productId: product.id, quantity: 1 }]
  });
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
});
