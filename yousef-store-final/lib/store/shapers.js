/**
 * تشكيل وتنقية الصفوف الخارجة من قاعدة البيانات
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
module.exports = function createShapers(sctx) {
  const {
    pool
  } = sctx;

  function sanitizeUser(user) {
    if (!user) return null;
    const { password_hash: _ph, totp_secret: _ts, totp_last_code: _tc, totp_last_at: _ta, ...safe } = user;
    return { ...safe, totp_enabled: user.totp_enabled ? 1 : 0, email_verified: user.email_verified ? 1 : 0, must_change_password: user.must_change_password ? 1 : 0 };
  }

  function decorateProduct(product) {
    if (!product) return null;
    const rating = product.rating_count ? Number((product.rating_sum / product.rating_count).toFixed(1)) : 0;
    let images = [];
    try { images = JSON.parse(product.images || '[]'); } catch (_) { images = []; }
    return { ...product, images, rating, reviews_count: product.rating_count || 0 };
  }

  async function loadOrderItems(client, orderId) {
    const c = client || pool;
    const { rows } = await c.query('SELECT product_id as "productId", name, price, image_url, quantity FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]);
    return rows;
  }

  // (أداء) بديل مجمّع لـ loadOrderItems: بيجيب أصناف عدد كبير من الطلبات
  // بـ query واحد بدل query لكل طلب على حدة (N+1). مهم جدًا في صفحة الطلبات
  // وتصدير CSV لما عدد الطلبات يكبر — كانت كل صفحة (20 طلب) بتعمل 21 رحلة
  // لقاعدة البيانات، وتصدير كل الطلبات كان بيعمل رحلة لكل طلب بمفرده.
  async function loadOrderItemsBatch(client, orderIds) {
    const map = new Map();
    if (!orderIds.length) return map;
    const c = client || pool;
    const { rows } = await c.query(
      'SELECT order_id as "orderId", product_id as "productId", name, price, image_url, quantity FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY order_id, id',
      [orderIds]
    );
    for (const row of rows) {
      const { orderId, ...item } = row;
      if (!map.has(orderId)) map.set(orderId, []);
      map.get(orderId).push(item);
    }
    return map;
  }

  async function shapeOrder(client, order) {
    if (!order) return null;
    let history = [];
    try { history = JSON.parse(order.history || '[]'); } catch (_) { history = []; }
    return { ...order, history, items: await loadOrderItems(client, order.id) };
  }
  async function shapeOrders(client, orders) {
    if (!orders.length) return [];
    const itemsByOrder = await loadOrderItemsBatch(client, orders.map((o) => o.id));
    return orders.map((order) => {
      let history = [];
      try { history = JSON.parse(order.history || '[]'); } catch (_) { history = []; }
      return { ...order, history, items: itemsByOrder.get(order.id) || [] };
    });
  }

  return {
    decorateProduct,
    loadOrderItems,
    sanitizeUser,
    shapeOrder,
    shapeOrders
  };
};
