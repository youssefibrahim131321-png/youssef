// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
module.exports = function registerSecurityHeaders(deps = {}) {
  const { SENSITIVE_PATHS, apiLimiter, app, compression, createRateLimiter, crypto, csrfProtection, enforcePasswordChange, express, googleAuth, sessionMiddleware } = deps;
  // ---------------------------------------------------------------------------
  // Middlewares عامة
  // ---------------------------------------------------------------------------
  // (إصلاح DoS) 3 ميجا JSON على *كل* مسار كان سطح هجوم بالذاكرة. الصور بترفع
  // عبر multipart (multer) بحدودها الخاصة، فالـ JSON مش محتاج أكتر من 128 كيلو.
  // (أداء) ضغط Brotli/Gzip لكل الردود النصية قبل أي middleware بيبعت محتوى.
  app.use(compression());
  // (ترقية Express 5) query parser الافتراضي بقى 'simple' (querystring) بدل
  // 'extended'. المشروع مش بيعتمد على كويري متداخل، فبنثبّت 'simple' صراحة
  // عشان السلوك يبقى واضح ومتوقّع لأي حد بيقرأ الكود.
  app.set('query parser', 'simple');
  app.use(express.json({
    limit: '128kb'
  }));
  app.use(express.urlencoded({
    extended: true,
    limit: '128kb'
  }));
  app.use(sessionMiddleware);
  app.use(csrfProtection);
  // قايمة الهوستات الموثوقة: SITE_URL أوّلًا، وبعدها ALLOWED_HOSTS (مفصولة بفاصلة).
  const TRUSTED_HOSTS = new Set([process.env.SITE_URL, ...String(process.env.ALLOWED_HOSTS || '').split(',')].map(v => {
    const raw = String(v || '').trim();
    if (!raw) return '';
    try { return new URL(raw.includes('://') ? raw : `https://${raw}`).host.toLowerCase(); } catch (_) { return ''; }
  }).filter(Boolean));
  function safeRedirectHost(req) {
    const host = String(req.headers.host || '').toLowerCase();
    if (TRUSTED_HOSTS.size) return TRUSTED_HOSTS.has(host) ? host : [...TRUSTED_HOSTS][0];
    // بدون قائمة موثوقة لا نعيد التوجيه مطلقًا؛ هيدر Host قابل للتزوير وقد يحوّل
    // المستخدم إلى نطاق خارجي (Open Redirect). يجب ضبط SITE_URL أو ALLOWED_HOSTS.
    return null;
  }

  // (إصلاح CSP) img-src مكانت مفتوحة على كل https: — أي دومين يقدر يحمّل صور
  // (تتبّع/تسريب). بقت 'self' + data:/blob: بس، ولو محتاج CDN صور خارجي حدّده
  // صراحةً: IMG_SRC_EXTRA="https://cdn.example.com".
  const IMG_SRC_EXTRA = String(process.env.IMG_SRC_EXTRA || '').trim()
    ? ' ' + String(process.env.IMG_SRC_EXTRA).trim()
    : '';
  app.use((req, res, next) => {
    // (4) CSP بدون 'unsafe-inline' للسكريبتات: كل سكريبت inline لازم يحمل الـ
    // nonce العشوائي بتاع الطلب ده، فأي سكريبت بيحقنه مهاجم (XSS) مش هيشتغل.
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // (إصلاح) عزل نافذة المتصفح: أي نافذة بتفتحها مواقع تانية ما تقدرش تمسك
    // مرجع للصفحة دي (تعطيل هجمات tabnabbing / XS-Leaks).
    res.setHeader('Cross-Origin-Opener-Policy', googleAuth.isEnabled() ? 'same-origin-allow-popups' : 'same-origin');
    res.setHeader('Reporting-Endpoints', 'csp-endpoint="/api/csp-report"');
    // (إصلاح) الصفحات الحساسة ما تتفهرسش في محركات البحث مهما حصل.
    if (SENSITIVE_PATHS.test(req.path)) res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Content-Security-Policy', ["default-src 'self'", `img-src 'self' data: blob:${IMG_SRC_EXTRA}`, `style-src 'self' 'nonce-${res.locals.cspNonce}' https://fonts.googleapis.com`, "style-src-attr 'none'", "font-src 'self' https://fonts.gstatic.com data:", `script-src 'self' 'nonce-${res.locals.cspNonce}'${googleAuth.isEnabled() ? ' https://accounts.google.com https://apis.google.com' : ''}`, "object-src 'none'", `connect-src 'self'${googleAuth.isEnabled() ? ' https://accounts.google.com' : ''}`, `frame-src 'self'${googleAuth.isEnabled() ? ' https://accounts.google.com' : ''}`, "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", 'report-uri /api/csp-report', "report-to csp-endpoint"].join('; '));
    // (إصلاح أمني) HSTS بيتبعت على أي اتصال HTTPS مش بس لما NODE_ENV=production،
    // عشان النشر ورا بروكسي من غير NODE_ENV ما يفضلش من غير حماية downgrade.
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const isHttps = req.secure || forwardedProto === 'https';
    if (isHttps || process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
    // فرض HTTPS خلف بروكسي (Render/Railway/Nginx). الهوست بيتاخد من SITE_URL أو
    // من قائمة ALLOWED_HOSTS بس — مش من هيدر Host اللي المهاجم يقدر يزوّره
    // (Host header injection كان بيسمح بإعادة توجيه لدومين خارجي).
    if (process.env.FORCE_HTTPS === '1' && forwardedProto === 'http') {
      const target = safeRedirectHost(req);
      if (target) return res.redirect(301, `https://${target}${req.originalUrl}`);
    }
    return next();
  });

  // تقارير انتهاك CSP: مسار صغير جدًا، محدود المعدّل، وبيسجّل بس.
  app.post('/api/csp-report', createRateLimiter({
    scope: 'csp-report',
    windowMs: 60 * 1000,
    max: 20,
    message: 'ok'
  }), express.json({
    type: ['application/csp-report', 'application/reports+json', 'application/json'],
    limit: '16kb'
  }), (req, res) => {
    const body = req.body || {};
    const r = body['csp-report'] || (Array.isArray(body) ? (body[0] || {}).body : null) || body;
    console.warn('[csp]', JSON.stringify({
      documentURI: String(r.documentURI || r.documentURL || '').slice(0, 300),
      violatedDirective: String(r.violatedDirective || r.effectiveDirective || '').slice(0, 120),
      blockedURI: String(r.blockedURI || r.blockedURL || '').slice(0, 300)
    }));
    res.status(204).end();
  });
  app.use('/api', apiLimiter);
  app.use('/api', enforcePasswordChange);
  // (إصلاح أمني) لوحة التحكم مقفولة على أدمن من غير 2FA: مسموح بس بنقاط
  // إعداد التحقق بخطوتين وتسجيل الخروج لحد ما يفعّله.
  // (إصلاح) جوّه app.use('/api', ...) الـ req.path بيبقى من غير بادئة /api،
  // فمقارنته بقوائم فيها '/api/...' كانت بتفشل دايمًا وترفض كل الطلبات.
  // (توضيح) ميزة التحقق بخطوتين (2FA/TOTP) **شغّالة بالكامل** في
  // lib/routes/auth-routes.js (/api/auth/2fa/setup|enable|disable|status
  // و/api/auth/2fa/verify-login) وبتتطبّق على تسجيل الدخول العادي.
  // اللي اتشال هنا هو بوابة 2FA **الإجبارية على لوحة الأدمن** بس (اللي كانت
  // بتقفل كل مسارات /api على الأدمن لحد ما يفعّل TOTP) بناءً على طلب المالك.
  // ممنوع حذف مسارات 2FA اعتمادًا على التعليق ده.

  return {  };
};
