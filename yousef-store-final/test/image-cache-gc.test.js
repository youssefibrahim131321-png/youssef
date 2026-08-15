/**
 * اختبارات مكنسة كاش الصور + قفل النسخ + تسخين النسخ المحوّلة.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sweepImageCache } = require('../lib/image-cache-gc');
const { createInstanceLock } = require('../lib/instance-lock');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}

test('المكنسة بتمسح النسخ اللي أصلها مش موجود', async () => {
  const root = tmpdir('src-');
  const cache = tmpdir('cache-');
  write(path.join(root, 'a.jpg'), 100);
  write(path.join(cache, 'avif', 'a.jpg.abc-1.avif'), 50);
  write(path.join(cache, 'avif', 'gone.jpg.abc-1.avif'), 50);

  const stats = await sweepImageCache({ cacheDir: cache, rootDir: root, logger: { log() {} } });
  assert.equal(stats.orphans, 1);
  assert.ok(fs.existsSync(path.join(cache, 'avif', 'a.jpg.abc-1.avif')));
  assert.ok(!fs.existsSync(path.join(cache, 'avif', 'gone.jpg.abc-1.avif')));
});

test('المكنسة بتقصّ الكاش لما يعدّي الحد الأقصى', async () => {
  const root = tmpdir('src2-');
  const cache = tmpdir('cache2-');
  for (const name of ['a', 'b', 'c']) {
    write(path.join(root, `${name}.jpg`), 10);
    write(path.join(cache, 'webp', `${name}.jpg.x-1.webp`), 1000);
  }
  // نخلي a أقدم استخدامًا عشان تكون أول اللي تتمسح.
  const old = Date.now() - 60 * 60 * 1000;
  fs.utimesSync(path.join(cache, 'webp', 'a.jpg.x-1.webp'), old / 1000, old / 1000);

  const stats = await sweepImageCache({ cacheDir: cache, rootDir: root, maxBytes: 2500, ttlMs: 0, logger: { log() {} } });
  assert.equal(stats.trimmed, 1);
  assert.ok(stats.totalBytes <= 2500);
  assert.ok(!fs.existsSync(path.join(cache, 'webp', 'a.jpg.x-1.webp')));
});

test('المكنسة بتمسح النسخ المنتهية بالـ TTL', async () => {
  const root = tmpdir('src3-');
  const cache = tmpdir('cache3-');
  write(path.join(root, 'a.jpg'), 10);
  const variant = path.join(cache, 'avif', 'a.jpg.x-1.avif');
  write(variant, 10);
  const old = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(variant, old, old);

  const stats = await sweepImageCache({ cacheDir: cache, rootDir: root, ttlMs: 24 * 60 * 60 * 1000, logger: { log() {} } });
  assert.equal(stats.expired, 1);
  assert.ok(!fs.existsSync(variant));
});

test('المكنسة ما بتوقعش لو مجلد الكاش مش موجود', async () => {
  const stats = await sweepImageCache({ cacheDir: path.join(os.tmpdir(), 'does-not-exist-xyz'), logger: { log() {} } });
  assert.equal(stats.scanned, 0);
});

test('قفل النسخ: نسخة واحدة بس هي اللي تشتغل', async () => {
  let locked = false;
  const fakePool = {
    connect: async () => ({
      query: async (sql) => {
        if (sql.includes('pg_try_advisory_lock')) {
          if (locked) return { rows: [{ ok: false }] };
          locked = true;
          return { rows: [{ ok: true }] };
        }
        locked = false;
        return { rows: [] };
      },
      release() {}
    })
  };
  const lock = createInstanceLock({ pool: fakePool, logger: { error() {} } });
  let runs = 0;
  const first = lock.withLock('job', async () => {
    runs += 1;
    // النسخة التانية بتحاول أثناء ما الأولى شغالة
    const second = await lock.withLock('job-other-instance', async () => { runs += 1; });
    assert.equal(second.skipped, true);
  });
  const result = await first;
  assert.equal(result.ran, true);
  assert.equal(runs, 1);

  // بعد التحرير، الشغل بيمشي تاني عادي
  const again = await lock.withLock('job', async () => 'ok');
  assert.equal(again.value, 'ok');
});

test('قفل النسخ: بدون قاعدة بيانات بيشتغل عادي', async () => {
  const lock = createInstanceLock({ pool: null });
  const result = await lock.withLock('job', async () => 42);
  assert.equal(result.value, 42);
});

test('تسخين النسخ: بيرجع بهدوء لو الملف مش موجود', async () => {
  const { warmVariants } = require('../lib/image-serve');
  const root = tmpdir('warm-');
  const cache = tmpdir('warm-cache-');
  const out = await warmVariants({ rootDir: root, cacheDir: cache, relative: 'nope.jpg', logger: { warn() {} } });
  assert.equal(out.warmed, 0);
});
