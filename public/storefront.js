/* (إصلاح 10) روابط منتجات حقيقية /product/<id>/<slug> بدل /?p=ID */
function productSlug(name) {
  return String(name || '').trim().replace(/\u0640/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 70).toLowerCase() || 'product';
}
function productUrlPath(p) { return p && p.id ? `/product/${p.id}/${productSlug(p.name)}` : '/'; }
function currentProductId() {
  const m = /^\/product\/(\d+)/.exec(location.pathname);
  if (m) return Number(m[1]);
  const q = new URLSearchParams(location.search).get('p');
  return q ? Number(q) : null;
}
/* (إصلاح 7) الـ API بقى صفحات؛ بنجيب الصفحات ورا بعض بدل طلب واحد ضخم. */
async function fetchAllProducts(limit = 100, maxPages = 25) {
  let page = 1; let all = []; let categories = [];
  for (; page <= maxPages; page += 1) {
    const res = await fetch(`/api/products?limit=${limit}&page=${page}`);
    if (!res.ok) throw new Error('products');
    const data = await res.json();
    all = all.concat(data.products || []);
    if (page === 1) categories = data.categories || [];
    if (!data.hasMore) break;
  }
  return { products: all, categories };
}

/* ═══ YOUSEF STORE — Storefront Engine v2 ═══ */
let currentUser = null;
let PRODUCTS = [];
let storeSettings = {};
let wishlistIds = new Set();
let wishlistFilterActive = false;
const WHATSAPP_NUMBER = '201000000000';

try { var cart = JSON.parse(localStorage.getItem('yousefCart') || '{}'); } catch (e) { var cart = {}; }
// أسماء منتجات السلة (نسخة محلية) عشان نقدر نبلّغ العميل باسم المنتج حتى لو
// اتشال من المتجر خالص.
try { var cartNames = JSON.parse(localStorage.getItem('yousefCartNames') || '{}'); } catch (e) { var cartNames = {}; }
// (7) تنضيف السلة من أي كميات سالبة/صفر/غير صحيحة محفوظة قبل كده
(function sanitizeCart() {
  Object.keys(cart).forEach((id) => {
    const qty = Math.floor(Number(cart[id]));
    if (!Number.isInteger(Number(id)) || !Number.isFinite(qty) || qty < 1) { delete cart[id]; return; }
    cart[id] = Math.min(999, qty);
  });
})();
let currentFilter = 'الكل';

const $ = (id) => document.getElementById(id);
/* الدوال المشتركة (escape / صور آمنة / تنسيق السعر / إعلان لقارئ الشاشة) بقت
   في ui-utils.js بدل ما تتكرر في كل صفحة بنسخ مختلفة. */
const { escapeHtml, safeImageUrl, safeImage, announce, formatEGP } = window.YousefUI;
const fmt = formatEGP;

/* ─── (إصلاح) فشل الشبكة مش مبلوع بالسكوت: رسالة واضحة + زر إعادة محاولة ─── */
function showNetworkError(message, retry) {
  let bar = $('netErrorBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'netErrorBar';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;inset-inline:0;top:0;z-index:9999;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;padding:10px 14px;background:#7f1d1d;color:#fff;font:inherit;font-size:14px;';
    document.body.appendChild(bar);
  }
  bar.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = message;
  bar.appendChild(text);
  if (typeof retry === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'إعادة المحاولة';
    btn.style.cssText = 'padding:6px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.6);background:transparent;color:#fff;cursor:pointer;font:inherit;min-height:36px;';
    btn.addEventListener('click', () => { clearNetworkError(); retry(); });
    bar.appendChild(btn);
  }
  if (typeof announce === 'function') announce(message);
}
function clearNetworkError() { $('netErrorBar')?.remove(); }

/* ─── Preloader ─── */
window.addEventListener('load', () => {
  setTimeout(() => {
    var pre = $('preloader');
    if (pre) {
      pre.classList.add('done');
      // (إصلاح) شاشة التحميل كانت بتفضل في الـ DOM بعد ما تختفي — دلوقتي بتتشال خالص.
      setTimeout(function () { pre.remove(); }, 800);
    }
    document.body.classList.remove('no-scroll');
  }, 1200);
});
document.body.classList.add('no-scroll');

/* ─── Scroll progress ─── */
const scrollBar = $('scrollProgress');
// (إصلاح أداء) الحساب بقى مرة واحدة لكل إطار (rAF) بدل كل حدث سكرول، ومرجع
// الهيدر متخزّن، فمفيش layout thrashing على الموبايل.
const siteHeaderEl = document.querySelector('.site-header');
let scrollTicking = false;
window.addEventListener('scroll', () => {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    scrollTicking = false;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pct = max > 0 ? (window.scrollY / max) * 100 : 0;
    if (scrollBar) scrollBar.style.width = pct + '%';
    siteHeaderEl?.classList.toggle('scrolled', window.scrollY > 40);
  });
}, { passive: true });

/* ─── Hero canvas particles ─── */
(function initCanvas() {
  const canvas = $('heroCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h, particles = [];

  function resize() {
    w = canvas.width = canvas.offsetWidth;
    h = canvas.height = canvas.offsetHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  for (let i = 0; i < 60; i++) {
    particles.push({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
      r: Math.random() * 2 + 0.5, o: Math.random() * 0.5 + 0.1
    });
  }

  // (إصلاح أداء) كانت المقارنة O(n²) على كل فريم وشغالة حتى والتاب مخفي —
  // ده كان بياكل بطارية الموبايل. دلوقتي: شبكة مكانية (grid) فبنقارن الجيران
  // القريبين بس، إيقاف كامل لما الصفحة تكون مخفية، واحترام تقليل الحركة.
  const LINK_DIST = 120;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let rafId = null;

  function drawFrame() {
    ctx.clearRect(0, 0, w, h);
    const cellSize = LINK_DIST;
    const cells = new Map();
    particles.forEach((p) => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(206, 124, 62, ${p.o})`;
      ctx.fill();
      const key = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)}`;
      let bucket = cells.get(key);
      if (!bucket) { bucket = []; cells.set(key, bucket); }
      bucket.push(p);
    });
    cells.forEach((bucket, key) => {
      const [cx, cy] = key.split(',').map(Number);
      const neighbours = [];
      for (let dx = 0; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy < 0) continue;
          const other = cells.get(`${cx + dx},${cy + dy}`);
          if (other && !(dx === 0 && dy === 0)) neighbours.push(...other);
        }
      }
      bucket.forEach((p, i) => {
        const candidates = bucket.slice(i + 1).concat(neighbours);
        candidates.forEach((p2) => {
          const dist = Math.hypot(p.x - p2.x, p.y - p2.y);
          if (dist < LINK_DIST) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = `rgba(206, 124, 62, ${0.08 * (1 - dist / LINK_DIST)})`;
            ctx.stroke();
          }
        });
      });
    });
  }

  function loop() {
    drawFrame();
    rafId = requestAnimationFrame(loop);
  }
  function start() {
    if (rafId === null && !document.hidden && !reduceMotion) rafId = requestAnimationFrame(loop);
  }
  function stop() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
  if (reduceMotion) drawFrame(); else start();
})();

/* ─── Toast ─── */
let toastTimer;
function showToast(msg) {
  const t = $('toast');
  const txt = $('toastText');
  if (!t || !txt) return;
  txt.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ─── Auth & Notifications ─── */
let notifyPollTimer = null;
async function loadUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error('auth check failed');
    const data = await res.json();
    clearNetworkError();
    currentUser = data.loggedIn ? data.user : null;
    const notifyBtn = $('notifyBtn');
    updateAccountMenu();
    if (currentUser) {
      notifyBtn?.classList.remove('hidden');
      refreshNotifications();
      if (!notifyPollTimer) notifyPollTimer = setInterval(refreshNotifications, 30000);
      if (window.YousefNotify) window.YousefNotify.mountNotifyBanner(currentUser);
      loadWishlist();
    } else {
      notifyBtn?.classList.add('hidden');
    }
  } catch (e) {
    // مهم: من غير رسالة العميل كان يبان مطلوع من حسابه بدون سبب.
    showNetworkError('تعذر التحقق من حسابك — يمكن الشبكة وقعت.', loadUser);
  }
}

/* ─── (12,13,14) قائمة الحساب: حسابي / طلباتي / تسجيل خروج ─── */
function updateAccountMenu() {
  const link = $('accountLink');
  const dropdown = $('accountDropdown');
  const mobileLink = $('mobileAccountLink');
  const footerLink = $('footerAccountLink');
  if (currentUser) {
    if (link) { link.href = '/dashboard.html'; link.setAttribute('aria-label', 'حسابي'); }
    if (mobileLink) mobileLink.href = '/dashboard.html';
    if (footerLink) footerLink.href = '/dashboard.html';
    const nameEl = $('accountMenuName');
    const emailEl = $('accountMenuEmail');
    if (nameEl) nameEl.textContent = currentUser.name || 'حسابي';
    if (emailEl) emailEl.textContent = currentUser.email || '';
  } else {
    if (link) link.href = '/account.html';
    if (mobileLink) mobileLink.href = '/account.html';
    if (footerLink) footerLink.href = '/account.html';
    dropdown?.classList.add('hidden');
  }
}

$('accountLink')?.addEventListener('click', (e) => {
  // من غير تسجيل دخول: الرابط يفتح صفحة الدخول عادي.
  if (!currentUser) return;
  e.preventDefault();
  const dd = $('accountDropdown');
  dd?.classList.toggle('hidden');
  $('accountLink')?.setAttribute('aria-expanded', dd && !dd.classList.contains('hidden') ? 'true' : 'false');
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#accountLink') && !e.target.closest('#accountDropdown')) {
    $('accountDropdown')?.classList.add('hidden');
    $('accountLink')?.setAttribute('aria-expanded', 'false');
  }
});

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  currentUser = null;
  wishlistIds = new Set();
  updateWishlistUI();
  updateAccountMenu();
  $('notifyBtn')?.classList.add('hidden');
  showToast('تم تسجيل الخروج');
  setTimeout(() => { window.location.href = '/'; }, 600);
}
$('logoutBtn')?.addEventListener('click', logout);

/* ─── Wishlist ─── */
async function loadWishlist() {
  if (!currentUser) return;
  try {
    const res = await fetch('/api/wishlist');
    const data = await res.json();
    if (!res.ok) throw new Error('wishlist failed');
    wishlistIds = new Set((data.products || []).map((p) => p.id));
    updateWishlistUI();
  } catch (e) {
    showNetworkError('تعذر تحميل المفضلة.', loadWishlist);
  }
}

function updateWishlistUI() {
  const badge = $('wishlistBadge');
  const btn = $('wishlistBtn');
  if (badge) {
    badge.textContent = wishlistIds.size;
    badge.classList.toggle('hidden', wishlistIds.size === 0);
  }
  if (btn) {
    btn.classList.toggle('active', wishlistIds.size > 0);
    btn.setAttribute('aria-label', wishlistIds.size ? `المفضلة (${wishlistIds.size} منتج)` : 'المفضلة');
  }
  // (a11y) الوصف بيتغير مع الحالة، فقارئ الشاشة يعرف إن المنتج محفوظ فعلًا.
  document.querySelectorAll('.wish-toggle').forEach((el) => {
    const on = wishlistIds.has(Number(el.dataset.wish));
    el.classList.toggle('active', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.setAttribute('aria-label', on ? 'إزالة من المفضلة' : 'أضف للمفضلة');
  });
  const modalWish = $('modalWishBtn');
  if (modalWish && modalWish.dataset.id) {
    const on = wishlistIds.has(Number(modalWish.dataset.id));
    modalWish.setAttribute('aria-pressed', on ? 'true' : 'false');
    modalWish.setAttribute('aria-label', on ? 'إزالة من المفضلة' : 'أضف للمفضلة');
  }
}

async function toggleWishlist(id) {
  if (!currentUser) { window.location.href = '/account.html?next=index.html'; return; }
  try {
    const res = await fetch(`/api/wishlist/${id}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'حدث خطأ'); return; }
    if (data.inWishlist) { wishlistIds.add(Number(id)); showToast('أضيف للمفضلة ❤'); }
    else { wishlistIds.delete(Number(id)); showToast('تمت الإزالة من المفضلة'); }
    updateWishlistUI();
    if ($('modalWishBtn')?.dataset.id === String(id)) {
      $('modalWishBtn').classList.toggle('active', data.inWishlist);
      $('modalWishBtn').setAttribute('aria-pressed', data.inWishlist ? 'true' : 'false');
      $('modalWishBtn').setAttribute('aria-label', data.inWishlist ? 'إزالة من المفضلة' : 'أضف للمفضلة');
    }
    if (wishlistFilterActive) renderProducts();
  } catch (e) {
    showToast('تعذر الاتصال بالخادم');
  }
}

async function refreshNotifications() {
  try {
    const res = await fetch('/api/notifications/mine');
    if (!res.ok) return;
    const { notifications } = await res.json();
    const badge = $('notifyBadge');
    const dropdown = $('notifyDropdown');
    const unread = notifications.filter((n) => !n.read).length;
    if (badge) {
      badge.textContent = unread;
      badge.classList.toggle('hidden', unread === 0);
    }
    if (dropdown) {
      dropdown.innerHTML = notifications.length
        ? notifications.map((n) => `<div class="notify-item"><strong>${escapeHtml(n.title)}</strong><span>${escapeHtml(n.body)}</span><time>${new Date(n.created_at).toLocaleString('ar-EG')}</time></div>`).join('')
        : '<div class="notify-empty">لا توجد إشعارات بعد</div>';
    }
  } catch (e) {
    const dropdown = $('notifyDropdown');
    if (dropdown) dropdown.innerHTML = '<div class="notify-empty">تعذر تحميل الإشعارات — <button type="button" id="notifyRetry" style="background:none;border:none;color:inherit;text-decoration:underline;cursor:pointer;font:inherit">إعادة المحاولة</button></div>';
    $('notifyRetry')?.addEventListener('click', refreshNotifications);
  }
}

$('notifyBtn')?.addEventListener('click', async () => {
  const dd = $('notifyDropdown');
  dd?.classList.toggle('hidden');
  if (dd && !dd.classList.contains('hidden')) {
    $('notifyBadge')?.classList.add('hidden');
    try {
      const res = await fetch('/api/notifications/mine');
      const { notifications } = await res.json();
      notifications.filter((n) => !n.read).forEach((n) => fetch(`/api/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {}));
    } catch (e) {
      showToast('تعذر تحديث حالة الإشعارات');
    }
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#notifyBtn') && !e.target.closest('#notifyDropdown')) {
    $('notifyDropdown')?.classList.add('hidden');
  }
});

/* ─── Store data ─── */
async function loadStoreData() {
  try {
    const [productsRes, settingsRes] = await Promise.all([
      fetchAllProducts(),
      fetch('/api/site/settings').then((r) => { if (!r.ok) throw new Error('settings'); return r.json(); })
    ]);
    PRODUCTS = (productsRes.products || []).filter((p) => p.active !== 0);
    storeSettings = settingsRes.settings || {};
    storeSettings.whatsappNumber = storeSettings.whatsappNumber || WHATSAPP_NUMBER;
    if (storeSettings.name) {
      document.querySelectorAll('[data-store-name]').forEach((el) => { el.textContent = storeSettings.name; });
    }
    updateContactLinks();
    renderStoreStats();
    buildFilterTabs(productsRes.categories || []);
    renderFeatured();
    renderProducts();
    updateCart();
    const deepLinkId = currentProductId();
    if (deepLinkId && PRODUCTS.some((p) => p.id === Number(deepLinkId))) openProductModal(deepLinkId);
    clearNetworkError();
  } catch (e) {
    console.warn('Store load failed', e);
    const grid = $('productGrid') || document.querySelector('.product-grid');
    if (grid && !PRODUCTS.length) {
      grid.innerHTML = '<div class="empty-state">تعذر تحميل المنتجات — تأكد من اتصالك بالإنترنت. <button type="button" id="storeRetryBtn" class="btn btn-ghost" style="margin-inline-start:8px;min-height:44px">إعادة المحاولة</button></div>';
      $('storeRetryBtn')?.addEventListener('click', loadStoreData);
    }
    showNetworkError('تعذر تحميل بيانات المتجر.', loadStoreData);
  }
}

window.addEventListener('popstate', () => {
  const id = currentProductId();
  if (id && PRODUCTS.some((p) => p.id === Number(id))) openProductModal(id);
  else { $('productModal')?.classList.remove('open'); document.body.classList.remove('no-scroll'); }
});

function updateContactLinks() {
  const phone = $('storePhoneLink');
  const wa = $('storeWhatsAppLink');
  const waLink = $('waLink');
  if (phone) phone.textContent = storeSettings.phone || '01xxxxxxxxx';
  if (wa) wa.href = `https://wa.me/${storeSettings.whatsappNumber || WHATSAPP_NUMBER}`;
  if (waLink) waLink.href = `https://wa.me/${storeSettings.whatsappNumber || WHATSAPP_NUMBER}?text=${encodeURIComponent('السلام عليكم، محتاج أستفسر عن منتج')}`;
}

function renderStoreStats() {
  const cats = new Set(PRODUCTS.map((p) => (p.category || '').trim()).filter(Boolean));
  const deals = PRODUCTS.filter((p) => Number(p.old_price || 0) > Number(p.price || 0)).length;
  const stock = PRODUCTS.reduce((s, p) => s + Number(p.stock || 0), 0);
  if ($('storeProductsCount')) $('storeProductsCount').textContent = `${PRODUCTS.length} منتج`;
  if ($('storeCategoryCount')) $('storeCategoryCount').textContent = `${cats.size} قسم`;
  if ($('storeDealCount')) $('storeDealCount').textContent = `${deals} عرض`;
  if ($('storeInventoryCount')) $('storeInventoryCount').textContent = `${stock} قطعة`;
}

function buildFilterTabs(categories) {
  const tabs = $('filterTabs');
  if (!tabs) return;
  const cats = categories.length ? categories.map((c) => c.name) : [...new Set(PRODUCTS.map((p) => p.category))];
  tabs.innerHTML = `<button class="tab active" data-filter="الكل">الكل</button>` +
    cats.map((c) => `<button class="tab" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('');
}

function renderFeatured() {
  const el = $('featuredScroll');
  if (!el) return;
  const featured = PRODUCTS.filter((p) => p.featured === 1).slice(0, 8);
  const list = featured.length ? featured : PRODUCTS.slice(0, 6);
  el.innerHTML = list.map((p) => `
    <div class="featured-card" data-open="${p.id}">
      <img data-fallback="1" alt="${escapeHtml(p.name)}" loading="lazy" data-img-id="${p.id}">
      <div class="featured-card-body">
        <h4>${escapeHtml(p.name)}</h4>
        <div class="price">${fmt(p.price)}</div>
      </div>
    </div>`).join('');
  // (أمان) رابط الصورة بيتحط عبر setAttribute بدل تضمينه في سلسلة innerHTML.
  el.querySelectorAll('img[data-img-id]').forEach((img) => {
    const p = list.find((x) => x.id === Number(img.dataset.imgId));
    if (p) img.setAttribute('src', safeImage(p.image_url));
  });
}

function getVisibleProducts() {
  const q = ($('productSearch')?.value || '').trim().toLowerCase();
  let list = currentFilter === 'الكل' ? PRODUCTS : PRODUCTS.filter((p) => p.category === currentFilter);
  if (wishlistFilterActive) list = list.filter((p) => wishlistIds.has(p.id));
  if (!q) return list;
  return list.filter((p) => `${p.name} ${p.category || ''} ${p.description || ''}`.toLowerCase().includes(q));
}

function renderProducts() {
  const grid = $('productGrid');
  const count = $('productCount');
  if (!grid) return;
  const list = getVisibleProducts();
  if (count) count.textContent = `${list.length} منتج`;

  injectCatalogSchema(list);

  if (!list.length) {
    grid.innerHTML = wishlistFilterActive
      ? '<div class="empty-state">مفضلتك فاضية لسه — اضغط على ♥ في أي منتج عشان تحفظه هنا.</div>'
      : '<div class="empty-state">لا توجد منتجات مطابقة — جرّب كلمة أخرى أو غيّر التصنيف.</div>';
    return;
  }

  grid.innerHTML = list.map((p) => `
    <article class="product-card" data-id="${p.id}" data-open="${p.id}">
      <div class="product-media">
        ${p.tag ? `<span class="badge-tag">${escapeHtml(p.tag)}</span>` : ''}
        <button class="wish-toggle${wishlistIds.has(p.id) ? ' active' : ''}" data-wish="${p.id}" aria-pressed="${wishlistIds.has(p.id) ? 'true' : 'false'}" aria-label="${wishlistIds.has(p.id) ? 'إزالة من المفضلة' : 'أضف للمفضلة'}"><svg viewBox="0 0 24 24" fill="none"><path d="M12 20s-7.5-4.6-10-9.3C.5 7.4 2.3 4 5.7 4c2 0 3.6 1.1 4.3 2.6C10.7 5.1 12.3 4 14.3 4c3.4 0 5.2 3.4 3.7 6.7C15.5 15.4 12 20 12 20z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <img class="lazy" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-fallback="1" alt="${escapeHtml(p.name)}" loading="lazy" data-img-id="${p.id}">
        <div class="product-quick">عرض التفاصيل</div>
      </div>
      <div class="product-body">
        <div class="product-cat">${escapeHtml(p.category || '')}</div>
        <div class="product-name">${escapeHtml(p.name)}</div>
        ${Number(p.reviews_count || 0) ? `<div class="product-rating"><span class="stars">${starString(Number(p.rating || 0))}</span><span>(${p.reviews_count})</span></div>` : ''}
        <div class="product-desc">${escapeHtml(p.description || 'منتج مميز من متجر يوسف')}</div>
        <div class="product-foot">
          <div class="product-price">${p.old_price ? `<span class="old">${fmt(p.old_price)}</span>` : ''}${fmt(p.price)}</div>
          <button class="add-btn" data-add="${p.id}" aria-label="أضف ${escapeHtml(p.name)} للسلة">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
    </article>`).join('');

  // (أمان) رابط الصورة (data-src) بيتحط عبر setAttribute بدل تضمينه في سلسلة innerHTML.
  grid.querySelectorAll('img[data-img-id]').forEach((img) => {
    const p = list.find((x) => x.id === Number(img.dataset.imgId));
    if (p) img.setAttribute('data-src', safeImage(p.image_url));
  });

  requestAnimationFrame(() => {
    grid.querySelectorAll('.product-card').forEach((c, i) => setTimeout(() => c.classList.add('show'), i * 40));
  });

  const obs = new IntersectionObserver((entries, o) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const img = e.target;
      img.src = img.dataset.src;
      img.onload = () => img.classList.add('loaded');
      o.unobserve(img);
    });
  }, { rootMargin: '200px' });
  grid.querySelectorAll('img.lazy').forEach((img) => obs.observe(img));
}

function setJsonLd(id, data) {
  let tag = document.getElementById(id);
  if (!tag) {
    tag = document.createElement('script');
    tag.type = 'application/ld+json';
    tag.id = id;
    document.head.appendChild(tag);
  }
  tag.textContent = JSON.stringify(data);
}

function injectCatalogSchema(list) {
  if (!list.length) return;
  setJsonLd('schema-catalog', {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: list.slice(0, 30).map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${location.origin}${productUrlPath(p)}`,
      name: p.name
    }))
  });
}

function setProductSchema(p) {
  setJsonLd('schema-product', {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: p.description || 'منتج مميز من متجر يوسف لمستلزمات العربيات',
    image: safeImageUrl(p.image_url),
    category: p.category || undefined,
    aggregateRating: Number(p.reviews_count || 0) ? {
      '@type': 'AggregateRating',
      ratingValue: Number(p.rating || 0),
      reviewCount: Number(p.reviews_count || 0)
    } : undefined,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'EGP',
      price: Number(p.price || 0),
      availability: Number(p.stock || 0) > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url: `${location.origin}${productUrlPath(p)}`
    }
  });
}

/* ─── Product Modal ─── */
function starString(avg) {
  const rounded = Math.round(avg);
  return '★★★★★☆☆☆☆☆'.slice(5 - rounded, 10 - rounded);
}

function openProductModal(id) {
  const p = PRODUCTS.find((x) => x.id === Number(id));
  if (!p) return;
  const modal = $('productModal');
  if (!modal) return;
  $('modalImg').src = safeImageUrl(p.image_url);
  $('modalImg').dataset.fallback = '1';
  $('modalImg').alt = p.name;
  $('modalTitle').textContent = p.name;
  $('modalCat').textContent = p.category || '';
  $('modalDesc').textContent = p.description || 'منتج مميز من متجر يوسف لمستلزمات العربيات.';
  $('modalPrice').innerHTML = (p.old_price ? `<span class="old" style="font-size:16px;color:var(--text-3);text-decoration:line-through;margin-inline-start:8px">${fmt(p.old_price)}</span>` : '') + fmt(p.price);
  $('modalAddBtn').onclick = () => { if (addToCart(p.id)) closeProductModal(); };

  const wishBtn = $('modalWishBtn');
  if (wishBtn) {
    wishBtn.dataset.id = String(p.id);
    wishBtn.classList.toggle('active', wishlistIds.has(p.id));
    wishBtn.onclick = () => toggleWishlist(p.id);
  }

  const ratingCount = Number(p.reviews_count || 0);
  const ratingAvg = Number(p.rating || 0);
  $('modalRating').innerHTML = ratingCount
    ? `<span class="stars">${starString(ratingAvg)}</span><span class="count">${ratingAvg.toFixed(1)} (${ratingCount} تقييم)</span>`
    : `<span class="count">لسه مفيش تقييمات لهذا المنتج</span>`;

  loadReviews(p.id);
  resetReviewForm(p.id);
  setProductSchema(p);
  if (currentProductId() !== Number(p.id)) {
    history.pushState({ productId: p.id }, '', productUrlPath(p));
  }

  modal.classList.add('open');
  document.body.classList.add('no-scroll');
}

async function loadReviews(productId) {
  const list = $('reviewsList');
  if (!list) return;
  list.innerHTML = '<div class="reviews-empty">جاري التحميل...</div>';
  try {
    const res = await fetch(`/api/products/${productId}/reviews`);
    const data = await res.json();
    const reviews = data.reviews || [];
    list.innerHTML = reviews.length
      ? reviews.map((r) => `
        <div class="review-item">
          <div class="r-head"><span class="r-name">${escapeHtml(r.user_name || 'عميل')}</span><span class="r-stars">${starString(r.rating)}</span></div>
          ${r.comment ? `<div class="r-comment">${escapeHtml(r.comment)}</div>` : ''}
          <div class="r-date">${new Date(r.created_at).toLocaleDateString('ar-EG')}</div>
        </div>`).join('')
      : '<div class="reviews-empty">لسه مفيش تقييمات — كن أول من يقيّم المنتج.</div>';
  } catch (e) {
    list.innerHTML = '<div class="reviews-empty">تعذر تحميل التقييمات.</div>';
  }
}

function resetReviewForm(productId) {
  const starsInput = $('reviewStarsInput');
  const comment = $('reviewComment');
  const msg = $('reviewMsg');
  if (starsInput) { starsInput.dataset.value = '0'; starsInput.querySelectorAll('span').forEach((s) => s.classList.remove('on')); }
  if (comment) comment.value = '';
  if (msg) { msg.textContent = ''; msg.className = 'review-msg'; }
  const submitBtn = $('submitReviewBtn');
  if (submitBtn) submitBtn.onclick = () => submitReview(productId);
}

$('reviewStarsInput')?.addEventListener('click', (e) => {
  const star = e.target.closest('[data-star]');
  if (!star) return;
  const val = Number(star.dataset.star);
  const input = $('reviewStarsInput');
  input.dataset.value = String(val);
  input.querySelectorAll('span').forEach((s) => s.classList.toggle('on', Number(s.dataset.star) <= val));
});

async function submitReview(productId) {
  if (!currentUser) { window.location.href = '/account.html?next=index.html'; return; }
  const rating = Number($('reviewStarsInput')?.dataset.value || 0);
  const msg = $('reviewMsg');
  if (!rating) { msg.textContent = 'اختار تقييم بالنجوم أولاً'; msg.className = 'review-msg err'; return; }
  const btn = $('submitReviewBtn');
  btn.disabled = true; btn.textContent = 'جاري الإرسال...';
  try {
    const res = await fetch(`/api/products/${productId}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating, comment: $('reviewComment')?.value.trim() })
    });
    const data = await res.json();
    if (!res.ok) {
      msg.textContent = data.error || 'تعذر إرسال التقييم';
      msg.className = 'review-msg err';
    } else {
      msg.textContent = 'تم إرسال تقييمك، شكرًا لك 🙏';
      msg.className = 'review-msg ok';
      loadReviews(productId);
    }
  } catch (e) {
    msg.textContent = 'تعذر الاتصال بالخادم';
    msg.className = 'review-msg err';
  }
  btn.disabled = false; btn.textContent = 'إرسال التقييم';
}

function closeProductModal() {
  $('productModal')?.classList.remove('open');
  document.body.classList.remove('no-scroll');
  if (currentProductId()) {
    history.pushState({}, '', '/');
  }
  document.getElementById('schema-product')?.remove();
}

$('modalClose')?.addEventListener('click', closeProductModal);
// (4) بدل onclick داخل الـ HTML — عشان الـ CSP يقدر يمنع السكريبتات المضمّنة تمامًا.
$('modalClose2')?.addEventListener('click', closeProductModal);
$('productModal')?.addEventListener('click', (e) => { if (e.target === $('productModal')) closeProductModal(); });

/* ─── Cart ─── */
function stockOf(id) {
  const p = PRODUCTS.find((pp) => pp.id === Number(id));
  return p ? Math.max(0, Number(p.stock || 0)) : 0;
}

function addToCart(id) {
  const available = stockOf(id);
  const current = cart[id] || 0;
  // (6) بدل ما نقلل الكمية بصمت، بنمنع الزيادة ونبلّغ العميل بالمتاح
  if (available <= 0) { showToast('المنتج ده نفد من المخزون حاليًا'); return false; }
  if (current + 1 > available) { showToast(`المتاح من المنتج ده ${available} قطعة فقط`); return false; }
  cart[id] = current + 1;
  updateCart();
  return true;
}

function changeQty(id, delta) {
  if (!cart[id]) return;
  const next = cart[id] + delta;
  // (7) الكميات السالبة أو الصفرية تعني إزالة المنتج، مش قيمة سالبة في السلة
  if (next <= 0) { delete cart[id]; updateCart(); return; }
  const available = stockOf(id);
  if (next > available) { showToast(`المتاح من المنتج ده ${available} قطعة فقط`); return; }
  if (next > 999) { showToast('الحد الأقصى 999 قطعة'); return; }
  cart[id] = next;
  updateCart();
}

/** بيشيل من السلة أي منتج مابقاش موجود/متاح في المتجر، مع إشعار واضح. */
function pruneMissingCartItems() {
  if (!Array.isArray(PRODUCTS) || !PRODUCTS.length) return;
  const gone = Object.keys(cart).filter((id) => !PRODUCTS.some((p) => p.id === Number(id)));
  if (!gone.length) return;
  const names = gone.map((id) => cartNames[id]).filter(Boolean);
  gone.forEach((id) => { delete cart[id]; delete cartNames[id]; });
  try { localStorage.setItem('yousefCart', JSON.stringify(cart)); } catch (e) {}
  try { localStorage.setItem('yousefCartNames', JSON.stringify(cartNames)); } catch (e) {}
  const label = names.length ? `«${names.join('»، «')}»` : 'منتج';
  const msg = names.length === 1
    ? `${label} مابقاش متاح واتشال من السلة.`
    : `${label} مابقوش متاحين واتشالوا من السلة.`;
  toast(msg);
  if (typeof announce === 'function') announce(msg);
}

function removeItem(id) {
  delete cart[id];
  updateCart();
}

function updateCart() {
  // (إصلاح) لو منتج اتشال من المتجر بعد ما العميل حطه في السلة، كان بيختفي
  // بصمت وبيتحسب في العدّاد. دلوقتي بنشيله فعليًا وبنقول للعميل ليه.
  pruneMissingCartItems();
  // (أمان) الكميات المحفوظة في localStorage ممكن تكون متلاعب فيها. بنثبّتها
  // على المتاح في المخزون (وبحد أقصى 999) قبل أي عرض أو حساب.
  Object.keys(cart).forEach((id) => {
    const max = Math.min(999, stockOf(id));
    const q = Math.floor(Number(cart[id]));
    if (!Number.isFinite(q) || q < 1) { delete cart[id]; return; }
    if (q > max) { if (max < 1) delete cart[id]; else cart[id] = max; }
    else cart[id] = q;
  });
  const ids = Object.keys(cart);
  const count = ids.reduce((s, id) => s + cart[id], 0);
  const cartBtn = $('cartBtn');
  if (cartBtn) cartBtn.setAttribute('aria-label', count ? `السلة (${count} قطعة)` : 'السلة (فاضية)');
  const badge = $('cartBadge');
  if (badge) {
    badge.textContent = count;
    badge.classList.remove('bump');
    void badge.offsetWidth;
    badge.classList.add('bump');
  }
  try { localStorage.setItem('yousefCart', JSON.stringify(cart)); } catch (e) {}

  const el = $('cartItems');
  const totalEl = $('cartTotal');
  if (!el) return;

  if (!ids.length) {
    el.innerHTML = `<div class="cart-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h2l2.4 12.2a2 2 0 002 1.8h8.6a2 2 0 002-1.7L21 8H6"/></svg>السلة فاضية — ضيف حاجة من المنتجات.</div>`;
  } else {
    el.innerHTML = ids.map((id) => {
      const p = PRODUCTS.find((pp) => pp.id === Number(id));
      if (!p) return '';
      cartNames[id] = p.name;
      return `<div class="cart-item">
        <div class="cart-item-icon"><img data-fallback="1" alt="" data-img-id="${p.id}"></div>
        <div class="cart-item-info">
          <div class="cart-item-name">${escapeHtml(p.name)}</div>
          <div class="cart-item-price">${fmt(p.price)}</div>
          <div class="qty-control">
            <button class="qty-btn" data-dec="${p.id}">−</button>
            <span class="qty-val">${cart[id]}</span>
            <button class="qty-btn" data-inc="${p.id}">+</button>
            <span class="remove-btn" data-remove="${p.id}">إزالة</span>
          </div>
        </div>
      </div>`;
    }).join('');
    // (أمان) رابط صورة السلة بيتحط عبر setAttribute بدل تضمينه في سلسلة innerHTML.
    el.querySelectorAll('img[data-img-id]').forEach((img) => {
      const p = PRODUCTS.find((pp) => pp.id === Number(img.dataset.imgId));
      if (p) img.setAttribute('src', safeImage(p.image_url));
    });
  }

  const total = ids.reduce((s, id) => {
    const p = PRODUCTS.find((pp) => pp.id === Number(id));
    return p ? s + p.price * cart[id] : s;
  }, 0);
  if (totalEl) totalEl.textContent = fmt(total);

  const orderLines = ids.map((id) => {
    const p = PRODUCTS.find((pp) => pp.id === Number(id));
    return p ? `• ${p.name} × ${cart[id]} = ${fmt(p.price * cart[id])}` : '';
  }).filter(Boolean).join('\n');
  const msg = `السلام عليكم، عايز أطلب من يوسف:\n${orderLines}\n\nالإجمالي: ${fmt(total)}`;
  const waBtn = $('whatsappOrderBtn');
  if (waBtn) waBtn.href = `https://wa.me/${storeSettings.whatsappNumber || WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
  try { localStorage.setItem('yousefCartSummary', msg); } catch (e) {}
}

function openCart() {
  $('cartDrawer')?.classList.add('open');
  $('cartOverlay')?.classList.add('open');
  document.body.classList.add('no-scroll');
}
function closeCartFn() {
  $('cartDrawer')?.classList.remove('open');
  $('cartOverlay')?.classList.remove('open');
  document.body.classList.remove('no-scroll');
}

$('cartBtn')?.addEventListener('click', openCart);
$('closeCart')?.addEventListener('click', closeCartFn);
$('cartOverlay')?.addEventListener('click', closeCartFn);
$('cartItems')?.addEventListener('click', (e) => {
  const inc = e.target.closest('[data-inc]');
  const dec = e.target.closest('[data-dec]');
  const rem = e.target.closest('[data-remove]');
  if (inc) changeQty(Number(inc.dataset.inc), 1);
  if (dec) changeQty(Number(dec.dataset.dec), -1);
  if (rem) removeItem(Number(rem.dataset.remove));
});

$('checkoutBtn')?.addEventListener('click', async (e) => {
  if (!Object.keys(cart).length) { e.preventDefault(); showToast('أولاً أضف منتج للسلة'); return; }
  e.preventDefault();
  await loadUser();
  window.location.href = currentUser ? '/checkout.html' : '/account.html?next=checkout.html';
});

/* ─── Event delegation ─── */
$('productGrid')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-add]');
  if (btn) {
    e.stopPropagation();
    const added = addToCart(Number(btn.dataset.add));
    btn.classList.remove('pulse'); void btn.offsetWidth; btn.classList.add('pulse');
    const p = PRODUCTS.find((x) => x.id === Number(btn.dataset.add));
    if (added && p) showToast(`اتضاف "${p.name}" للسلة ✓`);
    return;
  }
  const wish = e.target.closest('[data-wish]');
  if (wish) {
    e.stopPropagation();
    toggleWishlist(Number(wish.dataset.wish));
    return;
  }
  const card = e.target.closest('[data-open]');
  if (card) openProductModal(card.dataset.open);
});

$('wishlistBtn')?.addEventListener('click', () => {
  wishlistFilterActive = !wishlistFilterActive;
  $('wishlistBtn')?.classList.toggle('filtering', wishlistFilterActive);
  document.getElementById('products')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  renderProducts();
});

$('featuredScroll')?.addEventListener('click', (e) => {
  const card = e.target.closest('[data-open]');
  if (card) openProductModal(card.dataset.open);
});

$('filterTabs')?.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  tab.classList.add('active');
  currentFilter = tab.dataset.filter;
  renderProducts();
});

let productSearchDebounce = null;
$('productSearch')?.addEventListener('input', () => {
  clearTimeout(productSearchDebounce);
  productSearchDebounce = setTimeout(renderProducts, 250);
});

document.querySelectorAll('.cat-card').forEach((card) => {
  const activate = () => {
    const f = card.dataset.filter;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.filter === f));
    currentFilter = f;
    renderProducts();
    announce(`تم عرض قسم ${f}`);
    $('products')?.scrollIntoView({ behavior: 'smooth' });
  };
  card.addEventListener('click', activate);
  // (إتاحة) الكروت دي كانت div مش قابل للتشغيل بالكيبورد — دلوقتي Enter/Space.
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      activate();
    }
  });
});

/* ─── تبديل المظهر (فاتح/غامق) ───
   (إصلاح) الكود ده كان بيتعامل مع الزرار لوحده، فلما اتوحّد الثيم في /theme.js
   بقى فيه معالجين للضغطة الواحدة → الثيم يتقلب مرتين ويرجع زي ما كان.
   السكربت المشترك هو المسؤول الوحيد دلوقتي. */


/* ─── Mobile nav & burger ─── */
$('burgerBtn')?.addEventListener('click', () => {
  const nav = document.querySelector('.nav-links');
  const open = nav.style.display === 'flex';
  nav.style.cssText = open ? '' : 'display:flex;position:fixed;top:var(--header-h);inset-inline:0;background:var(--surface-solid-strong);flex-direction:column;padding:24px;gap:20px;border-bottom:1px solid var(--line);z-index:199;backdrop-filter:blur(12px);';
  // (إتاحة) قارئ الشاشة لازم يعرف القائمة مفتوحة ولا مقفولة.
  $('burgerBtn').setAttribute('aria-expanded', String(!open));
  setNavHidden(open);
});
/* (إتاحة) القائمة المقفولة على الموبايل مالهاش تبقى قابلة للوصول بالـ Tab
   ولا لقارئ الشاشة. inert + aria-hidden بيمنعوا ده تمامًا. */
function setNavHidden(hidden) {
  const nav = document.querySelector('.nav-links');
  if (!nav) return;
  const mobile = window.innerWidth <= 720;
  const shouldHide = mobile && hidden;
  if (shouldHide) { nav.setAttribute('inert', ''); nav.setAttribute('aria-hidden', 'true'); }
  else { nav.removeAttribute('inert'); nav.removeAttribute('aria-hidden'); }
}
setNavHidden(true);
window.addEventListener('resize', () => {
  if (window.innerWidth > 720) {
    document.querySelector('.nav-links').style.display = '';
    $('burgerBtn')?.setAttribute('aria-expanded', 'false');
  }
  setNavHidden(document.querySelector('.nav-links')?.style.display !== 'flex');
});
/* (وصولية) تحديد القسم الحالي في القائمة عشان قارئ الشاشة والكيبورد يعرفوا
   إحنا فين، بدل ما الروابط تبقى كلها بنفس الحالة. */
(() => {
  const links = Array.from(document.querySelectorAll('.nav-links a[href^="#"]'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  const setCurrent = (id) => links.forEach((link) => {
    if (link.getAttribute('href') === `#${id}`) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  });
  const sections = links
    .map((link) => document.querySelector(link.getAttribute('href')))
    .filter(Boolean);
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((e) => e.isIntersecting)
      .sort((x, y) => y.intersectionRatio - x.intersectionRatio)[0];
    if (visible) setCurrent(visible.target.id);
  }, { rootMargin: '-45% 0px -45% 0px', threshold: [0, 0.25, 0.5, 1] });
  sections.forEach((section) => observer.observe(section));
})();

document.querySelectorAll('.nav-links a').forEach((a) => a.addEventListener('click', () => {
  if (window.innerWidth <= 720) {
    document.querySelector('.nav-links').style.display = '';
    $('burgerBtn')?.setAttribute('aria-expanded', 'false');
    setNavHidden(true);
  }
}));
$('mobileCartBtn')?.addEventListener('click', openCart);

/* ─── Scroll reveal ─── */
const revealObs = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); revealObs.unobserve(e.target); } });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => revealObs.observe(el));

/* ─── Count up stats ─── */
function countUp(el, target, dur = 1600) {
  const start = performance.now();
  function tick(now) {
    const p = Math.min((now - start) / dur, 1);
    el.textContent = Math.floor((1 - Math.pow(1 - p, 3)) * target).toLocaleString('en-US');
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = target.toLocaleString('en-US');
  }
  requestAnimationFrame(tick);
}
const statObs = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { countUp(e.target, Number(e.target.dataset.count)); statObs.unobserve(e.target); } });
}, { threshold: 0.5 });
document.querySelectorAll('[data-count]').forEach((el) => statObs.observe(el));

/* ─── Hero tilt ─── */
const heroVisual = document.querySelector('.hero-visual-card');
if (heroVisual && window.matchMedia('(pointer:fine)').matches) {
  heroVisual.addEventListener('pointermove', (e) => {
    const r = heroVisual.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    heroVisual.style.transform = `perspective(1200px) rotateY(${x * 10}deg) rotateX(${-y * 10}deg) translateY(-6px)`;
  });
  heroVisual.addEventListener('pointerleave', () => { heroVisual.style.transform = ''; });
}

/* ─── Init ─── */
loadStoreData();
loadUser();
updateCart();


/* fallback الصور المكسورة بقى في ui-utils.js (installImageFallback) بدل ما
   يتركّب هنا كمان — نسخة واحدة لكل الصفحات. */
