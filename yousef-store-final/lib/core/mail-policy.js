// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
module.exports = function createMailPolicy(deps = {}) {
  const { activeProvider, shouldExposeLink } = deps;
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
  const mailHealth = {
    failures: 0,
    degradedUntil: 0
  };
  function noteMailFailure() {
    mailHealth.failures += 1;
    if (mailHealth.failures >= MAIL_FAILURE_THRESHOLD) {
      mailHealth.degradedUntil = Date.now() + MAIL_DEGRADED_WINDOW_MS;
      console.error('\x1b[31m⚠️  مزوّد البريد واقع — تم تعليق إلزامية تفعيل البريد مؤقتًا عشان العملاء يقدروا يطلبوا. الطلبات دي هتتعلّم «بريد غير مؤكد» للأدمن.\x1b[0m');
    }
  }
  function noteMailSuccess() {
    mailHealth.failures = 0;
    mailHealth.degradedUntil = 0;
  }
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
  // (إصلاح 4) التحقق بخطوتين (TOTP) رجع يشتغل فعليًا: اختياري لأي حساب،
  // وموصى بيه بشدة لحساب الأدمن. البنية التحتية (lib/totp.js + auth-tokens-repo)
  // كانت جاهزة ومُختبرة، لكن كان في مسحة قسرية هنا عند كل إقلاع كانت بتشيل أي
  // تفعيل قديم — اتشالت، فدلوقتي التفعيل بيفضل زي ما هو بين عمليات التشغيل.
  return { EMAIL_VERIFICATION_AVAILABLE, REQUIRE_EMAIL_VERIFICATION, noteMailFailure, noteMailSuccess, emailVerificationEnforced, EMAIL_VERIFY_MODE };
};
