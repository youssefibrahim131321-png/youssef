/**
 * أصل الموقع العام (Public Base URL) — مصدر واحد موثوق
 * ---------------------------------------------------------------------------
 * (إصلاح أمني — Host Header Injection) كل مكان في المشروع كان بيبني روابط
 * مطلقة من `${req.protocol}://${req.get('host')}`. هيدر `Host` بيتحكم فيه
 * المُرسِل بالكامل (مالوش علاقة بـ TRUST_PROXY لأنه مش X-Forwarded-Host)،
 * فمهاجم كان يقدر يبعت طلب /api/auth/forgot-password ببريد الضحية مع
 * Host: evil.com فيوصل للضحية بريد حقيقي من المتجر فيه رابط استعادة على
 * دومين المهاجم ← استيلاء كامل على الحساب (بما فيه الأدمن). نفس النمط كان
 * بيسمّم sitemap/canonical/JSON-LD (SEO poisoning + cache poisoning).
 *
 * القاعدة دلوقتي:
 *   1) SITE_URL أو PUBLIC_BASE_URL لو مضبوط ← يُستخدم دائمًا (يتجاهل الهيدر).
 *   2) وإلا: هيدر Host يُقبل فقط لو موجود في ALLOWED_HOSTS.
 *   3) وإلا: في الإنتاج نرجع أول هوست موثوق، ولو مفيش أي إعداد نرجع null
 *      (المستدعي بيقرر) — وخارج الإنتاج بنسمح بالهوست عشان التطوير المحلي.
 */

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return `${url.protocol}//${url.host}`.replace(/\/+$/, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

function configuredOrigin() {
  return normalizeOrigin(process.env.SITE_URL) || normalizeOrigin(process.env.PUBLIC_BASE_URL);
}

function allowedOrigins() {
  return String(process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
}

/** هوستات موثوقة (بدون بروتوكول) للمقارنة مع هيدر Host الخام. */
function trustedHosts() {
  const list = [configuredOrigin(), ...allowedOrigins()].filter(Boolean);
  return new Set(list.map(origin => origin.replace(/^https?:\/\//, '')));
}

function requestOrigin(req) {
  const host = String((req && (req.get ? req.get('host') : (req.headers || {}).host)) || '')
    .trim()
    .toLowerCase();
  // صيغة دومين سليمة بس: من غير @ أو / أو مسافات (يمنع "evil.com/x" و userinfo).
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) return '';
  const protocol = (req && req.protocol) || 'https';
  return `${protocol}://${host}`;
}

/**
 * @param {object} req طلب Express
 * @param {{ fallbackToHost?: boolean }} [options]
 *        fallbackToHost=false ← ممنوع نهائيًا السقوط على هيدر Host غير الموثوق
 *        (يُستخدم للروابط اللي بتتبعت بالبريد). الافتراضي true بيسمح بالهوست
 *        خارج الإنتاج فقط.
 * @returns {string|null} أصل مطلق بدون / في الآخر، أو null لو مفيش أصل موثوق.
 */
function publicBaseUrl(req, options = {}) {
  const configured = configuredOrigin();
  if (configured) return configured;

  const hosts = trustedHosts();
  const origin = requestOrigin(req);
  const host = origin.replace(/^https?:\/\//, '');

  if (hosts.size) return hosts.has(host) ? origin : `https://${[...hosts][0]}`;

  // من غير أي إعداد: بنسمح بس بهوست محلي (تطوير) — أي دومين تاني جاي من هيدر
  // Host بيتـرفض حتى خارج الإنتاج، عشان ما يبقاش فيه مسار مختلف بيخبّي الثغرة.
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/.test(host);
  const allowFallback = options.fallbackToHost !== false && process.env.NODE_ENV !== 'production' && isLoopback;
  return allowFallback && origin ? origin : null;
}

/** نسخة "مش بترجع null": بتستخدم localhost كملاذ أخير (للسياقات غير الحسّاسة). */
function publicBaseUrlOrLocal(req, options = {}) {
  return publicBaseUrl(req, options) || 'http://localhost:' + String(process.env.PORT || 3000);
}

module.exports = { publicBaseUrl, publicBaseUrlOrLocal, normalizeOrigin, trustedHosts };
