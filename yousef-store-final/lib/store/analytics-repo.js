/**
 * تحليلات لوحة التحكم
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
module.exports = function createAnalyticsRepo(sctx) {
  const {
    pool
  } = sctx;
  // ربط متأخر: دوال بتعيش في موديولات تانية، بتتحل وقت النداء مش وقت التحميل.
  const getCategories = (...args) => sctx.getCategories(...args);
  const getSiteSettings = (...args) => sctx.getSiteSettings(...args);

  async function getAnalytics(days = 14) {
    const { rows: orders } = await pool.query('SELECT id, user_id, status, payment_status, payment_method, total_amount, customer_name, created_at FROM orders');
    const settings = await getSiteSettings();
    // (أداء) إحصائيات المنتجات بتتحسب في SQL بدل سحب كل جدول المنتجات للذاكرة
    // وعمل filter/reduce عليه — مع آلاف المنتجات ده كان بياكل ذاكرة ووقت.
    const lowStockThreshold = Number(settings.lowStockThreshold || 5);
    const { rows: productStatsRows } = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE active = TRUE)::int AS active_count,
             COUNT(*) FILTER (WHERE active = TRUE AND COALESCE(stock, 0) <= $1)::int AS low_stock,
             COALESCE(SUM(COALESCE(price, 0) * COALESCE(stock, 0)), 0) AS inventory_value,
             COALESCE(SUM(COALESCE(views, 0)), 0)::int AS total_views
      FROM products
    `, [lowStockThreshold]);
    const productStats = productStatsRows[0] || { total: 0, active_count: 0, low_stock: 0, inventory_value: 0, total_views: 0 };
    const paidOrders = orders.filter((o) => o.status !== 'cancelled');
    const revenue = paidOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayOrders = paidOrders.filter((o) => new Date(o.created_at) >= today);

    const series = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - i);
      const next = new Date(day); next.setDate(next.getDate() + 1);
      const dayOrders = paidOrders.filter((o) => { const at = new Date(o.created_at); return at >= day && at < next; });
      series.push({ date: day.toISOString().slice(0, 10), orders: dayOrders.length, revenue: dayOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0) });
    }

    const { rows: topProductRows } = await pool.query(`
      SELECT oi.product_id as "productId", MAX(oi.name) as name,
             SUM(oi.quantity)::int as quantity, SUM(oi.quantity * oi.price) as revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status != 'cancelled'
      GROUP BY oi.product_id
      ORDER BY quantity DESC
      LIMIT 8
    `);

    const statusCounts = orders.reduce((acc, o) => { acc[o.status] = (acc[o.status] || 0) + 1; return acc; }, {});
    const paymentCounts = orders.reduce((acc, o) => { acc[o.payment_method] = (acc[o.payment_method] || 0) + 1; return acc; }, {});

    const customerTotals = new Map();
    paidOrders.forEach((o) => {
      if (!o.user_id) return;
      const entry = customerTotals.get(o.user_id) || { userId: o.user_id, name: o.customer_name, orders: 0, total: 0 };
      entry.orders += 1;
      entry.total += Number(o.total_amount || 0);
      customerTotals.set(o.user_id, entry);
    });

    const { rows: usersCountRows } = await pool.query('SELECT COUNT(*)::int as c FROM users');
    const { rows: customersCountRows } = await pool.query("SELECT COUNT(*)::int as c FROM users WHERE role != 'admin'");
    const { rows: reviewsCountRows } = await pool.query('SELECT COUNT(*)::int as c FROM reviews');
    const { rows: couponsActiveRows } = await pool.query('SELECT COUNT(*)::int as c FROM coupons WHERE active = TRUE');

    // ------------------------------------------------------------------
    // (جديد) إحصائيات إضافية: نمو الفترة، عملاء جدد/عائدين، معدل التحويل،
    // متوسط قِطع الطلب، وأفضل قسم مبيعًا — كلها من بيانات حقيقية موجودة.
    // ------------------------------------------------------------------
    const periodStart = new Date(); periodStart.setHours(0, 0, 0, 0); periodStart.setDate(periodStart.getDate() - (days - 1));
    const prevStart = new Date(periodStart); prevStart.setDate(prevStart.getDate() - days);
    const periodOrders = paidOrders.filter((o) => new Date(o.created_at) >= periodStart);
    const prevPeriodOrders = paidOrders.filter((o) => { const at = new Date(o.created_at); return at >= prevStart && at < periodStart; });
    const periodRevenue = periodOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
    const prevRevenue = prevPeriodOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
    const revenueGrowthPct = prevRevenue > 0 ? ((periodRevenue - prevRevenue) / prevRevenue) * 100 : (periodRevenue > 0 ? 100 : 0);
    const ordersGrowthPct = prevPeriodOrders.length > 0 ? ((periodOrders.length - prevPeriodOrders.length) / prevPeriodOrders.length) * 100 : (periodOrders.length > 0 ? 100 : 0);

    const usersInPeriod = new Set(periodOrders.filter((o) => o.user_id).map((o) => o.user_id));
    let newCustomers = 0; let returningCustomers = 0;
    usersInPeriod.forEach((uid) => {
      const ordersOfUser = paidOrders.filter((o) => o.user_id === uid);
      const firstOrderAt = ordersOfUser.reduce((min, o) => (new Date(o.created_at) < min ? new Date(o.created_at) : min), new Date());
      if (firstOrderAt >= periodStart) newCustomers += 1; else returningCustomers += 1;
    });

    const totalViews = Number(productStats.total_views || 0);
    const conversionRate = totalViews > 0 ? (paidOrders.length / totalViews) * 100 : 0;

    const { rows: itemsRows } = await pool.query(`
      SELECT COALESCE(SUM(oi.quantity), 0)::int as total_items
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status != 'cancelled'
    `);
    const avgItemsPerOrder = paidOrders.length ? (Number(itemsRows[0].total_items || 0) / paidOrders.length) : 0;

    const { rows: bestCatRows } = await pool.query(`
      SELECT p.category as category, SUM(oi.quantity * oi.price) as revenue
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
      WHERE o.status != 'cancelled' AND p.category IS NOT NULL AND p.category != ''
      GROUP BY p.category ORDER BY revenue DESC LIMIT 1
    `);
    const bestCategory = bestCatRows[0] ? { name: bestCatRows[0].category, revenue: Number(bestCatRows[0].revenue || 0) } : null;

    return {
      stats: {
        orders: orders.length,
        products: Number(productStats.total || 0),
        activeProducts: Number(productStats.active_count || 0),
        users: usersCountRows[0].c,
        customers: customersCountRows[0].c,
        pendingOrders: orders.filter((o) => o.status === 'pending').length,
        confirmedOrders: orders.filter((o) => o.status === 'confirmed').length,
        doneOrders: orders.filter((o) => o.status === 'done').length,
        cancelledOrders: orders.filter((o) => o.status === 'cancelled').length,
        totalRevenue: revenue,
        todayRevenue: todayOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0),
        todayOrders: todayOrders.length,
        averageOrder: paidOrders.length ? Math.round(revenue / paidOrders.length) : 0,
        lowStock: Number(productStats.low_stock || 0),
        inventoryValue: Number(productStats.inventory_value || 0),
        reviews: reviewsCountRows[0].c,
        coupons: couponsActiveRows[0].c,
        conversionRate,
        avgItemsPerOrder
      },
      series,
      topProducts: topProductRows.map((r) => ({ productId: r.productId, name: r.name, quantity: Number(r.quantity || 0), revenue: Number(r.revenue || 0) })),
      topCustomers: [...customerTotals.values()].sort((a, b) => b.total - a.total).slice(0, 6),
      statusCounts,
      paymentCounts,
      categories: await getCategories(),
      growth: { revenuePct: revenueGrowthPct, ordersPct: ordersGrowthPct },
      customerSegments: { new: newCustomers, returning: returningCustomers },
      bestCategory
    };
  }

  return {
    getAnalytics
  };
};
