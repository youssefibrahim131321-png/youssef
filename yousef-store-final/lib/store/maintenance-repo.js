/**
 * flush/backup واللقطة الكاملة للبيانات
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
module.exports = function createMaintenanceRepo(sctx) {
  const {
    SCHEMA_VERSION,
    pool
  } = sctx;
  // ربط متأخر: دوال بتعيش في موديولات تانية، بتتحل وقت النداء مش وقت التحميل.
  const decorateProduct = (...args) => sctx.decorateProduct(...args);
  const getSiteSettings = (...args) => sctx.getSiteSettings(...args);
  const shapeOrders = (...args) => sctx.shapeOrders(...args);

  async function flush() { return true; }

  // (ترقية) VACUUM INTO بتاعة SQLite اتشالت تمامًا — Railway Postgres عنده
  // نسخ احتياطي مُدار تلقائيًا (managed backups + point-in-time recovery) على
  // مستوى المنصة، فمفيش داعي لأي نسخ يدوي من جوه التطبيق. الدالة فضلت موجودة
  // (بترجع false وبتسجّل تحذير) عشان أي كود قديم بينادي عليها ما ينهارش،
  // وعشان توثّق ليه الميزة اتشالت لمين بيقرأ الكود بعدين.
  async function backup() {
    console.warn('[store] النسخ الاحتياطي بقى مسؤولية Railway Postgres (managed backups) — مفيش نسخ يدوي من التطبيق دلوقتي.');
    return false;
  }

  // (إصلاح ملاحظة الأداء) التصدير الكامل كان بيسحب الجداول كلها بدون حد،
  // فمع عشرات آلاف الصفوف ممكن ياكل ذاكرة السيرفر. دلوقتي فيه سقف واضح
  // (EXPORT_MAX_ROWS، افتراضي 50000 لكل جدول) والرد بيوضّح لو حصل اقتطاع.
  const EXPORT_MAX_ROWS = Math.max(1000, Number(process.env.EXPORT_MAX_ROWS || 50000));

  async function getRawSnapshot() {
    const truncated = [];
    const capped = async (table, orderBy) => {
      const { rows } = await pool.query(
        `SELECT * FROM ${table}${orderBy ? ` ORDER BY ${orderBy}` : ''} LIMIT $1`, [EXPORT_MAX_ROWS]);
      if (rows.length >= EXPORT_MAX_ROWS) truncated.push(table);
      return rows;
    };
    const users = await capped('users', 'id');
    const productsRaw = await capped('products', 'id');
    const ordersRaw = await capped('orders', 'id DESC');
    const coupons = await capped('coupons');
    const reviews = await capped('reviews', 'id DESC');
    const wishlists = await capped('wishlists');
    const notifications = await capped('notifications', 'id DESC');
    const pushSubscriptions = await capped('push_subscriptions');
    const activityLog = await capped('activity_log', 'id DESC');
    return {
      schemaVersion: SCHEMA_VERSION,
      exportLimit: EXPORT_MAX_ROWS,
      truncatedTables: truncated,
      users,
      products: productsRaw.map(decorateProduct),
      orders: await shapeOrders(null, ordersRaw),
      coupons,
      reviews,
      wishlists,
      notifications,
      pushSubscriptions,
      activityLog,
      siteSettings: await getSiteSettings(),
      sessionSecret: null,
      vapid: null
    };
  }

  return {
    backup,
    flush,
    getRawSnapshot
  };
};
