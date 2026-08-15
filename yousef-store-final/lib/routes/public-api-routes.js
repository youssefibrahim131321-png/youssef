const { truthy } = require('../core/bool');
/**
 * واجهات عامة: الصحة، المنتجات، الأقسام، إعدادات المتجر
 * -------------------------------------------------------------------------
 * موديول اتفصل من server.js عشان الملف ما يبقاش آلاف السطور. كل الاعتماديات
 * (الـ store والحدود والمساعدات) بتتمرّر من server.js في كائن deps واحد،
 * فالسلوك زي ما هو بالحرف بس التنظيم بقى أوضح.
 */
module.exports = function registerPublicApiRoutes(app, deps) {
  const {
    adminWriteLimiter,
    audit,
    queryProducts,
    requireAdmin,
    store
  } = deps;

  app.get('/api/health', async (_req, res) => {
    // (إصلاح 9) كان بيرجع ok:true دايمًا من غير أي فحص حقيقي للاتصال
    // بقاعدة البيانات — يعني مراقبة خارجية (uptime monitor) كانت ممكن تفضل
    // "خضرا" حتى لو Postgres واقعة فعليًا. دلوقتي بنعمل SELECT 1 حقيقي.
    try {
      await store.pool.query('SELECT 1');
    } catch (error) {
      return res.status(503).json({
        ok: false,
        service: 'yousef-store',
        uptime: Math.round(process.uptime()),
        error: 'database_unreachable'
      });
    }
    res.json({
      ok: true,
      service: 'yousef-store',
      uptime: Math.round(process.uptime())
    });
  });
  app.get('/api/products', async (req, res) => {
    // (إصلاح 7) pagination حقيقي: بنرجّع صفحة واحدة بس بدل الكتالوج كله.
    const result = queryProducts(await store.getProducts(true), req.query || {});
    res.json({
      products: result.items,
      total: result.total,
      page: result.page,
      limit: result.limit,
      pages: result.pages,
      hasMore: result.hasMore,
      categories: await store.getCategories()
    });
  });
  // (إصلاح) عدّاد المشاهدات كان بيزيد مع *كل* طلب GET، فأي حد يقدر يضخّم
  // الأرقام بحلقة curl ويفسد التحليلات و"الأكثر مشاهدة". دلوقتي مشاهدة واحدة
  // لكل (IP + منتج) خلال 30 دقيقة، بذاكرة محدودة الحجم عشان ما تكبرش بلا حد.
  const VIEW_DEDUPE_MS = 30 * 60 * 1000;
  const VIEW_DEDUPE_MAX = 20000;
  const recentViews = new Map();
  function shouldCountView(req, productId) {
    const now = Date.now();
    if (recentViews.size > VIEW_DEDUPE_MAX) {
      for (const [key, at] of recentViews) {
        if (now - at > VIEW_DEDUPE_MS) recentViews.delete(key);
      }
      if (recentViews.size > VIEW_DEDUPE_MAX) recentViews.clear();
    }
    const key = `${req.ip}|${productId}`;
    const last = recentViews.get(key);
    if (last && now - last < VIEW_DEDUPE_MS) return false;
    recentViews.set(key, now);
    return true;
  }

  app.get('/api/products/:id', async (req, res) => {
    const product = await store.getProductById(req.params.id);
    if (!product || !truthy(product.active)) return res.status(404).json({
      error: 'المنتج غير موجود'
    });
    if (shouldCountView(req, product.id)) await store.incrementProductViews(product.id);
    const related = (await store.getProducts(true)).filter(p => p.category === product.category && p.id !== product.id).slice(0, 4);
    res.json({
      product,
      related,
      reviews: await store.getReviewsByProduct(product.id)
    });
  });
  app.get('/api/categories', async (_req, res) => res.json({
    categories: await store.getCategories()
  }));
  app.get('/api/site/settings', async (_req, res) => res.json({
    settings: await store.getSiteSettings()
  }));
  app.put('/api/site/settings', requireAdmin, adminWriteLimiter, async (req, res) => {
    const settings = await store.updateSiteSettings(req.body || {});
    audit(req, 'تحديث إعدادات المتجر', '');
    res.json({
      ok: true,
      settings
    });
  });
};
