/**
 * حماية صفحات وملفات لوحة التحكم
 * -------------------------------------------------------------------------
 * موديول اتفصل من server.js عشان الملف ما يبقاش آلاف السطور. كل الاعتماديات
 * (الـ store والحدود والمساعدات) بتتمرّر من server.js في كائن deps واحد،
 * فالسلوك زي ما هو بالحرف بس التنظيم بقى أوضح.
 */
module.exports = function registerAdminPanelRoutes(app, deps) {
  const {
    PUBLIC_DIR,
    fs,
    path,
    requireAdminPanel,
    sendHtml
  } = deps;

  app.get('/dash.html', (_req, res) => res.redirect('/admin.html'));
  app.get(['/admin', '/admin.html'], requireAdminPanel, (_req, res) => sendHtml(res, path.join(PUBLIC_DIR, 'admin.html')));

  // (تنظيف) CSS/JS لوحة التحكم اتنقلوا من داخل admin.html لملفات خارجية عشان
  // يتكاشوا في المتصفح. بنقدّمهم وراء نفس حماية اللوحة (مش عبر static العام).
  app.get('/admin.css', requireAdminPanel, (_req, res) => {
    res.type('text/css; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(path.join(PUBLIC_DIR, 'admin.css'));
  });

  // (تقسيم) admin.js اتقسم لموديولات ES تحت /public/js/admin/. بنقدّمهم وراء
  // نفس حماية اللوحة، وبقائمة أسماء صريحة عشان نمنع أي path traversal.
  const ADMIN_MODULES = new Set(fs.readdirSync(path.join(PUBLIC_DIR, 'js', 'admin')).filter((f) => f.endsWith('.js')));
  app.get('/js/admin/:file', requireAdminPanel, (req, res) => {
    const file = String(req.params.file || '');
    if (!ADMIN_MODULES.has(file)) return res.status(404).type('text/plain').send('غير موجود');
    res.type('application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(path.join(PUBLIC_DIR, 'js', 'admin', file));
  });

  // (1) express.static مع extensions:['html'] كان بيقدّم /admin و /admin.html
  // كملفات ثابتة قبل أي تحقق. هنا نحجب أي مسار بيوصل لملف الأدمن مهما كان شكله
  // (/admin، /admin.html، //admin.html، /Admin.HTML ...) قبل الوصول للـ static.
  // (إصلاح) endsWith('/admin.html') كان بيتطابق مع أي مسار منتهي بيه (مثلاً
  // /foo/admin.html) بشكل غير دقيق. بدل التطابق الفضفاض، عندنا allowlist دقيق
  // لمسارات الأدمن الثابتة فقط.
  const ADMIN_ASSET_PATHS = new Set(['/admin', '/admin.html', '/admin.css']);
  app.use((req, res, next) => {
    const normalized = decodeURIComponent(req.path).toLowerCase().replace(/\/+/g, '/');
    if (ADMIN_ASSET_PATHS.has(normalized) || normalized.startsWith('/js/admin/')) return requireAdminPanel(req, res, next);
    return next();
  });
};
