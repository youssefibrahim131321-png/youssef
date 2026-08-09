const test = require('node:test');
const assert = require('node:assert');
const { createRateLimiterFactory } = require('../lib/rate-limit');

function fakeStore() {
  const rows = new Map();
  return {
    rows,
    rateLimitGet: (key) => rows.get(key) || null,
    rateLimitSet: (key, count, resetAt) => { rows.set(key, { count, resetAt }); }
  };
}
function fakeRes() {
  return { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test('blocks after the limit is exceeded', () => {
  const factory = createRateLimiterFactory({ store: fakeStore() });
  const limiter = factory.createRateLimiter({ scope: 't', windowMs: 1000, max: 2, message: 'stop' });
  const run = () => { const res = fakeRes(); let passed = false; limiter({ ip: '1.1.1.1' }, res, () => { passed = true; }); return { res, passed }; };
  assert.strictEqual(run().passed, true);
  assert.strictEqual(run().passed, true);
  const third = run();
  assert.strictEqual(third.passed, false);
  assert.strictEqual(third.res.statusCode, 429);
});

test('persisted counters survive a restart', () => {
  const store = fakeStore();
  const first = createRateLimiterFactory({ store });
  const limiter = first.createRateLimiter({ scope: 'auth', windowMs: 60000, max: 2, message: 'stop', persist: true });
  limiter({ ip: '9.9.9.9' }, fakeRes(), () => {});
  limiter({ ip: '9.9.9.9' }, fakeRes(), () => {});
  first.flush();
  assert.ok(store.rows.size > 0, 'counter written to the database');

  // "restart": brand new factory, same shared store
  const second = createRateLimiterFactory({ store });
  const limiter2 = second.createRateLimiter({ scope: 'auth', windowMs: 60000, max: 2, message: 'stop', persist: true });
  const res = fakeRes(); let passed = false;
  limiter2({ ip: '9.9.9.9' }, res, () => { passed = true; });
  assert.strictEqual(passed, false, 'limit is still enforced after restart');
  assert.strictEqual(res.statusCode, 429);
});

test('expired buckets are swept', () => {
  const factory = createRateLimiterFactory({ store: fakeStore() });
  factory.hit('x|1', -1, false);
  factory.sweep();
  assert.strictEqual(factory.buckets.size, 0);
});
