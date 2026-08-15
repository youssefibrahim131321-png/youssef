/**
 * لوحة التحكم: الإحصائيات والطلبات وتصدير CSV
 * -------------------------------------------------------------------------
 * موديول اتفصل من server.js عشان الملف ما يبقاش آلاف السطور. كل الاعتماديات
 * (الـ store والحدود والمساعدات) بتتمرّر من server.js في كائن deps واحد،
 * فالسلوك زي ما هو بالحرف بس التنظيم بقى أوضح.
 */
module.exports = function registerAdminOrderRoutes(app, deps) {
  const {
    adminBulkLimiter,
    adminWriteLimiter,
    armNotificationTimer,
    asText,
    audit,
    notifyCustomer,
    requireAdmin,
    store
  } = deps;

  app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
    const analytics = await store.getAnalytics(days);
    res.json({
      ...analytics,
      lowStockProducts: await store.getLowStockProducts(),
      recentOrders: await store.getRecentOrders(8),
      activity: await store.getActivityLog(12)
    });
  });

  // (أداء) الفلترة والترقيم بقوا في SQL بدل تحميل جدول الطلبات كله في الذاكرة
  // وفلترته بالـ JS في كل طلب من اللوحة. لو اللوحة بعتت cursor (آخر id شافته
  // في الصفحة اللي فاتت) بنستخدم keyset pagination بدل OFFSET — مهم لما
  // عدد الطلبات يكبر وييجي حد يفتح صفحة بعيدة.
  app.get('/api/admin/orders', requireAdmin, async (req, res) => {
    const {
      status,
      q,
      payment,
      from,
      to,
      cursor
    } = req.query;
    res.json(await store.queryOrders({
      status,
      q,
      payment,
      from,
      to,
      cursor,
      page: req.query.page,
      perPage: req.query.perPage
    }));
  });
  const ORDER_STATUSES = ['pending', 'confirmed', 'shipping', 'done', 'cancelled'];
  const PAYMENT_STATUSES = ['pending', 'paid', 'refunded'];
  app.put('/api/admin/orders/:id', requireAdmin, adminWriteLimiter, async (req, res) => {
    const {
      status,
      paymentStatus,
      notes
    } = req.body || {};
    if (status && !ORDER_STATUSES.includes(status)) return res.status(400).json({
      error: 'حالة الطلب غير صالحة'
    });
    if (paymentStatus && !PAYMENT_STATUSES.includes(paymentStatus)) return res.status(400).json({
      error: 'حالة الدفع غير صالحة'
    });
    const order = await store.updateOrder(req.params.id, {
      status: status || undefined,
      payment_status: paymentStatus || undefined,
      notes: notes !== undefined ? asText(notes, 500) : undefined
    }, 'تحديث من لوحة التحكم');
    if (!order) return res.status(404).json({
      error: 'الطلب غير موجود'
    });
    if (status === 'shipping') notifyCustomer(order, 'طلبك خرج للتوصيل 🚚', `طلبك رقم #${order.id} في الطريق إليك الآن.`);
    if (status === 'done') notifyCustomer(order, 'تم تسليم طلبك ✅', `طلبك رقم #${order.id} تم تسليمه بنجاح، شكرًا لطلبك منّا!`);
    if (status === 'cancelled') notifyCustomer(order, 'تم إلغاء طلبك', `طلبك رقم #${order.id} تم إلغاؤه. تواصل معنا لو كان هذا غير متوقع.`);
    audit(req, 'تحديث طلب', `#${order.id} → ${status || order.status}`);
    res.json({
      ok: true,
      order
    });
  });
  app.post('/api/admin/orders/:id/confirm', requireAdmin, adminWriteLimiter, async (req, res) => {
    const minutes = Number((req.body || {}).notifyMinutes) || 0;
    if (minutes < 0 || minutes > 1440) return res.status(400).json({
      error: 'المدة يجب أن تكون بين 0 و 1440 دقيقة.'
    });
    const order = await store.scheduleOrderNotification(req.params.id, {
      notifyMinutes: minutes,
      notifyMessage: asText((req.body || {}).notifyMessage, 300)
    });
    if (!order) return res.status(404).json({
      error: 'الطلب غير موجود'
    });
    notifyCustomer(order, 'تم تأكيد طلبك ✅', `طلبك رقم #${order.id} تم تأكيده وجاري تجهيزه الآن.`);
    if (order.notify_at) armNotificationTimer(order);
    audit(req, 'تأكيد طلب', `#${order.id} (${minutes} دقيقة)`);
    res.json({
      ok: true,
      order
    });
  });
  app.get('/api/admin/orders/export.csv', requireAdmin, adminBulkLimiter, async (req, res) => {
    const {
      status,
      q,
      payment,
      from,
      to
    } = req.query;
    // (إصلاح) تصدير بيانات العملاء (اسم/هاتف/عنوان) بالجملة عملية حساسة —
    // لازم تتسجّل زي أي فعل إداري تاني، مش بس التعديل والحذف.
    audit(req, 'تصدير الطلبات CSV', [status, payment, q].filter(Boolean).join(' | ') || 'الكل');
    const header = ['رقم الطلب', 'العميل', 'الهاتف', 'العنوان', 'الحالة', 'الدفع', 'طريقة الدفع', 'الخصم', 'الشحن', 'الإجمالي', 'التاريخ'];
    // (10) حماية من CSV Injection: أي خلية بتبدأ بـ = + - @ أو tab/CR بيقرأها
    // Excel/Sheets كصيغة قابلة للتنفيذ. بنسبقها بعلامة اقتباس مفردة عشان تفضل
    // نص عادي، مع الهروب القياسي لعلامات الاقتباس.
    const escapeCsv = value => {
      let text = String(value ?? '').replace(/\r\n|\r|\n/g, ' ');
      if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.write('\uFEFF' + header.join(',') + '\n');
    // (إصلاح أداء) بدل ما نجيب كل الطلبات المطابقة دفعة واحدة في الذاكرة
    // (getOrdersForExport القديمة كانت بتطلب حتى 100000 صف بضربة واحدة)،
    // بنمشي على الطلبات دفعة دفعة (keyset pagination بالـ id) ونكتب كل دفعة
    // للـ response فورًا. الذاكرة المستخدمة بقت محدودة بحجم الدفعة (500 طلب)
    // مش بعدد الطلبات كله، وده بيفرق كتير لما جدول الطلبات يكبر جدًا.
    try {
      for await (const batch of store.iterateOrdersForExport({ status, q, payment, from, to }, 500)) {
        const rows = batch.map(o => [o.id, o.customer_name, o.customer_phone, o.customer_address, o.status, o.payment_status, o.payment_method, o.discount, o.shipping_fee, o.total_amount, o.created_at].map(escapeCsv).join(','));
        res.write(rows.join('\n') + '\n');
      }
    } catch (error) {
      // الهيدرز اتبعتت خلاص، فمش هينفع نرجّع 500 — نقفل الاتصال بس.
      console.error('[orders-export] فشل أثناء الكتابة:', error.message);
    }
    res.end();
  });
};
