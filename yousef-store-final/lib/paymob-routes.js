/**
 * lib/paymob-routes.js — راوتس بوابة Paymob. الملف ده self-contained ومحدش
 * غيره بيعدّل فيه، فمينفعش يفترض أي حاجة عن server.js غير اللي بييجيله في
 * `deps`.
 *
 * الاستخدام من server.js:
 *   const { registerPaymobRoutes } = require('./lib/paymob-routes');
 *   registerPaymobRoutes(app, { store, csrfProtection, requireAuth, rateLimit });
 *
 * شكل deps المطلوب بالظبط:
 *   store            : كائن store.js (async). لازم يوفّر:
 *                        - await store.getOrderById(id)
 *                        - await store.updateOrder(id, updates, note)
 *                        - await store.createOrder({ userId, customerName, customerPhone,
 *                            customerAddress, paymentMethod, notes, items, couponCode })
 *                        - await store.findUserById(id) (اختياري، لبريد العميل لو موجود)
 *   csrfProtection   : middleware الـ CSRF الحالي (Express) — بيتطبق بس على
 *                      /api/checkout/paymob (المسار الوحيد اللي بينده المتصفح
 *                      مباشرة بجلسة أدمن/عميل). الـ webhook والـ return مش
 *                      بيتعملهم csrf لأنهم مش نداء من المتصفح بجلسة العميل.
 *   requireAuth      : middleware بيتأكد إن req.user موجود (401 لو لأ).
 *   webhookRateLimit : (اختياري) حد معدّل خاص بالـ webhook بس. من غيره الـ
 *                      webhook بيشارك حد الكتابة العام بمفتاح IP، فزحمة إشعارات
 *                      دفع مشروعة من نفس IP بتاع Paymob ممكن تترفض بـ 429.
 *   rateLimit        : دالة (req) => middleware، أو middleware جاهز يتحط على
 *                      /api/checkout/paymob. بنقبل الشكلين: لو function بـ
 *                      arity صفر أو بترجّع middleware نستخدمها زي ما هي، ولو
 *                      حد فضّل يبعت middleware جاهز (زي writeLimiter) بيشتغل
 *                      نفس الشيء.
 */
const paymob = require('./paymob');

function asMiddleware(rateLimit) {
  if (typeof rateLimit !== 'function') return (_req, _res, next) => next();
  // لو الدالة بتاخد (req,res,next) مباشرة (middleware جاهز) استخدمها زي ما هي.
  if (rateLimit.length >= 2) return rateLimit;
  // لو factory بترجّع middleware
  try {
    const mw = rateLimit();
    if (typeof mw === 'function') return mw;
  } catch (_) { /* تجاهل */ }
  return (_req, _res, next) => next();
}

function registerPaymobRoutes(app, deps = {}) {
  const { store, csrfProtection, requireAuth, rateLimit, webhookRateLimit } = deps;
  if (!store) throw new Error('registerPaymobRoutes: store مطلوب');
  const limiter = asMiddleware(rateLimit);
  // (إصلاح) الـ webhook له scope وحد منفصلين — مش بيشارك عدّاد الكتابة بتاع
  // زوّار الموقع، فما ينفعش إشعار دفع حقيقي يترفض بسبب زحمة طلبات تانية.
  const webhookLimiter = webhookRateLimit ? asMiddleware(webhookRateLimit) : limiter;
  const noop = (_req, _res, next) => next();
  const csrf = typeof csrfProtection === 'function' ? csrfProtection : noop;
  const auth = typeof requireAuth === 'function' ? requireAuth : noop;
  const checkoutResults = new Map();
  const MAX_PENDING_PAYMOB = Math.max(1, Number(process.env.MAX_PENDING_PAYMOB_ORDERS || 3));
  if (paymob.isEnabled() && !paymob.hasHmacSecret()) {
    console.error('[paymob] تحذير: PAYMOB_HMAC_SECRET غير مضبوط؛ سيتم رفض كل webhooks حتى يتم ضبطه.');
  }

  // (مراقبة) توثيق كل محاولة تعامل مع Paymob في جدول paymob_events. اللوج ده
  // ما ينفعش يكسر عملية دفع، فبنتجاهل أي فشل فيه بهدوء.
  const logEvent = (event) => {
    try {
      const out = store.logPaymobEvent ? store.logPaymobEvent(event) : null;
      if (out && typeof out.catch === 'function') out.catch(() => {});
    } catch (_) { /* لا شيء */ }
  };

  // -------------------------------------------------------------------------
  // إنشاء عملية دفع أونلاين: بينشئ الطلب في القاعدة أولاً بحالة pending، وبعدين
  // ينشئ نية الدفع عند Paymob بنفس مبلغ الطلب المحسوب من السيرفر (مش من العميل).
  // -------------------------------------------------------------------------
  // نقطة تظبيط بسيطة للواجهة الأمامية: تعرف هل الدفع أونلاين مفعّل ولا لأ،
  // من غير ما تفترض شكل أي endpoint إعدادات تاني في المشروع.
  app.get('/api/config', (_req, res) => {
    res.json({ paymobEnabled: paymob.isEnabled() });
  });

  app.post('/api/checkout/paymob', auth, csrf, limiter, async (req, res) => {
    try {
      if (!paymob.isEnabled()) {
        return res.status(503).json({ error: 'الدفع أونلاين غير متاح حاليًا، استخدم الدفع عند الاستلام.' });
      }
      const body = req.body || {};
      const idemKey = String(req.get('Idempotency-Key') || '').trim().slice(0, 120);
      if (store.pool && req.user?.id) {
        const pending = await store.pool.query(
          "SELECT COUNT(*)::int AS count FROM orders WHERE user_id = $1 AND payment_method = 'paymob' AND payment_status = 'pending' AND created_at > NOW() - ($2::text || ' minutes')::interval",
          [Number(req.user.id), String(process.env.PAYMOB_PENDING_WINDOW_MINUTES || 45)]
        );
        if (Number(pending.rows?.[0]?.count || 0) >= MAX_PENDING_PAYMOB) {
          return res.status(429).json({ error: `لديك ${MAX_PENDING_PAYMOB} عمليات دفع معلقة. أكمل واحدة منها أو انتظر انتهائها.` });
        }
      }
      const customerName = String(body.customerName || req.user?.name || '').trim();
      const customerPhone = String(body.customerPhone || '').trim();
      const customerAddress = String(body.customerAddress || '').trim();
      const notes = String(body.notes || '').trim();
      const couponCode = body.couponCode ? String(body.couponCode).trim() : undefined;
      const items = Array.isArray(body.items) ? body.items : [];
      const method = ['card', 'wallet'].includes(body.method) ? body.method : null;
      const requestKey = `${req.user.id}:${idemKey || JSON.stringify({ customerPhone, customerAddress, couponCode, method, items })}`;
      if (checkoutResults.has(requestKey)) return res.json(checkoutResults.get(requestKey));

      if (!customerName || customerName.length < 2 || customerName.length > 80) {
        return res.status(400).json({ error: 'اسم العميل غير صالح' });
      }
      if (!/^01[0-9]{9}$/.test(customerPhone)) {
        return res.status(400).json({ error: 'رقم الهاتف غير صالح' });
      }
      if (!customerAddress || customerAddress.length < 10 || customerAddress.length > 300) {
        return res.status(400).json({ error: 'العنوان غير صالح' });
      }
      if (!items.length || items.length > 50) {
        return res.status(400).json({ error: 'السلة فارغة أو تحتوي منتجات كثيرة جدًا' });
      }
      const badQty = items.some((item) => {
        const q = Number(item && item.quantity);
        return !Number.isFinite(q) || !Number.isInteger(q) || q < 1 || q > 999;
      });
      if (badQty) return res.status(400).json({ error: 'كمية غير صالحة في السلة' });

      // (مهم) الطلب بيتعمل بحالة pending + payment_method='paymob'. المبلغ
      // بيتحسب جوه createOrder من المنتجات الفعلية في القاعدة، مش من العميل.
      let order;
      try {
        order = await store.createOrder({
          userId: req.user.id,
          customerName,
          customerPhone,
          customerAddress,
          paymentMethod: 'paymob',
          notes,
          items,
          couponCode
        });
      } catch (error) {
        if (error.code === 'INSUFFICIENT_STOCK') {
          return res.status(409).json({ error: 'الكمية المطلوبة غير متاحة.', code: 'INSUFFICIENT_STOCK', issues: error.issues || [] });
        }
        if (error.code === 'INVALID_COUPON') return res.status(400).json({ error: error.reason || 'كود الخصم غير صالح' });
        if (error.code === 'NO_VALID_ITEMS') return res.status(400).json({ error: 'المنتجات المطلوبة غير متاحة أو نفدت من المخزون.' });
        throw error;
      }

      let checkout;
      try {
        checkout = await paymob.createCheckout({
          order,
          customer: { name: customerName, phone: customerPhone, address: customerAddress, email: req.user.email },
          methods: method ? [method] : undefined
        });
      } catch (error) {
        // (مهم) لو Paymob فشل، الطلب فاضل موجود بحالة pending عشان العميل
        // يقدر يجرب تاني أو يكلّم الدعم — مش بنمسحه.
        console.error('[paymob] فشل إنشاء نية الدفع:', error.code || error.message);
        logEvent({ stage: 'checkout', outcome: 'gateway_error', orderId: order.id, expectedAmount: order.total_amount, detail: error.code || error.message });
        return res.status(502).json({ error: 'تعذر الاتصال ببوابة الدفع، حاول مرة أخرى أو اختر الدفع عند الاستلام.', orderId: order.id });
      }

      logEvent({ stage: 'checkout', outcome: 'intention_created', success: true, orderId: order.id, expectedAmount: order.total_amount, txnId: checkout.providerRef, detail: 'تم إنشاء نية دفع' });
      const result = { ok: true, orderId: order.id, url: checkout.url };
      if (requestKey) { checkoutResults.set(requestKey, result); setTimeout(() => checkoutResults.delete(requestKey), 15 * 60 * 1000).unref?.(); }
      return res.json(result);
    } catch (error) {
      console.error('[paymob] /api/checkout/paymob error:', error.message);
      return res.status(500).json({ error: 'تعذر بدء عملية الدفع.' });
    }
  });

  // -------------------------------------------------------------------------
  // Webhook: Paymob بيبعت إشعار السيرفر-لسيرفر ده بعد كل معاملة. لازم يفضل
  // من غير CSRF (مش نداء من متصفح فيه جلستنا) وبيتحقق أمانه بالـ HMAC بس.
  // idempotent: أي استدعاء متكرر لنفس المعاملة ما بيغيّرش حالة طلب مدفوع فعلاً.
  // -------------------------------------------------------------------------
  app.post('/api/public/paymob/webhook', webhookLimiter, async (req, res) => {
    try {
      // (إصلاح أمني) التحقق من HMAC إجباري: المسار ده معفي من CSRF، فالتوقيع هو
      // وسيلة المصادقة الوحيدة. لو السر مش مظبوط بنرفض كل الطلبات (fail closed)
      // بدل ما الـ webhook يشتغل بدون تحقق.
      if (!paymob.hasHmacSecret()) {
        console.error('[paymob webhook] PAYMOB_HMAC_SECRET مش مظبوط — الـ webhook مرفوض بالكامل.');
        logEvent({ stage: 'webhook', outcome: 'not_configured', detail: 'PAYMOB_HMAC_SECRET غير مظبوط' });
        return res.status(503).json({ error: 'الـ webhook غير مهيأ' });
      }
      const receivedHmac = String(req.query.hmac || req.get('x-paymob-hmac') || '').trim();
      const payload = req.body;
      if (!/^[a-f0-9]{64,128}$/i.test(receivedHmac) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({ error: 'طلب غير صالح' });
      }
      if (!paymob.verifyHmac(payload, receivedHmac)) {
        // (أمان) ما بنطبعش أي جزء من الـ payload أو الـ HMAC نفسه في اللوج.
        console.warn('[paymob webhook] توقيع HMAC غير صالح، تم الرفض.');
        logEvent({ stage: 'webhook', outcome: 'invalid_hmac', hmacValid: false, detail: 'توقيع غير مطابق' });
        return res.status(401).json({ error: 'توقيع غير صالح' });
      }

      const obj = payload.obj || payload;
      const specialRef = String(obj?.order?.merchant_order_id || obj?.order?.special_reference || obj?.special_reference || '').trim();
      const match = /^order-(\d+)$/.exec(specialRef);
      if (!match) {
        logEvent({ stage: 'webhook', outcome: 'unknown_reference', hmacValid: true, detail: 'مرجع الطلب غير معروف' });
        return res.status(400).json({ error: 'مرجع الطلب غير معروف' });
      }
      const orderId = Number(match[1]);

      const order = await store.getOrderById(orderId);
      if (!order || order.payment_method !== 'paymob') {
        logEvent({ stage: 'webhook', outcome: 'order_not_found', hmacValid: true, orderId, detail: 'الطلب غير موجود أو مش paymob' });
        return res.status(404).json({ error: 'الطلب غير موجود' });
      }

      // (أمان) المبلغ اللي رجع من Paymob لازم يطابق إجمالي الطلب عندنا —
      // منعًا لأي محاولة تلاعب بمبلغ أقل ونجاح وهمي.
      const paidAmount = Number(obj.amount_cents) / 100;
      const success = obj.success === true || obj.success === 'true';
      const amountMatches = Math.abs(paidAmount - Number(order.total_amount)) < 0.01;

      // (idempotency) الفحص بقى جوّه نفس المعاملة اللي بتقفل صف الطلب
      // (skipIfPaymentStatusIn) بدل قراءة برّه المعاملة — فإعادة إرسال الإشعار
      // مرتين في نفس اللحظة مستحيل تتنفّذ مرتين.
      const finalStatuses = ['paid', 'refunded'];
      if (finalStatuses.includes(order.payment_status)) {
        logEvent({ stage: 'webhook', outcome: 'already_final', success: true, hmacValid: true, orderId, txnId: obj.id, amountCents: obj.amount_cents, expectedAmount: order.total_amount, detail: `الحالة النهائية ${order.payment_status} موجودة قبل كده` });
        return res.status(200).json({ ok: true, already: true });
      }

      const updated = success && amountMatches
        ? await store.updateOrder(orderId, { payment_status: 'paid' }, 'تم الدفع أونلاين عبر Paymob', { skipIfPaymentStatusIn: finalStatuses })
        : await store.updateOrder(orderId, { payment_status: 'failed' }, success ? 'مبلغ الدفع غير مطابق' : 'فشلت عملية الدفع أونلاين', { skipIfPaymentStatusIn: finalStatuses });
      logEvent({
        stage: 'webhook',
        outcome: success && amountMatches ? 'paid' : (success ? 'amount_mismatch' : 'failed'),
        success: !!(success && amountMatches),
        hmacValid: true,
        orderId,
        txnId: obj.id,
        amountCents: obj.amount_cents,
        expectedAmount: order.total_amount,
        detail: success && amountMatches ? 'تم تأكيد الدفع' : (success ? `المبلغ المستلم ${paidAmount} لا يطابق ${order.total_amount}` : 'فشلت المعاملة عند البوابة')
      });
      if (updated && updated.skipped) {
        return res.status(200).json({ ok: true, already: true });
      }
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error('[paymob webhook] error:', error.message);
      logEvent({ stage: 'webhook', outcome: 'error', detail: error.message });
      // (إصلاح) الكود كان بيرجّع 500 فعليًا رغم إن التعليق بيقول 200 — ده كان
      // بيخلي Paymob يعتبرها فشل مؤقت ويعمل Retry Storm على نفس الإشعار.
      // 200 هنا يعني بس "استلمنا الإشعار"، مش إن الدفع نجح؛ الخطأ مسجّل باللوج
      // للمتابعة اليدوية، وأي محاولة تانية (retry طبيعي من Paymob أو مراجعة
      // يدوية) هتعيد تنفيذ نفس المنطق idempotent فوق.
      return res.status(200).json({ ok: true, error: 'تعذرت معالجة الإشعار داخليًا، تم التسجيل للمراجعة' });
    }
  });

  // -------------------------------------------------------------------------
  // صفحة رجوع العميل بعد الدفع (Transaction response callback). بنتحقق من
  // الـ HMAC الموجود في الـ query string، وبعدين نوجّه لصفحة نجاح/فشل بسيطة.
  // ملحوظة: ده مجرد تجربة استخدام للعميل — التأكيد الفعلي للطلب بييجي من
  // الـ webhook فوق، مش من هنا (المتصفح ممكن يقفل قبل ما يوصل هنا).
  // -------------------------------------------------------------------------
  app.get('/payment/return', async (req, res) => {
    try {
      const receivedHmac = String(req.query.hmac || '').trim();
      const payloadFromQuery = { obj: req.query };
      const validHmac = receivedHmac && paymob.verifyHmac(payloadFromQuery, receivedHmac);
      const success = String(req.query.success || '').toLowerCase() === 'true';
      const specialRef = String(req.query.merchant_order_id || '').trim();
      const match = /^order-(\d+)$/.exec(specialRef);
      const orderId = match ? match[1] : '';

      if (!validHmac) {
        logEvent({ stage: 'return', outcome: 'invalid_hmac', hmacValid: false, orderId: orderId || null, detail: 'توقيع صفحة الرجوع غير صالح' });
        return res.redirect(`/order-status.html?status=unknown${orderId ? `&order=${encodeURIComponent(orderId)}` : ''}`);
      }
      const status = success ? 'success' : 'failed';
      return res.redirect(`/order-status.html?status=${status}${orderId ? `&order=${encodeURIComponent(orderId)}` : ''}`);
    } catch (error) {
      console.error('[paymob return] error:', error.message);
      return res.redirect('/order-status.html?status=unknown');
    }
  });
}

module.exports = { registerPaymobRoutes };
