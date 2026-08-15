/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, $$, toast } from './core.js';
import { PAGE_META } from './labels.js';
import { loadOverview } from './overview.js';
import { loadOrders } from './orders.js';
import { loadProducts } from './products.js';
import { loadInventory } from './inventory.js';
import { loadCoupons } from './coupons.js';
import { loadReviews } from './reviews.js';
import { loadUsers } from './users.js';
import { loadActivity } from './activity.js';
import { loadSettings } from './settings.js';

export const LOADERS = {
  overview: loadOverview, orders: loadOrders, products: loadProducts, inventory: loadInventory,
  coupons: loadCoupons, reviews: loadReviews, users: loadUsers, activity: loadActivity,
  settings: async () => { await loadSettings(); }
};

export function go(page) {
  // (إصلاح) هاش غير معروف كان بيرمي TypeError ويوقف اللوحة كلها.
  if (!$(`#page-${page}`)) page = 'overview';
  $$('.page').forEach((el) => el.classList.add('hidden'));
  $(`#page-${page}`).classList.remove('hidden');
  $$('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.page === page));
  const [title, sub] = PAGE_META[page] || ['', ''];
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
  $('#sidebar').classList.remove('open');
  location.hash = page;
  LOADERS[page] && LOADERS[page]();
}

export function wireNav() {
$$('.nav-item[data-page]').forEach((btn) => btn.onclick = () => go(btn.dataset.page));
$$('[data-page-link]').forEach((btn) => btn.onclick = () => go(btn.dataset.pageLink));
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
$('#refreshBtn').onclick = () => { const page = location.hash.slice(1) || 'overview'; LOADERS[page] && LOADERS[page](); toast('تم التحديث'); };
$('#logoutBtn').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/admin-login.html'; };
// (إصلاح) اللوحة كانت بتخزّن الثيم في مفتاح خاص بيها (adminTheme) وبتحطه على
// <body> بس، فكان الاختيار بيضيع بينها وبين باقي الموقع. دلوقتي بتستخدم نفس
// السكربت المشترك /theme.js اللي بيحط data-theme على <html> ويحفظه لكل الصفحات.
// الزرار نفسه بقى .theme-toggle في admin.html، و/theme.js بيتكفّل بالضغط.
try { localStorage.removeItem('adminTheme'); } catch (_) { /* تخزين مقفول */ }
}
