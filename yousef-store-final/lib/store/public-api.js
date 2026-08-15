/**
 * واجهة الـ store العامة
 * -------------------------------------------------------------------------
 * نفس المفاتيح اللي كانت بترجع من createStore بالحرف. الملف ده بيمنع أي
 * موديول جديد إنه "يختفي" من الواجهة بالغلط: أي مفتاح ناقص بيرمي خطأ واضح
 * وقت التشغيل بدل ما يبان كـ undefined is not a function بعدين.
 */
const STORE_API_KEYS = [

    // نظام
    'flush', 'backup', 'ensureAdmin', 'getRawSnapshot', 'getAdminUsers', 'getStalePendingOrders',
    'pool', // (اختياري) وصول مباشر للـ 'Pool' لو محتاجه سكريبت هجرة/صيانة خارجي
    // مستخدمون
    'getUsers', 'getUsersWithStats', 'findUserByEmail', 'findUserByNormalizedEmail', 'findUserById', 'createUser', 'verifyPassword', 'updateUser', 'deleteUser', 'sanitizeUser', 'bumpSessionVersion', 'hasAdmin',
    // توكنات المصادقة، تفعيل البريد، وكلمة المرور
    'createAuthToken', 'consumeAuthToken', 'peekAuthToken', 'createAuthCode', 'consumeAuthCode', 'invalidateAuthTokens', 'purgeExpiredAuthTokens', 'markEmailVerified', 'setUserPassword',
    // التحقق بخطوتين
    'setTotpSecret', 'enableTotp', 'disableTotp', 'disableAllTotp', 'getTotpSecret', 'claimTotpCode',
    // حدود المعدّل الدائمة
    'rateLimitHit', 'rateLimitGet', 'rateLimitSet', 'resetRateLimit', 'purgeExpiredRateLimits',
    // منتجات
    'getProducts', 'getProductById', 'createProduct', 'updateProduct', 'deleteProduct', 'adjustStock',
    'incrementProductViews', 'getCategories', 'getLowStockProducts',
    // كوبونات
    'getCoupons', 'createCoupon', 'updateCoupon', 'deleteCoupon', 'evaluateCoupon',
    // طلبات
    'createOrder', 'getOrders', 'queryOrders', 'getOrdersForExport', 'iterateOrdersForExport', 'getRecentOrders', 'getOrdersByUser', 'getOrderById', 'updateOrder', 'getOrderByProofFilename', 'getStalePaymobOrders',
    'logPaymobEvent', 'getPaymobEvents', 'getPaymobSyncStats', 'getPaymobReconciliation', 'claimPaymobAlert', 'purgeOldPaymobEvents',
    'recordPaymentProof', 'getPaymentProofOwner', 'getPaymentProofByHash', 'deletePaymentProof', 'getOrphanPaymentProofs',
    'scheduleOrderNotification', 'markOrderNotified', 'claimOrderNotification', 'releaseOrderNotification',
    'getPendingScheduledNotifications',
    // تقييمات ومفضلة
    'addReview', 'getReviewsByProduct', 'getAllReviews', 'deleteReview', 'getWishlist', 'toggleWishlist',
    // إشعارات
    'addNotification', 'getNotificationsByUser', 'markNotificationRead', 'markAllNotificationsRead',
    'broadcastNotification', 'addPushSubscription', 'removePushSubscription', 'getPushSubscriptionsByUser',
    // إعدادات
    'getSiteSettings', 'updateSiteSettings', 'getOrCreateSessionSecret', 'getOrCreateVapidKeys',
    // سجل وتحليلات
    'logActivity', 'getActivityLog', 'getAnalytics'
  
];

module.exports = function buildStoreApi(sctx) {
  const api = {};
  for (const key of STORE_API_KEYS) {
    if (sctx[key] === undefined) throw new Error(`[store] مفتاح ناقص من واجهة الـ store: ${key}`);
    api[key] = sctx[key];
  }
  return api;
};

module.exports.STORE_API_KEYS = STORE_API_KEYS;
