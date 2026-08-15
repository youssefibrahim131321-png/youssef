const { truthy } = require('./bool');
// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
module.exports = async function registerStaticServing(deps = {}) {
  const { DATA_DIR, PUBLIC_DIR, UPLOADS_DIR, app, assetVersion, createImageFormatMiddleware, everyInstances, express, fs, path, productPath, sendHtml, store, sweepImageCache, warmVariants } = deps;
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname;
    try {
      pathname = decodeURIComponent(req.path);
    } catch (_) {
      return next();
    }
    if (pathname.includes('\0') || pathname.includes('..')) return next();
    const candidate = pathname === '/' ? '/index.html' : pathname.endsWith('.html') ? pathname : null;
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
  app.get(['/product/:id', '/product/:id/:slug'], async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return next();
    let product = null;
    try {
      product = await store.getProductById(id);
    } catch (_) {
      product = null;
    }
    if (!product || !truthy(product.active)) {
      res.status(404);
      return sendHtml(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    // المقارنة بتتعمل على النص بعد فك الترميز، عشان الروابط العربية (%D8..)
    // ما تعملش حلقة إعادة توجيه لا نهائية.
    const canonical = productPath(product);
    let decodedPath = req.path;
    try {
      decodedPath = decodeURIComponent(req.path);
    } catch (_) {/* مسار غير صالح */}
    if (decodedPath !== canonical) return res.redirect(301, encodeURI(canonical));
    return sendHtml(res, path.join(PUBLIC_DIR, 'index.html'));
  });

  // (أداء) تحويل الصور تلقائيًا لـ AVIF/WebP حسب دعم المتصفح، مع كاش على القرص.
  // بيتفعّل في الإنتاج تلقائيًا (أو IMAGE_AUTO_FORMAT=on) ولو sharp متاحة.
  const IMAGE_CACHE_DIR = path.resolve(process.env.IMAGE_CACHE_DIR || path.join(DATA_DIR, 'image-cache'));
  app.use(createImageFormatMiddleware({
    mount: '/uploads/products',
    rootDir: UPLOADS_DIR,
    cacheDir: path.join(IMAGE_CACHE_DIR, 'products')
  }));
  app.use(createImageFormatMiddleware({
    mount: '',
    rootDir: PUBLIC_DIR,
    cacheDir: path.join(IMAGE_CACHE_DIR, 'public')
  }));

  // (قرص) مكنسة كاش الصور: بتمسح النسخ اللي أصلها اتمسح، والقديمة، وبتقصّ
  // الكاش لو عدّى IMAGE_CACHE_MAX_MB. من غيرها الكاش بينمو للأبد على الـ Volume.
  // (إصلاح) المكنسة async دلوقتي وبتشتغل على دفعات (مش هتجمّد السيرفر)، وبقت
  // ملفوفة بالـ instance-lock حتى في أول تشغيل بعد الإقلاع — قبل كده أول
  // تشغيل بعد ٦٠ ثانية كان بره القفل، فمع أكتر من instance كانوا كلهم
  // بيبدأوا مسح متزامن لنفس مجلد الكاش المشترك بالظبط اللي القفل اتعمل عشانه.
  const sweepImageCachesOnce = everyInstances('image-cache-sweep', async () => {
    await sweepImageCache({ cacheDir: path.join(IMAGE_CACHE_DIR, 'products'), rootDir: UPLOADS_DIR });
    await sweepImageCache({ cacheDir: path.join(IMAGE_CACHE_DIR, 'public'), rootDir: PUBLIC_DIR });
  });
  setTimeout(() => { sweepImageCachesOnce().catch(() => {/* لا شيء */}); }, 60 * 1000).unref();
  setInterval(() => { sweepImageCachesOnce().catch(() => {/* لا شيء */}); }, 6 * 60 * 60 * 1000).unref();

  // تسخين نسخ AVIF/WebP وقت الرفع بدل وقت أول زيارة.
  const warmImageVariants = (filename) => warmVariants({
    rootDir: UPLOADS_DIR,
    cacheDir: path.join(IMAGE_CACHE_DIR, 'products'),
    relative: filename
  });

  // لو الصور المرفوعة متخزنة برّه مجلد public (على Volume)، بنقدّمها من مسارها الحقيقي.
  if (UPLOADS_DIR !== path.join(PUBLIC_DIR, 'uploads', 'products')) {
    app.use('/uploads/products', express.static(UPLOADS_DIR, {
      maxAge: '30d',
      immutable: true
    }));
  }

  // (أداء) الملفات النصية الثابتة (CSS/JS/SVG/JSON) بتتقدّم عن طريق res.send
  // عشان تعدّي على middleware الضغط — express.static بيستخدم sendFile وما بيتضغطش.
  const TEXT_ASSET_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8'
  };
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname;
    try {
      pathname = decodeURIComponent(req.path);
    } catch (_) {
      return next();
    }
    if (pathname.includes('\0') || pathname.includes('..')) return next();
    const type = TEXT_ASSET_TYPES[path.extname(pathname).toLowerCase()];
    if (!type) return next();
    const filePath = path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filePath)) return next();
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      return next();
    }
    if (!stat.isFile()) return next();
    // service-worker لازم يتراجع كل مرة، وباقي الأصول بكاش قصير + إعادة تحقق.
    const isSW = path.basename(filePath) === 'service-worker.js';
    const requestedVersion = typeof req.query.v === 'string' ? req.query.v : '';
    const fingerprinted = !isSW && requestedVersion && requestedVersion === assetVersion(pathname);
    res.setHeader('Content-Type', type);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', isSW
      ? 'no-cache'
      : fingerprinted
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600, stale-while-revalidate=86400, must-revalidate');
    res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    if (req.method === 'HEAD') return res.end();
    try {
      return res.send(fs.readFileSync(filePath));
    } catch (_) {
      return next();
    }
  });

  // الصور والخطوط: كاش طويل (بتتغيّر باسم جديد لما تترفع نسخة جديدة).
  app.use(express.static(PUBLIC_DIR, {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      // الخطوط أسماؤها ثابتة ومحتواها ما بيتغيّرش: immutable آمن.
      if (/\.(?:woff2?|ttf|otf)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/\.(?:jpg|jpeg|png|webp|avif|gif|ico)$/i.test(filePath)) {
        // (إصلاح) صور public (اللوجو/الأيقونات) أسماؤها ثابتة، فـ immutable كان
        // معناه إن أي تحديث للوجو مش بيوصل للمستخدم لمدة ٣٠ يوم. الكاش فضل
        // طويل بس مع revalidate رخيص (304) لما ينتهي.
        res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    }
  }));
  return { warmImageVariants };
};
