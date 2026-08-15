// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
module.exports = async function createSessionSecurity(deps = {}) {
  const { crypto, store } = deps;
  // (5) المفتاح الجذري مش بيوقّع أي حاجة بشكل مباشر. بنشتق منه مفتاحين منفصلين
  // تمامًا (HKDF) — واحد لتوقيع الجلسة وواحد لتوكن الـ CSRF. كده تسريب أو كسر
  // أحدهما لا يسمح بتزوير التاني، ومفيش أي احتمال لاستخدام توكن CSRF كجلسة
  // صالحة أو العكس (confused deputy).
  const ROOT_SECRET = process.env.SESSION_SECRET || (await store.getOrCreateSessionSecret());
  const deriveKey = label => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ROOT_SECRET), Buffer.alloc(0), Buffer.from(label), 32));
  const SESSION_KEY = deriveKey('yousef-store/session-v1');
  const CSRF_KEY = deriveKey('yousef-store/csrf-v1');
  // (إصلاح S2 — دفاع إضافي) لو TOTP_ENCRYPTION_KEY متحدد، secret-crypto بيستخدمه
  // هو مباشرة (أقوى خيار). لو مش متحدد، بنمرّر مفتاح احتياطي مشتق بنفس أسلوب
  // مفتاحي الجلسة/CSRF فوق (HKDF + domain separation) بدل ما نسيب الأسرار
  // تتخزّن نص صريح بصمت.
  require('../../lib/secret-crypto').configureFallbackKey(deriveKey('yousef-store/totp-v1'));
  const SESSION_COOKIE = 'yousef_session';
  const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  // جلسة الأدمن أقصر بكتير من جلسة العميل: لوحة التحكم مفتاح المتجر كله، فمش
  // منطقي تفضل مفتوحة 30 يوم على جهاز ممكن يضيع أو يتسرق.
  const ADMIN_SESSION_MAX_AGE_MS = Number(process.env.ADMIN_SESSION_HOURS || 12) * 60 * 60 * 1000;
  const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // ساعة واحدة لاستعادة كلمة المرور
  const VERIFY_CODE_TTL_MS = 15 * 60 * 1000; // 15 دقيقة لكود التفعيل الرقمي
  const TOTP_PENDING_TTL_MS = 5 * 60 * 1000; // 5 دقايق لإكمال خطوة التحقق بخطوتين بعد الباسورد
  // ---------------------------------------------------------------------------
  // جلسات موقّعة (stateless)
  // ---------------------------------------------------------------------------
  const base64url = input => Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signWith = (key, payload) => base64url(crypto.createHmac('sha256', key).update(payload).digest());
  const sign = payload => signWith(SESSION_KEY, payload);
  const signCsrf = payload => signWith(CSRF_KEY, payload);
  // (إصلاح) الجلسة كانت موقّعة (HMAC) بس مش مشفّرة: أي حد يشوف الكوكي —
  // امتداد متصفح ضار، أداة تشخيص، لوج بيسجّل الهيدرز بالغلط — يقدر يقرا
  // الـ role والـ user id كـ Base64 عادي. مش ثغرة صلاحيات فعلية (التوقيع
  // بيمنع أي تعديل، وsession_version بيلغي الجلسات القديمة عند الحاجة)،
  // لكنه تسريب معلومات بلا داعي. دلوقتي المحتوى نفسه مشفّر (AES-256-GCM)
  // بمفتاح مشتق منفصل تمامًا (domain separation زي باقي المفاتيح فوق)، وبرّه
  // كله لسه موقّع بنفس HMAC زي الأول (طبقة دفاع إضافية، مش بديل عن الـ GCM
  // tag). ملحوظة: أي جلسة موجودة وقت النشر هتتطلب دخول تاني، لأن الصيغة
  // القديمة (JSON صريح) مش قابلة لفك التشفير بالمفتاح الجديد.
  const SESSION_ENC_KEY = deriveKey('yousef-store/session-enc-v1');
  function encryptSessionPayload(data) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', SESSION_ENC_KEY, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return base64url(Buffer.concat([iv, tag, enc]));
  }
  function decryptSessionPayload(payload) {
    const blob = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (blob.length < 29) return null; // 12 (iv) + 16 (tag) + محتوى فعلي
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const enc = blob.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', SESSION_ENC_KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  }
  function createSessionToken(data) {
    const payload = encryptSessionPayload({
      ...data,
      iat: Date.now()
    });
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
      const data = decryptSessionPayload(payload);
      const maxAge = data.role === 'admin' ? ADMIN_SESSION_MAX_AGE_MS : SESSION_MAX_AGE_MS;
      if (data.iat && Date.now() - data.iat > maxAge) return null;
      return data;
    } catch (_) {
      return null;
    }
  }
  function parseCookies(req) {
    const cookies = {};
    const header = req.headers.cookie;
    if (!header) return cookies;
    header.split(';').forEach(pair => {
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
    // (إصلاح أمني) DISABLE_SECURE_COOKIE مسموح بيها في التطوير المحلي بس.
    if (process.env.DISABLE_SECURE_COOKIE === '1' && process.env.NODE_ENV !== 'production') return false;
    const req = res.req;
    if (req && (req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https')) return true;
    return process.env.NODE_ENV === 'production';
  }
  function cookieParts(name, value, maxAgeSeconds, res, httpOnly = true) {
    // (إصلاح) SameSite=Lax مش Strict: مع Strict كان الرجوع من بوابة الدفع
    // (Paymob) بييجي من غير كوكي الجلسة، فالعميل بيلاقي نفسه خارج من حسابه.
    // Lax بيبعت الكوكي مع التنقّل العادي (GET) بس، وحماية CSRF متكفّلة
    // بطلبات التغيير عن طريق double-submit token في هيدر مخصص.
    const parts = [`${name}=${value}`, 'Path=/', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
    if (httpOnly) parts.splice(2, 0, 'HttpOnly');
    if (isSecureRequest(res)) parts.push('Secure');
    return parts.join('; ');
  }
  function appendCookie(res, cookie) {
    const existing = res.getHeader('Set-Cookie');
    const list = existing ? Array.isArray(existing) ? existing : [existing] : [];
    list.push(cookie);
    res.setHeader('Set-Cookie', list);
  }
  function setSessionCookie(res, data) {
    const token = createSessionToken(data);
    const maxAge = data && data.role === 'admin' ? ADMIN_SESSION_MAX_AGE_MS : SESSION_MAX_AGE_MS;
    appendCookie(res, cookieParts(SESSION_COOKIE, encodeURIComponent(token), Math.floor(maxAge / 1000), res));
    issueCsrfCookie(res, true);
  }
  const clearSessionCookie = res => {
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
  // مقارنة نصوص بزمن ثابت — نفس أسلوب باقي الكود (مفيش === على توكنات).
  function safeEqualStr(a, b) {
    const bufA = Buffer.from(String(a), 'utf8');
    const bufB = Buffer.from(String(b), 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }
  const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  function csrfProtection(req, res, next) {
    // ويبهوك Paymob بيجي من سيرفر خارجي، فمستثنى من CSRF (بيتحقق بالتوقيع HMAC).
    if (req.path === '/api/public/paymob/webhook') return next();
    const cookies = parseCookies(req);
    if (!cookies[CSRF_COOKIE] || !isValidCsrfToken(cookies[CSRF_COOKIE])) issueCsrfCookie(res, true);
    if (CSRF_SAFE_METHODS.has(req.method)) return next();

    // (إصلاح 12) الطلب من غير Origin مكانش بيتفحص أصلًا. دلوقتي لازم إثبات
    // أصل واحد على الأقل: Origin، أو Referer من نفس الهوست، أو Sec-Fetch-Site
    // بقيمة same-origin/same-site. غياب الثلاثة = رفض.
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    const hostMatches = value => {
      try {
        return new URL(value).host === req.headers.host;
      } catch (_) {
        return false;
      }
    };
    let originOk = false;
    if (origin && origin !== 'null') originOk = hostMatches(origin);else if (fetchSite === 'same-origin' || fetchSite === 'same-site') originOk = true;else if (referer) originOk = hostMatches(referer);
    if (!originOk) return res.status(403).json({
      error: 'طلب مرفوض (مصدر غير موثوق)'
    });
    const headerToken = req.headers[CSRF_HEADER] || req.body && req.body._csrf;
    const cookieToken = cookies[CSRF_COOKIE];
    if (!headerToken || !cookieToken || !safeEqualStr(String(headerToken), String(cookieToken)) || !isValidCsrfToken(String(headerToken))) {
      return res.status(403).json({
        error: 'انتهت صلاحية الصفحة، حدّث الصفحة وحاول مرة أخرى.'
      });
    }
    return next();
  }
  // (أداء) كاش قصير لمستخدم الجلسة: sessionMiddleware كان بيعمل استعلام DB
  // على *كل* ريكوست، بما فيها الأصول الثابتة تحت الحماية. الكاش عمره ثوانٍ
  // قليلة، وبيتخطّى بالكامل في الطلبات غير الآمنة (POST/PUT/PATCH/DELETE)
  // عشان أي إبطال جلسة (تغيير باسورد / خروج من كل الأجهزة) يبان فورًا.
  // (إصلاح تعدد النسخ) الكاش ده محلي لكل instance، فلو المشروع شغّال بأكتر من
  // نسخة (ALLOW_MULTI_INSTANCE=1) بيبقى ممكن نسخة تكمّل تقرا مستخدم قديم بعد
  // إبطال جلسته من نسخة تانية. في الحالة دي بنعطّل الكاش بالكامل (TTL=0)
  // وبنقرا من القاعدة المشتركة على طول — الصح أهم من السرعة هنا.
  const MULTI_INSTANCE = process.env.ALLOW_MULTI_INSTANCE === '1';
  const USER_CACHE_TTL_MS = MULTI_INSTANCE ? 0 : 1000;
  const USER_CACHE_MAX = 5000;
  const userCache = new Map();
  function cacheGetUser(id) {
    if (!USER_CACHE_TTL_MS) return null;
    const hit = userCache.get(id);
    if (!hit) return null;
    if (hit.expires <= Date.now()) { userCache.delete(id); return null; }
    return hit.user;
  }
  function cacheSetUser(id, user) {
    if (!USER_CACHE_TTL_MS) return;
    if (userCache.size > USER_CACHE_MAX) {
      const now = Date.now();
      for (const [k, v] of userCache) if (v.expires <= now) userCache.delete(k);
      if (userCache.size > USER_CACHE_MAX) userCache.clear();
    }
    userCache.set(id, { user, expires: Date.now() + USER_CACHE_TTL_MS });
  }

  async function loadSessionUser(userId, method) {
    const id = Number(userId);
    const cacheable = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    if (cacheable) {
      const cached = cacheGetUser(id);
      if (cached !== null) return cached;
    } else {
      userCache.delete(id);
    }
    const user = await store.findUserById(id);
    if (cacheable) cacheSetUser(id, user || false);
    return user || null;
  }

  async function sessionMiddleware(req, res, next) {
    const data = parseSessionToken(parseCookies(req)[SESSION_COOKIE]);
    const user = data ? (await loadSessionUser(data.userId, req.method)) || null : null;
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
  return { RESET_TOKEN_TTL_MS, VERIFY_CODE_TTL_MS, TOTP_PENDING_TTL_MS, base64url, setSessionCookie, clearSessionCookie, csrfProtection, sessionMiddleware };
};
