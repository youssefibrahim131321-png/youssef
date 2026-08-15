// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
const { truthy } = require('./bool');

module.exports = async function createGuards(deps = {}) {
  const { store } = deps;
  // ---------------------------------------------------------------------------
  // حراسة الصفحات والـ APIs
  // ---------------------------------------------------------------------------
  function requireAdminPanel(req, res, next) {
    if (!req.user || req.user.role !== 'admin') return res.redirect('/admin-login.html');
    if (truthy(req.user.must_change_password)) {
      return res.redirect('/account.html?next=%2Fadmin.html&mustChange=1');
    }
    return next();
  }
  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({
      error: 'من فضلك سجّل الدخول أولًا'
    });
    return next();
  }
  // (أمان) فرض تغيير كلمة المرور المؤقتة من السيرفر مش من الواجهة بس: طالما
  // must_change_password = 1، أي طلب API غير الطلبات اللازمة للتغيير نفسه بيترفض،
  // فمحدش يقدر يستخدم الحساب بكلمة مرور مؤقتة عن طريق نداء الـ API مباشرة.
  // (إصلاح) الميدل‑وير ده مركّب على '/api' فـ req.path بييجي من غير البادئة دي،
  // فلازم نركّب المسار الكامل قبل المقارنة بالقائمة المسموحة. الدالة كانت
  // ناقصة خالص فأي حساب لازم يغيّر كلمة مروره كان بياخد 500 بدل الرسالة.
  const fullApiPath = req => {
    const full = `${req.baseUrl || ''}${req.path || ''}`;
    return full.length > 1 ? full.replace(/\/+$/, '') : full;
  };
  const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/change-password', '/api/auth/logout', '/api/auth/logout-all-devices', '/api/auth/me', '/api/csrf', '/api/csp-report']);
  function enforcePasswordChange(req, res, next) {
    if (!req.user || !truthy(req.user.must_change_password)) return next();
    if (PASSWORD_CHANGE_ALLOWED.has(fullApiPath(req))) return next();
    return res.status(403).json({
      error: 'لازم تغيّر كلمة المرور المؤقتة قبل استخدام الحساب.',
      mustChangePassword: true
    });
  }
  function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({
      error: 'من فضلك سجّل الدخول أولًا'
    });
    if (req.user.role !== 'admin') return res.status(403).json({
      error: 'هذه الصفحة للمسؤولين فقط'
    });
    return next();
  }
  const audit = async (req, action, details) => await store.logActivity({
    userId: req.user ? req.user.id : null,
    userName: req.user ? req.user.name : 'نظام',
    action,
    details
  });
  return { requireAdminPanel, requireAuth, enforcePasswordChange, requireAdmin, audit };
};
