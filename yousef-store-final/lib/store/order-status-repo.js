/**
 * استعلام الطلبات وتحديث حالتها والإشعارات المجدولة
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
module.exports = function createOrderStatusRepo(sctx) {
  const {
    nowISO,
    pool,
    withTransaction
  } = sctx;
  // ربط متأخر: دوال بتعيش في موديولات تانية، بتتحل وقت النداء مش وقت التحميل.
  const loadOrderItems = (...args) => sctx.loadOrderItems(...args);
  const shapeOrder = (...args) => sctx.shapeOrder(...args);
  const shapeOrders = (...args) => sctx.shapeOrders(...args);

  async function getOrders() {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY id DESC');
    return shapeOrders(null, rows);
  }

  // (أداء) صفحات لاحقة بتتجاب بـ keyset pagination (id < آخر رقم شفناه) بدل
  // LIMIT/OFFSET. الفرق مش حاسس على صفحة 2 أو 3، لكن مع نمو جدول الطلبات
  // لصفحات بعيدة (يعني OFFSET بعشرات أو مئات الآلاف)، Postgres كان لازم
  // يعدّ ويرمي كل الصفوف اللي قبلها كل مرة — كل صفحة كانت بتبقى أبطأ من
  // اللي قبلها. الـ cursor هنا هو الـ id بتاع آخر طلب في الصفحة اللي فاتت؛
  // اللوحة بتحتفظ بيه بنفسها وبتبعته تاني وقت "التالي" (شوف orders.js).
  // من غير cursor بنرجع لسلوك page/perPage القديم بالـ OFFSET، وده لسه
  // مستخدَم في الصفحة الأولى وفي getOrdersForExport وفي الاختبارات الحالية.
  async function queryOrders({ status, payment, from, to, q, page = 1, perPage = 20, cursor = null } = {}) {
    const where = [];
    const args = [];
    const p = () => `$${args.length}`;
    if (status && status !== 'all') { args.push(String(status)); where.push(`status = ${p()}`); }
    if (payment && payment !== 'all') { args.push(String(payment)); where.push(`payment_method = ${p()}`); }
    if (from) { args.push(new Date(from).toISOString()); where.push(`created_at >= ${p()}`); }
    if (to) { args.push(`${String(to)}T23:59:59.999Z`); where.push(`created_at <= ${p()}`); }
    if (q) {
      const needle = `%${String(q).toLowerCase()}%`;
      args.push(needle); const a1 = p();
      args.push(needle); const a2 = p();
      args.push(needle); const a3 = p();
      args.push(needle); const a4 = p();
      where.push(`(CAST(id AS TEXT) LIKE ${a1} OR lower(customer_name) LIKE ${a2} OR customer_phone LIKE ${a3} OR lower(customer_address) LIKE ${a4})`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const safePage = Math.max(1, Number(page) || 1);
    const safePerPage = Math.min(100, Math.max(5, Number(perPage) || 20));
    const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM orders ${clause}`, args);
    const total = Number(countRows[0].n || 0);

    const cursorId = cursor !== null && cursor !== undefined && cursor !== '' ? Number(cursor) : null;
    let rows;
    if (cursorId !== null && Number.isFinite(cursorId)) {
      const cArgs = [...args, cursorId, safePerPage];
      const cClause = clause ? `${clause} AND id < $${cArgs.length - 1}` : `WHERE id < $${cArgs.length - 1}`;
      ({ rows } = await pool.query(`SELECT * FROM orders ${cClause} ORDER BY id DESC LIMIT $${cArgs.length}`, cArgs));
    } else {
      const limitArgs = [...args, safePerPage, (safePage - 1) * safePerPage];
      ({ rows } = await pool.query(`SELECT * FROM orders ${clause} ORDER BY id DESC LIMIT $${limitArgs.length - 1} OFFSET $${limitArgs.length}`, limitArgs));
    }

    return {
      orders: await shapeOrders(null, rows),
      total,
      page: safePage,
      perPage: safePerPage,
      pages: Math.max(1, Math.ceil(total / safePerPage)),
      // آخر id في الصفحة دي — اللوحة بتخزّنه وتبعته كـ cursor وقت طلب الصفحة اللي بعدها.
      nextCursor: rows.length ? rows[rows.length - 1].id : null
    };
  }

  async function getOrdersForExport(filters = {}) {
    const result = await queryOrders({ ...filters, page: 1, perPage: 100000 });
    return result.orders;
  }

  // (أداء) تصدير CSV بدفعات (keyset pagination بالـ id) بدل query واحد ممكن
  // يرجّع عشرات الآلاف من الصفوف مرة واحدة (COUNT + OFFSET كبير بيبقى بطيء
  // وبياكل ميموري كتير مع نمو جدول الطلبات). كل دفعة بتستخدم shapeOrders
  // المجمّعة (query واحد للأصناف بدل واحد لكل طلب)، فالذاكرة والاستعلامات
  // محدودة بحجم الدفعة بس مش بعدد الطلبات كله.
  async function* iterateOrdersForExport({ status, payment, from, to, q } = {}, batchSize = 500) {
    const where = [];
    const baseArgs = [];
    const p = () => `$${baseArgs.length}`;
    if (status && status !== 'all') { baseArgs.push(String(status)); where.push(`status = ${p()}`); }
    if (payment && payment !== 'all') { baseArgs.push(String(payment)); where.push(`payment_method = ${p()}`); }
    if (from) { baseArgs.push(new Date(from).toISOString()); where.push(`created_at >= ${p()}`); }
    if (to) { baseArgs.push(`${String(to)}T23:59:59.999Z`); where.push(`created_at <= ${p()}`); }
    if (q) {
      const needle = `%${String(q).toLowerCase()}%`;
      baseArgs.push(needle); const a1 = p();
      baseArgs.push(needle); const a2 = p();
      baseArgs.push(needle); const a3 = p();
      baseArgs.push(needle); const a4 = p();
      where.push(`(CAST(id AS TEXT) LIKE ${a1} OR lower(customer_name) LIKE ${a2} OR customer_phone LIKE ${a3} OR lower(customer_address) LIKE ${a4})`);
    }

    let cursor = null;
    for (;;) {
      const clauseParts = [...where];
      const args = [...baseArgs];
      if (cursor !== null) { args.push(cursor); clauseParts.push(`id < $${args.length}`); }
      const clause = clauseParts.length ? `WHERE ${clauseParts.join(' AND ')}` : '';
      args.push(batchSize);
      const { rows } = await pool.query(
        `SELECT * FROM orders ${clause} ORDER BY id DESC LIMIT $${args.length}`, args);
      if (!rows.length) return;
      yield await shapeOrders(null, rows);
      if (rows.length < batchSize) return;
      cursor = rows[rows.length - 1].id;
    }
  }

  async function getRecentOrders(limit = 8) {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT $1', [Math.max(1, Number(limit) || 8)]);
    return shapeOrders(null, rows);
  }
  async function getOrdersByUser(userId) {
    const { rows } = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC', [Number(userId)]);
    return shapeOrders(null, rows);
  }
  async function getOrderById(id) {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [Number(id)]);
    return rows[0] ? shapeOrder(null, rows[0]) : null;
  }

  // (إصلاح) طلبات Paymob غير المدفوعة (pending/failed) بتفضل خاصمة من
  // المخزون لغاية ما حد يلغيها يدويًا. الدالة دي بترجّع مرشّحين للإلغاء
  // التلقائي: طلبات Paymob لسه في حالة pending عادية (مش cancelled/done)
  // وحالة دفعها pending أو failed، وعدّت عليها المهلة المحددة من إنشائها.
  async function getStalePaymobOrders(olderThanMs) {
    const cutoff = new Date(Date.now() - Number(olderThanMs || 0)).toISOString();
    const { rows } = await pool.query(
      `SELECT id FROM orders
       WHERE payment_method = 'paymob'
         AND status = 'pending'
         AND payment_status IN ('pending', 'failed')
         AND created_at < $1
       ORDER BY created_at`,
      [cutoff]
    );
    return rows.map(r => r.id);
  }

  async function restoreStockForOrder(client, orderId) {
    const items = await loadOrderItems(client, orderId);
    for (const item of items) {
      await client.query('UPDATE products SET stock = stock + $1::int, sold = GREATEST(0, sold - $2::int) WHERE id = $3', [item.quantity, item.quantity, item.productId]);
    }
  }

  async function deductStockForOrder(client, orderId) {
    const items = [...await loadOrderItems(client, orderId)].sort((a, b) => Number(a.productId) - Number(b.productId));
    const issues = [];
    // (إصلاح oversell) خصم شرطي ذرّي لكل صنف بدل فحص ثم خصم (TOCTOU).
    for (const item of items) {
      const { rows, rowCount } = await client.query(
        'UPDATE products SET stock = stock - $1::int, sold = sold + $2::int WHERE id = $3 AND stock >= $4::int RETURNING id, stock',
        [item.quantity, item.quantity, item.productId, item.quantity]);
      if (!rowCount) {
        const { rows: prows } = await client.query('SELECT id, name, stock FROM products WHERE id = $1', [item.productId]);
        const product = prows[0];
        issues.push({
          productId: item.productId,
          name: product ? product.name : item.name,
          available: product ? Math.max(0, Number(product.stock || 0)) : 0,
          requested: item.quantity
        });
      }
      void rows;
    }
    if (issues.length) {
      const err = new Error('Insufficient stock');
      err.code = 'INSUFFICIENT_STOCK';
      err.issues = issues;
      throw err;
    }
  }

  const ORDER_STATUS_VALUES = ['pending', 'confirmed', 'shipping', 'done', 'cancelled'];
  const PAYMENT_STATUS_VALUES = ['pending', 'paid', 'failed', 'refunded'];

  async function updateOrder(id, updates, note, options = {}) {
    if (updates && updates.status !== undefined && !ORDER_STATUS_VALUES.includes(updates.status)) {
      throw new Error('حالة الطلب غير صالحة');
    }
    if (updates && updates.payment_status !== undefined && !PAYMENT_STATUS_VALUES.includes(updates.payment_status)) {
      throw new Error('حالة الدفع غير صالحة');
    }
    return withTransaction(pool, async (client) => {
      // (إصلاح سباق) قفل صف الطلب: أي محاولتين متزامنتين (مثلًا إعادة إرسال
      // webhook من Paymob) بيتسلسلوا، فالتحقق من idempotency بقى موثوق.
      const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [Number(id)]);
      const order = rows[0];
      if (!order) return null;
      // حماية انتقال حالة الدفع: لو الطلب وصل لحالة نهائية خلاص، ما نلمسوش تاني.
      const blocked = Array.isArray(options.skipIfPaymentStatusIn) ? options.skipIfPaymentStatusIn : null;
      if (blocked && blocked.includes(order.payment_status)) {
        return { ...await shapeOrder(client, order), skipped: true };
      }
      const previousStatus = order.status;
      const fieldMap = {
        status: 'status', payment_status: 'payment_status', notes: 'notes', customer_name: 'customer_name',
        customer_phone: 'customer_phone', customer_address: 'customer_address', payment_proof_url: 'payment_proof_url'
      };
      const sets = [];
      const params = [];
      Object.keys(updates).forEach((key) => {
        if (updates[key] !== undefined && fieldMap[key]) { params.push(updates[key]); sets.push(`${fieldMap[key]} = $${params.length}`); }
      });
      let history = [];
      try { history = JSON.parse(order.history || '[]'); } catch (_) { history = []; }
      if (updates.status && updates.status !== previousStatus) {
        history.push({ status: updates.status, at: nowISO(), note: note || '' });
        params.push(JSON.stringify(history)); sets.push(`history = $${params.length}`);
        if (updates.status === 'cancelled' && previousStatus !== 'cancelled') {
          await restoreStockForOrder(client, order.id);
        }
        if (previousStatus === 'cancelled' && updates.status !== 'cancelled') {
          await deductStockForOrder(client, order.id);
        }
        if (updates.status === 'done' && order.payment_status === 'pending') { params.push('paid'); sets.push(`payment_status = $${params.length}`); }
      }
      if (sets.length) {
        params.push(order.id);
        await client.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
      const { rows: after } = await client.query('SELECT * FROM orders WHERE id = $1', [order.id]);
      return shapeOrder(client, after[0]);
    });
  }

  async function scheduleOrderNotification(id, { notifyMinutes, notifyMessage }) {
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query('SELECT * FROM orders WHERE id = $1', [Number(id)]);
      const order = rows[0];
      if (!order) return null;
      let history = [];
      try { history = JSON.parse(order.history || '[]'); } catch (_) { history = []; }
      history.push({ status: 'confirmed', at: nowISO(), note: 'تم تأكيد الطلب من لوحة التحكم' });
      const minutes = Number(notifyMinutes);
      let notifyAt = null; let notifyMsg = null; let notified = true;
      if (minutes > 0) {
        notifyAt = new Date(Date.now() + minutes * 60000).toISOString();
        notifyMsg = String(notifyMessage || '').slice(0, 300) || null;
        notified = false;
      }
      await client.query(`UPDATE orders SET status='confirmed', confirmed_at=$1, history=$2, notify_minutes=$3, notify_at=$4, notify_message=$5, notified=$6 WHERE id=$7`,
        [nowISO(), JSON.stringify(history), minutes > 0 ? minutes : null, notifyAt, notifyMsg, notified, order.id]);
      const { rows: after } = await client.query('SELECT * FROM orders WHERE id = $1', [order.id]);
      return shapeOrder(client, after[0]);
    });
  }

  async function markOrderNotified(id) {
    await pool.query('UPDATE orders SET notified = TRUE WHERE id = $1', [Number(id)]);
    return getOrderById(id);
  }

  async function claimOrderNotification(id) {
    const res = await pool.query('UPDATE orders SET notified = TRUE WHERE id = $1 AND notified = FALSE', [Number(id)]);
    return res.rowCount > 0;
  }
  async function releaseOrderNotification(id) {
    const res = await pool.query('UPDATE orders SET notified = FALSE WHERE id = $1', [Number(id)]);
    return res.rowCount > 0;
  }

  async function getPendingScheduledNotifications() {
    const { rows } = await pool.query('SELECT * FROM orders WHERE notify_at IS NOT NULL AND notified = FALSE');
    return shapeOrders(null, rows);
  }

  return {
    ORDER_STATUS_VALUES,
    PAYMENT_STATUS_VALUES,
    claimOrderNotification,
    deductStockForOrder,
    getOrderById,
    getOrders,
    getOrdersByUser,
    getOrdersForExport,
    iterateOrdersForExport,
    getPendingScheduledNotifications,
    getRecentOrders,
    getStalePaymobOrders,
    markOrderNotified,
    queryOrders,
    releaseOrderNotification,
    restoreStockForOrder,
    scheduleOrderNotification,
    updateOrder
  };
};
