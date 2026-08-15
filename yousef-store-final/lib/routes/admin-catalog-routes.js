/**
 * لوحة التحكم: المنتجات والكوبونات والتقييمات
 * -------------------------------------------------------------------------
 * موديول اتفصل من server.js عشان الملف ما يبقاش آلاف السطور. كل الاعتماديات
 * (الـ store والحدود والمساعدات) بتتمرّر من server.js في كائن deps واحد،
 * فالسلوك زي ما هو بالحرف بس التنظيم بقى أوضح.
 */
module.exports = function registerAdminCatalogRoutes(app, deps) {
  const {
    adminWriteLimiter,
    audit,
    cleanupOldProductImage,
    requireAdmin,
    store,
    validate,
    writeLimiter
  } = deps;

  app.get('/api/admin/products', requireAdmin, async (_req, res) => res.json({
    products: await store.getProducts(false)
  }));

  // (12) نفس قواعد التحقق للإضافة والتعديل — الفرق الوحيد إن التعديل جزئي
  // (الحقول اللي مش مبعوتة بتفضل زي ما هي)، فالحقول تبقى مطلوبة في POST بس.
  const productRules = partial => ({
    name: {
      required: !partial,
      label: 'اسم المنتج',
      minLength: 2,
      maxLength: 120
    },
    category: {
      required: !partial,
      label: 'القسم',
      maxLength: 60
    },
    price: {
      required: !partial,
      label: 'السعر',
      type: 'number',
      min: 0,
      max: 10000000
    },
    stock: {
      label: 'المخزون',
      type: 'number',
      min: 0,
      max: 1000000
    },
    oldPrice: {
      label: 'السعر قبل الخصم',
      type: 'number',
      min: 0,
      max: 10000000
    },
    sku: {
      label: 'كود المنتج',
      maxLength: 40
    },
    tag: {
      label: 'الوسم',
      maxLength: 40
    },
    description: {
      label: 'الوصف',
      maxLength: 1200
    }
  });
  app.post('/api/admin/products', requireAdmin, writeLimiter, async (req, res) => {
    const {
      errors
    } = validate(productRules(false), req.body);
    if (errors.length) return res.status(400).json({
      error: errors[0],
      errors
    });
    const product = await store.createProduct(req.body);
    audit(req, 'إضافة منتج', product.name);
    res.json({
      ok: true,
      productId: product.id,
      product
    });
  });
  app.put('/api/admin/products/:id', requireAdmin, writeLimiter, async (req, res) => {
    // (12) كان التعديل بيمرّر req.body للـ store من غير أي تحقق، على عكس الإضافة.
    const {
      errors
    } = validate(productRules(true), req.body);
    if (errors.length) return res.status(400).json({
      error: errors[0],
      errors
    });
    const before = await store.getProductById(req.params.id);
    const product = await store.updateProduct(req.params.id, req.body || {});
    if (!product) return res.status(404).json({
      error: 'المنتج غير موجود'
    });
    if (before) cleanupOldProductImage(before.image_url, product.image_url);
    audit(req, 'تعديل منتج', product.name);
    res.json({
      ok: true,
      product
    });
  });
  app.post('/api/admin/products/:id/stock', requireAdmin, adminWriteLimiter, async (req, res) => {
    const delta = Number((req.body || {}).delta);
    if (!Number.isFinite(delta)) return res.status(400).json({
      error: 'قيمة غير صالحة'
    });
    const product = await store.adjustStock(req.params.id, delta);
    if (!product) return res.status(404).json({
      error: 'المنتج غير موجود'
    });
    audit(req, 'تعديل مخزون', `${product.name}: ${delta > 0 ? '+' : ''}${delta}`);
    res.json({
      ok: true,
      product
    });
  });
  app.delete('/api/admin/products/:id', requireAdmin, adminWriteLimiter, async (req, res) => {
    const product = await store.getProductById(req.params.id);
    const deleted = await store.deleteProduct(req.params.id);
    if (!deleted) return res.status(404).json({
      error: 'المنتج غير موجود'
    });
    if (product) cleanupOldProductImage(product.image_url, null);
    audit(req, 'حذف منتج', product ? product.name : req.params.id);
    res.json({
      ok: true
    });
  });
  app.get('/api/admin/coupons', requireAdmin, async (_req, res) => res.json({
    coupons: await store.getCoupons()
  }));
  app.post('/api/admin/coupons', requireAdmin, writeLimiter, async (req, res) => {
    try {
      const coupon = await store.createCoupon(req.body || {});
      audit(req, 'إضافة كوبون', coupon.code);
      return res.json({
        ok: true,
        coupon
      });
    } catch (error) {
      return res.status(400).json({
        error: error.message === 'Coupon already exists' ? 'هذا الكود موجود بالفعل' : 'بيانات الكوبون غير صحيحة'
      });
    }
  });
  app.put('/api/admin/coupons/:id', requireAdmin, adminWriteLimiter, async (req, res) => {
    const coupon = await store.updateCoupon(req.params.id, req.body || {});
    if (!coupon) return res.status(404).json({
      error: 'الكوبون غير موجود'
    });
    audit(req, 'تعديل كوبون', coupon.code || req.params.id);
    res.json({
      ok: true,
      coupon
    });
  });
  app.delete('/api/admin/coupons/:id', requireAdmin, adminWriteLimiter, async (req, res) => {
    if (!(await store.deleteCoupon(req.params.id))) return res.status(404).json({
      error: 'الكوبون غير موجود'
    });
    audit(req, 'حذف كوبون', req.params.id);
    res.json({
      ok: true
    });
  });
  app.get('/api/admin/reviews', requireAdmin, async (_req, res) => res.json({
    reviews: await store.getAllReviews()
  }));
  app.delete('/api/admin/reviews/:id', requireAdmin, adminWriteLimiter, async (req, res) => {
    if (!(await store.deleteReview(req.params.id))) return res.status(404).json({
      error: 'التقييم غير موجود'
    });
    audit(req, 'حذف تقييم', req.params.id);
    res.json({
      ok: true
    });
  });
};
