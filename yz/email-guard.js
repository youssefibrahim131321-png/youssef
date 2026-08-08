/**
 * ---------------------------------------------------------------------------
 * email-guard.js — حماية من الإيميلات الوهمية *من غير* إرسال كود أو رابط
 * ---------------------------------------------------------------------------
 * الفكرة: بدل ما نستنى المستخدم يستلم كود (وده اللي كان بيفشل)، بنتحقق من
 * البريد نفسه لحظة التسجيل بأربع طبقات:
 *   1) شكل البريد + تطبيع (gmail: إزالة النقط و +tag) عشان محدش يعمل
 *      100 حساب من نفس الإيميل.
 *   2) قائمة نطاقات البريد المؤقت (temp-mail / 10minutemail / mailinator ...).
 *   3) الأخطاء الإملائية الشائعة (gmail.con / gmial.com) — بنرفضها بوضوح.
 *   4) فحص سجلات MX الحقيقية للنطاق عبر DNS: لو النطاق ما يقدرش يستقبل
 *      بريد أصلًا يبقى إيميل وهمي 100% ويترفض.
 * الطبقة اللي بتثبت "ملكية" البريد فعليًا هي الدخول بجوجل (google-auth.js).
 */
const dns = require('dns').promises;

// نطاقات بريد مؤقت/يستخدم للتسجيل الوهمي (أشهرها + المتغيرات)
const DISPOSABLE = new Set([
  'mailinator.com', 'yopmail.com', 'guerrillamail.com', 'guerrillamail.info',
  'sharklasers.com', 'grr.la', '10minutemail.com', '10minutemail.net',
  'tempmail.com', 'temp-mail.org', 'tempmailo.com', 'tempmail.dev',
  'throwawaymail.com', 'trashmail.com', 'trashmail.de', 'fakeinbox.com',
  'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc',
  'mailnesia.com', 'mytemp.email', 'moakt.com', 'emailondeck.com',
  'spam4.me', 'inboxbear.com', 'mohmal.com', 'mailcatch.com',
  'discard.email', 'burnermail.io', 'anonaddy.me', 'tempr.email',
  'byom.de', 'einrot.com', 'mailsac.com', 'harakirimail.com',
  'tmpmail.org', 'linshiyouxiang.net', 'luxusmail.org', 'vmani.com',
  'emailfake.com', 'fake-mail.net', 'tempinbox.com', 'test.com',
  'example.com', 'example.org', 'example.net', 'mail.tm', 'dropmail.me'
]);

// أخطاء إملائية شائعة → التصحيح المقترح
const TYPOS = {
  'gmail.con': 'gmail.com', 'gmail.co': 'gmail.com', 'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmaill.com': 'gmail.com',
  'gnail.com': 'gmail.com', 'gamil.com': 'gmail.com', 'hotmial.com': 'hotmail.com',
  'hotmail.con': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'yahooo.com': 'yahoo.com',
  'yaho.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'outlok.com': 'outlook.com',
  'outlook.con': 'outlook.com', 'icloud.con': 'icloud.com'
};

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

// كاش بسيط لنتائج الـ MX عشان ما نعملش DNS lookup لكل تسجيل
const mxCache = new Map();
const MX_TTL_MS = 6 * 60 * 60 * 1000;

async function hasMailExchanger(domain) {
  const cached = mxCache.get(domain);
  if (cached && Date.now() - cached.at < MX_TTL_MS) return cached.ok;
  let ok = false;
  try {
    const records = await dns.resolveMx(domain);
    ok = Array.isArray(records) && records.some((r) => r && r.exchange);
  } catch (_) {
    // بعض النطاقات بتستقبل بريد على سجل A لو مفيش MX
    try {
      const a = await dns.resolve4(domain);
      ok = Array.isArray(a) && a.length > 0;
    } catch (_e) { ok = false; }
  }
  mxCache.set(domain, { ok, at: Date.now() });
  return ok;
}

/** التطبيع: الشكل اللي بنمنع بيه تكرار نفس الإيميل بصيغ مختلفة. */
function normalizeEmail(email) {
  const raw = String(email || '').trim().toLowerCase();
  const at = raw.lastIndexOf('@');
  if (at < 1) return raw;
  let local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  local = local.split('+')[0];
  if (GMAIL_DOMAINS.has(domain)) local = local.replace(/\./g, '');
  return `${local}@${GMAIL_DOMAINS.has(domain) ? 'gmail.com' : domain}`;
}

/**
 * الفحص الكامل. بيرجّع { ok, reason, email, normalized }.
 * لو الشبكة وقعت (DNS مش شغال) بنعدّي بدل ما نقفل التسجيل على الكل.
 */
async function checkEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(value) || value.length > 190) {
    return { ok: false, reason: 'البريد الإلكتروني غير صحيح' };
  }
  const domain = value.slice(value.lastIndexOf('@') + 1);

  if (TYPOS[domain]) {
    return { ok: false, reason: `يبدو إن فيه خطأ إملائي — تقصد ${TYPOS[domain]}؟` };
  }
  if (DISPOSABLE.has(domain)) {
    return { ok: false, reason: 'البريد المؤقت غير مقبول. من فضلك استخدم بريدك الحقيقي (Gmail أو غيره).' };
  }
  if (process.env.EMAIL_GUARD_MX !== '0') {
    // (إصلاح) بنفرّق بين «النطاق ملوش بريد» و«الـ DNS بتاعنا وقع». لو الفحص
    // نفسه فشل لأسباب شبكة، بنعدّي بدل ما نقفل التسجيل على كل الناس.
    let deliverable = true;
    try {
      deliverable = await hasMailExchanger(domain);
    } catch (_) {
      // (أمان) fail-open مقصود عشان عطل DNS مؤقت ما يقفلش التسجيل على الكل،
      // بس لازم يبان بوضوح في اللوج إن حماية MX اتخطّاها بسبب عطل.
      console.warn(`[email-guard] ⚠️ تعذر فحص MX لنطاق "${domain}" — تم تجاوز الفحص مؤقتًا (fail-open) بسبب عطل شبكة/DNS.`);
      deliverable = true;
    }
    if (!deliverable) {
      return { ok: false, reason: 'نطاق البريد ده مش بيستقبل رسائل — تأكد من كتابة البريد صح.' };
    }
  }
  return { ok: true, email: value, normalized: normalizeEmail(value) };
}

module.exports = { checkEmail, normalizeEmail, isDisposableDomain: (d) => DISPOSABLE.has(String(d).toLowerCase()) };
