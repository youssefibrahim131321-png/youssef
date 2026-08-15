// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
module.exports = async function createNotifyEngine(deps = {}) {
  const { everyInstances, store, webpush } = deps;
  // ---------------------------------------------------------------------------
  // Web Push (VAPID)
  // ---------------------------------------------------------------------------
  const vapidKeys = await store.getOrCreateVapidKeys(() => webpush.generateVAPIDKeys());
  webpush.setVapidDetails(process.env.VAPID_CONTACT || 'mailto:admin@example.com', vapidKeys.publicKey, vapidKeys.privateKey);
  async function sendPushToUser(userId, payload) {
    (await store.getPushSubscriptionsByUser(userId)).forEach(async sub => {
      webpush.sendNotification(sub, JSON.stringify(payload)).catch(async err => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await store.removePushSubscription(sub.endpoint);
          return;
        }
        // (إصلاح) مكناش بنسجّل أي فشل، فكان مستحيل تعرف إن الإشعارات واقعة.
        console.error('[web-push] فشل إرسال إشعار', {
          userId,
          status: err.statusCode || null,
          message: String(err.message || '').slice(0, 200)
        });
      });
    });
  }
  async function notifyCustomer(order, title, body) {
    if (!order || !order.user_id) return;
    await store.addNotification({
      userId: order.user_id,
      orderId: order.id,
      title,
      body
    });
    sendPushToUser(order.user_id, {
      title,
      body,
      orderId: order.id,
      url: '/account.html'
    });
  }

  // ---------------------------------------------------------------------------
  // محرك الإشعارات المجدولة
  // ---------------------------------------------------------------------------
  const scheduledTimers = new Map();
  const MAX_TIMER_MS = 2 ** 31 - 1;
  function armNotificationTimer(order) {
    if (scheduledTimers.has(order.id)) clearTimeout(scheduledTimers.get(order.id));
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, new Date(order.notify_at).getTime() - Date.now()));
    const timer = setTimeout(() => fireScheduledNotification(order.id), delay);
    if (typeof timer.unref === 'function') timer.unref();
    scheduledTimers.set(order.id, timer);
  }
  async function fireScheduledNotification(orderId) {
    const order = await store.getOrderById(orderId);
    scheduledTimers.delete(orderId);
    if (!order || order.notified) return;
    // (10) نحجز الإشعار ذرّيًا (مرة واحدة بس) ثم نرسل فعليًا. لو الإرسال فشل
    // نفك الحجز عشان المكنسة تعيد المحاولة، بدل ما نعتبره «مُرسَل» قبل الإرسال.
    if (!(await store.claimOrderNotification(orderId))) return;
    try {
      notifyCustomer(order, 'طلبك في الطريق 🚚', order.notify_message || `طلبك رقم #${order.id} جاهز وفي طريقه إليك الآن!`);
    } catch (error) {
      console.error('[scheduled notification]', error);
      await store.releaseOrderNotification(orderId);
    }
  }
  (await store.getPendingScheduledNotifications()).forEach(armNotificationTimer);

  // مكنسة كل دقيقة: تلتقط أي إشعار فات موعده (بعد انقطاع/إعادة تشغيل).
  setInterval(everyInstances('scheduled-notifications-sweep', async () => {
    (await store.getPendingScheduledNotifications()).forEach(order => {
      if (new Date(order.notify_at).getTime() <= Date.now()) fireScheduledNotification(order.id);else if (!scheduledTimers.has(order.id)) armNotificationTimer(order);
    });
  }), 60 * 1000).unref();
  return { vapidKeys, sendPushToUser, notifyCustomer, armNotificationTimer };
};
