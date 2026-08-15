// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
module.exports = async function createLimiters(deps = {}) {
  const { createRateLimiterFactory, jobLock, store } = deps;
  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------
  // العدّادات العامة عالية التردد (api/write/coupon...) في ذاكرة العملية
  // (Map، O(1)، بدون I/O على كل طلب) عشان ما نضربش قاعدة البيانات كل طلب.
  // (إصلاح 5) الحدود الحسّاسة المعرّضة لهجوم موزّع (دخول/استعادة كلمة مرور)
  // بقت بتتحسب مركزيًا وذرّيًا في Postgres نفسه (store.rateLimitHit) بدل
  // ما تعتمد على نسخة محلية بتتزامن كل شوية — فمهاجم موزّع بين N instances
  // (حتى لو على أجهزة مختلفة تمامًا) بيشوف نفس العدّاد بالظبط، مش N × الحد.
  // تفاصيل الفرق بين النوعين في lib/rate-limit.js.
  const rateLimitFactory = createRateLimiterFactory({
    store
  });
  const createRateLimiter = rateLimitFactory.createRateLimiter;

  // تنظيف دوري للسجلات المنتهية (حدود المعدّل + توكنات المصادقة).
  setInterval(async () => {
    rateLimitFactory.sweep(); // عدّاد محلي: لازم ينضف في كل نسخة.
    await jobLock.withLock('purge-expired', async () => {
      try {
        await store.purgeExpiredRateLimits();
        await store.purgeExpiredAuthTokens();
      } catch (_) {/* لا شيء */}
    }).catch(() => {});
  }, 10 * 60 * 1000).unref();
  const apiLimiter = createRateLimiter({
    scope: 'api',
    persist: true,
    windowMs: 60 * 1000,
    max: 240,
    message: 'طلبات كثيرة جدًا، برجاء الانتظار قليلًا.'
  });
  const authLimiter = createRateLimiter({
    scope: 'auth',
    persist: true,
    windowMs: 10 * 60 * 1000,
    max: 8,
    message: 'محاولات دخول كثيرة جدًا، حاول مرة أخرى بعد قليل.',
    keyFn: req => `${req.ip}:${String(req.body && req.body.email || '').trim().toLowerCase()}`
  });
  // حد إضافي على الحساب نفسه بغض النظر عن الـ IP (يحمي من هجمات موزّعة على IPs
  // كتير أو مزيفة تستهدف حساب واحد بعينه).
  // (إصلاح أمني) الحد على مستوى الحساب بيتعدّ على المحاولات *الفاشلة* بس،
  // والفحص بيقرأ العدّاد من غير ما يزوّده. كده مهاجم من IPs كتير مش قادر
  // يقفل حساب صاحبه: أول ما يدخل بكلمة السر الصح بيعدّي عادي.
  // (إصلاح 5) العدّاد ده سكوب 'auth-account' اللي بقى مركزي في Postgres
  // (centralizedScopes)، فالفحص هنا لازم يقرا من القاعدة مباشرة بدل الذاكرة
  // المحلية — غير كده مهاجم موزّع بين N instances كان بيشوف قفل مختلف على
  // كل instance (لأن كل عملية عندها نسخة محلية منفصلة من نفس المفتاح).
  const ACCOUNT_LOCK_WINDOW_MS = 10 * 60 * 1000;
  const ACCOUNT_LOCK_MAX = 12;
  const accountKey = email => `auth-account|account:${email}`;
  async function accountLockedFor(email) {
    let row = null;
    try { row = await store.rateLimitGet(accountKey(email)); }
    catch (error) { console.error('[auth-account]', error.message); return 0; }
    if (!row || row.resetAt <= Date.now()) return 0;
    return row.count > ACCOUNT_LOCK_MAX ? Math.max(1, Math.ceil((row.resetAt - Date.now()) / 1000)) : 0;
  }
  async function noteFailedLogin(email) {
    try { await rateLimitFactory.hit(accountKey(email), ACCOUNT_LOCK_WINDOW_MS, true); }
    catch (error) { console.error('[auth-account]', error.message); }
  }
  // حد إنشاء الحسابات على نفس البريد (مش تسجيل دخول، فمفيش خطر قفل حساب).
  const registerAccountLimiter = createRateLimiter({
    scope: 'auth-account',
    persist: true,
    windowMs: 10 * 60 * 1000,
    max: 12,
    message: 'محاولات كثيرة جدًا على هذا البريد، حاول مرة أخرى بعد قليل.',
    keyFn: req => `register:${String(req.body && req.body.email || '').trim().toLowerCase()}`
  });
  const writeLimiter = createRateLimiter({
    scope: 'write',
    persist: true,
    windowMs: 60 * 1000,
    max: 40,
    message: 'عدد كبير من العمليات، برجاء المحاولة بعد دقيقة.'
  });
  // (1) حد صارم على طلبات استعادة كلمة المرور وإعادة إرسال رسائل التفعيل، عشان
  // محدش يستخدمها كسلاح إزعاج (email bombing) على بريد عميل.
  // (إصلاح) كل مسارات الأدمن الحساسة (تعديل/حذف/تأكيد/تصدير) وراها حد معدّل.
  // لو جلسة الأدمن اتسرّبت، المهاجم مش هيقدر يعمل حذف أو تعديل جماعي سريع.
  // (إصلاح) تخمين أكواد الخصم: النقطة دي عامة ومكانتش وراها غير الحد العام،
  // فكود قصير كان ممكن يتخمّن ببطء وبلا نهاية. حد خاص بالـ IP + حد على الكود
  // نفسه بيمنع الاستكشاف الجماعي.
  const couponLimiter = createRateLimiter({
    scope: 'coupon',
    persist: true,
    windowMs: 10 * 60 * 1000,
    max: 20,
    message: 'محاولات كثيرة على أكواد الخصم، استنى شوية وحاول تاني.'
  });
  const couponCodeLimiter = createRateLimiter({
    scope: 'coupon-code',
    persist: true,
    windowMs: 10 * 60 * 1000,
    max: 30,
    message: 'محاولات كثيرة على كود الخصم ده، حاول بعد شوية.',
    keyFn: req => `code:${String(req.body && req.body.code || '').trim().toLowerCase()}`
  });
  const adminWriteLimiter = createRateLimiter({
    scope: 'admin-write',
    persist: true,
    windowMs: 60 * 1000,
    max: 60,
    message: 'عدد كبير من عمليات لوحة التحكم في وقت قصير، استنى دقيقة وحاول تاني.'
  });
  const adminBulkLimiter = createRateLimiter({
    scope: 'admin-bulk',
    persist: true,
    windowMs: 10 * 60 * 1000,
    max: 6,
    message: 'عدد كبير من عمليات التصدير/النسخ الاحتياطي، حاول بعد شوية.'
  });
  const passwordResetLimiter = createRateLimiter({
    scope: 'password-reset',
    persist: true,
    windowMs: 30 * 60 * 1000,
    max: 5,
    message: 'طلبات كثيرة لاستعادة كلمة المرور، حاول بعد نصف ساعة.',
    keyFn: req => `${req.ip}:${String(req.body && req.body.email || '').trim().toLowerCase()}`
  });
  return { rateLimitFactory, createRateLimiter, apiLimiter, authLimiter, accountLockedFor, noteFailedLogin, registerAccountLimiter, writeLimiter, couponLimiter, couponCodeLimiter, adminWriteLimiter, adminBulkLimiter, passwordResetLimiter };
};
