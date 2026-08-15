// (إصلاح) الإصدار اتزوّد عشان الكاش القديم الناقص يتمسح عند كل العملاء.
const CACHE_NAME = 'yousef-store-v31';
// كاش منفصل لصور /uploads/ بحد أقصى وتنظيف (FIFO: الأقدم إدخالًا يتشال أول)
// عشان ما يكبرش بلا نهاية. مش LRU — مفيش تتبّع لآخر استخدام.
const MEDIA_CACHE = 'yousef-store-media-v13';
const MEDIA_MAX_ENTRIES = 60;
// صفحة أوفلاين واضحة بدل ما نرجّع الصفحة الرئيسية لأي مسار.
const OFFLINE_URL = '/offline.html';
// كان theme.css ناقص هنا، فالموقع أوفلاين كان بيظهر من غير أي تنسيق.
// ملاحظة: مفيش أي صفحة HTML هنا غير offline.html (بدون سكربت inline)، عشان
// ما نكاشش صفحة بـ CSP nonce قديم.
const SHELL_ASSETS = [
  '/theme.css',
  '/styles.css',
  '/tokens.css',
  '/auth.css',
  '/theme.js',
  '/ui-utils.js',
  '/csrf.js',
  '/js/store/auth.js',
  '/js/store/cart.js',
  '/js/store/catalog.js',
  '/js/store/core.js',
  '/js/store/effects.js',
  '/js/store/interactions.js',
  '/js/store/main.js',
  '/js/store/nav.js',
  '/js/store/notifications.js',
  '/js/store/product-links.js',
  '/js/store/product-modal.js',
  '/js/store/state.js',
  '/js/store/wishlist.js',
  '/notify-client.js',
  '/offline.js',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/uploads/products/placeholder.jpg',
  OFFLINE_URL
];
// (إصلاح) قبل كده أي ملف .css/.js كان بيتكاش تلقائيًا بالـ regex، فأي أصل
// جديد أو محدَّث كان بيتقدّم للمستخدم من نسخة قديمة بلا نهاية (بما فيها ملفات
// مش تحت سيطرتنا). دلوقتي الكاش محدود بقائمة أصول صريحة فقط (SHELL_ASSETS)،
// والقائمة نفسها مربوطة بإصدار الكاش فأي نشر جديد يمسح القديم.
const SHELL_ASSET_SET = new Set(SHELL_ASSETS);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // addAll بيفشل كله لو ملف واحد مش موجود، فبنكاش كل ملف لوحده.
      .then((cache) => Promise.all(SHELL_ASSETS.map((asset) => cache.add(asset).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('message', (event) => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // (إصلاح) كان بيمسح MEDIA_CACHE نفسه في كل تفعيل، فكاش الصور كان بلا فايدة.
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key !== CACHE_NAME && key !== MEDIA_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    // (إصلاح تعارض CSP nonce) صفحات الـ HTML *مش* بتتكاش أبدًا: السيرفر بيحقن
    // nonce عشوائي في كل طلب، فأي نسخة مخزّنة هتتقدّم بـ nonce قديم وكل
    // السكربتات الـ inline هتتحظر → صفحة بيضا. الشبكة أولًا، ولو مفيش نت
    // بنرجّع صفحة الأوفلاين الثابتة (اللي مفيهاش سكربت inline) بس.
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (_) {
        return (await caches.match(OFFLINE_URL)) || new Response('أنت غير متصل بالإنترنت.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    // أي طلب لواجهات الـ API ما يتكاشش أبدًا (بيانات حية + جلسات).
    if (url.pathname.startsWith('/api/')) return;

    if (SHELL_ASSET_SET.has(url.pathname)) {
      event.respondWith(networkFirst(request));
      return;
    }
    // (إصلاح) صور المنتجات والهيرو المرفوعة بقت متكاشة كمان، فالموقع أوفلاين
    // يفضل بصورته الكاملة بدل صور مكسورة.
    if (url.pathname.startsWith('/uploads/')) {
      event.respondWith(mediaCache(request));
      return;
    }
    return;
  }

  if (url.origin === 'https://images.pexels.com') {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    event.respondWith(cacheFirst(request));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, fresh.clone());
  }
  return fresh;
}

// كاش الصور: نفس فكرة stale-while-revalidate بس في كاش منفصل بحد أقصى
// للعناصر، والأقدم إدخالًا بيتشال أول (FIFO، مش LRU) — تنظيف تلقائي بدل
// نمو بلا حدود.
async function mediaCache(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(request);
  const update = fetch(request).then(async (response) => {
    if (response && response.ok) {
      await cache.put(request, response.clone());
      await trimCache(cache, MEDIA_MAX_ENTRIES);
    }
    return response;
  }).catch(() => cached);
  return cached || update;
}

// FIFO: cache.keys() بترجّع المفاتيح بترتيب الإضافة، فبنشيل الأقدم إضافةً.
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

async function networkFirst(request, cacheName = CACHE_NAME) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (_) {
    return (await cache.match(request)) || caches.match(OFFLINE_URL);
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const fetchPromise = fetch(request).then((response) => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  }).catch(() => cached);
  return cached || fetchPromise;
}

// ---------------------------------------------------------------------------
// Web Push: shows a real OS/browser notification even if the site tab is
// closed, for order-confirmed and "order is on the way" alerts.
// ---------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let payload = { title: 'يوسف لمستلزمات العربيات', body: 'لديك تحديث جديد على طلبك.' };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch (err) {}
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      dir: 'rtl',
      lang: 'ar',
      data: { url: payload.url || '/' },
      vibrate: [80, 40, 80]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
