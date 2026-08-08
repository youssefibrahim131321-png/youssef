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
const multer = require('multer');
const webpush = require('web-push');
const { createStore } = require('./store');
const { sendMail, shouldExposeLink, activeProvider } = require('./mailer');
const { checkConfig, onKnownProxyHost } = require('./config-check');
const emailGuard = require('./email-guard');
const googleAuth = require('./google-auth');
const totpLib = require('./lib/totp');
const { queryProducts } = require('./lib/product-query');
const { productPath, parseProductPath } = require('./lib/slug');
const imageOptimize = require('./lib/image-optimize');
const storageGuard = require('./lib/storage-guard');
const { createRateLimiterFactory } = require('./lib/rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
// مسارات التخزين: قابلة للتوجيه لمجلد Persistent Volume عبر متغيرات البيئة
// (DATA_DIR / UPLOADS_DIR). على Railway اعمل Volume على /data وظبّط
// DATA_DIR=/data و UPLOADS_DIR=/data/uploads/products، وإلا أي إعادة نشر
// هتمسح قاعدة البيانات والصور المرفوعة.
// (إصلاح) لو في Volume متركّب على Railway، بنستخدمه تلقائيًا كمجلد بيانات
// حتى لو نسيت تظبّط DATA_DIR — ده كان أشهر سبب لتوقف التشغيل وضياع البيانات.
const VOLUME_MOUNT = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const RESOLVED_DATA_DIR = process.env.DATA_DIR || VOLUME_MOUNT || path.join(__dirname, 'data');
const DATA_DIR = path.resolve(RESOLVED_DATA_DIR);
if (!process.env.DATA_DIR) process.env.DATA_DIR = DATA_DIR;
// (إصلاح) لو ظبّطت DATA_DIR على Volume دائم، الصور المرفوعة بتتبعه تلقائيًا
// من غير ما تفتكر تظبّط UPLOADS_DIR كمان — أشهر سبب لضياع صور المنتجات.
const USING_EXTERNAL_DATA_DIR = DATA_DIR !== path.resolve(path.join(__dirname, 'data'));
const UPLOADS_DIR = path.resolve(
  process.env.UPLOADS_DIR
  || (USING_EXTERNAL_DATA_DIR ? path.join(DATA_DIR, 'uploads', 'products') : path.join(PUBLIC_DIR, 'uploads', 'products'))
);

// صور إثبات التحويل (فودافون كاش / انستا باي). بتتخزن برّه مجلد public عشان
// ما تكونش متاحة لأي حد بمجرد معرفة اسم الملف — بتتقدّم من مسار محمي بس.
const PROOFS_DIR = path.resolve(process.env.PROOFS_DIR || path.join(DATA_DIR, 'payment-proofs'));
const DB_PATH = path.join(DATA_DIR, 'store.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(PROOFS_DIR, { recursive: true });
// (أمان) مجلد حجر صحي مؤقت خارج أي مسار static: أي ملف مرفوع بيتكتب هنا
// الأول وبيتفحص من محتواه الحقيقي (magic bytes) قبل ما يتنقل لمجلد
// الصور/الإيصالات النهائي، عشان ملف مرفوض ما يتقدّمش أبدًا عبر أي static route.
const QUARANTINE_DIR = path.resolve(process.env.QUARANTINE_DIR || path.join(DATA_DIR, 'incoming-uploads'));
fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
checkConfig({ dataDir: DATA_DIR, mailProvider: activeProvider() });
// (إصلاح) تحذير صريح: من غير مزوّد بريد، رسائل التفعيل واستعادة كلمة المرور
// مش بتوصل خالص — وده كان بيبان كأنه «الرسالة اتبعتت» وهي مش موجودة.
if (activeProvider() === 'console') {
  console.warn('\x1b[31m⚠️  مفيش مزوّد بريد متظبط (RESEND_API_KEY أو SMTP_URL أو MAIL_WEBHOOK_URL). رسائل التفعيل واستعادة كلمة المرور مش هتوصل لحد.\x1b[0m');
  // (إصلاح) في الإنتاج ده مش تحذير — ده عطل صامت: العميل اللي ينسى كلمة
  // مروره بيتقفل برّه المتجر للأبد. بنوقف التشغيل إلا لو وافقت صراحةً.
  // (إصلاح) مش سبب لإيقاف التشغيل بعد كده: الموقع بيشتغل بوضع الحماية،
  // ولو عايز تمنع التشغيل من غير بريد ظبّط REQUIRE_MAIL_PROVIDER=1.
  if (process.env.NODE_ENV === 'production' && process.env.REQUIRE_MAIL_PROVIDER === '1') {
    console.error('\x1b[31m⛔ التشغيل اتوقف: REQUIRE_MAIL_PROVIDER=1 بس مفيش مزوّد بريد متظبط.\x1b[0m');
    process.exit(1);
  }
}
// (إصلاح) sharp اختيارية: لو مش متثبتة الصور بترفع من غير ضغط من غير أي إشعار.
if (!imageOptimize.isAvailable()) {
  console.warn('\x1b[33mℹ️  مكتبة sharp مش متاحة: الصور هتترفع من غير ضغط على السيرفر (الضغط في المتصفح بس).\x1b[0m');
  // (إصلاح) في الإنتاج، رفع صور بحجمها الأصلي = استهلاك مساحة وباندويدث
  // وبطء في المتجر. REQUIRE_IMAGE_OPTIMIZE=1 بيمنع التشغيل من غير sharp.
  if (process.env.REQUIRE_IMAGE_OPTIMIZE === '1') {
    console.error('\x1b[31m⛔ التشغيل اتوقف: REQUIRE_IMAGE_OPTIMIZE=1 بس sharp مش متثبتة (npm i sharp).\x1b[0m');
    process.exit(1);
  }
}
// (إصلاح) تحذير واضح: لو الصور والداتا جوه مجلد المشروع على منصة سحابية، أي
// إعادة نشر هتمسحها. لازم Volume + DATA_DIR/UPLOADS_DIR.
// (إصلاح) النسخة الاحتياطية الافتراضية بقت جنب مجلد البيانات مش جوّاه، عشان
// تفضل نسخة حقيقية لو ملف قاعدة البيانات نفسه اتلخبط أو اتمسح.
// (إصلاح) على Volume دائم، النسخ الاحتياطي لازم يفضل جوه الـ Volume نفسه
// (مثلاً /data/backups) مش برّه (/store-backups) لأن برّه بيتمسح مع كل نشر.
const BACKUP_DIR = path.resolve(
  process.env.BACKUP_DIR
  || (USING_EXTERNAL_DATA_DIR ? path.join(DATA_DIR, 'backups') : path.join(DATA_DIR, '..', 'store-backups'))
);
// (إصلاح) store.js بيقرأ BACKUP_DIR من البيئة كمان. من غير السطر ده كان بيتعمل
// مجلدين نسخ احتياطي مختلفين (واحد جوّه مجلد البيانات) والنسخة تبقى على نفس الديسك.
process.env.BACKUP_DIR = BACKUP_DIR;

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const storageStatus = storageGuard.checkStorage({
  projectRoot: __dirname, dataDir: DATA_DIR, uploadsDir: UPLOADS_DIR, backupDir: BACKUP_DIR
});
if (storageStatus.fatal) {
  // على منصة سحابية في وضع الإنتاج، التشغيل بتخزين مؤقت = فقدان مؤكد للبيانات
  // مع أول إعادة نشر. بنقف هنا بدل ما نكتشف ده بعد ضياع الطلبات.
  process.exit(1);
}
// (6) SQLite ملف واحد = instance واحد. القفل ده بيمنع تشغيل نسختين على نفس
// مجلد البيانات (اللي كان هيكسر الحدود والإشعارات والبيانات).
const instanceLock = storageGuard.acquireInstanceLock(DATA_DIR);
if (!instanceLock.ok && process.env.ALLOW_MULTI_INSTANCE !== '1') process.exit(1);
const store = createStore(DB_PATH);

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

// ---------------------------------------------------------------------------
// حساب الأدمن: يُقرأ من متغيرات البيئة إن وُجدت. لو أول تشغيل للموقع (مفيش
// أدمن لسه) ومفيش ADMIN_PASSWORD متحدد، نولّد كلمة مرور قوية عشوائية بدل
// admin123 المعروفة للجميع، ونطبعها في السجل مرة واحدة بس. مهم: ده بيحصل بس
// لو مفيش أدمن أصلًا، عشان إعادة تشغيل السيرفر (على Railway مثلًا) ما تعملش
// إعادة تعيين لكلمة مرور غيّرها صاحب المتجر بنفسه من قبل.
const adminAlreadyExists = store.hasAdmin();
// (إصلاح) ADMIN_PASSWORD_RESET=1 = ولّد كلمة مرور جديدة للأدمن دلوقتي حتى لو
// الحساب موجود. ده طوق النجاة لما كلمة السر تضيع ومفيش بريد شغّال: ظبّط
// المتغير، أعد التشغيل، هتلاقي كلمة المرور في اللوج وفي ملف داخل مجلد البيانات،
// ادخل بيها وغيّرها من لوحة التحكم، وبعدين شيل المتغير.
const FORCE_ADMIN_RESET = String(process.env.ADMIN_PASSWORD_RESET || '') === '1';
let generatedAdminPassword = null;
let effectiveAdminPassword = process.env.ADMIN_PASSWORD;
if (FORCE_ADMIN_RESET && !effectiveAdminPassword) {
  generatedAdminPassword = crypto.randomBytes(9).toString('base64url');
  effectiveAdminPassword = generatedAdminPassword;
}
if (!adminAlreadyExists && !effectiveAdminPassword) {
  generatedAdminPassword = crypto.randomBytes(9).toString('base64url');
  effectiveAdminPassword = generatedAdminPassword;
}
const adminInfo = store.ensureAdmin({
  email: process.env.ADMIN_EMAIL,
  password: effectiveAdminPassword
});
const ADMIN_PASSWORD_FILE = path.join(DATA_DIR, 'INITIAL-ADMIN-PASSWORD.txt');
const ADMIN_RESET_LINK_FILE = path.join(DATA_DIR, 'LAST-ADMIN-RESET-LINK.txt');
if (generatedAdminPassword) {
  // (إصلاح) كلمة المرور مكانتش بتتطبع غير مرة واحدة في اللوج. دلوقتي بتتكتب
  // كمان في ملف محمي جوه مجلد البيانات، وبيتمسح تلقائيًا أول ما الأدمن يسجّل
  // دخول بنجاح. ولو ضاعت خالص: npm run admin:reset-password
  try {
    fs.writeFileSync(ADMIN_PASSWORD_FILE, `${adminInfo.email}\n${generatedAdminPassword}\n`, { mode: 0o600 });
    console.warn(`\x1b[33m📄 اتحفظت كمان في: ${ADMIN_PASSWORD_FILE} (هتتمسح لما تغيّر كلمة المرور من لوحة التحكم)\x1b[0m`);
  } catch (error) {
    console.warn('[admin] تعذر حفظ ملف كلمة المرور الأولية:', error.message);
  }
  console.warn('\n\x1b[33m🔑 أول تشغيل: تم إنشاء حساب أدمن بكلمة مرور عشوائية قوية (مش admin123):');
  console.warn(`    البريد: ${adminInfo.email}`);
  console.warn(`    كلمة المرور: ${generatedAdminPassword}`);
  console.warn('    سجّل دخول بيها وغيّرها من لوحة التحكم (حسابي ← تغيير كلمة المرور).');
  console.warn('    (أو حدد ADMIN_EMAIL/ADMIN_PASSWORD في متغيرات البيئة عشان تتحكم فيها بنفسك)\x1b[0m\n');
} else if (fs.existsSync(ADMIN_PASSWORD_FILE)) {
  // (إصلاح) أهم مشكلة كانت: كلمة المرور بتتطبع مرة واحدة بس وبتضيع من اللوج،
  // وبتتمسح أول تسجيل دخول قبل ما صاحب المتجر يغيّرها. دلوقتي طول ما الملف
  // موجود (يعني لسه ما اتغيّرتش من اللوحة) بتتطبع في كل إعادة تشغيل.
  try {
    const [savedEmail, savedPassword] = fs.readFileSync(ADMIN_PASSWORD_FILE, 'utf8').split('\n');
    console.warn('\n\x1b[33m🔑 بيانات دخول الأدمن (لسه ما اتغيّرتش):');
    console.warn(`    البريد: ${savedEmail}`);
    console.warn(`    كلمة المرور: ${savedPassword}`);
    console.warn('    غيّرها من لوحة التحكم وهتتمسح تلقائيًا من السيرفر.\x1b[0m\n');
  } catch (_) { /* الملف اتقرى غلط — مش مشكلة */ }
} else if (adminInfo.usingDefaultPassword) {
  console.warn('\n\x1b[33m⚠️  تحذير أمني: حساب الأدمن يستخدم كلمة المرور الافتراضية admin123');
  console.warn('    غيّرها فورًا من لوحة التحكم، أو شغّل الخادم بـ:');
  console.warn('    ADMIN_EMAIL=you@mail.com ADMIN_PASSWORD=كلمة-قوية npm start\x1b[0m\n');
}

// (5) المفتاح الجذري مش بيوقّع أي حاجة بشكل مباشر. بنشتق منه مفتاحين منفصلين
// تمامًا (HKDF) — واحد لتوقيع الجلسة وواحد لتوكن الـ CSRF. كده تسريب أو كسر
// أحدهما لا يسمح بتزوير التاني، ومفيش أي احتمال لاستخدام توكن CSRF كجلسة
// صالحة أو العكس (confused deputy).
const ROOT_SECRET = process.env.SESSION_SECRET || store.getOrCreateSessionSecret();
const deriveKey = (label) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ROOT_SECRET), Buffer.alloc(0), Buffer.from(label), 32));
const SESSION_KEY = deriveKey('yousef-store/session-v1');
const CSRF_KEY = deriveKey('yousef-store/csrf-v1');
const SESSION_COOKIE = 'yousef_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// جلسة الأدمن أقصر بكتير من جلسة العميل: لوحة التحكم مفتاح المتجر كله، فمش
// منطقي تفضل مفتوحة 30 يوم على جهاز ممكن يضيع أو يتسرق.
const ADMIN_SESSION_MAX_AGE_MS = Number(process.env.ADMIN_SESSION_HOURS || 12) * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;        // ساعة واحدة لاستعادة كلمة المرور
const VERIFY_CODE_TTL_MS = 15 * 60 * 1000;        // 15 دقيقة لكود التفعيل الرقمي
// (2) لو مفعّل، العميل لازم يفعّل بريده قبل ما يقدر يعمل طلب.
// (تعديل) التحقق بكود اتلغى تمامًا للعميل والأدمن. الحساب بيتفعّل فور التسجيل
// بعد فحص البريد (شكل + بريد مؤقت + سجلات MX)، ومفيش أي كود أو رابط تفعيل.
// (إصلاح جوهري) الـ guard بيفلتر البريد الوهمي/المؤقت بس — هو *مش* إثبات
// ملكية. إثبات الملكية الحقيقي = كود 6 أرقام بيوصل على نفس البريد، أو دخول
// بجوجل. ومفيش أي حساب بيتعلّم email_verified=1 من غير واحد من الاتنين دول.
const EMAIL_VERIFICATION_AVAILABLE = activeProvider() !== 'console' || shouldExposeLink();
// (إصلاح 9) الشرط بقى قرار صريح منك، مش نتيجة جانبية لوجود مزوّد بريد:
//  - REQUIRE_EMAIL_VERIFICATION=1 (الافتراضي لما يبقى فيه مزوّد): إلزامي.
//  - من غير مزوّد: الطلبات مش هتتقفل، لكن الحساب بيتعلّم «غير مفعّل» ويظهر
//    للأدمن كطلب محتاج تأكيد يدوي — بدل ما نفتح الباب لأي بريد وهمي بصمت.
//  - لو المزوّد نفسه وقع: بندخل «وضع متدهور» مؤقت (mailerDegraded) فالعملاء
//    ما يتقفلش عليهم المتجر بسبب عطل عندنا — نقطة الفشل الواحدة اتشالت.
const REQUIRE_EMAIL_VERIFICATION = EMAIL_VERIFICATION_AVAILABLE && process.env.REQUIRE_EMAIL_VERIFICATION !== '0';
const MAIL_FAILURE_THRESHOLD = Number(process.env.MAIL_FAILURE_THRESHOLD || 3);
const MAIL_DEGRADED_WINDOW_MS = Number(process.env.MAIL_DEGRADED_MINUTES || 30) * 60 * 1000;
const mailHealth = { failures: 0, degradedUntil: 0 };
function noteMailFailure() {
  mailHealth.failures += 1;
  if (mailHealth.failures >= MAIL_FAILURE_THRESHOLD) {
    mailHealth.degradedUntil = Date.now() + MAIL_DEGRADED_WINDOW_MS;
    console.error('\x1b[31m⚠️  مزوّد البريد واقع — تم تعليق إلزامية تفعيل البريد مؤقتًا عشان العملاء يقدروا يطلبوا. الطلبات دي هتتعلّم «بريد غير مؤكد» للأدمن.\x1b[0m');
  }
}
function noteMailSuccess() { mailHealth.failures = 0; mailHealth.degradedUntil = 0; }
const mailerDegraded = () => Date.now() < mailHealth.degradedUntil;
let lastDegradedBypassWarnAt = 0;
function emailVerificationEnforced() {
  if (!REQUIRE_EMAIL_VERIFICATION) return false;
  if (mailerDegraded()) {
    // (أمان) fail-open مقصود وقت عطل مزوّد البريد، بس لازم يبان بوضوح في
    // اللوج (مرة كل دقيقة بحد أقصى) إن حماية "تفعيل البريد إلزامي" اتخطّاها.
    const now = Date.now();
    if (now - lastDegradedBypassWarnAt > 60 * 1000) {
      lastDegradedBypassWarnAt = now;
      console.warn('\x1b[33m⚠️ [email-guard] وضع متدهور: تم تجاوز إلزامية تفعيل البريد مؤقتًا لأن مزوّد البريد واقع (fail-open).\x1b[0m');
    }
    return false;
  }
  return true;
}
const EMAIL_VERIFY_MODE = EMAIL_VERIFICATION_AVAILABLE ? 'code' : 'off';
if (!EMAIL_VERIFICATION_AVAILABLE) {
  console.warn('\x1b[33m⚠️  مفيش مزوّد بريد مظبوط، فمفيش إثبات ملكية للبريد: الحسابات هتفضل «غير مفعّلة» (مش هنعلّمها مفعّلة كدب). ظبّط RESEND_API_KEY أو SMTP_URL أو GOOGLE_CLIENT_ID.\x1b[0m');
}
// (إصلاح 4) التحقق بخطوتين (TOTP) رجع يشتغل: اختياري للعميل، وموصى به بشدة
// للأدمن (تقدر تفرضه بـ REQUIRE_ADMIN_2FA=1).
const TWO_FACTOR_DISABLED = false;
const REQUIRE_ADMIN_2FA = process.env.REQUIRE_ADMIN_2FA === '1';
const TOTP_ISSUER = process.env.TOTP_ISSUER || 'Yousef Store';

// ---------------------------------------------------------------------------
// Web Push (VAPID)
// ---------------------------------------------------------------------------
const vapidKeys = store.getOrCreateVapidKeys(() => webpush.generateVAPIDKeys());
webpush.setVapidDetails(
  process.env.VAPID_CONTACT || 'mailto:admin@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

function sendPushToUser(userId, payload) {
  store.getPushSubscriptionsByUser(userId).forEach((sub) => {
    webpush.sendNotification(sub, JSON.stringify(payload)).catch((err) => {
      if (err.statusCode === 410 || err.statusCode === 404) {
        store.removePushSubscription(sub.endpoint);
        return;
      }
      // (إصلاح) مكناش بنسجّل أي فشل، فكان مستحيل تعرف إن الإشعارات واقعة.
      console.error('[web-push] فشل إرسال إشعار', {
        userId,
        status: err.statusCode || null,
        message: String(err.message || '').slice(0, 200)
      });
    });
  });
}

function notifyCustomer(order, title, body) {
  if (!order || !order.user_id) return;
  store.addNotification({ userId: order.user_id, orderId: order.id, title, body });
  sendPushToUser(order.user_id, { title, body, orderId: order.id, url: '/account.html' });
}

// ---------------------------------------------------------------------------
// محرك الإشعارات المجدولة
// ---------------------------------------------------------------------------
const scheduledTimers = new Map();
const MAX_TIMER_MS = 2 ** 31 - 1;

function armNotificationTimer(order) {
  if (scheduledTimers.has(order.id)) clearTimeout(scheduledTimers.get(order.id));
  const delay = Math.min(MAX_TIMER_MS, Math.max(0, new Date(order.notify_at).getTime() - Date.now()));
  const timer = setTimeout(() => fireScheduledNotification(order.id), delay);
  if (typeof timer.unref === 'function') timer.unref();
  scheduledTimers.set(order.id, timer);
}

function fireScheduledNotification(orderId) {
  const order = store.getOrderById(orderId);
  scheduledTimers.delete(orderId);
  if (!order || order.notified) return;
  // (10) نحجز الإشعار ذرّيًا (مرة واحدة بس) ثم نرسل فعليًا. لو الإرسال فشل
  // نفك الحجز عشان المكنسة تعيد المحاولة، بدل ما نعتبره «مُرسَل» قبل الإرسال.
  if (!store.claimOrderNotification(orderId)) return;
  try {
    notifyCustomer(order, 'طلبك في الطريق 🚚', order.notify_message || `طلبك رقم #${order.id} جاهز وفي طريقه إليك الآن!`);
  } catch (error) {
    console.error('[scheduled notification]', error);
    store.releaseOrderNotification(orderId);
  }
}

store.getPendingScheduledNotifications().forEach(armNotificationTimer);

// مكنسة كل دقيقة: تلتقط أي إشعار فات موعده (بعد انقطاع/إعادة تشغيل).
setInterval(() => {
  store.getPendingScheduledNotifications().forEach((order) => {
    if (new Date(order.notify_at).getTime() <= Date.now()) fireScheduledNotification(order.id);
    else if (!scheduledTimers.has(order.id)) armNotificationTimer(order);
  });
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// (إصلاح) نسخة احتياطية خارج الديسك
// ---------------------------------------------------------------------------
// نسخة احتياطية على نفس السيرفر مش نسخة احتياطية: لو الـ Volume ضاع، ضاعت
// النسخة معاه. لو ظبّطت BACKUP_UPLOAD_URL (أي endpoint بيقبل PUT/POST لملف
// ثنائي — S3 presigned، R2، Bunny، أو سيرفر بتاعك) بنرفع آخر نسخة هناك بعد
// كل عملية backup. BACKUP_UPLOAD_TOKEN اختياري (بيتبعت كـ Authorization).
const BACKUP_UPLOAD_URL = String(process.env.BACKUP_UPLOAD_URL || '').trim();
const BACKUP_UPLOAD_METHOD = (process.env.BACKUP_UPLOAD_METHOD || 'PUT').toUpperCase() === 'POST' ? 'POST' : 'PUT';
if (!BACKUP_UPLOAD_URL && process.env.NODE_ENV === 'production') {
  console.warn('\x1b[33m⚠️  مفيش نسخ احتياطي خارجي (BACKUP_UPLOAD_URL). النسخ كلها على نفس الديسك — أي فقدان للـ Volume = فقدان كامل للطلبات.\x1b[0m');
}

function latestBackupFile() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('store-') && f.endsWith('.db'))
      .sort();
    return files.length ? path.join(BACKUP_DIR, files[files.length - 1]) : null;
  } catch (_) { return null; }
}

async function uploadBackupOffsite() {
  if (!BACKUP_UPLOAD_URL) return { ok: false, skipped: true };
  const file = latestBackupFile();
  if (!file) return { ok: false, error: 'مفيش نسخة احتياطية للرفع' };
  try {
    const body = fs.readFileSync(file);
    const headers = { 'Content-Type': 'application/octet-stream', 'X-Backup-Filename': path.basename(file) };
    if (process.env.BACKUP_UPLOAD_TOKEN) headers.Authorization = `Bearer ${process.env.BACKUP_UPLOAD_TOKEN}`;
    const url = BACKUP_UPLOAD_URL.endsWith('/') ? BACKUP_UPLOAD_URL + path.basename(file) : BACKUP_UPLOAD_URL;
    const res = await fetch(url, { method: BACKUP_UPLOAD_METHOD, headers, body });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`[backup] اترفعت نسخة خارجية: ${path.basename(file)}`);
    return { ok: true, file: path.basename(file) };
  } catch (error) {
    console.error('[backup] فشل الرفع الخارجي:', error.message);
    return { ok: false, error: error.message };
  }
}

// نسخة احتياطية تلقائية كل 6 ساعات + رفعها خارج السيرفر لو متظبط
setInterval(() => {
  if (store.backup()) uploadBackupOffsite();
}, 6 * 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// (إصلاح) تنبيه الطلبات المعلّقة (SLA)
// ---------------------------------------------------------------------------
// الدفع اليدوي معناه إن كل طلب مستني مراجعة بشرية. لو الأدمن مش فاتح اللوحة،
// الطلب كان بيفضل معلّق بلا نهاية والعميل مستني. دلوقتي بنبّه الأدمن جوّه
// المتجر + push على أي طلب عدّى عليه ORDER_SLA_HOURS وهو لسه pending.
const ORDER_SLA_MS = Math.max(1, Number(process.env.ORDER_SLA_HOURS || 3)) * 60 * 60 * 1000;
const slaAlerted = new Set();
function alertStalePendingOrders() {
  try {
    const stale = store.getStalePendingOrders(ORDER_SLA_MS);
    if (!stale.length) return 0;
    const admins = store.getAdminUsers();
    if (!admins.length) return 0;
    let sent = 0;
    for (const order of stale) {
      if (slaAlerted.has(order.id)) continue;
      slaAlerted.add(order.id);
      const title = 'طلب معلّق محتاج مراجعة ⏰';
      const body = `الطلب #${order.id} (${order.customer_name || 'عميل'}) لسه معلّق من أكتر من ${Math.round(ORDER_SLA_MS / 3600000)} ساعة.`;
      for (const admin of admins) {
        store.addNotification({ userId: admin.id, orderId: order.id, title, body });
        sendPushToUser(admin.id, { title, body, orderId: order.id, url: '/admin.html' });
      }
      sent += 1;
    }
    // ما نخليش الـ Set يكبر للأبد: بنشيل الطلبات اللي اتراجعت خلاص.
    if (slaAlerted.size > 5000) slaAlerted.clear();
    return sent;
  } catch (error) {
    console.error('[order-sla]', error.message);
    return 0;
  }
}
setTimeout(alertStalePendingOrders, 90 * 1000).unref();
setInterval(alertStalePendingOrders, 30 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
// (إصلاح أداء) الحدود بقت في ذاكرة العملية بدل قاعدة البيانات: كل طلب كان
// بيعمل كتابة SQLite متزامنة (transaction) وده كان بيقفل الـ event loop على
// *كل* طلب API. دلوقتي العدّاد Map في الذاكرة (O(1)، بدون I/O)، والقاعدة
// بتتكتب بس لما نحتاجها فعلًا. ملاحظة: التطبيق ده SQLite بملف واحد، يعني
// instance واحد بطبيعته؛ لو حبيت تشغّل أكتر من instance لازم Redis/Postgres.
const rateLimitFactory = createRateLimiterFactory({ store });
// (إصلاح) الحدود الحسّاسة (دخول/استعادة كلمة مرور/عمليات أدمن) بقت متخزّنة في
// قاعدة البيانات المشتركة: مش بتتصفّر مع كل restart، وبتتشارك بين أي عدد من
// العمليات (processes) اللي شغالة على نفس مجلد البيانات. الحدود العامة عالية
// التردد (api/write) فاضلة في الذاكرة عشان ما نضربش SQLite على كل طلب.
// ملاحظة تشغيل: لو شغّلت instances على أجهزة مختلفة (مش نفس الـ Volume) لازم
// مخزن مشترك حقيقي — ظبّط REDIS_URL أو خلي كل الحدود persist وشارك الـ Volume.
const createRateLimiter = rateLimitFactory.createRateLimiter;

// تنظيف دوري للسجلات المنتهية (حدود المعدّل + توكنات المصادقة).
setInterval(() => {
  rateLimitFactory.sweep();
  try { store.purgeExpiredRateLimits(); store.purgeExpiredAuthTokens(); } catch (_) { /* لا شيء */ }
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
  keyFn: (req) => `${req.ip}:${String((req.body && req.body.email) || '').trim().toLowerCase()}`
});
// حد إضافي على الحساب نفسه بغض النظر عن الـ IP (يحمي من هجمات موزّعة على IPs
// كتير أو مزيفة تستهدف حساب واحد بعينه).
const authAccountLimiter = createRateLimiter({
  scope: 'auth-account',
  persist: true,
  windowMs: 10 * 60 * 1000,
  max: 12,
  message: 'محاولات دخول كثيرة جدًا على هذا الحساب، حاول مرة أخرى بعد قليل.',
  keyFn: (req) => `account:${String((req.body && req.body.email) || '').trim().toLowerCase()}`
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
  keyFn: (req) => `code:${String((req.body && req.body.code) || '').trim().toLowerCase()}`
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
  keyFn: (req) => `${req.ip}:${String((req.body && req.body.email) || '').trim().toLowerCase()}`
});

// ---------------------------------------------------------------------------
// أدوات مساعدة
// ---------------------------------------------------------------------------
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}
const isEmail = (value) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-zA-Z]{2,12}$/.test(String(value || '').trim());
const isPhone = (value) => /^[0-9+\-\s()]{7,20}$/.test(String(value || '').trim());
const asText = (value, max) => String(value ?? '').trim().slice(0, max);

function validate(rules, body) {
  const errors = [];
  const output = {};
  for (const [field, rule] of Object.entries(rules)) {
    const raw = body ? body[field] : undefined;
    if (rule.required && (raw === undefined || raw === null || String(raw).trim() === '')) {
      errors.push(rule.label ? `${rule.label} مطلوب` : `${field} مطلوب`);
      continue;
    }
    if (raw === undefined || raw === null || raw === '') { output[field] = rule.default; continue; }
    if (rule.type === 'number') {
      const num = Number(raw);
      if (!Number.isFinite(num)) { errors.push(`${rule.label || field} يجب أن يكون رقمًا`); continue; }
      if (rule.min !== undefined && num < rule.min) { errors.push(`${rule.label || field} يجب ألا يقل عن ${rule.min}`); continue; }
      if (rule.max !== undefined && num > rule.max) { errors.push(`${rule.label || field} يجب ألا يزيد عن ${rule.max}`); continue; }
      output[field] = num;
      continue;
    }
    if (rule.type === 'email' && !isEmail(raw)) { errors.push('البريد الإلكتروني غير صحيح'); continue; }
    if (rule.type === 'phone' && !isPhone(raw)) { errors.push('رقم الهاتف غير صحيح'); continue; }
    if (rule.enum && !rule.enum.includes(raw)) { errors.push(`${rule.label || field} غير صالح`); continue; }
    const text = String(raw);
    if (rule.minLength && text.trim().length < rule.minLength) {
      errors.push(`${rule.label || field} يجب ألا يقل عن ${rule.minLength} أحرف`);
      continue;
    }
    output[field] = rule.maxLength ? text.trim().slice(0, rule.maxLength) : text;
  }
  return { errors, value: output };
}

// ---------------------------------------------------------------------------
// جلسات موقّعة (stateless)
// ---------------------------------------------------------------------------
const base64url = (input) => Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function base64urlDecode(input) {
  let value = input.replace(/-/g, '+').replace(/_/g, '/');
  while (value.length % 4) value += '=';
  return Buffer.from(value, 'base64').toString('utf8');
}
const signWith = (key, payload) => base64url(crypto.createHmac('sha256', key).update(payload).digest());
const sign = (payload) => signWith(SESSION_KEY, payload);
const signCsrf = (payload) => signWith(CSRF_KEY, payload);
function createSessionToken(data) {
  const payload = base64url(JSON.stringify({ ...data, iat: Date.now() }));
  return `${payload}.${sign(payload)}`;
}
function parseSessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const data = JSON.parse(base64urlDecode(payload));
    const maxAge = data.role === 'admin' ? ADMIN_SESSION_MAX_AGE_MS : SESSION_MAX_AGE_MS;
    if (data.iat && Date.now() - data.iat > maxAge) return null;
    return data;
  } catch (_) { return null; }
}
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    if (key) cookies[key] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}
// (5) الكوكيز دايمًا HttpOnly + SameSite=Strict، و Secure تلقائيًا على أي
// اتصال HTTPS (سواء مباشر أو خلف بروكسي) وليس فقط لما NODE_ENV=production.
function isSecureRequest(res) {
  if (process.env.DISABLE_SECURE_COOKIE === '1') return false;
  const req = res.req;
  if (req && (req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https')) return true;
  return process.env.NODE_ENV === 'production';
}
function cookieParts(name, value, maxAgeSeconds, res, httpOnly = true) {
  const parts = [`${name}=${value}`, 'Path=/', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (httpOnly) parts.splice(2, 0, 'HttpOnly');
  if (isSecureRequest(res)) parts.push('Secure');
  return parts.join('; ');
}
function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  list.push(cookie);
  res.setHeader('Set-Cookie', list);
}
function setSessionCookie(res, data) {
  const token = createSessionToken(data);
  const maxAge = data && data.role === 'admin' ? ADMIN_SESSION_MAX_AGE_MS : SESSION_MAX_AGE_MS;
  appendCookie(res, cookieParts(SESSION_COOKIE, encodeURIComponent(token), Math.floor(maxAge / 1000), res));
  issueCsrfCookie(res, true);
}
const clearSessionCookie = (res) => {
  appendCookie(res, cookieParts(SESSION_COOKIE, '', 0, res));
  issueCsrfCookie(res, true);
};

// ---------------------------------------------------------------------------
// (2) حماية CSRF — Double Submit Cookie موقّع
// ---------------------------------------------------------------------------
const CSRF_COOKIE = 'yousef_csrf';
const CSRF_HEADER = 'x-csrf-token';
const CSRF_MAX_AGE = 12 * 60 * 60; // 12 ساعة

function createCsrfToken() {
  const raw = crypto.randomBytes(24).toString('base64url');
  // (5) موقّع بمفتاح الـ CSRF المستقل، مش بمفتاح الجلسة.
  return `${raw}.${signCsrf(raw)}`;
}
function isValidCsrfToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const idx = token.lastIndexOf('.');
  const raw = token.slice(0, idx);
  const signature = token.slice(idx + 1);
  const expected = signCsrf(raw);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// كوكي الـ CSRF مقروء من الجافاسكريبت عمدًا (مش HttpOnly) عشان الواجهة تبعته
// في هيدر X-CSRF-Token؛ أمانه جاي من إن أي موقع تاني لا يقدر يقرأ الكوكي.
function issueCsrfCookie(res, force = false) {
  if (!force && res.locals && res.locals.csrfToken) return res.locals.csrfToken;
  const token = createCsrfToken();
  appendCookie(res, cookieParts(CSRF_COOKIE, token, CSRF_MAX_AGE, res, false));
  if (res.locals) res.locals.csrfToken = token;
  return token;
}

const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function csrfProtection(req, res, next) {
  const cookies = parseCookies(req);
  if (!cookies[CSRF_COOKIE] || !isValidCsrfToken(cookies[CSRF_COOKIE])) issueCsrfCookie(res, true);
  if (CSRF_SAFE_METHODS.has(req.method)) return next();

  // (إصلاح 12) الطلب من غير Origin مكانش بيتفحص أصلًا. دلوقتي لازم إثبات
  // أصل واحد على الأقل: Origin، أو Referer من نفس الهوست، أو Sec-Fetch-Site
  // بقيمة same-origin/same-site. غياب الثلاثة = رفض.
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  const hostMatches = (value) => {
    try { return new URL(value).host === req.headers.host; } catch (_) { return false; }
  };
  let originOk = false;
  if (origin && origin !== 'null') originOk = hostMatches(origin);
  else if (fetchSite === 'same-origin' || fetchSite === 'same-site') originOk = true;
  else if (referer) originOk = hostMatches(referer);
  if (!originOk) return res.status(403).json({ error: 'طلب مرفوض (مصدر غير موثوق)' });

  const headerToken = req.headers[CSRF_HEADER] || (req.body && req.body._csrf);
  const cookieToken = cookies[CSRF_COOKIE];
  if (!headerToken || !cookieToken || headerToken !== cookieToken || !isValidCsrfToken(String(headerToken))) {
    return res.status(403).json({ error: 'انتهت صلاحية الصفحة، حدّث الصفحة وحاول مرة أخرى.' });
  }
  return next();
}

function sessionMiddleware(req, res, next) {
  const data = parseSessionToken(parseCookies(req)[SESSION_COOKIE]);
  const user = data ? store.findUserById(data.userId) : null;
  const versionMatches = user && data.sv === (user.session_version || 0);
  if (data && (!user || !versionMatches)) {
    req.session = null;
    req.user = null;
    clearSessionCookie(res);
    return next();
  }
  req.session = data || null;
  req.user = user;
  next();
}

// ---------------------------------------------------------------------------
// Middlewares عامة
// ---------------------------------------------------------------------------
// (إصلاح DoS) 3 ميجا JSON على *كل* مسار كان سطح هجوم بالذاكرة. الصور بترفع
// عبر multipart (multer) بحدودها الخاصة، فالـ JSON مش محتاج أكتر من 128 كيلو.
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: true, limit: '128kb' }));
app.use(sessionMiddleware);
app.use(csrfProtection);

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
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data: blob: https:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    `script-src 'self' 'nonce-${res.locals.cspNonce}'${googleAuth.isEnabled() ? ' https://accounts.google.com https://apis.google.com' : ''}`,
    "object-src 'none'",
    `connect-src 'self'${googleAuth.isEnabled() ? ' https://accounts.google.com' : ''}`,
    `frame-src 'self'${googleAuth.isEnabled() ? ' https://accounts.google.com' : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'report-uri /api/csp-report',
    "report-to csp-endpoint"
  ].join('; '));
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    // فرض HTTPS خلف بروكسي (Render/Railway/Nginx)
    if (process.env.FORCE_HTTPS === '1' && req.headers['x-forwarded-proto'] === 'http') {
      return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
  }
  return next();
});

// تقارير انتهاك CSP: مسار صغير جدًا، محدود المعدّل، وبيسجّل بس.
app.post('/api/csp-report',
  createRateLimiter({ scope: 'csp-report', windowMs: 60 * 1000, max: 20, message: 'ok' }),
  express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }),
  (req, res) => {
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

// ---------------------------------------------------------------------------
// حراسة الصفحات والـ APIs
// ---------------------------------------------------------------------------
function requireAdminPanel(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.redirect('/admin-login.html');
  return next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'من فضلك سجّل الدخول أولًا' });
  return next();
}
// (أمان) فرض تغيير كلمة المرور المؤقتة من السيرفر مش من الواجهة بس: طالما
// must_change_password = 1، أي طلب API غير الطلبات اللازمة للتغيير نفسه بيترفض،
// فمحدش يقدر يستخدم الحساب بكلمة مرور مؤقتة عن طريق نداء الـ API مباشرة.
const PASSWORD_CHANGE_ALLOWED = new Set([
  '/api/auth/change-password',
  '/api/auth/logout',
  '/api/auth/logout-all-devices',
  '/api/auth/me',
  '/api/csrf',
  '/api/csp-report'
]);
function enforcePasswordChange(req, res, next) {
  if (!req.user || req.user.must_change_password !== 1) return next();
  if (PASSWORD_CHANGE_ALLOWED.has(req.path)) return next();
  return res.status(403).json({
    error: 'لازم تغيّر كلمة المرور المؤقتة قبل استخدام الحساب.',
    mustChangePassword: true
  });
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'من فضلك سجّل الدخول أولًا' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'هذه الصفحة للمسؤولين فقط' });
  return next();
}
const audit = (req, action, details) => store.logActivity({
  userId: req.user ? req.user.id : null,
  userName: req.user ? req.user.name : 'نظام',
  action,
  details
});

// (13) /dashboard.html بقت لوحة تحكم العميل (ملف ثابت). المسارات القديمة
// الخاصة بالأدمن بقت /dash.html فقط.
app.get('/dash.html', (_req, res) => res.redirect('/admin.html'));
app.get(['/admin', '/admin.html'], requireAdminPanel, (_req, res) => sendHtml(res, path.join(PUBLIC_DIR, 'admin.html')));

// (تنظيف) CSS/JS لوحة التحكم اتنقلوا من داخل admin.html لملفات خارجية عشان
// يتكاشوا في المتصفح. بنقدّمهم وراء نفس حماية اللوحة (مش عبر static العام).
app.get(['/admin.css', '/admin.js'], requireAdminPanel, (req, res) => {
  const file = req.path === '/admin.css' ? 'admin.css' : 'admin.js';
  res.type(file === 'admin.css' ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(path.join(PUBLIC_DIR, file));
});

// (1) express.static مع extensions:['html'] كان بيقدّم /admin و /admin.html
// كملفات ثابتة قبل أي تحقق. هنا نحجب أي مسار بيوصل لملف الأدمن مهما كان شكله
// (/admin، /admin.html، //admin.html، /Admin.HTML ...) قبل الوصول للـ static.
// (إصلاح) endsWith('/admin.html') كان بيتطابق مع أي مسار منتهي بيه (مثلاً
// /foo/admin.html) بشكل غير دقيق. بدل التطابق الفضفاض، عندنا allowlist دقيق
// لمسارات الأدمن الثابتة فقط.
const ADMIN_ASSET_PATHS = new Set(['/admin', '/admin.html', '/admin.css', '/admin.js']);
app.use((req, res, next) => {
  const normalized = decodeURIComponent(req.path).toLowerCase().replace(/\/+/g, '/');
  if (ADMIN_ASSET_PATHS.has(normalized)) return requireAdminPanel(req, res, next);
  return next();
});

app.get('/robots.txt', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /admin.html\nDisallow: /admin.js\nDisallow: /admin.css\nDisallow: /admin-login.html\nDisallow: /account.html\nDisallow: /checkout.html\nDisallow: /api/\n\nSitemap: ${base}/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', (_req, res) => {
  const base = `${_req.protocol}://${_req.get('host')}`;
  const products = store.getProducts(true);
  const staticUrls = [
    { loc: `${base}/`, priority: '1.0' },
    { loc: `${base}/shipping.html`, priority: '0.5' },
    { loc: `${base}/returns.html`, priority: '0.5' },
    { loc: `${base}/privacy.html`, priority: '0.4' }
  ];
  // (إصلاح 10) مسارات حقيقية /product/<id>/<slug> بدل query string.
  const productUrls = products.map((p) => ({ loc: `${base}${productPath(p)}`, priority: '0.7' }));
  const urls = [...staticUrls, ...productUrls];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${u.loc}</loc><priority>${u.priority}</priority></url>`)
    .join('\n')}\n</urlset>`;
  res.type('application/xml').send(xml);
});

// (4) بنقدّم صفحات الـ HTML بأنفسنا عشان نحقن الـ nonce في كل <script> داخلي
// قبل الإرسال. الملفات التانية (CSS/JS/صور) بتكمل عادي على express.static.
const htmlCache = new Map();
function readHtml(filePath) {
  const stat = fs.statSync(filePath);
  const cached = htmlCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content;
  const content = fs.readFileSync(filePath, 'utf8');
  htmlCache.set(filePath, { mtimeMs: stat.mtimeMs, content });
  return content;
}
function injectNonce(html, nonce) {
  return html.replace(/<script(?![^>]*\bsrc=)([^>]*)>/gi, (match, attrs) => (
    /\bnonce=/i.test(attrs) ? match : `<script${attrs} nonce="${nonce}">`
  ));
}
// (إصلاح SEO) og:url / og:image / twitter:image / canonical لازم تكون روابط
// مطلقة، وإلا معاينة اللينك على واتساب وفيسبوك ما بتظهرش.
function absolutizeSocialTags(html, req) {
  const base = (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const abs = (value) => (/^https?:\/\//i.test(value) ? value : base + (value.startsWith('/') ? value : '/' + value));
  return html
    .replace(/(<meta\s+property="og:(?:url|image)"\s+content=")([^"]*)(")/gi, (m, a, v, b) => a + abs(v) + b)
    .replace(/(<meta\s+name="twitter:image"\s+content=")([^"]*)(")/gi, (m, a, v, b) => a + abs(v) + b)
    .replace(/(<link\s+rel="canonical"\s+href=")([^"]*)(")/gi, (m, a, v, b) => a + abs(v) + b);
}
// (إصلاح SEO) صفحة المنتج بتتفتح كـ /?p=ID داخل تطبيق صفحة واحدة، فالمعاينة
// على واتساب/فيسبوك وجوجل كانت بتبان بعنوان المتجر العام. هنا بنحقن بيانات
// المنتج نفسه في الـ HTML قبل الإرسال + JSON-LD للأرشفة.
function escAttr(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function injectProductMeta(html, req) {
  const raw = req.query && req.query.p;
  const fromPath = parseProductPath(req.path);
  const id = fromPath || Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(id) || id <= 0) return html;
  let product = null;
  try { product = store.getProductById(id); } catch (_) { return html; }
  if (!product || product.is_active === 0) return html;

  const base = (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const abs = (v) => (!v ? base + '/icon-512.png' : /^https?:\/\//i.test(v) ? v : base + (v.startsWith('/') ? v : '/' + v));
  const title = `${product.name} — يوسف | مستلزمات العربيات`;
  const desc = String(product.description || `${product.name} متوفر في متجر يوسف بسعر ${product.price} ج.م مع توصيل لحد باب البيت.`).replace(/\s+/g, ' ').trim().slice(0, 180);
  const image = abs(product.image_url || product.image);
  const url = `${base}${productPath(product)}`;

  const set = (h, re, replacement) => (re.test(h) ? h.replace(re, replacement) : h);
  let out = html;
  out = set(out, /<title>[\s\S]*?<\/title>/i, `<title>${escAttr(title)}</title>`);
  out = set(out, /(<meta\s+name="description"\s+content=")[^"]*(")/i, `$1${escAttr(desc)}$2`);
  out = set(out, /(<meta\s+property="og:title"\s+content=")[^"]*(")/i, `$1${escAttr(title)}$2`);
  out = set(out, /(<meta\s+property="og:description"\s+content=")[^"]*(")/i, `$1${escAttr(desc)}$2`);
  out = set(out, /(<meta\s+property="og:image"\s+content=")[^"]*(")/i, `$1${escAttr(image)}$2`);
  out = set(out, /(<meta\s+property="og:url"\s+content=")[^"]*(")/i, `$1${escAttr(url)}$2`);
  out = set(out, /(<meta\s+property="og:type"\s+content=")[^"]*(")/i, '$1product$2');
  out = set(out, /(<meta\s+name="twitter:title"\s+content=")[^"]*(")/i, `$1${escAttr(title)}$2`);
  out = set(out, /(<meta\s+name="twitter:description"\s+content=")[^"]*(")/i, `$1${escAttr(desc)}$2`);
  out = set(out, /(<meta\s+name="twitter:image"\s+content=")[^"]*(")/i, `$1${escAttr(image)}$2`);
  out = set(out, /(<link\s+rel="canonical"\s+href=")[^"]*(")/i, `$1${escAttr(url)}$2`);

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product',
    name: product.name, description: desc, image: [image], sku: String(product.id),
    brand: { '@type': 'Brand', name: 'يوسف | مستلزمات العربيات' },
    offers: {
      '@type': 'Offer', url, priceCurrency: 'EGP', price: Number(product.price || 0).toFixed(2),
      availability: (product.stock > 0) ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    },
  }).replace(/</g, '\\u003c');
  return out.replace(/<\/head>/i, `<script type="application/ld+json">${jsonLd}</script></head>`);
}
function sendHtml(res, filePath) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  let html = readHtml(filePath);
  if (path.basename(filePath) === 'index.html') html = injectProductMeta(html, res.req);
  html = absolutizeSocialTags(html, res.req);
  res.send(injectNonce(html, res.locals.cspNonce));
}
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let pathname;
  try { pathname = decodeURIComponent(req.path); } catch (_) { return next(); }
  if (pathname.includes('\0') || pathname.includes('..')) return next();
  const candidate = pathname === '/' ? '/index.html' : (pathname.endsWith('.html') ? pathname : null);
  if (!candidate) return next();
  const filePath = path.join(PUBLIC_DIR, candidate);
  // منع أي خروج من مجلد public مهما كان شكل المسار
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return next();
  if (!fs.existsSync(filePath)) return next();
  return sendHtml(res, filePath);
});


// (إصلاح 10) صفحة المنتج بمسار حقيقي: /product/<id>/<slug>. بنقدّم نفس
// index.html مع ميتا المنتج و JSON-LD محقونين، وبنعمل redirect دائم من
// الرابط القديم /?p=ID عشان الأرشفة تتجمّع على رابط واحد.
app.get(['/product/:id', '/product/:id/:slug'], (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return next();
  let product = null;
  try { product = store.getProductById(id); } catch (_) { product = null; }
  if (!product || product.active === 0) {
    res.status(404);
    return sendHtml(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  // المقارنة بتتعمل على النص بعد فك الترميز، عشان الروابط العربية (%D8..)
  // ما تعملش حلقة إعادة توجيه لا نهائية.
  const canonical = productPath(product);
  let decodedPath = req.path;
  try { decodedPath = decodeURIComponent(req.path); } catch (_) { /* مسار غير صالح */ }
  if (decodedPath !== canonical) return res.redirect(301, encodeURI(canonical));
  return sendHtml(res, path.join(PUBLIC_DIR, 'index.html'));
});

// لو الصور المرفوعة متخزنة برّه مجلد public (على Volume)، بنقدّمها من مسارها الحقيقي.
if (UPLOADS_DIR !== path.join(PUBLIC_DIR, 'uploads', 'products')) {
  app.use('/uploads/products', express.static(UPLOADS_DIR, { maxAge: '1h' }));
}
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', extensions: ['html'] }));

// ---------------------------------------------------------------------------
// APIs عامة
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'yousef-store', uptime: Math.round(process.uptime()) }));

app.get('/api/products', (req, res) => {
  // (إصلاح 7) pagination حقيقي: بنرجّع صفحة واحدة بس بدل الكتالوج كله.
  const result = queryProducts(store.getProducts(true), req.query || {});
  res.json({
    products: result.items,
    total: result.total,
    page: result.page,
    limit: result.limit,
    pages: result.pages,
    hasMore: result.hasMore,
    categories: store.getCategories()
  });
});

app.get('/api/products/:id', (req, res) => {
  const product = store.getProductById(req.params.id);
  if (!product || product.active !== 1) return res.status(404).json({ error: 'المنتج غير موجود' });
  store.incrementProductViews(product.id);
  const related = store.getProducts(true).filter((p) => p.category === product.category && p.id !== product.id).slice(0, 4);
  res.json({ product, related, reviews: store.getReviewsByProduct(product.id) });
});

app.get('/api/categories', (_req, res) => res.json({ categories: store.getCategories() }));
app.get('/api/site/settings', (_req, res) => res.json({ settings: store.getSiteSettings() }));

app.put('/api/site/settings', requireAdmin, adminWriteLimiter, (req, res) => {
  const settings = store.updateSiteSettings(req.body || {});
  audit(req, 'تحديث إعدادات المتجر', '');
  res.json({ ok: true, settings });
});

// ---------------------------------------------------------------------------
// المصادقة
// ---------------------------------------------------------------------------
app.post('/api/auth/register', authLimiter, authAccountLimiter, async (req, res) => {
  const { errors, value } = validate({
    name: { required: true, label: 'الاسم', minLength: 2, maxLength: 80 },
    email: { required: true, label: 'البريد الإلكتروني', type: 'email', maxLength: 190 },
    password: { required: true, label: 'كلمة المرور', minLength: 8, maxLength: 100 },
    phone: { label: 'رقم الهاتف', maxLength: 30 },
    address: { label: 'العنوان', maxLength: 200 }
  }, req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  // (جديد) بوابة البريد الوهمي: بترفض البريد المؤقت، الأخطاء الإملائية،
  // والنطاقات اللي مش بتستقبل بريد أصلًا — قبل ما نعمل الحساب.
  const guard = await emailGuard.checkEmail(value.email);
  if (!guard.ok) return res.status(400).json({ error: guard.reason, code: 'EMAIL_REJECTED' });
  // منع تكرار نفس الإيميل بصيغ مختلفة (نقط gmail أو +tag).
  const twin = store.findUserByNormalizedEmail
    ? store.findUserByNormalizedEmail(guard.normalized)
    : null;
  if (twin) return res.status(409).json({ error: 'البريد الإلكتروني مسجل بالفعل' });

  try {
    // (إصلاح) الحساب بيتعمل *غير مفعّل*. مفيش أي طريقة يتعلّم بيها مفعّل غير
    // كود بيوصل على نفس البريد أو دخول بجوجل — فمستحيل حد يسجّل ببريد غيره
    // ويستخدمه كأنه بتاعه.
    store.createUser({ ...value, role: 'customer', emailVerified: false });
    const user = store.findUserByEmail(value.email);
    let devCode = null;
    if (EMAIL_VERIFICATION_AVAILABLE) {
      try { devCode = await issueVerificationEmail(req, user); }
      catch (err) { console.error('[verify-email] فشل إرسال كود التفعيل:', err.message); }
    }
    setSessionCookie(res, { userId: user.id, role: user.role, email: user.email, sv: user.session_version || 0 });
    return res.json({
      ok: true,
      user: store.sanitizeUser(user),
      emailVerificationRequired: REQUIRE_EMAIL_VERIFICATION,
      emailVerificationAvailable: EMAIL_VERIFICATION_AVAILABLE,
      message: EMAIL_VERIFICATION_AVAILABLE
        ? 'تم إنشاء الحساب. بعتنالك كود تفعيل من 6 أرقام على بريدك — أدخله عشان نتأكد إن البريد بتاعك فعلًا.'
        : 'تم إنشاء الحساب. مرحبًا بيك في متجر يوسف!',
      ...(devCode ? { devVerifyCode: devCode } : {})
    });
  } catch (error) {
    if (error.message === 'Email already exists') return res.status(409).json({ error: 'البريد الإلكتروني مسجل بالفعل' });
    console.error('[register]', error);
    return res.status(500).json({ error: 'تعذر إنشاء الحساب' });
  }
});

app.post('/api/auth/login', authLimiter, authAccountLimiter, (req, res) => {
  const email = asText((req.body || {}).email, 190).trim().toLowerCase();
  const password = (req.body || {}).password;
  const requiredRole = (req.body || {}).role;
  if (!email || !password) return res.status(400).json({ error: 'من فضلك أدخل البريد الإلكتروني وكلمة المرور' });

  const user = store.verifyPassword(email, password);
  if (!user) return res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
  // (إصلاح 4) خطوة تانية: لو الحساب مفعّل عليه TOTP لازم كود صحيح.
  if (user.totp_enabled === 1) {
    const code = String((req.body || {}).totpCode || '').replace(/\D/g, '');
    if (!code) return res.status(401).json({ error: 'أدخل كود التحقق بخطوتين', code: 'TOTP_REQUIRED', twoFactorRequired: true });
    const secretRow = store.getTotpSecret(user.id);
    if (!secretRow || !totpLib.verify(secretRow.totp_secret, code) || !store.claimTotpCode(user.id, code)) {
      return res.status(401).json({ error: 'كود التحقق غير صحيح أو مستخدم من قبل', code: 'TOTP_INVALID', twoFactorRequired: true });
    }
  } else if (user.role === 'admin' && REQUIRE_ADMIN_2FA) {
    return res.status(403).json({ error: 'مطلوب تفعيل التحقق بخطوتين لحساب المسؤول قبل الدخول.', code: 'TOTP_SETUP_REQUIRED' });
  }
  if (requiredRole && user.role !== requiredRole) {
    return res.status(403).json({
      error: requiredRole === 'admin'
        ? 'هذا الحساب ليس حساب مسؤول. استخدم صفحة تسجيل دخول العملاء.'
        : 'هذا حساب مسؤول. استخدم صفحة تسجيل دخول المسؤول.'
    });
  }
  setSessionCookie(res, { userId: user.id, role: user.role, email: user.email, sv: user.session_version || 0 });
  // (إصلاح) الملف مكانش المفروض يتمسح هنا: كان أي دخول ناجح بيمسح كلمة المرور
  // الأولية قبل ما صاحب المتجر يغيّرها، وبعدها لو الجلسة ضاعت مفيش أي طريقة
  // يرجع بيها. بيتمسح دلوقتي بعد تغيير كلمة المرور فعليًا (change-password).
  res.json({
    ok: true,
    user: store.sanitizeUser(user),
    mustChangePassword: user.must_change_password === 1,
    emailVerified: user.email_verified === 1,
    twoFactorEnabled: user.totp_enabled === 1
  });
});

app.post('/api/auth/logout', (_req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.json({ loggedIn: false });
  res.json({
    loggedIn: true,
    user: store.sanitizeUser(req.user),
    mustChangePassword: req.user.must_change_password === 1,
    emailVerified: req.user.email_verified === 1,
    emailVerificationRequired: emailVerificationEnforced(),
    twoFactorEnabled: req.user.totp_enabled === 1
  });
});

app.put('/api/auth/profile', requireAuth, writeLimiter, (req, res) => {
  const { errors, value } = validate({
    name: { required: true, label: 'الاسم', minLength: 2, maxLength: 80 },
    phone: { label: 'رقم الهاتف', maxLength: 30 },
    address: { label: 'العنوان', maxLength: 300 }
  }, req.body);
  if (errors.length) return res.status(400).json({ error: errors[0] });
  const user = store.updateUser(req.user.id, value);
  res.json({ ok: true, user });
});

app.post('/api/auth/change-password', requireAuth, authLimiter, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!store.verifyPassword(req.user.email, currentPassword)) {
    return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  }
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل' });
  }
  const user = store.updateUser(req.user.id, { password: newPassword });
  // كلمة المرور اتغيّرت فعلًا ← ملف كلمة المرور الأولية مالوش لزوم على الديسك.
  if (user.role === 'admin') { try { fs.unlinkSync(ADMIN_PASSWORD_FILE); } catch (_) { /* مش موجود */ } }
  // نحدّث كوكي الجهاز الحالي بالإصدار الجديد؛ أي جهاز/جلسة تانية هتتسجل خروج تلقائيًا.
  setSessionCookie(res, { userId: user.id, role: user.role, email: user.email, sv: user.session_version || 0 });
  res.json({ ok: true });
});

// تسجيل خروج من كل الأجهزة (يبطل كل الجلسات القديمة حتى لو الكوكي لسه موجود عند حد تاني)
app.post('/api/auth/logout-all-devices', requireAuth, (req, res) => {
  const user = store.bumpSessionVersion(req.user.id);
  setSessionCookie(res, { userId: user.id, role: user.role, email: user.email, sv: user.session_version || 0 });
  audit(req, 'تسجيل خروج من كل الأجهزة', '');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// (1) استعادة كلمة المرور — للعميل وللأدمن على السواء
// (2) تفعيل البريد الإلكتروني
// ---------------------------------------------------------------------------
const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

// (إصلاح 9) كل إرسال بريد بيعدّي من هنا عشان نعرف إن المزوّد وقع وندخل الوضع
// المتدهور بدل ما المتجر يتقفل على كل العملاء.
async function sendMailTracked(options) {
  try {
    const result = await sendMail(options);
    noteMailSuccess();
    return result;
  } catch (error) {
    noteMailFailure();
    throw error;
  }
}

// بيرجّع الرابط نصًا لو إحنا في وضع تطوير من غير مزوّد بريد، عشان تقدر تجرّب.
// (2) بقينا نبعت كود رقمي من 6 أرقام بدل رابط: أسهل على العميل، ومش محتاج
// دومين عام ولا رابط يشتغل، وصالح 15 دقيقة بس ويُستخدم مرة واحدة.
async function issueVerificationEmail(req, user) {
  const code = store.createAuthCode({ userId: user.id, type: 'verify', ttlMs: VERIFY_CODE_TTL_MS });
  await sendMailTracked({
    to: user.email,
    subject: 'كود تفعيل بريدك الإلكتروني — متجر يوسف',
    text: `كود التفعيل بتاعك هو: ${code} — صالح 15 دقيقة، وما تديهوش لحد.`
  });
  // في وضع التطوير (من غير مزوّد بريد) بنرجّع الكود عشان تقدر تجرّب محليًا.
  return shouldExposeLink() ? code : null;
}

app.post('/api/auth/forgot-password', passwordResetLimiter, async (req, res) => {
  const email = asText((req.body || {}).email, 190).trim().toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: 'البريد الإلكتروني غير صحيح' });
  const user = store.findUserByEmail(email);
  let devLink = null;
  if (user) {
    const token = store.createAuthToken({ userId: user.id, type: 'reset', ttlMs: RESET_TOKEN_TTL_MS });
    const link = `${baseUrl(req)}/reset-password.html?token=${encodeURIComponent(token)}`;
    await sendMailTracked({
      to: user.email,
      subject: 'استعادة كلمة المرور — متجر يوسف',
      text: 'لو إنت اللي طلبت استعادة كلمة المرور، افتح الرابط ده (صالح ساعة واحدة). لو مش إنت، تجاهل الرسالة.',
      link
    });
    devLink = shouldExposeLink() ? link : null;
    // (إصلاح) لو مفيش مزوّد بريد متظبط، رسالة الاستعادة مكانتش بتوصل لحد وكان
    // صاحب المتجر بيتقفل بره لوحته من غير أي بديل. بالنسبة لحساب الأدمن بس،
    // بنكتب الرابط في ملف محمي جوه مجلد البيانات وبنطبعه في لوج السيرفر (مش
    // في رد الـ API أبدًا) عشان صاحب المتجر يقدر يستعيد حسابه من الاستضافة.
    if (user.role === 'admin' && activeProvider() === 'console') {
      try {
        fs.writeFileSync(ADMIN_RESET_LINK_FILE, `${new Date().toISOString()}\n${link}\n`, { mode: 0o600 });
      } catch (error) { console.warn('[admin] تعذر حفظ رابط الاستعادة:', error.message); }
      console.warn(`\x1b[33m🔗 مفيش مزوّد بريد متظبط — رابط استعادة كلمة مرور الأدمن (صالح ساعة):\n    ${link}\n    (اتحفظ كمان في ${ADMIN_RESET_LINK_FILE})\x1b[0m`);
    }
    store.logActivity({ userId: user.id, userName: user.name, action: 'طلب استعادة كلمة المرور', details: user.email });
  }
  // ردّ واحد ثابت سواء البريد موجود أو لأ، عشان محدش يعرف مين مسجّل عندنا
  // (user enumeration).
  return res.json({
    ok: true,
    message: 'لو البريد ده مسجّل عندنا، هيوصلك رابط لإعادة تعيين كلمة المرور خلال دقائق.',
    ...(devLink ? { devResetLink: devLink } : {})
  });
});

// التحقق من صلاحية التوكن قبل عرض الفورم (من غير ما نستهلكه)
app.get('/api/auth/reset-password/check', (req, res) => {
  const token = String(req.query.token || '');
  // مجرد فحص شكلي سريع؛ التحقق الحقيقي والاستهلاك بيحصلوا عند الإرسال.
  res.json({ ok: token.length >= 20 });
});

app.post('/api/auth/reset-password', passwordResetLimiter, (req, res) => {
  const { token, password } = req.body || {};
  if (!token) return res.status(400).json({ error: 'رابط غير صالح' });
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
  }
  if (String(password).length > 100) return res.status(400).json({ error: 'كلمة المرور طويلة جدًا' });
  const user = store.consumeAuthToken(String(token), 'reset');
  if (!user) return res.status(400).json({ error: 'الرابط غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.' });
  store.setUserPassword(user.id, String(password));
  // أي جلسة مفتوحة (حتى بتاعة المهاجم) بتتلغي فورًا مع تغيير كلمة المرور.
  store.logActivity({ userId: user.id, userName: user.name, action: 'إعادة تعيين كلمة المرور', details: user.email });
  clearSessionCookie(res);
  res.json({ ok: true, message: 'تم تغيير كلمة المرور بنجاح. سجّل الدخول بكلمة المرور الجديدة.' });
});

// (إصلاح) تفعيل حقيقي بكود 6 أرقام بيتبعت على البريد نفسه، صالح 15 دقيقة،
// ويُستخدم مرة واحدة. مفيش أي مسار بيعلّم الحساب مفعّل من غير الكود ده.
app.post('/api/auth/resend-verification', requireAuth, passwordResetLimiter, async (req, res) => {
  if (req.user.email_verified === 1) {
    return res.json({ ok: true, alreadyVerified: true, message: 'حسابك مفعّل بالفعل.' });
  }
  if (!EMAIL_VERIFICATION_AVAILABLE) {
    return res.status(503).json({ error: 'خدمة إرسال البريد مش مفعّلة حاليًا — تواصل معانا لتفعيل حسابك.' });
  }
  let devCode = null;
  try {
    devCode = await issueVerificationEmail(req, req.user);
  } catch (err) {
    console.error('[verify-email]', err.message);
    return res.status(502).json({ error: 'تعذر إرسال كود التفعيل دلوقتي، حاول بعد شوية.' });
  }
  return res.json({
    ok: true,
    message: 'بعتنالك كود تفعيل جديد على بريدك (صالح 15 دقيقة).',
    ...(devCode ? { devVerifyCode: devCode } : {})
  });
});

app.post('/api/auth/verify-email', requireAuth, authLimiter, (req, res) => {
  if (req.user.email_verified === 1) return res.json({ ok: true, message: 'حسابك مفعّل بالفعل.' });
  const code = String((req.body || {}).code || '').replace(/\D/g, '');
  if (code.length !== 6) return res.status(400).json({ error: 'الكود لازم يكون 6 أرقام' });
  const user = store.consumeAuthCode(req.user.id, code, 'verify');
  if (!user) return res.status(400).json({ error: 'الكود غير صحيح أو انتهت صلاحيته. اطلب كود جديد.' });
  store.markEmailVerified(user.id);
  store.logActivity({ userId: user.id, userName: user.name, action: 'تفعيل البريد الإلكتروني', details: user.email });
  return res.json({ ok: true, message: 'تم تفعيل بريدك بنجاح ✅' });
});

// ---------------------------------------------------------------------------
// (جديد) الدخول/التسجيل بحساب جوجل — إثبات ملكية البريد من غير كود ولا رابط
// ---------------------------------------------------------------------------
app.get('/api/auth/config', (_req, res) => {
  res.json({
    googleEnabled: googleAuth.isEnabled(),
    googleClientId: googleAuth.isEnabled() ? googleAuth.clientId() : null,
    emailVerifyMode: EMAIL_VERIFY_MODE
  });
});

app.post('/api/auth/google', authLimiter, async (req, res) => {
  if (!googleAuth.isEnabled()) {
    return res.status(503).json({ error: 'الدخول بجوجل غير مفعّل على هذا الموقع.' });
  }
  const profile = await googleAuth.verifyIdToken((req.body || {}).credential);
  if (!profile) return res.status(401).json({ error: 'تعذر التحقق من حساب جوجل. جرّب تاني.' });

  let user = store.findUserByEmail(profile.email);
  if (!user) {
    // حساب جديد بكلمة مرور عشوائية (المستخدم بيدخل بجوجل، ويقدر يعمل
    // "نسيت كلمة المرور" لو حب يستخدم كلمة مرور عادية بعدين).
    store.createUser({
      name: profile.name,
      email: profile.email,
      password: crypto.randomBytes(24).toString('base64url'),
      role: 'customer',
      emailVerified: true
    });
    user = store.findUserByEmail(profile.email);
    store.logActivity({ userId: user.id, userName: user.name, action: 'إنشاء حساب بجوجل', details: user.email });
  } else if (user.email_verified !== 1) {
    store.markEmailVerified(user.id);
    user = store.findUserByEmail(profile.email);
  }
  // (إصلاح) الدخول بجوجل كان بيتخطى التحقق بخطوتين: جوجل بتثبت ملكية البريد
  // بس، مش العامل التاني. لو الحساب مفعّل عليه TOTP لازم كود صحيح زي مسار
  // كلمة المرور بالظبط.
  if (user.totp_enabled === 1) {
    const code = String((req.body || {}).totpCode || '').replace(/\D/g, '');
    if (!code) return res.status(401).json({ error: 'أدخل كود التحقق بخطوتين', code: 'TOTP_REQUIRED', twoFactorRequired: true });
    const secretRow = store.getTotpSecret(user.id);
    if (!secretRow || !totpLib.verify(secretRow.totp_secret, code) || !store.claimTotpCode(user.id, code)) {
      return res.status(401).json({ error: 'كود التحقق غير صحيح أو مستخدم من قبل', code: 'TOTP_INVALID', twoFactorRequired: true });
    }
  } else if (user.role === 'admin' && REQUIRE_ADMIN_2FA) {
    return res.status(403).json({ error: 'مطلوب تفعيل التحقق بخطوتين لحساب المسؤول قبل الدخول.', code: 'TOTP_SETUP_REQUIRED' });
  }
  setSessionCookie(res, { userId: user.id, role: user.role, email: user.email, sv: user.session_version || 0 });
  return res.json({ ok: true, user: store.sanitizeUser(user), emailVerified: true, provider: 'google' });
});

// ---------------------------------------------------------------------------
// (6) التحقق بخطوتين (2FA) — إجباري عمليًا لحساب الأدمن، ومتاح للعملاء كمان
// ---------------------------------------------------------------------------
// (تعديل) كل نقاط التحقق بخطوتين متوقفة وبترجع رد ثابت.
app.get('/api/auth/2fa/status', requireAuth, (req, res) => {
  const row = store.getTotpSecret(req.user.id);
  res.json({
    enabled: req.user.totp_enabled === 1,
    pending: !!(row && row.totp_secret && row.totp_enabled !== 1),
    requiredForAdmin: REQUIRE_ADMIN_2FA,
    disabled: TWO_FACTOR_DISABLED
  });
});

// إنشاء سر جديد (لسه مش مفعّل لحد ما المستخدم يأكد بكود صحيح).
app.post('/api/auth/2fa/setup', requireAuth, authLimiter, (req, res) => {
  const secret = totpLib.generateSecret();
  store.setTotpSecret(req.user.id, secret);
  audit(req, 'بدء تفعيل التحقق بخطوتين', '');
  res.json({
    ok: true,
    secret,
    otpauthUrl: totpLib.otpauthUrl({ secret, label: req.user.email, issuer: TOTP_ISSUER })
  });
});

app.post('/api/auth/2fa/enable', requireAuth, authLimiter, (req, res) => {
  const row = store.getTotpSecret(req.user.id);
  if (!row || !row.totp_secret) return res.status(400).json({ error: 'ابدأ الإعداد الأول' });
  const code = String((req.body || {}).code || '').replace(/\D/g, '');
  if (!totpLib.verify(row.totp_secret, code) || !store.claimTotpCode(req.user.id, code)) {
    return res.status(400).json({ error: 'الكود غير صحيح، جرّب تاني' });
  }
  store.enableTotp(req.user.id);
  audit(req, 'تفعيل التحقق بخطوتين', '');
  res.json({ ok: true, enabled: true });
});

app.post('/api/auth/2fa/disable', requireAuth, authLimiter, (req, res) => {
  const { password, code } = req.body || {};
  if (!store.verifyPassword(req.user.email, password)) {
    return res.status(400).json({ error: 'كلمة المرور غير صحيحة' });
  }
  const row = store.getTotpSecret(req.user.id);
  if (row && row.totp_enabled === 1) {
    const clean = String(code || '').replace(/\D/g, '');
    if (!totpLib.verify(row.totp_secret, clean)) return res.status(400).json({ error: 'كود التحقق غير صحيح' });
  }
  store.disableTotp(req.user.id);
  audit(req, 'إيقاف التحقق بخطوتين', '');
  res.json({ ok: true, enabled: false });
});

// ---------------------------------------------------------------------------
// الكوبونات (عام)
// ---------------------------------------------------------------------------
app.post('/api/coupons/validate', couponLimiter, couponCodeLimiter, writeLimiter, (req, res) => {
  const rawSubtotal = Number((req.body || {}).subtotal);
  const subtotal = Number.isFinite(rawSubtotal) && rawSubtotal >= 0 ? rawSubtotal : 0;
  const result = store.evaluateCoupon((req.body || {}).code, subtotal, req.user ? req.user.id : null);
  if (!result.valid) return res.status(400).json(result);
  res.json(result);
});

// ---------------------------------------------------------------------------
// الطلبات
// ---------------------------------------------------------------------------
const PAYMENT_METHODS = ['whatsapp', 'vodafone-cash', 'instapay', 'cash-on-delivery'];
// طرق الدفع اللي لازم معاها صورة إيصال تحويل من العميل.
const PROOF_REQUIRED_METHODS = ['vodafone-cash', 'instapay'];

const PROOF_URL_RE = /^\/api\/payment-proof\/([a-f0-9-]{36}\.(?:jpg|png|webp))$/i;


app.post('/api/orders', requireAuth, writeLimiter, (req, res) => {
  const settings = store.getSiteSettings();
  if (!settings.storeOpen) return res.status(503).json({ error: 'المتجر مغلق مؤقتًا، برجاء المحاولة لاحقًا.' });
  // (2) البريد المفعّل شرط لإتمام الطلب، عشان نضمن إن بيانات التواصل حقيقية.
  if (emailVerificationEnforced() && req.user.email_verified !== 1) {
    return res.status(403).json({
      error: 'من فضلك فعّل بريدك الإلكتروني أولًا بالكود اللي بعتناه لك، ثم أعد المحاولة.',
      code: 'EMAIL_NOT_VERIFIED'
    });
  }

  const { errors, value } = validate({
    customerName: { required: true, label: 'اسم العميل', minLength: 2, maxLength: 80 },
    customerPhone: { required: true, label: 'رقم الهاتف', type: 'phone', maxLength: 30 },
    customerAddress: { label: 'العنوان', maxLength: 300 },
    paymentMethod: { required: true, label: 'طريقة الدفع', enum: PAYMENT_METHODS },
    notes: { label: 'ملاحظات', maxLength: 500 },
    couponCode: { label: 'كود الخصم', maxLength: 30 },
    transferRef: { label: 'رقم عملية التحويل', maxLength: 40 }
  }, req.body);
  const items = (req.body || {}).items;
  if (!Array.isArray(items) || !items.length) errors.push('السلة فارغة');
  if (Array.isArray(items) && items.length > 50) errors.push('عدد المنتجات في الطلب كبير جدًا');
  // (7) رفض الكميات السالبة أو الصفرية أو الكسرية على مستوى الـ API
  if (Array.isArray(items)) {
    const badQty = items.some((item) => {
      const q = Number(item && item.quantity);
      return !Number.isFinite(q) || !Number.isInteger(q) || q < 1 || q > 999;
    });
    if (badQty) errors.push('الكمية يجب أن تكون رقمًا صحيحًا من 1 إلى 999');
  }
  // (جديد) الدفع بفودافون كاش أو انستا باي لازم معاه صورة إيصال التحويل.
  const rawProof = String((req.body || {}).paymentProofUrl || '').trim();
  let paymentProofUrl = null;
  if (PROOF_REQUIRED_METHODS.includes(value.paymentMethod)) {
    // (جديد) رقم عملية التحويل إجباري مع الإيصال: بيخلي المطابقة مع كشف
    // المحفظة ممكنة، فصورة مفبركة من غير عملية حقيقية بتتكشف فورًا.
    const ref = String(value.transferRef || '').trim();
    if (!/^[0-9A-Za-z-]{6,40}$/.test(ref)) {
      errors.push('اكتب رقم عملية التحويل (٦ خانات على الأقل) زي ما ظاهر في رسالة المحفظة');
    }
    const match = PROOF_URL_RE.exec(rawProof);
    let proofOwner = null;
    if (match) { try { proofOwner = store.getPaymentProofOwner(match[1]); } catch (_) { proofOwner = null; } }
    if (!match) {
      errors.push('من فضلك ارفع صورة إيصال التحويل قبل تأكيد الطلب');
    } else if (!fs.existsSync(path.join(PROOFS_DIR, match[1]))) {
      errors.push('صورة الإيصال لم تُرفع بشكل صحيح، حاول ترفعها تاني');
    } else if (!proofOwner || Number(proofOwner) !== Number(req.user.id)) {
      // (إصلاح IDOR) لازم إثبات التحويل يكون مرفوع من نفس المستخدم صاحب
      // الطلب — وإلا ممكن حد يستخدم اسم ملف إيصال حد تاني.
      return res.status(403).json({ error: 'صورة الإيصال دي مش تبعك' });
    } else if (store.getOrderByProofFilename(match[1])) {
      // نفس الصورة ما تتستخدمش لأكتر من طلب
      errors.push('صورة الإيصال دي مستخدمة في طلب سابق، ارفع صورة التحويل الجديد');
    } else {
      paymentProofUrl = rawProof;
    }
  }
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  try {
    const order = store.createOrder({ userId: req.user.id, ...value, items, paymentProofUrl, transferRef: value.transferRef });
    notifyCustomer(order, 'استلمنا طلبك 📦', `طلبك رقم #${order.id} تم استلامه بنجاح وجاري مراجعته.`);
    return res.json({
      ok: true,
      orderId: order.id,
      totalAmount: order.total_amount,
      subtotal: order.subtotal,
      discount: order.discount,
      shippingFee: order.shipping_fee,
      order
    });
  } catch (error) {
    if (error.code === 'INVALID_QUANTITY') {
      return res.status(400).json({ error: 'الكمية يجب أن تكون رقمًا صحيحًا من 1 إلى 999' });
    }
    if (error.code === 'INVALID_COUPON') {
      return res.status(400).json({ error: error.reason || 'كود الخصم غير صالح' });
    }
    if (error.code === 'INSUFFICIENT_STOCK') {
      // (6) تنبيه صريح للعميل بدل تقليل الكمية بصمت
      const issues = error.issues || [];
      const detail = issues
        .map((i) => (i.available > 0
          ? `${i.name}: المتاح ${i.available} فقط (طلبت ${i.requested})`
          : `${i.name}: نفد من المخزون`))
        .join(' — ');
      return res.status(409).json({
        error: `الكمية المطلوبة غير متاحة. ${detail}`,
        code: 'INSUFFICIENT_STOCK',
        issues
      });
    }
    if (error.code === 'NO_VALID_ITEMS') return res.status(400).json({ error: 'المنتجات المطلوبة غير متاحة أو نفدت من المخزون.' });
    if (error.code === 'PROOF_REUSED' || String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'صورة الإيصال دي مستخدمة في طلب سابق، ارفع صورة التحويل الجديد.' });
    }
    console.error('[create order]', error);
    return res.status(500).json({ error: 'تعذر إنشاء الطلب.' });
  }
});

app.get('/api/orders/mine', requireAuth, (req, res) => res.json({ orders: store.getOrdersByUser(req.user.id) }));

app.get('/api/orders/:id', requireAuth, (req, res) => {
  const order = store.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (order.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'غير مصرح' });
  res.json({ order });
});

// العميل يستطيع إلغاء طلبه طالما لم يخرج للتوصيل
app.post('/api/orders/:id/cancel', requireAuth, writeLimiter, (req, res) => {
  const order = store.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (order.user_id !== req.user.id) return res.status(403).json({ error: 'غير مصرح' });
  if (!['pending', 'confirmed'].includes(order.status)) {
    return res.status(400).json({ error: 'لا يمكن إلغاء الطلب في حالته الحالية' });
  }
  const updated = store.updateOrder(order.id, { status: 'cancelled' }, 'إلغاء بواسطة العميل');
  res.json({ ok: true, order: updated });
});

// ---------------------------------------------------------------------------
// التقييمات والمفضلة
// ---------------------------------------------------------------------------
app.get('/api/products/:id/reviews', (req, res) => res.json({ reviews: store.getReviewsByProduct(req.params.id) }));

app.post('/api/products/:id/reviews', requireAuth, writeLimiter, (req, res) => {
  const rating = Number((req.body || {}).rating);
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'التقييم يجب أن يكون من 1 إلى 5' });
  const hasBought = store.getOrdersByUser(req.user.id)
    .some((order) => order.status !== 'cancelled' && order.items.some((item) => item.productId === Number(req.params.id)));
  if (!hasBought) return res.status(403).json({ error: 'يمكنك تقييم المنتجات التي اشتريتها فقط' });
  try {
    const review = store.addReview({
      productId: req.params.id,
      userId: req.user.id,
      userName: req.user.name,
      rating,
      comment: asText((req.body || {}).comment, 600)
    });
    return res.json({ ok: true, review });
  } catch (_) {
    return res.status(404).json({ error: 'المنتج غير موجود' });
  }
});

app.get('/api/wishlist', requireAuth, (req, res) => res.json({ products: store.getWishlist(req.user.id) }));
app.post('/api/wishlist/:productId', requireAuth, writeLimiter, (req, res) => {
  const product = store.getProductById(req.params.productId);
  if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
  res.json({ ok: true, ...store.toggleWishlist(req.user.id, product.id) });
});

// ---------------------------------------------------------------------------
// الإشعارات
// ---------------------------------------------------------------------------
app.get('/api/push/vapid-public-key', (_req, res) => res.json({ publicKey: vapidKeys.publicKey }));

app.post('/api/push/subscribe', requireAuth, writeLimiter, (req, res) => {
  const subscription = (req.body || {}).subscription;
  const endpoint = String((subscription && subscription.endpoint) || '');
  // (إصلاح) تحقق من شكل الـ endpoint + سقف اشتراكات لكل مستخدم، عشان محدش
  // يحقن آلاف اشتراكات وهمية تكبّر القاعدة وتبطّئ كل إشعار.
  if (!subscription || !/^https:\/\/[^\s]{10,500}$/i.test(endpoint)) {
    return res.status(400).json({ error: 'اشتراك غير صالح' });
  }
  const keys = subscription.keys || {};
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string'
      || keys.p256dh.length > 200 || keys.auth.length > 100) {
    return res.status(400).json({ error: 'اشتراك غير صالح' });
  }
  // addPushSubscription بيشيل أقدم اشتراك تلقائيًا عند السقف، فمفيش حالة LIMIT.
  store.addPushSubscription(req.user.id, { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, writeLimiter, (req, res) => {
  if ((req.body || {}).endpoint) store.removePushSubscription(req.body.endpoint);
  res.json({ ok: true });
});

app.get('/api/notifications/mine', requireAuth, (req, res) => res.json({ notifications: store.getNotificationsByUser(req.user.id) }));
app.post('/api/notifications/read-all', requireAuth, (req, res) => { store.markAllNotificationsRead(req.user.id); res.json({ ok: true }); });
app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
  store.markNotificationRead(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// لوحة التحكم
// ---------------------------------------------------------------------------
app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
  const analytics = store.getAnalytics(days);
  res.json({
    ...analytics,
    lowStockProducts: store.getLowStockProducts(),
    recentOrders: store.getRecentOrders(8),
    activity: store.getActivityLog(12)
  });
});

// (أداء) الفلترة والترقيم بقوا في SQL بدل تحميل جدول الطلبات كله في الذاكرة
// وفلترته بالـ JS في كل طلب من اللوحة.
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const { status, q, payment, from, to } = req.query;
  res.json(store.queryOrders({
    status, q, payment, from, to,
    page: req.query.page,
    perPage: req.query.perPage
  }));
});

const ORDER_STATUSES = ['pending', 'confirmed', 'shipping', 'done', 'cancelled'];
const PAYMENT_STATUSES = ['pending', 'paid', 'refunded'];

app.put('/api/admin/orders/:id', requireAdmin, adminWriteLimiter, (req, res) => {
  const { status, paymentStatus, notes } = req.body || {};
  if (status && !ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'حالة الطلب غير صالحة' });
  if (paymentStatus && !PAYMENT_STATUSES.includes(paymentStatus)) return res.status(400).json({ error: 'حالة الدفع غير صالحة' });

  const order = store.updateOrder(req.params.id, {
    status: status || undefined,
    payment_status: paymentStatus || undefined,
    notes: notes !== undefined ? asText(notes, 500) : undefined
  }, 'تحديث من لوحة التحكم');
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

  if (status === 'shipping') notifyCustomer(order, 'طلبك خرج للتوصيل 🚚', `طلبك رقم #${order.id} في الطريق إليك الآن.`);
  if (status === 'done') notifyCustomer(order, 'تم تسليم طلبك ✅', `طلبك رقم #${order.id} تم تسليمه بنجاح، شكرًا لطلبك منّا!`);
  if (status === 'cancelled') notifyCustomer(order, 'تم إلغاء طلبك', `طلبك رقم #${order.id} تم إلغاؤه. تواصل معنا لو كان هذا غير متوقع.`);

  audit(req, 'تحديث طلب', `#${order.id} → ${status || order.status}`);
  res.json({ ok: true, order });
});

app.post('/api/admin/orders/:id/confirm', requireAdmin, adminWriteLimiter, (req, res) => {
  const minutes = Number((req.body || {}).notifyMinutes) || 0;
  if (minutes < 0 || minutes > 1440) return res.status(400).json({ error: 'المدة يجب أن تكون بين 0 و 1440 دقيقة.' });
  const order = store.scheduleOrderNotification(req.params.id, {
    notifyMinutes: minutes,
    notifyMessage: asText((req.body || {}).notifyMessage, 300)
  });
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

  notifyCustomer(order, 'تم تأكيد طلبك ✅', `طلبك رقم #${order.id} تم تأكيده وجاري تجهيزه الآن.`);
  if (order.notify_at) armNotificationTimer(order);
  audit(req, 'تأكيد طلب', `#${order.id} (${minutes} دقيقة)`);
  res.json({ ok: true, order });
});

app.get('/api/admin/orders/export.csv', requireAdmin, adminBulkLimiter, (req, res) => {
  const { status, q, payment, from, to } = req.query;
  const orders = store.getOrdersForExport({ status, q, payment, from, to });
  const header = ['رقم الطلب', 'العميل', 'الهاتف', 'العنوان', 'الحالة', 'الدفع', 'طريقة الدفع', 'الخصم', 'الشحن', 'الإجمالي', 'التاريخ'];
  // (10) حماية من CSV Injection: أي خلية بتبدأ بـ = + - @ أو tab/CR بيقرأها
  // Excel/Sheets كصيغة قابلة للتنفيذ. بنسبقها بعلامة اقتباس مفردة عشان تفضل
  // نص عادي، مع الهروب القياسي لعلامات الاقتباس.
  const escapeCsv = (value) => {
    let text = String(value ?? '').replace(/\r\n|\r|\n/g, ' ');
    if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = orders.map((o) => [
    o.id, o.customer_name, o.customer_phone, o.customer_address, o.status, o.payment_status,
    o.payment_method, o.discount, o.shipping_fee, o.total_amount, o.created_at
  ].map(escapeCsv).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send('\uFEFF' + [header.join(','), ...rows].join('\n'));
});

// ---------------------------------------------------------------------------
// رفع صور المنتجات من الجهاز
// ---------------------------------------------------------------------------
const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': { ext: '.jpg', magic: [[0, [0xff, 0xd8, 0xff]]] },
  'image/png': { ext: '.png', magic: [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]] },
  'image/webp': { ext: '.webp', magic: [[0, [0x52, 0x49, 0x46, 0x46]], [8, [0x57, 0x45, 0x42, 0x50]]] }
};

const upload = multer({
  storage: multer.diskStorage({
    // (أمان) بيتكتب في مجلد الحجر الصحي مش في UPLOADS_DIR مباشرة، عشان أي
    // ملف مرفوض يتمسح قبل ما يبقى متاح عبر أي static route.
    destination: (_req, _file, cb) => cb(null, QUARANTINE_DIR),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID())
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // النوع الحقيقي بيتأكد من محتوى الملف بعد الرفع (detectImageType)، فبنسمح
    // هنا بأي نوع صورة أو نوع مجهول بدل ما نرفض صور موبايل سليمة. الاعتماد
    // الفعلي في القرار النهائي على sniffing المحتوى فقط (finalizeUploadedImage).
    const mt = String(file.mimetype || '').toLowerCase();
    if (mt.startsWith('image/') || mt === 'application/octet-stream' || mt === '') return cb(null, true);
    cb(new Error('الملف المختار مش صورة — اختر صورة JPG أو PNG أو WEBP'));
  }
});

// يتحقق من أول بايتات الملف الفعلية (magic bytes) بدل الاكتفاء بامتداد الملف
// أو الـ mimetype اللي المتصفح بيبعته (ممكن يتزوّر بسهولة).
function fileMatchesDeclaredType(filePath, mimetype) {
  const rule = ALLOWED_IMAGE_TYPES[mimetype];
  if (!rule) return false;
  const fd = fs.openSync(filePath, 'r');
  try {
    return rule.magic.every(([offset, bytes]) => {
      const buf = Buffer.alloc(bytes.length);
      fs.readSync(fd, buf, 0, bytes.length, offset);
      return bytes.every((b, i) => buf[i] === b);
    });
  } finally {
    fs.closeSync(fd);
  }
}

// (إصلاح موبايل) كتير من متصفحات وتطبيقات الموبايل بتبعت الصورة بنوع غلط
// (application/octet-stream من مدير الملفات في أندرويد مثلًا) فالرفع كان
// بيترفض قبل ما يوصل أصلًا. بنحدد النوع الحقيقي من أول بايتات الملف نفسه،
// وده كمان أأمن من الاعتماد على اللي المتصفح بيقوله.
function detectImageType(filePath) {
  for (const [mimetype, rule] of Object.entries(ALLOWED_IMAGE_TYPES)) {
    try {
      if (fileMatchesDeclaredType(filePath, mimetype)) return { mimetype, ext: rule.ext };
    } catch (_) { /* الملف اتقفل أو اتمسح */ }
  }
  return null;
}

// بيصلّح امتداد الملف بعد ما نعرف نوعه الحقيقي، وبيرجّع الاسم النهائي أو null
// لو الملف مش صورة مدعومة (وساعتها بيتمسح فورًا).
function finalizeUploadedImage(srcDir, filename, destDir) {
  const current = path.join(srcDir, filename);
  if (path.dirname(current) !== path.resolve(srcDir)) return null;
  const detected = detectImageType(current);
  if (!detected) {
    // (أمان) الملف مرفوض من محتواه الفعلي — بيتمسح فورًا من الحجر الصحي
    // ومستحيل يتقدّم لمجلد بيتقدّم منه static route.
    fs.unlink(current, () => {});
    return null;
  }
  const finalName = `${filename}${detected.ext}`;
  const target = path.join(path.resolve(destDir), finalName);
  try {
    fs.renameSync(current, target);
  } catch (_) {
    try {
      fs.copyFileSync(current, target);
      fs.unlinkSync(current);
    } catch (moveError) {
      fs.unlink(current, () => {});
      return null;
    }
  }
  return finalName;
}

// ---------------------------------------------------------------------------
// إثبات التحويل (فودافون كاش / انستا باي) — رفع من جهاز العميل
// ---------------------------------------------------------------------------
const uploadProof = multer({
  storage: multer.diskStorage({
    // (أمان) نفس مبدأ رفع صور المنتجات: يتكتب في الحجر الصحي أولًا.
    destination: (_req, _file, cb) => cb(null, QUARANTINE_DIR),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID())
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mt = String(file.mimetype || '').toLowerCase();
    if (mt.startsWith('image/') || mt === 'application/octet-stream' || mt === '') return cb(null, true);
    cb(new Error('الملف المختار مش صورة — صوّر سكرين شوت للتحويل وارفعه'));
  }
});

app.post('/api/payment-proof', requireAuth, writeLimiter, (req, res) => {
  uploadProof.single('proof')(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ error: tooBig ? 'حجم الصورة كبير — الحد الأقصى 5 ميجابايت' : (err.message || 'تعذر رفع الصورة') });
    }
    if (!req.file) return res.status(400).json({ error: 'من فضلك اختر صورة إيصال التحويل' });
    const finalName = finalizeUploadedImage(QUARANTINE_DIR, req.file.filename, PROOFS_DIR);
    if (!finalName) {
      return res.status(400).json({ error: 'الصورة دي بصيغة مش مدعومة (زي HEIC). خد سكرين شوت للتحويل وارفعه، أو اختار صورة JPG/PNG.' });
    }
    req.file.filename = finalName;
    const filePath = path.join(PROOFS_DIR, finalName);
    // (إصلاح) بصمة الصورة: أشهر تحايل على الدفع اليدوي هو رفع نفس صورة
    // التحويل تاني (أو صورة اتسربت من حد تاني). البصمة بتمنع ده قبل ما الطلب
    // يتسجّل أصلًا، مش بعد ما الأدمن يراجعه.
    let proofHash = null;
    try {
      proofHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch (e) {
      console.error('[payment-proof] تعذر حساب بصمة الصورة:', e.message);
    }
    // (إصلاح IDOR) بنسجّل مين رفع الصورة، فحتى قبل ما ترتبط بطلب مفيش حد
    // تاني يقدر يفتحها حتى لو عرف اسم الملف.
    // (إصلاح سباق) رفض التكرار بقى من القيد الفريد على البصمة داخل القاعدة،
    // مش من فحص SELECT قبل الكتابة (اللي رفعتين متزامنتين كانوا يعدّوا منه).
    try {
      store.recordPaymentProof(req.file.filename, req.user.id, proofHash);
    } catch (e) {
      fs.unlink(filePath, () => {});
      if (e.code === 'DUPLICATE_PROOF') {
        return res.status(409).json({ error: 'صورة التحويل دي اتستخدمت قبل كده. ارفع صورة التحويل الجديد بتاعك.' });
      }
      console.error('[payment-proof] تعذر تسجيل مالك الإيصال:', e.message);
      return res.status(500).json({ error: 'تعذر رفع الصورة، حاول تاني' });
    }
    res.json({ ok: true, url: `/api/payment-proof/${req.file.filename}` });
  });
});

// (إصلاح) مكنسة الإيصالات اليتيمة: أي إيصال اترفع ومحصلش طلب خلال 24 ساعة
// بيتمسح من الديسك ومن القاعدة، بدل ما يتراكم للأبد.
const PROOF_ORPHAN_TTL_MS = Number(process.env.PROOF_ORPHAN_HOURS || 24) * 60 * 60 * 1000;
function sweepOrphanPaymentProofs() {
  let removed = 0;
  try {
    for (const filename of store.getOrphanPaymentProofs(PROOF_ORPHAN_TTL_MS)) {
      const target = path.join(PROOFS_DIR, path.basename(filename));
      if (path.dirname(target) !== PROOFS_DIR) continue;
      try { fs.unlinkSync(target); } catch (_) { /* الملف مش موجود */ }
      store.deletePaymentProof(filename);
      removed += 1;
    }
  } catch (error) {
    console.error('[payment-proof sweep]', error.message);
  }
  return removed;
}
setTimeout(sweepOrphanPaymentProofs, 60 * 1000).unref();
setInterval(sweepOrphanPaymentProofs, 6 * 60 * 60 * 1000).unref();

// عرض صورة الإيصال: الأدمن يشوف أي إيصال، والعميل يشوف إيصاله هو بس.
// الصور اللي لسه ما اترفقتش بأي طلب يقدر يشوفها صاحب الجلسة اللي رفعها فقط
// بعد ربطها بالطلب — قبل كده مفيش أي وصول عام.
app.get('/api/payment-proof/:file', requireAuth, (req, res) => {
  const filename = path.basename(String(req.params.file || ''));
  if (!/^[a-f0-9-]{36}\.(jpg|png|webp)$/i.test(filename)) return res.status(400).json({ error: 'اسم ملف غير صالح' });
  const filePath = path.join(PROOFS_DIR, filename);
  if (path.dirname(filePath) !== PROOFS_DIR || !fs.existsSync(filePath)) return res.status(404).json({ error: 'الصورة غير موجودة' });
  if (req.user.role !== 'admin') {
    const order = store.getOrderByProofFilename(filename);
    // الملكية بقت في قاعدة البيانات (بدل ملف .owner جانبي). بنقرأ الملف القديم
    // كخطة رجوع للإيصالات اللي اترفعت قبل الترقية، ونهاجرها لقاعدة البيانات.
    // الملكية بتتقرأ من قاعدة البيانات بس (ملفات .owner القديمة اتشالت خالص —
    // مفيش حاجة بتكتبها، فقراءتها كانت سطح هجوم زيادة بلا فايدة).
    let owner = null;
    try { owner = store.getPaymentProofOwner(filename); } catch (_) { owner = null; }
    const isOrderOwner = order && Number(order.user_id) === Number(req.user.id);
    const isUploader = owner && Number(owner) === Number(req.user.id);
    // لازم يكون صاحب الطلب أو اللي رفع الصورة أصلًا — مجرد معرفة اسم الملف
    // مش كافية خالص.
    if (!isOrderOwner && !isUploader) return res.status(403).json({ error: 'غير مسموح' });
  }
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(filePath);
});

app.post('/api/admin/upload-image', requireAdmin, writeLimiter, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'تعذر رفع الصورة' });
    if (!req.file) return res.status(400).json({ error: 'من فضلك اختر صورة' });
    const storedName = finalizeUploadedImage(QUARANTINE_DIR, req.file.filename, UPLOADS_DIR);
    if (!storedName) return res.status(400).json({ error: 'الملف المرفوع ليس صورة صالحة (JPG / PNG / WEBP)' });
    // (إصلاح 8) الصورة بتتضغط وتتصغّر (WebP) بدل ما تتخزن زي ما هي.
    const finalName = await imageOptimize.optimizeInPlace(UPLOADS_DIR, storedName);
    audit(req, 'رفع صورة منتج', finalName);
    res.json({ ok: true, url: `/uploads/products/${finalName}` });
  });
});

// يمسح صورة قديمة من مجلد uploads لو مش مستخدمة في أي منتج تاني (يُستدعى بعد
// تعديل/حذف منتج غيّر صورته لمنع تراكم ملفات يتيمة على القرص).
function cleanupOldProductImage(oldUrl, newUrl) {
  if (!oldUrl || oldUrl === newUrl || !oldUrl.startsWith('/uploads/products/')) return;
  const stillUsed = store.getProducts(false).some((p) => p.image_url === oldUrl);
  if (stillUsed) return;
  const filename = path.basename(oldUrl);
  const filePath = path.join(UPLOADS_DIR, filename);
  if (path.dirname(filePath) === UPLOADS_DIR) fs.unlink(filePath, () => {});
}

app.get('/api/admin/products', requireAdmin, (_req, res) => res.json({ products: store.getProducts(false) }));

// (12) نفس قواعد التحقق للإضافة والتعديل — الفرق الوحيد إن التعديل جزئي
// (الحقول اللي مش مبعوتة بتفضل زي ما هي)، فالحقول تبقى مطلوبة في POST بس.
const productRules = (partial) => ({
  name: { required: !partial, label: 'اسم المنتج', minLength: 2, maxLength: 120 },
  category: { required: !partial, label: 'القسم', maxLength: 60 },
  price: { required: !partial, label: 'السعر', type: 'number', min: 0, max: 10000000 },
  stock: { label: 'المخزون', type: 'number', min: 0, max: 1000000 },
  oldPrice: { label: 'السعر قبل الخصم', type: 'number', min: 0, max: 10000000 },
  sku: { label: 'كود المنتج', maxLength: 40 },
  tag: { label: 'الوسم', maxLength: 40 },
  description: { label: 'الوصف', maxLength: 1200 }
});

app.post('/api/admin/products', requireAdmin, writeLimiter, (req, res) => {
  const { errors } = validate(productRules(false), req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  const product = store.createProduct(req.body);
  audit(req, 'إضافة منتج', product.name);
  res.json({ ok: true, productId: product.id, product });
});

app.put('/api/admin/products/:id', requireAdmin, writeLimiter, (req, res) => {
  // (12) كان التعديل بيمرّر req.body للـ store من غير أي تحقق، على عكس الإضافة.
  const { errors } = validate(productRules(true), req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  const before = store.getProductById(req.params.id);
  const product = store.updateProduct(req.params.id, req.body || {});
  if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
  if (before) cleanupOldProductImage(before.image_url, product.image_url);
  audit(req, 'تعديل منتج', product.name);
  res.json({ ok: true, product });
});

app.post('/api/admin/products/:id/stock', requireAdmin, adminWriteLimiter, (req, res) => {
  const delta = Number((req.body || {}).delta);
  if (!Number.isFinite(delta)) return res.status(400).json({ error: 'قيمة غير صالحة' });
  const product = store.adjustStock(req.params.id, delta);
  if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
  audit(req, 'تعديل مخزون', `${product.name}: ${delta > 0 ? '+' : ''}${delta}`);
  res.json({ ok: true, product });
});

app.delete('/api/admin/products/:id', requireAdmin, adminWriteLimiter, (req, res) => {
  const product = store.getProductById(req.params.id);
  const deleted = store.deleteProduct(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'المنتج غير موجود' });
  if (product) cleanupOldProductImage(product.image_url, null);
  audit(req, 'حذف منتج', product ? product.name : req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/coupons', requireAdmin, (_req, res) => res.json({ coupons: store.getCoupons() }));

app.post('/api/admin/coupons', requireAdmin, writeLimiter, (req, res) => {
  try {
    const coupon = store.createCoupon(req.body || {});
    audit(req, 'إضافة كوبون', coupon.code);
    return res.json({ ok: true, coupon });
  } catch (error) {
    return res.status(400).json({ error: error.message === 'Coupon already exists' ? 'هذا الكود موجود بالفعل' : 'بيانات الكوبون غير صحيحة' });
  }
});

app.put('/api/admin/coupons/:id', requireAdmin, adminWriteLimiter, (req, res) => {
  const coupon = store.updateCoupon(req.params.id, req.body || {});
  if (!coupon) return res.status(404).json({ error: 'الكوبون غير موجود' });
  res.json({ ok: true, coupon });
});

app.delete('/api/admin/coupons/:id', requireAdmin, adminWriteLimiter, (req, res) => {
  if (!store.deleteCoupon(req.params.id)) return res.status(404).json({ error: 'الكوبون غير موجود' });
  audit(req, 'حذف كوبون', req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/reviews', requireAdmin, (_req, res) => res.json({ reviews: store.getAllReviews() }));
app.delete('/api/admin/reviews/:id', requireAdmin, adminWriteLimiter, (req, res) => {
  if (!store.deleteReview(req.params.id)) return res.status(404).json({ error: 'التقييم غير موجود' });
  audit(req, 'حذف تقييم', req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  // (أداء) التجميع بقى في SQL بدل O(عملاء × طلبات) في الذاكرة.
  res.json({ users: store.getUsersWithStats() });
});

app.post('/api/admin/users', requireAdmin, writeLimiter, (req, res) => {
  const { errors, value } = validate({
    name: { required: true, label: 'الاسم', minLength: 2, maxLength: 80 },
    email: { required: true, label: 'البريد الإلكتروني', type: 'email', maxLength: 190 },
    password: { required: true, label: 'كلمة المرور', minLength: 8, maxLength: 100 },
    role: { label: 'الصلاحية', enum: ['customer', 'admin'], default: 'customer' }
  }, req.body);
  if (errors.length) return res.status(400).json({ error: errors[0] });
  try {
    // حساب أنشأه الأدمن بنفسه يُعتبر بريده موثوقًا (مفيش رابط تفعيل للعميل).
    const userId = store.createUser({ ...value, role: value.role || 'customer', emailVerified: true });
    audit(req, 'إضافة مستخدم', value.email);
    return res.json({ ok: true, userId });
  } catch (error) {
    if (error.message === 'Email already exists') return res.status(409).json({ error: 'البريد الإلكتروني مسجل بالفعل' });
    return res.status(500).json({ error: 'تعذر إنشاء المستخدم' });
  }
});

app.put('/api/admin/users/:id', requireAdmin, adminWriteLimiter, (req, res) => {
  const body = req.body || {};
  const { password, role } = body;
  if (password && String(password).length < 8) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
  if (role && !['customer', 'admin'].includes(role)) return res.status(400).json({ error: 'الصلاحية غير صالحة' });
  // (إصلاح) المسار ده كان بيعدي الاسم/البريد/الهاتف/العنوان من غير أي تحقق
  // من الصيغة (بريد من غير @ كان بيتخزن عادي). بنستخدم نفس قواعد التسجيل.
  const patch = {};
  ['name', 'email', 'phone', 'address'].forEach((k) => { if (body[k] !== undefined) patch[k] = body[k]; });
  if (Object.keys(patch).length) {
    const rules = {};
    if (patch.name !== undefined) rules.name = { required: true, label: 'الاسم', minLength: 2, maxLength: 80 };
    if (patch.email !== undefined) rules.email = { required: true, label: 'البريد الإلكتروني', type: 'email', maxLength: 190 };
    if (patch.phone !== undefined) rules.phone = { label: 'رقم الهاتف', maxLength: 30 };
    if (patch.address !== undefined) rules.address = { label: 'العنوان', maxLength: 300 };
    const { errors } = validate(rules, patch);
    if (errors.length) return res.status(400).json({ error: errors[0] });
  }
  try {
    const user = store.updateUser(req.params.id, body);
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (req.user.id === user.id) setSessionCookie(res, { userId: user.id, role: user.role, email: user.email, sv: user.session_version || 0 });
    audit(req, 'تعديل مستخدم', user.email);
    return res.json({ ok: true, user });
  } catch (error) {
    if (error.message === 'Email already exists') return res.status(409).json({ error: 'البريد الإلكتروني مسجل بالفعل' });
    return res.status(500).json({ error: 'تعذر تعديل المستخدم' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, adminWriteLimiter, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'لا يمكنك حذف حسابك الحالي' });
  try {
    if (!store.deleteUser(req.params.id)) return res.status(404).json({ error: 'المستخدم غير موجود' });
    audit(req, 'حذف مستخدم', req.params.id);
    return res.json({ ok: true });
  } catch (_) {
    return res.status(400).json({ error: 'لا يمكن حذف آخر حساب مسؤول' });
  }
});

app.post('/api/admin/broadcast', requireAdmin, writeLimiter, (req, res) => {
  const title = asText((req.body || {}).title, 80);
  const body = asText((req.body || {}).body, 300);
  if (!title || !body) return res.status(400).json({ error: 'العنوان والنص مطلوبان' });
  const userIds = store.broadcastNotification({ title, body });
  userIds.forEach((id) => sendPushToUser(id, { title, body, url: '/index.html' }));
  audit(req, 'إشعار جماعي', title);
  res.json({ ok: true, sent: userIds.length });
});

app.get('/api/admin/activity', requireAdmin, (_req, res) => res.json({ activity: store.getActivityLog(120) }));

app.post('/api/admin/backup', requireAdmin, adminBulkLimiter, async (req, res) => {
  const ok = store.backup();
  // النسخة بتتحاول تترفع برّه السيرفر فورًا لو BACKUP_UPLOAD_URL متظبط.
  const offsite = ok ? await uploadBackupOffsite() : { ok: false, skipped: true };
  audit(req, 'إنشاء نسخة احتياطية', offsite.ok ? 'مع رفع خارجي' : '');
  res.json({ ok, offsite: offsite.ok, offsiteConfigured: Boolean(BACKUP_UPLOAD_URL) });
});

app.get('/api/admin/export.json', requireAdmin, adminBulkLimiter, (_req, res) => {
  const snapshot = store.getRawSnapshot();
  delete snapshot.sessionSecret;
  delete snapshot.vapid;
  // (أمان) sanitizeUser بيشيل password_hash *و* أسرار الـ 2FA (totp_secret وغيره)
  // عشان تصدير البيانات ما يبقاش طريق لنسخ المصادقة الثنائية لأي حساب.
  snapshot.users = snapshot.users.map((u) => store.sanitizeUser(u));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="yousef-store-export.json"');
  res.send(JSON.stringify(snapshot, null, 2));
});

// ---------------------------------------------------------------------------
// الفاتورة
// ---------------------------------------------------------------------------
app.get('/invoice/:id', requireAuth, (req, res) => {
  const order = store.getOrderById(req.params.id);
  if (!order) return res.status(404).send('الطلب غير موجود');
  const isOwner = order.user_id && order.user_id === req.user.id;
  if (!isOwner && req.user.role !== 'admin') return res.status(403).send('غير مصرح بعرض هذه الفاتورة');

  const settings = store.getSiteSettings();
  const money = (value) => `${Number(value || 0).toLocaleString('en-US')} ${settings.currency}`;
  const rows = (order.items || []).map((item) => `<tr>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.quantity)}</td>
      <td>${money(item.price)}</td>
      <td>${money(Number(item.price) * Number(item.quantity || 1))}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"/>
<title>فاتورة #${order.id}</title>
<style>
  body{font-family:Tahoma,Arial,sans-serif;padding:36px;color:#111;background:#fff}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #c8793f;padding-bottom:16px;margin-bottom:22px}
  h1{margin:0;font-size:26px}.muted{color:#666;font-size:13px}
  table{width:100%;border-collapse:collapse;margin-top:18px}
  th,td{border:1px solid #ddd;padding:10px;text-align:right;font-size:14px}
  th{background:#f7f7f7}
  .totals{margin-top:18px;margin-inline-start:auto;width:320px}
  .totals div{display:flex;justify-content:space-between;padding:6px 0;font-size:15px}
  .grand{border-top:2px solid #111;font-weight:800;font-size:19px;margin-top:6px;padding-top:10px}
  .btn{margin-top:26px;padding:10px 20px;background:#c8793f;border:none;border-radius:8px;font-weight:700;cursor:pointer}
  @media print{.btn{display:none}}
</style></head><body>
<div class="head">
  <div>
    <h1>${escapeHtml(settings.name)}</h1>
    <div class="muted">${escapeHtml(settings.address)} · ${escapeHtml(settings.phone)}</div>
  </div>
  <div style="text-align:left">
    <h1>فاتورة #${order.id}</h1>
    <div class="muted">${new Date(order.created_at).toLocaleString('ar-EG')}</div>
  </div>
</div>
<p><strong>العميل:</strong> ${escapeHtml(order.customer_name)} · ${escapeHtml(order.customer_phone)}</p>
<p><strong>العنوان:</strong> ${escapeHtml(order.customer_address)}</p>
<p><strong>طريقة الدفع:</strong> ${escapeHtml(order.payment_method)} · <strong>الحالة:</strong> ${escapeHtml(order.status)}</p>
<table><thead><tr><th>المنتج</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead><tbody>${rows}</tbody></table>
<div class="totals">
  <div><span>المجموع الفرعي</span><span>${money(order.subtotal)}</span></div>
  ${order.discount ? `<div><span>الخصم${order.coupon_code ? ` (${escapeHtml(order.coupon_code)})` : ''}</span><span>- ${money(order.discount)}</span></div>` : ''}
  <div><span>الشحن</span><span>${order.shipping_fee ? money(order.shipping_fee) : 'مجاني'}</span></div>
  ${order.tax ? `<div><span>الضريبة</span><span>${money(order.tax)}</span></div>` : ''}
  <div class="grand"><span>الإجمالي</span><span>${money(order.total_amount)}</span></div>
</div>
<button class="btn" id="printBtn">طباعة الفاتورة</button>
<script nonce="${res.locals.cspNonce}">document.getElementById('printBtn').addEventListener('click', function(){ window.print(); });</script>
</body></html>`);
});

// ---------------------------------------------------------------------------
// معالجة الأخطاء و 404
// ---------------------------------------------------------------------------
app.use('/api', (_req, res) => res.status(404).json({ error: 'المسار غير موجود' }));
// (إصلاح) أي ملف ناقص بامتداد (JS/CSS/صورة) بيرجّع 404 حقيقي بنوعه الصحيح
// بدل HTML — كفاية أخطاء غامضة و soft-404 عند جوجل. الصفحات (بدون امتداد)
// بس هي اللي بتاخد صفحة 404 بشكل الموقع.
app.get('*', (req, res) => {
  const ext = path.extname(req.path).toLowerCase();
  if (ext && ext !== '.html') {
    res.status(404).type('text/plain; charset=utf-8').send('404 Not Found');
    return;
  }
  res.status(404);
  res.setHeader('X-Robots-Tag', 'noindex');
  sendHtml(res, path.join(PUBLIC_DIR, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error('[server error]', error);
  if (res.headersSent) return;
  res.status(500).json({ error: 'حدث خطأ غير متوقع في الخادم' });
});

// ---------------------------------------------------------------------------
// التشغيل والإغلاق الآمن
// ---------------------------------------------------------------------------
const server = app.listen(PORT, HOST, () => {
  console.log(`\n🚗 متجر يوسف يعمل على http://localhost:${PORT}`);
  console.log(`   لوحة التحكم: http://localhost:${PORT}/admin-login.html`);
});

function shutdown(signal) {
  console.log(`\n[${signal}] جاري الإغلاق الآمن وحفظ البيانات...`);
  try { rateLimitFactory.flush(); } catch (_) { /* لا شيء */ }
  store.flush();
  store.backup();
  try { instanceLock.release(); } catch (_) { /* لا شيء */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => shutdown(signal)));
process.on('uncaughtException', (error) => { console.error('[uncaught]', error); store.flush(); });
process.on('unhandledRejection', (error) => console.error('[unhandled]', error));

module.exports = app;
