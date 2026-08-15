/**
 * الكوبونات، الطلبات، التقييمات، المفضلة
 * -------------------------------------------------------------------------
 * موديول اتفصل من server.js عشان الملف ما يبقاش آلاف السطور. كل الاعتماديات
 * (الـ store والحدود والمساعدات) بتتمرّر من server.js في كائن deps واحد،
 * فالسلوك زي ما هو بالحرف بس التنظيم بقى أوضح.
 */
const { truthy } = require('../core/bool');

module.exports = function registerShopRoutes(app, deps) {
  const {
    PROOFS_DIR,
    asText,
    couponCodeLimiter,
    couponLimiter,
    emailVerificationEnforced,
    fsp,
    notifyCustomer,
    path,
    requireAuth,
    store,
    validate,
    writeLimiter
  } = deps;

  app.post('/api/coupons/validate', couponLimiter, couponCodeLimiter, writeLimiter, async (req, res) => {
    const rawSubtotal = Number((req.body || {}).subtotal);
    const subtotal = Number.isFinite(rawSubtotal) && rawSubtotal >= 0 ? rawSubtotal : 0;
    const result = await store.evaluateCoupon((req.body || {}).code, subtotal, req.user ? req.user.id : null);
    if (!result.valid) return res.status(400).json(result);
    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // الطلبات
  // ---------------------------------------------------------------------------
  const PAYMENT_METHODS = ['whatsapp', 'vodafone-cash', 'instapay', 'cash-on-delivery'];
  // طرق الدفع اللي لازم معاها صورة إيصال تحويل من العميل.
  const PROOF_REQUIRED_METHODS = ['vodafone-cash', 'instapay'];
  const PROOF_URL_RE = /^\/api\/payment-proof\/([a-f0-9-]{36}\.(?:jpg|png|webp))$/i;
  app.post('/api/orders', requireAuth, writeLimiter, async (req, res) => {
    const settings = await store.getSiteSettings();
    if (!settings.storeOpen) return res.status(503).json({
      error: 'المتجر مغلق مؤقتًا، برجاء المحاولة لاحقًا.'
    });
    // (2) البريد المفعّل شرط لإتمام الطلب، عشان نضمن إن بيانات التواصل حقيقية.
    if (emailVerificationEnforced() && !truthy(req.user.email_verified)) {
      return res.status(403).json({
        error: 'من فضلك فعّل بريدك الإلكتروني أولًا بالكود اللي بعتناه لك، ثم أعد المحاولة.',
        code: 'EMAIL_NOT_VERIFIED'
      });
    }
    const {
      errors,
      value
    } = validate({
      customerName: {
        required: true,
        label: 'اسم العميل',
        minLength: 2,
        maxLength: 80
      },
      customerPhone: {
        required: true,
        label: 'رقم الهاتف',
        type: 'phone',
        maxLength: 30
      },
      customerAddress: {
        label: 'العنوان',
        maxLength: 300
      },
      paymentMethod: {
        required: true,
        label: 'طريقة الدفع',
        enum: PAYMENT_METHODS
      },
      notes: {
        label: 'ملاحظات',
        maxLength: 500
      },
      couponCode: {
        label: 'كود الخصم',
        maxLength: 30
      },
      transferRef: {
        label: 'رقم عملية التحويل',
        maxLength: 40
      }
    }, req.body);
    const items = (req.body || {}).items;
    if (!Array.isArray(items) || !items.length) errors.push('السلة فارغة');
    if (Array.isArray(items) && items.length > 50) errors.push('عدد المنتجات في الطلب كبير جدًا');
    // (7) رفض الكميات السالبة أو الصفرية أو الكسرية على مستوى الـ API
    if (Array.isArray(items)) {
      const badQty = items.some(item => {
        const q = Number(item && item.quantity);
        return !Number.isFinite(q) || !Number.isInteger(q) || q < 1 || q > 999;
      });
      if (badQty) errors.push('الكمية يجب أن تكون رقمًا صحيحًا من 1 إلى 999');
    }
    // (جديد) الدفع بفودافون كاش أو انستا باي لازم معاه صورة إيصال التحويل.
    const rawProof = String((req.body || {}).paymentProofUrl || '').trim();
    let paymentProofUrl = null;
    if (PROOF_REQUIRED_METHODS.includes(value.paymentMethod)) {
      // (جديد) رقم عملية التحويل إجباري مع الإيصال: بيخلي المطابقة مع كشف
      // المحفظة ممكنة، فصورة مفبركة من غير عملية حقيقية بتتكشف فورًا.
      const ref = String(value.transferRef || '').trim();
      if (!/^[0-9A-Za-z-]{6,40}$/.test(ref)) {
        errors.push('اكتب رقم عملية التحويل (٦ خانات على الأقل) زي ما ظاهر في رسالة المحفظة');
      }
      const match = PROOF_URL_RE.exec(rawProof);
      let proofOwner = null;
      if (match) {
        try {
          proofOwner = await store.getPaymentProofOwner(match[1]);
        } catch (_) {
          proofOwner = null;
        }
      }
      if (!match) {
        errors.push('من فضلك ارفع صورة إيصال التحويل قبل تأكيد الطلب');
      } else if (!(await fsp.access(path.join(PROOFS_DIR, match[1])).then(() => true).catch(() => false))) {
        errors.push('صورة الإيصال لم تُرفع بشكل صحيح، حاول ترفعها تاني');
      } else if (!proofOwner || Number(proofOwner) !== Number(req.user.id)) {
        // (إصلاح IDOR) لازم إثبات التحويل يكون مرفوع من نفس المستخدم صاحب
        // الطلب — وإلا ممكن حد يستخدم اسم ملف إيصال حد تاني.
        return res.status(403).json({
          error: 'صورة الإيصال دي مش تبعك'
        });
      } else if (await store.getOrderByProofFilename(match[1])) {
        // نفس الصورة ما تتستخدمش لأكتر من طلب
        errors.push('صورة الإيصال دي مستخدمة في طلب سابق، ارفع صورة التحويل الجديد');
      } else {
        paymentProofUrl = rawProof;
      }
    }
    if (errors.length) return res.status(400).json({
      error: errors[0],
      errors
    });
    try {
      const order = await store.createOrder({
        userId: req.user.id,
        ...value,
        items,
        paymentProofUrl,
        transferRef: value.transferRef
      });
      notifyCustomer(order, 'استلمنا طلبك 📦', `طلبك رقم #${order.id} تم استلامه بنجاح وجاري مراجعته.`);
      return res.json({
        ok: true,
        orderId: order.id,
        totalAmount: order.total_amount,
        subtotal: order.subtotal,
        discount: order.discount,
        shippingFee: order.shipping_fee,
        order
      });
    } catch (error) {
      if (error.code === 'INVALID_QUANTITY') {
        return res.status(400).json({
          error: 'الكمية يجب أن تكون رقمًا صحيحًا من 1 إلى 999'
        });
      }
      if (error.code === 'INVALID_COUPON') {
        return res.status(400).json({
          error: error.reason || 'كود الخصم غير صالح'
        });
      }
      if (error.code === 'INSUFFICIENT_STOCK') {
        // (6) تنبيه صريح للعميل بدل تقليل الكمية بصمت
        const issues = error.issues || [];
        const detail = issues.map(i => i.available > 0 ? `${i.name}: المتاح ${i.available} فقط (طلبت ${i.requested})` : `${i.name}: نفد من المخزون`).join(' — ');
        return res.status(409).json({
          error: `الكمية المطلوبة غير متاحة. ${detail}`,
          code: 'INSUFFICIENT_STOCK',
          issues
        });
      }
      if (error.code === 'NO_VALID_ITEMS') return res.status(400).json({
        error: 'المنتجات المطلوبة غير متاحة أو نفدت من المخزون.'
      });
      if (error.code === 'PROOF_REUSED' || error.code === '23505') {
        return res.status(409).json({
          error: 'صورة الإيصال دي مستخدمة في طلب سابق، ارفع صورة التحويل الجديد.'
        });
      }
      console.error('[create order]', error);
      return res.status(500).json({
        error: 'تعذر إنشاء الطلب.'
      });
    }
  });
  app.get('/api/orders/mine', requireAuth, async (req, res) => res.json({
    orders: await store.getOrdersByUser(req.user.id)
  }));
  app.get('/api/orders/:id', requireAuth, async (req, res) => {
    const order = await store.getOrderById(req.params.id);
    if (!order) return res.status(404).json({
      error: 'الطلب غير موجود'
    });
    if (order.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({
      error: 'غير مصرح'
    });
    res.json({
      order
    });
  });

  // العميل يستطيع إلغاء طلبه طالما لم يخرج للتوصيل
  app.post('/api/orders/:id/cancel', requireAuth, writeLimiter, async (req, res) => {
    const order = await store.getOrderById(req.params.id);
    if (!order) return res.status(404).json({
      error: 'الطلب غير موجود'
    });
    if (order.user_id !== req.user.id) return res.status(403).json({
      error: 'غير مصرح'
    });
    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({
        error: 'لا يمكن إلغاء الطلب في حالته الحالية'
      });
    }
    const updated = await store.updateOrder(order.id, {
      status: 'cancelled'
    }, 'إلغاء بواسطة العميل');
    res.json({
      ok: true,
      order: updated
    });
  });

  // ---------------------------------------------------------------------------
  // التقييمات والمفضلة
  // ---------------------------------------------------------------------------
  app.get('/api/products/:id/reviews', async (req, res) => res.json({
    reviews: await store.getReviewsByProduct(req.params.id)
  }));
  app.post('/api/products/:id/reviews', requireAuth, writeLimiter, async (req, res) => {
    const rating = Number((req.body || {}).rating);
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({
      error: 'التقييم يجب أن يكون من 1 إلى 5'
    });
    const hasBought = (await store.getOrdersByUser(req.user.id)).some(order => order.status !== 'cancelled' && order.items.some(item => item.productId === Number(req.params.id)));
    if (!hasBought) return res.status(403).json({
      error: 'يمكنك تقييم المنتجات التي اشتريتها فقط'
    });
    try {
      const review = await store.addReview({
        productId: req.params.id,
        userId: req.user.id,
        userName: req.user.name,
        rating,
        comment: asText((req.body || {}).comment, 600)
      });
      return res.json({
        ok: true,
        review
      });
    } catch (_) {
      return res.status(404).json({
        error: 'المنتج غير موجود'
      });
    }
  });
  app.get('/api/wishlist', requireAuth, async (req, res) => res.json({
    products: await store.getWishlist(req.user.id)
  }));
  app.post('/api/wishlist/:productId', requireAuth, writeLimiter, async (req, res) => {
    const product = await store.getProductById(req.params.productId);
    if (!product) return res.status(404).json({
      error: 'المنتج غير موجود'
    });
    res.json({
      ok: true,
      ...(await store.toggleWishlist(req.user.id, product.id))
    });
  });
};
