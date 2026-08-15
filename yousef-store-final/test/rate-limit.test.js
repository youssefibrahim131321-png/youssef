// المخزن بقى غير متزامن (Postgres)، فالمُحدِّد نفسه async: كل نداء بيتعمله await.
require('./helpers/test-db'); // قاعدة بيانات اختبارات معزولة في الذاكرة (لازم قبل store/server)
const test = require('node:test');
const assert = require('node:assert');
const { createRateLimiterFactory } = require('../lib/rate-limit');

function fakeStore() {
  const rows = new Map();
  return {
    rows,
    rateLimitGet: async (key) => rows.get(key) || null,
    rateLimitSet: async (key, count, resetAt) => { rows.set(key, { count, resetAt }); },
    // نفس منطق rate-limits-repo.js الحقيقي (Postgres): قراءة+زيادة ذرّية على
    // نفس المفتاح، عشان اختبارات "أكتر من instance" تعكس السلوك الحقيقي.
    rateLimitHit: async (key, windowMs) => {
      const now = Date.now();
      const row = rows.get(key);
      if (!row || row.resetAt <= now) {
        const resetAt = now + windowMs;
        rows.set(key, { count: 1, resetAt });
        return { count: 1, resetAt };
      }
      row.count += 1;
      return { count: row.count, resetAt: row.resetAt };
    }
  };
}
function fakeRes() {
  return { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
// بننده الـ middleware ونستنى إما next() أو ردّ 429.
async function call(limiter, ip) {
  const res = fakeRes();
  let passed = false;
  await limiter({ ip }, res, () => { passed = true; });
  return { res, passed };
}

test('blocks after the limit is exceeded', async () => {
  const factory = createRateLimiterFactory({ store: fakeStore() });
  const limiter = factory.createRateLimiter({ scope: 't', windowMs: 1000, max: 2, message: 'stop' });
  assert.strictEqual((await call(limiter, '1.1.1.1')).passed, true);
  assert.strictEqual((await call(limiter, '1.1.1.1')).passed, true);
  const third = await call(limiter, '1.1.1.1');
  assert.strictEqual(third.passed, false);
  assert.strictEqual(third.res.statusCode, 429);
});

test('persisted counters survive a restart', async () => {
  const store = fakeStore();
  const first = createRateLimiterFactory({ store });
  const limiter = first.createRateLimiter({ scope: 'auth', windowMs: 60000, max: 2, message: 'stop', persist: true });
  await call(limiter, '9.9.9.9');
  await call(limiter, '9.9.9.9');
  await first.flush();
  assert.ok(store.rows.size > 0, 'counter written to the database');

  // "restart": brand new factory, same shared store
  const second = createRateLimiterFactory({ store });
  const limiter2 = second.createRateLimiter({ scope: 'auth', windowMs: 60000, max: 2, message: 'stop', persist: true });
  const again = await call(limiter2, '9.9.9.9');
  assert.strictEqual(again.passed, false, 'limit is still enforced after restart');
  assert.strictEqual(again.res.statusCode, 429);
});

test('expired buckets are swept', async () => {
  const factory = createRateLimiterFactory({ store: fakeStore() });
  await factory.hit('x|1', -1, false);
  factory.sweep();
  assert.strictEqual(factory.buckets.size, 0);
});

test('(إصلاح 5) auth scope is centralized: multiple instances share one counter, not one each', async () => {
  const store = fakeStore();
  // اتنين factory منفصلين بنفس القاعدة = محاكاة تشغيل instance A و instance B
  // في نفس الوقت (زي Railway horizontal scaling).
  const instanceA = createRateLimiterFactory({ store });
  const instanceB = createRateLimiterFactory({ store });
  const limiterA = instanceA.createRateLimiter({ scope: 'auth', windowMs: 60000, max: 3, message: 'stop', persist: true });
  const limiterB = instanceB.createRateLimiter({ scope: 'auth', windowMs: 60000, max: 3, message: 'stop', persist: true });

  // 3 محاولات موزّعة بالتبادل بين الـ instances — لازم يتحسبوا على نفس
  // العدّاد المشترك (3 مسموحة)، مش 3 لكل instance (اللي كانت هتبقى 6).
  assert.strictEqual((await call(limiterA, '5.5.5.5')).passed, true);
  assert.strictEqual((await call(limiterB, '5.5.5.5')).passed, true);
  assert.strictEqual((await call(limiterA, '5.5.5.5')).passed, true);
  // الرابعة، أيًا كان الـ instance، لازم تتمنع لأن العدّاد المركزي وصل 3.
  const fourthOnB = await call(limiterB, '5.5.5.5');
  assert.strictEqual(fourthOnB.passed, false);
  assert.strictEqual(fourthOnB.res.statusCode, 429);
});
