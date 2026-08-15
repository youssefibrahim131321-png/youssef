/**
 * (إصلاح 5) حدود المعدّل: عدّاد في الذاكرة (سريع، بدون I/O على كل طلب) للحدود
 * العامة عالية التردد (api/write/coupon...)، لكن الحدود الحسّاسة المعرّضة
 * لهجوم موزّع بين أكتر من instance (auth/auth-account/password-reset) بتتحسب
 * مركزيًا وذرّيًا في Postgres مباشرة (store.rateLimitHit) بدل ما تعتمد على
 * نسخة محلية بتتزامن كل شوية — فمهاجم موزّع بين N instances بيشوف نفس
 * العدّاد بالظبط أيًا كان الـ instance اللي طلبه راح عليه، مش N × الحد.
 */
// (إصلاح) 'write' و'coupon'/'coupon-code' كانوا محليين فقط (Map في ذاكرة كل
// Instance)، فمع أكتر من Instance شغّال الحد الفعلي كان تقريبًا عدد
// الـInstances × الحد المفروض — مهاجم موزّع بين الـInstances (مباشرة أو عن
// طريق Load Balancer) يقدر يضرب POST /api/orders أو /api/coupons/validate
// أكتر بكتير من المسموح. نقلهم لـcentralizedScopes بيخليهم يتحسبوا ذرّيًا في
// Postgres زي auth بالظبط (مع نفس fallback التدهور المحلي لو القاعدة واقعة).
function createRateLimiterFactory({ store, flushEveryMs = 5000, maxBuckets = 50000, logger = console, protectedScopes = ['auth', 'auth-account'], centralizedScopes = ['auth', 'auth-account', 'password-reset', 'write', 'coupon', 'coupon-code'] }) {
  const buckets = new Map();
  let dirty = new Set();
  // (إصلاح) لما العدّاد المركزي يقع بنفضل شغّالين بعدّاد محلي (عشان auth ما يقفش)،
  // بس ده معناه إن مهاجم موزّع بين N instances يقدر يشوف N × الحد. فبنسجّل
  // تنبيه صريح، وبنشدّد الحد للنص طول فترة التدهور (شوف createRateLimiter).
  let centralDownUntil = 0;
  let lastDegradedLogAt = 0;
  function isDegraded() { return Date.now() < centralDownUntil; }

  async function flush() {
    if (!dirty.size) return;
    const pending = dirty; dirty = new Set();
    for (const key of pending) {
      const row = buckets.get(key);
      if (!row || !row.persist) continue;
      try { await store.rateLimitSet(key, row.count, row.resetAt); }
      catch (error) { logger.error('[rate-limit] فشل حفظ العدّاد:', error.message); }
    }
  }
  const timer = setInterval(flush, flushEveryMs);
  if (typeof timer.unref === 'function') timer.unref();

  async function hit(key, windowMs, persist) {
    const now = Date.now();
    const scope = key.slice(0, key.indexOf('|'));
    if (persist && centralizedScopes.includes(scope)) {
      // (إصلاح 5) مصدر الحقيقة الوحيد هنا هو Postgres نفسه: زيادة ذرّية
      // (SELECT+UPDATE جوه transaction واحدة) بدل عدّاد محلي بيتقرا من القاعدة
      // مرة واحدة بس أول ما المفتاح يظهر، وبعدها بيزيد محليًا من غير أي
      // تزامن حقيقي مع باقي الـ instances.
      try {
        return await store.rateLimitHit(key, windowMs);
      } catch (error) {
        centralDownUntil = Date.now() + 60 * 1000;
        if (Date.now() - lastDegradedLogAt > 30 * 1000) {
          lastDegradedLogAt = Date.now();
          logger.error('[rate-limit][ALERT] العدّاد المركزي واقع — الحدود الحسّاسة شغّالة محليًا بنص السقف مؤقتًا:', error.message);
        }
        // (احتياطي) لو القاعدة واقعة مؤقتًا، منمنعش تسجيل الدخول تمامًا —
        // بنكمل بعدّاد محلي مؤقت لحد ما القاعدة ترجع، بدل ما نوقف auth كله.
      }
    }
    let row = buckets.get(key);
    if (!row && persist) {
      // قراءة أولى من القاعدة: العدّاد بينجو من إعادة التشغيل.
      try {
        const saved = await store.rateLimitGet(key);
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
      // (إصلاح) عدّادات المصادقة الحسّاسة بقت بتتحسب مركزيًا فوق (centralizedScopes)
      // فمش بتوصل هنا أصلًا في الحالة العادية. الكود ده باقٍ كاحتياطي لحدود
      // persist=true التانية (زي write/coupon/admin-write) اللي لسه بتستخدم
      // النسخة المحلية + write-behind لأداء أعلى، وكمان كـ fallback لو القاعدة
      // المركزية واقعة مؤقتًا للحدود الحسّاسة (شوف الكاتش فوق).
      if (protectedScopes.includes(scope)) {
        // الكتابة بقت مُنتظَرة (await) مش fire-and-forget، فالطلب مش
        // بيكمل قبل ما العدّاد يتثبّت في القاعدة — يعني مفيش نافذة يقدر فيها
        // مهاجم يستهلك محاولات إضافية لو السيرفر وقع بعد الرد.
        try {
          await store.rateLimitSet(key, row.count, row.resetAt);
          dirty.delete(key);
        } catch (error) {
          logger.error('[rate-limit] فشل الحفظ الفوري:', error.message);
        }
      }
    }
    // بنعلّم الحدود الحسّاسة اللي اضطرت تنزل على العدّاد المحلي عشان
    // createRateLimiter يشدّد السقف طول فترة التدهور.
    row.degraded = !!persist && centralizedScopes.includes(scope) && isDegraded();
    return row;
  }

  function sweep() {
    const now = Date.now();
    for (const [key, row] of buckets) if (row.resetAt <= now) buckets.delete(key);
  }

  function createRateLimiter({ windowMs, max, message, keyFn, scope, persist }) {
    return async function limiter(req, res, next) {
      const rawKey = keyFn ? keyFn(req) : req.ip;
      const key = `${scope || 'default'}|${rawKey}`;
      let entry;
      try { entry = await hit(key, windowMs, persist); }
      catch (error) { logger.error('[rate-limit]', error.message); return next(); }
      // في وضع التدهور (القاعدة المركزية واقعة) بنشدّد السقف للنص عشان نقلّل
      // نافذة التجاوز الموزّع بين الـ instances.
      const effectiveMax = entry && entry.degraded ? Math.max(1, Math.ceil(max / 2)) : max;
      res.setHeader('X-RateLimit-Limit', effectiveMax);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, effectiveMax - entry.count));
      if (entry.count > effectiveMax) {
        res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)));
        return res.status(429).json({ error: message });
      }
      return next();
    };
  }

  return { createRateLimiter, hit, flush, sweep, buckets };
}

module.exports = { createRateLimiterFactory };
