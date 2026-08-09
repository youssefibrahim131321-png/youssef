// Shared helper: registers the service worker, requests notification
// permission, and subscribes the logged-in customer to Web Push so they can
// receive real order-confirmed / order-on-the-way notifications.
(function () {
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    try { return await navigator.serviceWorker.register('/service-worker.js'); }
    catch (err) {
      // (إصلاح) كان بيفشل في صمت تام. دلوقتي على الأقل بيتسجّل في الكونسول
      // عشان تعرف ليه الإشعارات مش شغالة بدل ما تفضل تخمّن.
      console.warn('[push] فشل تسجيل service worker:', err && err.message);
      return null;
    }
  }

  async function subscribeToPush() {
    if (!('PushManager' in window)) return false;
    const registration = await registerServiceWorker();
    if (!registration) return false;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;

    try {
      const keyRes = await fetch('/api/push/vapid-public-key');
      const { publicKey } = await keyRes.json();
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
      }
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription })
      });
      localStorage.setItem('yousefNotifyPromptDismissed', '1');
      return true;
    } catch (err) {
      // (إصلاح) نفس المشكلة: فشل الاشتراك كان صامت. بنبلّغ العميل ونسجّل السبب.
      console.warn('[push] فشل الاشتراك في الإشعارات:', err && err.message);
      if (window.YousefUI) window.YousefUI.announce('تعذر تفعيل الإشعارات دلوقتي، جرّب تاني بعدين.');
      return false;
    }
  }

  // Small dismissible banner offering to enable notifications, shown once
  // per browser after the customer is logged in (and only if not already
  // subscribed / previously dismissed).
  async function mountNotifyBanner(user) {
    if (!user || !('Notification' in window)) return;
    if (Notification.permission === 'granted') { registerServiceWorker(); return; }
    if (Notification.permission === 'denied') return;
    if (localStorage.getItem('yousefNotifyPromptDismissed')) return;

    const bar = document.createElement('div');
    bar.id = 'notifyBanner';
    bar.innerHTML = `
      <span class="notify-banner-text">🔔 فعّل الإشعارات عشان توصلك تحديثات طلبك أول بأول</span>
      <div class="notify-banner-actions">
        <button type="button" id="notifyBannerEnable">تفعيل الإشعارات</button>
        <button type="button" id="notifyBannerDismiss" aria-label="إغلاق">✕</button>
      </div>
    `;
    const style = document.createElement('style');
    style.textContent = `
      #notifyBanner{position:fixed;bottom:18px;inset-inline:18px;z-index:400;max-width:460px;margin-inline-start:auto;
        display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;
        background:linear-gradient(135deg, rgba(47, 111, 98,.16), rgba(206, 124, 62,.12));
        border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:14px 16px;
        backdrop-filter:blur(16px);box-shadow:0 20px 50px rgba(0,0,0,.35);
        font-family:'Cairo',sans-serif;color:#f5f6fb;animation:notifySlideIn .5s cubic-bezier(.22,1,.36,1);}
      @keyframes notifySlideIn{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:translateY(0);}}
      .notify-banner-text{font-size:13.5px;font-weight:600;flex:1;min-width:200px;}
      .notify-banner-actions{display:flex;align-items:center;gap:8px;}
      #notifyBannerEnable{background:linear-gradient(135deg,#ce7c3e,#eaad68);color:#1a1206;border:none;border-radius:12px;padding:9px 14px;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit;}
      #notifyBannerDismiss{background:rgba(255,255,255,.08);color:#f5f6fb;border:none;border-radius:10px;width:30px;height:30px;cursor:pointer;font-size:13px;}
    `;
    document.head.appendChild(style);
    document.body.appendChild(bar);

    document.getElementById('notifyBannerEnable').addEventListener('click', async () => {
      await subscribeToPush();
      bar.remove();
    });
    document.getElementById('notifyBannerDismiss').addEventListener('click', () => {
      localStorage.setItem('yousefNotifyPromptDismissed', '1');
      bar.remove();
    });
  }

  window.YousefNotify = { subscribeToPush, mountNotifyBanner, registerServiceWorker };
})();
