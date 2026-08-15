/**
 * ---------------------------------------------------------------------------
 * متجر يوسف — خادم Express
 * ---------------------------------------------------------------------------
 * أهم التحسينات في هذه النسخة:
 *  - تحقق صارم من كل المدخلات (أطوال، أنواع، قوائم مسموحة).
 *  - رؤوس أمان كاملة + CSP + منع الـ clickjacking.
 *  - Rate limiting عام + مشدد على المصادقة.
 *  - إدارة مخزون، كوبونات، تقييمات، مفضلة، وسجل حالات الطلب.
 *  - تحليلات كاملة للوحة التحكم + تصدير CSV + نسخ احتياطي بضغطة زر.
 *  - إشعارات مجدولة تنجو من إعادة التشغيل + مكنسة دورية للفائت.
 *  - إغلاق آمن (graceful shutdown) مع حفظ البيانات قبل الخروج.
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const multer = require('multer');
const webpush = require('web-push');
const {
  createStore
} = require('./store');
const {
  sendMail,
  shouldExposeLink,
  activeProvider
} = require('./mailer');
const {
  checkConfig,
  onKnownProxyHost
} = require('./config-check');
const emailGuard = require('./email-guard');
const googleAuth = require('./google-auth');
const {
  queryProducts
} = require('./lib/product-query');
const {
  productPath,
  parseProductPath
} = require('./lib/slug');
const { injectProductSection } = require('./lib/product-ssr');
const imageOptimize = require('./lib/image-optimize');
const { createImageFormatMiddleware, warmVariants } = require('./lib/image-serve');
const { createInstanceLock } = require('./lib/instance-lock');
const { sweepImageCache } = require('./lib/image-cache-gc');

const storageGuard = require('./lib/storage-guard');
const {
  createRateLimiterFactory
} = require('./lib/rate-limit');
const {
  compression
} = require('./lib/compress');
const { registerPaymobRoutes } = require('./lib/paymob-routes');
const registerAdminPanelRoutes = require('./lib/routes/admin-panel-routes');
const registerSeoRoutes = require('./lib/routes/seo-routes');
const registerPublicApiRoutes = require('./lib/routes/public-api-routes');
const registerAuthRoutes = require('./lib/routes/auth-routes');
const registerShopRoutes = require('./lib/routes/shop-routes');
const registerNotificationRoutes = require('./lib/routes/notification-routes');
const registerAdminOrderRoutes = require('./lib/routes/admin-order-routes');
const registerUploadRoutes = require('./lib/routes/upload-routes');
const registerAdminCatalogRoutes = require('./lib/routes/admin-catalog-routes');
const registerAdminUsersRoutes = require('./lib/routes/admin-users-routes');
const registerAdminReportRoutes = require('./lib/routes/admin-report-routes');
const totp = require('./lib/totp');
const turnstile = require('./lib/turnstile');
const registerInvoiceRoutes = require('./lib/routes/invoice-routes');
const installAsyncSafety = require('./lib/core/async-safety.js');
const resolveBootPaths = require('./lib/core/boot-paths.js');
const ensureAdminAccount = require('./lib/core/admin-bootstrap.js');
const createSessionSecurity = require('./lib/core/session-security.js');
const createMailPolicy = require('./lib/core/mail-policy.js');
const createNotifyEngine = require('./lib/core/notify-engine.js');
const createOffsiteBackup = require('./lib/core/offsite-backup.js');
const startOrderSlaAlerts = require('./lib/core/order-sla.js');
const createLimiters = require('./lib/core/limiters.js');
const createValidators = require('./lib/core/validators.js');
const registerSecurityHeaders = require('./lib/core/security-headers.js');
const createGuards = require('./lib/core/guards.js');
const createHtmlPipeline = require('./lib/core/html-pipeline.js');
const registerStaticServing = require('./lib/core/static-serve.js');
const startPaymobSweeper = require('./lib/core/paymob-sweeper.js');
const app = express();

installAsyncSafety({ app, express });
const { PORT, HOST, PUBLIC_DIR, DATA_DIR, UPLOADS_DIR, PROOFS_DIR, DB_PATH, QUARANTINE_DIR, BACKUP_DIR, instanceLock } = resolveBootPaths({ projectRoot: __dirname, activeProvider, checkConfig, fs, imageOptimize, path, storageGuard });
async function main() {
  const store = await createStore(DB_PATH);
  // (تعدد النسخ) قفل مشترك في القاعدة: المهام الدورية بتشتغل على نسخة واحدة بس،
  // فلو عملت scale لأكتر من instance مفيش إشعارات مكرّرة ولا نسخ احتياطي متزامن.
  const jobLock = createInstanceLock({ pool: store.pool, logger: console });
  const everyInstances = jobLock.scheduled;

  // نثق في X-Forwarded-For بس لو الموقع فعليًا خلف بروكسي حقيقي (Nginx/Render/Railway..).
  // لازم تحدد TRUST_PROXY=1 صراحةً في متغيرات البيئة عند النشر خلف بروكسي، وإلا
  // أي زائر يقدر يزوّر IP بتاعه عبر الهيدر ده ويتحايل على حماية تسجيل الدخول.
  // بنفعّله لو TRUST_PROXY=1، أو لو المنصة نفسها معروف إنها بروكسي (Railway/Render/Fly/Heroku)
  // عشان الـ rate limiting وحماية الجلسات ما تتكسرش بسبب متغير بيئة ناقص.
  // (إصلاح) مفيش تخمين خالص: الثقة في X-Forwarded-For بتتفعّل بقرار صريح منك.
  // TRUST_PROXY=1 (أو رقم أكبر لعدد البروكسيات) أو قائمة IPs موثوقة. أي قيمة
  // تانية (أو غياب المتغير) = مفيش ثقة نهائيًا، فمستحيل حد يزوّر IP ويتخطى
  // حماية الدخول، ومستحيل كمان نحجب كل الزوار بسبب IP بروكسي واحد.
  const TRUST_PROXY_RAW = String(process.env.TRUST_PROXY || '').trim();
  if (TRUST_PROXY_RAW && TRUST_PROXY_RAW !== '0' && TRUST_PROXY_RAW.toLowerCase() !== 'false') {
    const hops = Number(TRUST_PROXY_RAW);
    app.set('trust proxy', Number.isFinite(hops) && hops > 0 ? hops : TRUST_PROXY_RAW);
  } else {
    app.set('trust proxy', false);
    if (onKnownProxyHost()) {
      console.warn('\x1b[33m⚠️  المنصة دي غالبًا بروكسي لكن TRUST_PROXY مش متظبط، فكل الزوار هيبانوا بنفس الـ IP وحدود المحاولات هتبقى أقسى من اللازم. ظبّط TRUST_PROXY=1 لو إنت فعلًا خلف بروكسي واحد موثوق.\x1b[0m');
    }
  }
  app.disable('x-powered-by');
  // الصفحات اللي ما ينفعش تتفهرس في جوجل (لوحة تحكم، دخول، دفع، حساب).
  const SENSITIVE_PATHS = /^\/(admin|admin\.html|admin-login\.html|checkout\.html|account\.html|dashboard\.html|verify-email\.html|reset-password\.html|forgot-password\.html|invoice\/|api\/)/i;

  const { ADMIN_PASSWORD_FILE, ADMIN_RESET_LINK_FILE } = await ensureAdminAccount({ DATA_DIR, crypto, fs, path, store });

  const { RESET_TOKEN_TTL_MS, VERIFY_CODE_TTL_MS, TOTP_PENDING_TTL_MS, setSessionCookie, clearSessionCookie, csrfProtection, sessionMiddleware } = await createSessionSecurity({ crypto, store });
  const { EMAIL_VERIFICATION_AVAILABLE, REQUIRE_EMAIL_VERIFICATION, noteMailFailure, noteMailSuccess, emailVerificationEnforced, EMAIL_VERIFY_MODE } = createMailPolicy({ activeProvider, shouldExposeLink });

  const { vapidKeys, sendPushToUser, notifyCustomer, armNotificationTimer } = await createNotifyEngine({ everyInstances, store, webpush });

  const { BACKUP_UPLOAD_URL, uploadBackupOffsite } = await createOffsiteBackup({ BACKUP_DIR, everyInstances, fs, path, store });

  await startOrderSlaAlerts({ everyInstances, sendPushToUser, store });

  const { rateLimitFactory, createRateLimiter, apiLimiter, authLimiter, accountLockedFor, noteFailedLogin, registerAccountLimiter, writeLimiter, couponLimiter, couponCodeLimiter, adminWriteLimiter, adminBulkLimiter, passwordResetLimiter } = await createLimiters({ createRateLimiterFactory, jobLock, store });

  const { escapeHtml, isEmail, asText, validate } = createValidators({  });


  const { requireAdminPanel, requireAuth, enforcePasswordChange, requireAdmin, audit } = await createGuards({ store });
  registerSecurityHeaders({ SENSITIVE_PATHS, apiLimiter, app, compression, createRateLimiter, crypto, csrfProtection, enforcePasswordChange, express, googleAuth, sessionMiddleware });

  const { assetVersion, sendHtml } = await createHtmlPipeline({ PUBLIC_DIR, crypto, fs, injectProductSection, parseProductPath, path, productPath, store });
  // (إصلاح) /dashboard.html كانت بترجع 200 لأي زائر مش مسجّل، والحماية
  // الوحيدة كانت جافاسكريبت جوّه الصفحة (fetch /api/auth/me ثم redirect لو
  // مش مسجّل) — البيانات نفسها محمية فعليًا (بتيجي من API محتاج جلسة)، لكن
  // ده تسريب بسيط (بيأكّد للزائر إن المسار موجود ويرسم الصفحة قبل ما يتحوّل)
  // وغير متسق مع admin.html اللي بيتحوّل من السيرفر مباشرة. account.html
  // مستثناة عمدًا: هي نفسها صفحة تسجيل الدخول/التسجيل للزوار، فلازم تفضل 200.
  app.get('/dashboard.html', (req, res, next) => {
    if (!req.user) return res.redirect('/account.html?next=dashboard.html');
    return next();
  });

  // (13) /dashboard.html بقت لوحة تحكم العميل (ملف ثابت). المسارات القديمة
  // الخاصة بالأدمن بقت /dash.html فقط.
  registerAdminPanelRoutes(app, {
    PUBLIC_DIR,
    fs,
    path,
    requireAdminPanel,
    sendHtml
  });
  registerSeoRoutes(app, {
    productPath,
    store
  });

  const { warmImageVariants } = await registerStaticServing({ DATA_DIR, PUBLIC_DIR, UPLOADS_DIR, app, assetVersion, createImageFormatMiddleware, everyInstances, express, fs, path, productPath, sendHtml, store, sweepImageCache, warmVariants });

  // ---------------------------------------------------------------------------
  // APIs عامة
  // ---------------------------------------------------------------------------
  registerPublicApiRoutes(app, {
    adminWriteLimiter,
    audit,
    queryProducts,
    requireAdmin,
    store
  });

  // ---------------------------------------------------------------------------
  // المصادقة
  // ---------------------------------------------------------------------------
  registerAuthRoutes(app, {
    ADMIN_PASSWORD_FILE,
    ADMIN_RESET_LINK_FILE,
    EMAIL_VERIFICATION_AVAILABLE,
    EMAIL_VERIFY_MODE,
    REQUIRE_EMAIL_VERIFICATION,
    RESET_TOKEN_TTL_MS,
    TOTP_PENDING_TTL_MS,
    VERIFY_CODE_TTL_MS,
    accountLockedFor,
    activeProvider,
    asText,
    audit,
    authLimiter,
    clearSessionCookie,
    crypto,
    emailGuard,
    emailVerificationEnforced,
    fs,
    googleAuth,
    isEmail,
    noteFailedLogin,
    noteMailFailure,
    noteMailSuccess,
    passwordResetLimiter,
    registerAccountLimiter,
    requireAuth,
    sendMail,
    setSessionCookie,
    shouldExposeLink,
    store,
    totp,
    turnstile,
    validate,
    writeLimiter
  });

  // ---------------------------------------------------------------------------
  // الكوبونات (عام)
  // ---------------------------------------------------------------------------
  registerShopRoutes(app, {
    PROOFS_DIR,
    asText,
    couponCodeLimiter,
    couponLimiter,
    emailVerificationEnforced,
    fsp,
    notifyCustomer,
    path,
    requireAuth,
    store,
    validate,
    writeLimiter
  });

  // ---------------------------------------------------------------------------
  // الإشعارات
  // ---------------------------------------------------------------------------
  // (إصلاح SSRF) الاشتراك لازم يكون على دومين خدمة Push معروفة، مش أي رابط
  // HTTPS، عشان السيرفر ما يتحوّلش لأداة تبعت طلبات لأي عنوان يختاره المستخدم.
  registerNotificationRoutes(app, {
    requireAuth,
    store,
    vapidKeys,
    writeLimiter
  });

  // ---------------------------------------------------------------------------
  // لوحة التحكم
  // ---------------------------------------------------------------------------
  registerAdminOrderRoutes(app, {
    adminBulkLimiter,
    adminWriteLimiter,
    armNotificationTimer,
    asText,
    audit,
    notifyCustomer,
    requireAdmin,
    store
  });

  // ---------------------------------------------------------------------------
  // رفع صور المنتجات من الجهاز
  // ---------------------------------------------------------------------------
  const {
    cleanupOldProductImage
  } = registerUploadRoutes(app, {
    warmImageVariants,
    PROOFS_DIR,
    QUARANTINE_DIR,
    UPLOADS_DIR,
    audit,
    crypto,
    fs,
    fsp,
    imageOptimize,
    multer,
    path,
    requireAdmin,
    requireAuth,
    store,
    writeLimiter
  });
  registerAdminCatalogRoutes(app, {
    adminWriteLimiter,
    audit,
    cleanupOldProductImage,
    requireAdmin,
    store,
    validate,
    writeLimiter
  });
  registerAdminUsersRoutes(app, {
    BACKUP_UPLOAD_URL,
    adminBulkLimiter,
    adminWriteLimiter,
    asText,
    audit,
    requireAdmin,
    sendPushToUser,
    setSessionCookie,
    store,
    uploadBackupOffsite,
    validate,
    writeLimiter
  });

  // ---------------------------------------------------------------------------
  // الفاتورة
  // ---------------------------------------------------------------------------
  registerInvoiceRoutes(app, {
    escapeHtml,
    requireAuth,
    store
  });

  // ---------------------------------------------------------------------------
  // معالجة الأخطاء و 404
  // ---------------------------------------------------------------------------
  // (دفع أونلاين) راوتات Paymob — بتتسجّل بعد ما الـ store والوسائط جاهزين.
  // (إصلاح) حد منفصل وواسع للـ webhook: محمي بالـ HMAC أصلًا، والمهم إننا
  // ما نرفضش إشعار دفع حقيقي لمجرد إن نفس الـ IP عمل عمليات كتابة تانية.
  const paymobWebhookLimiter = createRateLimiter({
    scope: 'paymob-webhook',
    persist: false,
    windowMs: 60 * 1000,
    max: 300,
    message: 'طلبات كثيرة جدًا.'
  });
  registerPaymobRoutes(app, { store, csrfProtection, requireAuth, rateLimit: writeLimiter, webhookRateLimit: paymobWebhookLimiter });

  const { PAYMOB_STALE_MS, sweepStalePaymobOrdersOnce } = await startPaymobSweeper({ everyInstances, store });

  // ---------------------------------------------------------------------------
  // تقارير مصالحة المخزون + صحة مزامنة Paymob
  // ---------------------------------------------------------------------------
  registerAdminReportRoutes(app, {
    adminBulkLimiter,
    adminWriteLimiter,
    audit,
    paymobHoldMinutes: Math.round(PAYMOB_STALE_MS / 60000),
    paymobSweepNow: () => sweepStalePaymobOrdersOnce(),
    requireAdmin,
    store
  });

  app.use('/api', (_req, res) => res.status(404).json({
    error: 'المسار غير موجود'
  }));
  // (إصلاح) أي ملف ناقص بامتداد (JS/CSS/صورة) بيرجّع 404 حقيقي بنوعه الصحيح
  // بدل HTML — كفاية أخطاء غامضة و soft-404 عند جوجل. الصفحات (بدون امتداد)
  // بس هي اللي بتاخد صفحة 404 بشكل الموقع.
  // (ترقية Express 5) نمط '*' المجرّد مابقاش مدعوم في path-to-regexp v8؛
  // الاسم بقى إجباري للـ splat، فبقى '/*splat' بنفس المعنى بالظبط.
  app.get('/*splat', (req, res) => {
    const ext = path.extname(req.path).toLowerCase();
    if (ext && ext !== '.html') {
      res.status(404).type('text/plain; charset=utf-8').send('404 Not Found');
      return;
    }
    res.status(404);
    res.setHeader('X-Robots-Tag', 'noindex');
    // (إصلاح) صفحة 404 مخصّصة بدل تقديم الصفحة الرئيسية (soft-404 عند جوجل).
    const notFoundPage = path.join(PUBLIC_DIR, '404.html');
    sendHtml(res, fs.existsSync(notFoundPage) ? notFoundPage : path.join(PUBLIC_DIR, 'index.html'));
  });
  app.use((error, _req, res, _next) => {
    console.error('[server error]', error);
    if (res.headersSent) return;
    res.status(500).json({
      error: 'حدث خطأ غير متوقع في الخادم'
    });
  });

  // ---------------------------------------------------------------------------
  // التشغيل والإغلاق الآمن
  // ---------------------------------------------------------------------------
  const server = app.listen(PORT, HOST, () => {
    console.log(`\n🚗 متجر يوسف يعمل على http://localhost:${PORT}`);
    console.log(`   لوحة التحكم: http://localhost:${PORT}/admin-login.html`);
  });
  async function shutdown(signal) {
    console.log(`\n[${signal}] جاري الإغلاق الآمن وحفظ البيانات...`);
    try {
      rateLimitFactory.flush();
    } catch (_) {/* لا شيء */}
    await store.flush();
    await store.backup();
    try {
      instanceLock.release();
    } catch (_) {/* لا شيء */}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  }
  ['SIGINT', 'SIGTERM'].forEach(signal => process.on(signal, () => shutdown(signal)));
  process.on('uncaughtException', async error => {
    console.error('[uncaught]', error);
    await store.flush();
  });
  process.on('unhandledRejection', error => console.error('[unhandled]', error));
}
main().catch((err) => {
  console.error('[boot] فشل الإقلاع:', err);
  process.exit(1);
});

module.exports = app;
