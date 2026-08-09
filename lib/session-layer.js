/**
 * (تنظيف) طبقة الجلسات و CSRF اتفصلت من server.js (الملف كان ٢٢٠٠+ سطر).
 * الوحدة دي مالهاش أي علاقة بـ Express app مباشرة: بتاخد المفاتيح والإعدادات
 * وبترجع الدوال، فتقدر تتختبر لوحدها.
 */
const crypto = require('crypto');

function createSessionLayer({
  sessionKey,
  csrfKey,
  sessionCookie = 'yousef_session',
  sessionMaxAgeMs,
  adminSessionMaxAgeMs,
}) {
  const SESSION_COOKIE = sessionCookie;
  const SESSION_MAX_AGE_MS = sessionMaxAgeMs;
  const ADMIN_SESSION_MAX_AGE_MS = adminSessionMaxAgeMs;
  const SESSION_KEY = sessionKey;
  const CSRF_KEY = csrfKey;

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
    // (إصلاح) لكل جلسة معرّف فريد (jti) عشان نقدر نبطّلها لوحدها عند الخروج.
    const payload = base64url(JSON.stringify({ ...data, jti: crypto.randomUUID(), iat: Date.now() }));
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

  return {
    SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER, CSRF_MAX_AGE,
    base64url, base64urlDecode, sign, signCsrf,
    createSessionToken, parseSessionToken, parseCookies,
    isSecureRequest, cookieParts, appendCookie,
    setSessionCookie, clearSessionCookie,
    createCsrfToken, isValidCsrfToken, issueCsrfCookie,
  };
}

module.exports = { createSessionLayer };
