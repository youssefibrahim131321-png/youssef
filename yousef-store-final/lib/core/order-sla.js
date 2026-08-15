// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
module.exports = async function startOrderSlaAlerts(deps = {}) {
  const { everyInstances, sendPushToUser, store } = deps;
  // ---------------------------------------------------------------------------
  // (إصلاح) تنبيه الطلبات المعلّقة (SLA)
  // ---------------------------------------------------------------------------
  // الدفع اليدوي معناه إن كل طلب مستني مراجعة بشرية. لو الأدمن مش فاتح اللوحة،
  // الطلب كان بيفضل معلّق بلا نهاية والعميل مستني. دلوقتي بنبّه الأدمن جوّه
  // المتجر + push على أي طلب عدّى عليه ORDER_SLA_HOURS وهو لسه pending.
  const ORDER_SLA_MS = Math.max(1, Number(process.env.ORDER_SLA_HOURS || 3)) * 60 * 60 * 1000;
  const slaAlerted = new Set();
  async function alertStalePendingOrders() {
    try {
      const stale = await store.getStalePendingOrders(ORDER_SLA_MS);
      if (!stale.length) return 0;
      const admins = await store.getAdminUsers();
      if (!admins.length) return 0;
      let sent = 0;
      for (const order of stale) {
        if (slaAlerted.has(order.id)) continue;
        slaAlerted.add(order.id);
        const title = 'طلب معلّق محتاج مراجعة ⏰';
        const body = `الطلب #${order.id} (${order.customer_name || 'عميل'}) لسه معلّق من أكتر من ${Math.round(ORDER_SLA_MS / 3600000)} ساعة.`;
        for (const admin of admins) {
          await store.addNotification({
            userId: admin.id,
            orderId: order.id,
            title,
            body
          });
          sendPushToUser(admin.id, {
            title,
            body,
            orderId: order.id,
            url: '/admin.html'
          });
        }
        sent += 1;
      }
      // ما نخليش الـ Set يكبر للأبد: بنشيل الطلبات اللي اتراجعت خلاص.
      if (slaAlerted.size > 5000) slaAlerted.clear();
      return sent;
    } catch (error) {
      console.error('[order-sla]', error.message);
      return 0;
    }
  }
  const alertStalePendingOrdersOnce = everyInstances('order-sla-alerts', alertStalePendingOrders);
  setTimeout(alertStalePendingOrdersOnce, 90 * 1000).unref();
  setInterval(alertStalePendingOrdersOnce, 30 * 60 * 1000).unref();
  return {  };
};
