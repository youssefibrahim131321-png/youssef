/**
 * ---------------------------------------------------------------------------
 * فحص إعدادات البيئة عند الإقلاع (Startup Config Check)
 * ---------------------------------------------------------------------------
 * بيطبع تحذيرات واضحة بدل ما المشاكل تفضل صامتة:
 *  - NODE_ENV مش production في النشر → الكوكيز والحماية هتشتغل غلط.
 *  - TRUST_PROXY مش متحدد خلف بروكسي → rate limiting هيتحايل عليه.
 *  - مفيش مزوّد بريد → رسائل التفعيل/الاستعادة مش هتوصل.
 *  - مجلد البيانات مش على Persistent Volume → المتجر ممكن يتمسح مع كل نشر.
 */
const fs = require('fs');
const path = require('path');

function onRailway() {
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
}
function onKnownProxyHost() {
  return onRailway() || Boolean(process.env.RENDER || process.env.FLY_APP_NAME || process.env.DYNO);
}

/** true لو مجلد البيانات جوه مسار Volume (مش جوه مجلد الكود اللي بيتبني من جديد). */
function looksPersistent(dataDir) {
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (mount && path.resolve(dataDir).startsWith(path.resolve(mount))) return true;
  return path.resolve(dataDir).startsWith('/data');
}

function checkConfig({ dataDir, mailProvider }) {
  const problems = [];
  // (إصلاح) فقدان البيانات بقى مانع للإقلاع مش تحذير: لو إحنا على Railway
  // ومجلد البيانات/الصور مش على Volume دائم، أول نشر بيمسح المتجر كله. بنوقف
  // التشغيل فورًا إلا لو المستخدم أكّد صراحةً بـ ALLOW_EPHEMERAL_DATA=1.
  const fatal = [];
  const prod = process.env.NODE_ENV === 'production';

  if (onKnownProxyHost() && !prod) {
    problems.push('NODE_ENV مش متحدد بـ production — الكوكيز الآمنة (Secure/HttpOnly) وحماية الجلسات هتشتغل بشكل أضعف. ظبّط NODE_ENV=production.');
  }
  if (onKnownProxyHost() && process.env.TRUST_PROXY !== '1') {
    problems.push('TRUST_PROXY مش متحدد بـ 1 مع إنك خلف بروكسي — تم تفعيله تلقائيًا، لكن الأفضل تحدده صراحةً في متغيرات البيئة.');
  }
  if (mailProvider === 'console' && prod) {
    // من غير مزوّد بريد الموقع بيشتغل بوضع guard (فحص البريد + دخول جوجل)
    // فالتسجيل شغال عادي، بس استعادة كلمة المرور محتاجة بريد فعلًا.
    problems.push('مفيش مزوّد بريد — التسجيل شغال بوضع الحماية (فحص البريد + الدخول بجوجل) من غير أكواد، لكن "نسيت كلمة المرور" مش هيشتغل. لو عايزه، ظبّط RESEND_API_KEY أو SMTP_URL.');
  }
  if (!process.env.GOOGLE_CLIENT_ID && prod) {
    problems.push('GOOGLE_CLIENT_ID مش متحدد — زرار "الدخول بجوجل" مخفي. تفعيله بيدي أقوى إثبات لملكية البريد من غير أي رسائل.');
  }
  // (إصلاح) التحذير كان مربوط بـ Railway بس؛ Docker/VM عادية بتضيّع البيانات
  // بنفس الطريقة. في أي production غير Railway بنطلع تحذير واضح بدل صمت تام.
  if (prod && !onRailway() && !looksPersistent(dataDir)) {
    problems.push(`مجلد البيانات (${dataDir}) مش على مسار تخزين دائم واضح — لو الاستضافة بتعيد بناء الحاوية، المتجر هيتمسح. ظبّط DATA_DIR على Volume دائم (مثلًا /data).`);
  }
  if (onRailway() && !looksPersistent(dataDir)) {
    fatal.push(`مجلد البيانات (${dataDir}) مش على Persistent Volume — أي إعادة نشر هتمسح المتجر كله. اعمل Volume في Railway على /data وظبّط DATA_DIR=/data.`);
  }
  if (onRailway() && !process.env.UPLOADS_DIR && !looksPersistent(dataDir)) {
    fatal.push('UPLOADS_DIR مش متظبط — صور المنتجات بتتخزن جوه مجلد الكود وبتضيع مع كل نشر. ظبّط UPLOADS_DIR=/data/uploads/products بعد إنشاء الـ Volume.');
  }
  // (إصلاح أمني) من غير SITE_URL/PUBLIC_BASE_URL كل الروابط المطلقة (استعادة
  // كلمة المرور، sitemap، canonical) كانت بتتبني من هيدر Host اللي المهاجم
  // بيتحكم فيه. في الإنتاج بقى إجباري.
  if (prod && !process.env.SITE_URL && !process.env.PUBLIC_BASE_URL) {
    fatal.push('SITE_URL (أو PUBLIC_BASE_URL) مش متحدد — الروابط المطلقة هتتبنى من هيدر Host غير الموثوق، وده بيسمح بتسميم رابط استعادة كلمة المرور وروابط SEO. ظبّط SITE_URL=https://your-domain.com.');
  }
  if (prod && !process.env.SESSION_SECRET) {
    problems.push('SESSION_SECRET مش متحدد — بيتولّد تلقائيًا ويتخزن في قاعدة البيانات، لكن الأفضل تحدده كمتغير بيئة ثابت.');
  }
  if (prod && !process.env.TOTP_ENCRYPTION_KEY && !process.env.DATA_ENCRYPTION_KEY) {
    problems.push('TOTP_ENCRYPTION_KEY مش متحدد — أسرار التحقق بخطوتين هتتشفّر بمفتاح احتياطي مشتق من SESSION_SECRET بدل مفتاح مستقل تمامًا. مستحسن تحدده كمتغير منفصل لو الـ 2FA مفعّل فعليًا على حسابات حقيقية.');
  }

  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) { /* بيتعامل معاه لاحقًا */ }

  if (fatal.length) {
    const allowed = process.env.ALLOW_EPHEMERAL_DATA === '1';
    console.error('\n\x1b[31m🔴 خطر فقدان بيانات — تم إيقاف التشغيل:');
    fatal.forEach((p, i) => console.error(`   ${i + 1}) ${p}`));
    console.error('   راجع DEPLOY-RAILWAY.md. لو ده تشغيل تجريبي ومش مهتم بالبيانات، ظبّط ALLOW_EPHEMERAL_DATA=1.\x1b[0m\n');
    if (!allowed) process.exit(1);
    console.warn('\x1b[33m⚠️  تم التشغيل بوضع بيانات مؤقتة (ALLOW_EPHEMERAL_DATA=1) — البيانات هتضيع مع أي نشر.\x1b[0m');
    problems.push(...fatal);
  }

  if (problems.length) {
    console.warn('\n\x1b[33m⚠️  فحص إعدادات النشر — في حاجات محتاجة انتباهك:');
    problems.forEach((p, i) => console.warn(`   ${i + 1}) ${p}`));
    console.warn('   راجع ملف DEPLOY-RAILWAY.md لخطوات الضبط الكاملة.\x1b[0m\n');
  } else {
    console.log('\x1b[32m✅ فحص إعدادات النشر: كل حاجة متظبطة.\x1b[0m');
  }
  return problems;
}

module.exports = { checkConfig, onKnownProxyHost, onRailway, looksPersistent };
