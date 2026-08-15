/**
 * (إصلاح 12) كابتشا اختيارية (Cloudflare Turnstile) لتسجيل الحسابات الجديدة.
 * -----------------------------------------------------------------------
 * كانت /api/auth/register محمية بـ rate limiting + بوابة البريد بس، فإنشاء
 * حسابات آلية بطيئة (ببريد حقيقي يعدّي فحص MX) كان لسه ممكن نظريًا داخل حدود
 * المعدّل. Turnstile اختياري تمامًا: من غير TURNSTILE_SECRET_KEY الموقع
 * بيشتغل بالضبط زي الأول (rate limiting + email guard بس)، وده عشان مفيش
 * إجبار على مزوّد خارجي جديد. لو صاحب المتجر عايز طبقة حماية إضافية، يظبّط
 * TURNSTILE_SITE_KEY (عام، للواجهة) و TURNSTILE_SECRET_KEY (سري، للسيرفر).
 */
function isEnabled() {
  return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

function siteKey() {
  return process.env.TURNSTILE_SITE_KEY || null;
}

/** يتحقق من توكن Turnstile اللي بعتته الواجهة. true لو الكابتشا متعطّلة أصلًا. */
async function verify(token, remoteIp) {
  if (!isEnabled()) return { ok: true, skipped: true };
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'كابتشا مطلوبة' };
  }
  try {
    const body = new URLSearchParams({
      secret: process.env.TURNSTILE_SECRET_KEY,
      response: token
    });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await res.json();
    if (!data.success) return { ok: false, reason: 'فشل التحقق من الكابتشا' };
    return { ok: true };
  } catch (error) {
    // (احتياطي) لو خدمة Turnstile نفسها واقعة مؤقتًا، منمنعش التسجيل تمامًا —
    // بنسمح ونسجّل تحذير، عشان مشكلة عند مزوّد خارجي ما توقفش المتجر كله.
    console.error('[turnstile] فشل التحقق:', error.message);
    return { ok: true, degraded: true };
  }
}

module.exports = { isEnabled, siteKey, verify };
