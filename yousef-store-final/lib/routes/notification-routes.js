/**
 * إشعارات الويب push وإشعارات الحساب
 * -------------------------------------------------------------------------
 * موديول اتفصل من server.js عشان الملف ما يبقاش آلاف السطور. كل الاعتماديات
 * (الـ store والحدود والمساعدات) بتتمرّر من server.js في كائن deps واحد،
 * فالسلوك زي ما هو بالحرف بس التنظيم بقى أوضح.
 */
module.exports = function registerNotificationRoutes(app, deps) {
  const {
    requireAuth,
    store,
    vapidKeys,
    writeLimiter
  } = deps;

  const PUSH_ENDPOINT_HOSTS = ['android.googleapis.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com', 'updates-autopush.stage.mozaws.net', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com', 'web.push.apple.com'];
  function isAllowedPushEndpoint(endpoint) {
    if (!/^https:\/\/[^\s]{10,500}$/i.test(endpoint)) return false;
    let host;
    try {
      host = new URL(endpoint).hostname.toLowerCase();
    } catch (_) {
      return false;
    }
    return PUSH_ENDPOINT_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
  }
  app.get('/api/push/vapid-public-key', (_req, res) => res.json({
    publicKey: vapidKeys.publicKey
  }));
  app.post('/api/push/subscribe', requireAuth, writeLimiter, async (req, res) => {
    const subscription = (req.body || {}).subscription;
    const endpoint = String(subscription && subscription.endpoint || '');
    // (إصلاح) تحقق من شكل الـ endpoint + سقف اشتراكات لكل مستخدم، عشان محدش
    // يحقن آلاف اشتراكات وهمية تكبّر القاعدة وتبطّئ كل إشعار.
    if (!subscription || !isAllowedPushEndpoint(endpoint)) {
      return res.status(400).json({
        error: 'اشتراك غير صالح'
      });
    }
    const keys = subscription.keys || {};
    if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) {
      return res.status(400).json({
        error: 'اشتراك غير صالح'
      });
    }
    // addPushSubscription بيشيل أقدم اشتراك تلقائيًا عند السقف، فمفيش حالة LIMIT.
    await store.addPushSubscription(req.user.id, {
      endpoint,
      keys: {
        p256dh: keys.p256dh,
        auth: keys.auth
      }
    });
    res.json({
      ok: true
    });
  });
  app.post('/api/push/unsubscribe', requireAuth, writeLimiter, async (req, res) => {
    // (إصلاح صلاحيات) الحذف مقيّد باشتراكات المستخدم نفسه؛ قبل كده أي حساب
    // يعرف endpoint حد تاني كان يقدر يلغي إشعاراته.
    if ((req.body || {}).endpoint) await store.removePushSubscription(req.body.endpoint, req.user.id);
    res.json({
      ok: true
    });
  });
  app.get('/api/notifications/mine', requireAuth, async (req, res) => res.json({
    notifications: await store.getNotificationsByUser(req.user.id)
  }));
  app.post('/api/notifications/read-all', requireAuth, async (req, res) => {
    await store.markAllNotificationsRead(req.user.id);
    res.json({
      ok: true
    });
  });
  app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
    await store.markNotificationRead(req.params.id, req.user.id);
    res.json({
      ok: true
    });
  });
};
