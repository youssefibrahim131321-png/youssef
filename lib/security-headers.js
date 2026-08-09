/**
 * (تنظيف) رؤوس الأمان و CSP اتفصلت من server.js في وحدة مستقلة.
 */
const crypto = require('crypto');

function createSecurityHeaders({ googleAuth, sensitivePaths }) {
  const SENSITIVE_PATHS = sensitivePaths;
  return function securityHeaders(req, res, next) {
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
    `style-src 'self' 'nonce-${res.locals.cspNonce}' https://fonts.googleapis.com`,
    // سمات style="" الموجودة في الصفحات مسموحة، لكن أي <style> يحقنه مهاجم مرفوض.
    "style-src-attr 'unsafe-inline'",
    `style-src-elem 'self' 'nonce-${res.locals.cspNonce}' https://fonts.googleapis.com`,
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
  };
}

module.exports = { createSecurityHeaders };
