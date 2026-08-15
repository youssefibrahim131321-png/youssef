/**
 * اختبار تراجع (تكامل حقيقي، سيرفر شغّال فعليًا): Host Header Injection في
 * /api/auth/forgot-password.
 * ---------------------------------------------------------------------------
 * قبل الإصلاح، رابط استعادة كلمة المرور كان بيتبنى من `req.get('host')`
 * الخام، وهو هيدر بيتحكم فيه المُرسِل بالكامل. مهاجم كان يقدر يبعت هيدر
 * Host (وOrigin مطابق ليه عشان يعدّي فحص CSRF) لدومين تابع له، فيوصله رابط
 * استعادة يشاور على دومينه هو، وليس على المتجر الحقيقي — استيلاء كامل على
 * الحساب. راجع lib/core/public-url.js للتفاصيل.
 *
 * السلوك الحالي (أدق من مجرد fallback على localhost): لو مفيش أصل موثوق
 * مضبوط (PUBLIC_BASE_URL/SITE_URL/ALLOWED_HOSTS) والهوست الوارد مش loopback،
 * الـ API بيرفض بناء أي رابط أصلًا — بيرجع رد عام من غير devResetLink بدل ما
 * يسرّب رابط (ولو لدومين "آمن" زي localhost). الاختبار ده بيثبت إن:
 *  (أ) طلب بهيدر Host مزوّر لدومين المهاجم أبدًا ما بيرجّع رابط استعادة.
 *  (ب) نفس الطلب من الهوست الحقيقي (المحلي) بيرجّع رابط سليم وما بيحتويش
 *      على دومين المهاجم.
 */
require('./helpers/test-db'); // قاعدة بيانات اختبارات معزولة في الذاكرة (لازم قبل store/server)
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yousef-host-test-'));
const PORT = 4700 + Math.floor(Math.random() * 400);
const HOST_IP = '127.0.0.1';
const BASE = `http://${HOST_IP}:${PORT}`;
const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'AdminPass!2026';
const ATTACKER_HOST = 'evil-attacker.com';

let child;

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        // (مهم) عمدًا مفيش PUBLIC_BASE_URL ولا SITE_URL ولا ALLOWED_HOSTS
        // مضبوطين هنا، عشان نتأكد إن الـ fallback الآمن (localhost) هو اللي
        // بيتفعّل، مش هيدر Host المزوّر.
        PUBLIC_BASE_URL: '',
        SITE_URL: '',
        ALLOWED_HOSTS: '',
        DATABASE_URL: '',
        STORE_QUIET: '1',
        PORT: String(PORT),
        HOST: HOST_IP,
        NODE_ENV: 'test',
        DATA_DIR,
        UPLOADS_DIR: path.join(DATA_DIR, 'uploads'),
        BACKUP_DIR: path.join(DATA_DIR, '..', 'yousef-host-test-backups'),
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

function stopServer() {
  if (child) child.kill();
}

/** بيبعت طلب خام بمكتبة http الأساسية عشان نقدر نتحكم في هيدر Host بنفسه
 * (fetch بيرفض تعديل هيدر Host، بس المهاجم الحقيقي بيقدر يعمله بسهولة بأي
 * أداة زي curl، فبنحاكي نفس السيناريو من غير قيود fetch). */
function rawRequest({ method, path: reqPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: HOST_IP,
      port: PORT,
      path: reqPath,
      method,
      headers: {
        ...headers,
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* مش JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function extractSetCookie(headers) {
  const raw = headers['set-cookie'] || [];
  const jar = new Map();
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return jar;
}

test('forgot-password: هيدر Host/Origin مزوّر ما يأثرش على الدومين في رابط الاستعادة', async (t) => {
  await startServer();
  t.after(stopServer);

  // (1) نسجّل عميل عادي بحساب حقيقي، عشان يكون فيه مستخدم نطلب استعادة كلمة
  // مروره — بنستخدم الهوست الحقيقي هنا عشان التسجيل نفسه يعدّي عادي.
  const csrfWarmup = await rawRequest({ method: 'GET', path: '/api/health', headers: { host: `${HOST_IP}:${PORT}` } });
  assert.strictEqual(csrfWarmup.status, 200);
  const cookieJar = extractSetCookie(csrfWarmup.headers);
  const csrfToken = cookieJar.get('yousef_csrf');
  assert.ok(csrfToken, 'لازم كوكي CSRF يترجع من أول طلب');

  const email = 'victim@test.local';
  const cookieHeader = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const registerRes = await rawRequest({
    method: 'POST',
    path: '/api/auth/register',
    headers: {
      host: `${HOST_IP}:${PORT}`,
      origin: BASE,
      cookie: cookieHeader,
      'x-csrf-token': csrfToken
    },
    body: { name: 'ضحية', email, password: 'VictimPass!2026', phone: '01000000000', address: 'القاهرة' }
  });
  assert.strictEqual(registerRes.status, 200, `فشل التسجيل: ${JSON.stringify(registerRes.body)}`);

  // (2) الهجوم: طلب forgot-password بنفس كوكي الجلسة (متاح لأي زائر أصلًا،
  // مش لازم جلسة حتى)، لكن بهيدر Host وOrigin مزوّرين لدومين المهاجم
  // ومتطابقين مع بعض (بالظبط زي إثبات التقرير بـ curl).
  const attackRes = await rawRequest({
    method: 'POST',
    path: '/api/auth/forgot-password',
    headers: {
      host: ATTACKER_HOST,
      origin: `http://${ATTACKER_HOST}`,
      cookie: cookieHeader,
      'x-csrf-token': csrfToken
    },
    body: { email }
  });

  assert.strictEqual(attackRes.status, 200, `الطلب لازم ينجح ظاهريًا (نفس الرد للمهاجم وللمستخدم الشرعي): ${JSON.stringify(attackRes.body)}`);
  const attackLink = attackRes.body && attackRes.body.devResetLink;
  assert.ok(!attackLink, `مفيش أصل موثوق (Host مزوّر مش loopback) — المفروض ما يترجعش أي رابط أصلًا: ${attackLink}`);
  assert.ok(
    !JSON.stringify(attackRes.body || {}).includes(ATTACKER_HOST),
    `ردّ الـ API ما يجبش يحتوي على دومين المهاجم في أي شكل: ${JSON.stringify(attackRes.body)}`
  );

  // (3) نفس الطلب، لكن من الهوست الحقيقي (loopback) — هنا لازم الرابط يترجع
  // فعلًا وميكونش فيه أي أثر لدومين المهاجم من المحاولة اللي فاتت.
  const legitRes = await rawRequest({
    method: 'POST',
    path: '/api/auth/forgot-password',
    headers: {
      host: `${HOST_IP}:${PORT}`,
      origin: BASE,
      cookie: cookieHeader,
      'x-csrf-token': csrfToken
    },
    body: { email }
  });
  assert.strictEqual(legitRes.status, 200, `الطلب الشرعي المفروض ينجح: ${JSON.stringify(legitRes.body)}`);
  const legitLink = legitRes.body && legitRes.body.devResetLink;
  assert.ok(legitLink, `المفروض يترجع رابط استعادة من الهوست المحلي الحقيقي: ${JSON.stringify(legitRes.body)}`);
  assert.ok(!legitLink.includes(ATTACKER_HOST), `الرابط الشرعي ما يجبش يحتوي على دومين المهاجم: ${legitLink}`);
  assert.ok(legitLink.startsWith(`http://${HOST_IP}:${PORT}`), `المفروض يبني الرابط من الهوست المحلي الحقيقي: ${legitLink}`);
});
