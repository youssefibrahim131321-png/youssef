/**
 * (إصلاح 5) حدود المعدّل: عدّاد في الذاكرة (سريع، بدون I/O على كل طلب) لكن
 * مع «write-behind» لقاعدة البيانات وقراءة أولى منها (read-through). النتيجة:
 * الحد ما بيتصفّرش مع إعادة النشر/التشغيل، ومن غير ما نضرب SQLite كل طلب.
 */
function createRateLimiterFactory({ store, flushEveryMs = 5000, maxBuckets = 50000, logger = console, protectedScopes = ['auth', 'auth-account'] }) {
  const buckets = new Map();
  let dirty = new Set();

  function flush() {
    if (!dirty.size) return;
    const pending = dirty; dirty = new Set();
    for (const key of pending) {
      const row = buckets.get(key);
      if (!row || !row.persist) continue;
      try { store.rateLimitSet(key, row.count, row.resetAt); }
      catch (error) { logger.error('[rate-limit] فشل حفظ العدّاد:', error.message); }
    }
  }
  const timer = setInterval(flush, flushEveryMs);
  if (typeof timer.unref === 'function') timer.unref();

  function hit(key, windowMs, persist) {
    const now = Date.now();
    let row = buckets.get(key);
    if (!row && persist) {
      // قراءة أولى من القاعدة: العدّاد بينجو من إعادة التشغيل.
      try {
        const saved = store.rateLimitGet(key);
        if (saved && saved.resetAt > now) row = { count: saved.count, resetAt: saved.resetAt, persist: true };
      } catch (error) { logger.error('[rate-limit] فشل قراءة العدّاد:', error.message); }
      if (row) buckets.set(key, row);
    }
    if (!row || row.resetAt <= now) {
      row = { count: 0, resetAt: now + windowMs, persist: !!persist };
      // (أمان) ممنوع buckets.clear(): كان بيصفّر كل العدّادات (بما فيها حدود
      // تسجيل الدخول) لأي مهاجم يوصل للسقف. الإخلاء دلوقتي بيراعي قاعدتين:
      //  1) عدّادات auth/auth-account (lockout الخاص بتسجيل الدخول) ممنوع
      //     تتشال أبدًا هنا، حتى لو فاضت السعة — عشان إغراق مفاتيح جديدة
      //     (مثلًا IPs أو إيميلات وهمية كتير) ما يقدرش يصفّر قفل حساب فعلي.
      //  2) لو محتاجين نشيل زيادة، بنشيل الأقرب لانتهاء صلاحيته الأول
      //     (soonest-expiring)، مش عشوائي، وبس من بين العدّادات الغير محمية.
      if (buckets.size > maxBuckets) {
        const isProtected = (k) => protectedScopes.includes(k.slice(0, k.indexOf('|')));
        for (const [k, r] of buckets) if (r.resetAt <= now && !isProtected(k)) buckets.delete(k);
        if (buckets.size > maxBuckets) {
          const overflow = buckets.size - maxBuckets;
          const candidates = [...buckets.entries()].filter(([k]) => !isProtected(k));
          candidates.sort((a, b) => a[1].resetAt - b[1].resetAt);
          let removed = 0;
          for (const [k] of candidates) {
            if (removed >= overflow) break;
            buckets.delete(k);
            removed += 1;
          }
          // لو لسه فوق السقف وكل اللي فاضل عدّادات محمية، بنسيبهم زي ما هم:
          // أمان قفل تسجيل الدخول أهم من حد الذاكرة، والـ TTL هيشيلهم طبيعيًا.
        }
      }
      buckets.set(key, row);
    }
    row.count += 1;
    if (persist) {
      dirty.add(key);
      // (إصلاح) عدّادات المصادقة بتتكتب في القاعدة *فورًا* مش بعد 5 ثواني.
      // الكتابة المؤجلة كانت معناها إن كراش/إعادة نشر في اللحظة الغلط بيضيّع
      // محاولات الدخول الفاشلة ويدّي المهاجم محاولات مجانية جديدة.
      const scope = key.slice(0, key.indexOf('|'));
      if (protectedScopes.includes(scope)) {
        try { store.rateLimitSet(key, row.count, row.resetAt); dirty.delete(key); }
        catch (error) { logger.error('[rate-limit] فشل الحفظ الفوري:', error.message); }
      }
    }
    return row;
  }

  function sweep() {
    const now = Date.now();
    for (const [key, row] of buckets) if (row.resetAt <= now) buckets.delete(key);
  }

  function createRateLimiter({ windowMs, max, message, keyFn, scope, persist }) {
    return function limiter(req, res, next) {
      const rawKey = keyFn ? keyFn(req) : req.ip;
      const key = `${scope || 'default'}|${rawKey}`;
      let entry;
      try { entry = hit(key, windowMs, persist); }
      catch (error) { logger.error('[rate-limit]', error.message); return next(); }
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count));
      if (entry.count > max) {
        res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)));
        return res.status(429).json({ error: message });
      }
      return next();
    };
  }

  return { createRateLimiter, hit, flush, sweep, buckets };
}

module.exports = { createRateLimiterFactory };
