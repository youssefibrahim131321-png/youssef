/* مُولَّد من storefront.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, showToast, showNetworkError, clearNetworkError } from './core.js';
import { currentUser, setCurrentUser, setWishlistIds } from './state.js';
import { loadWishlist, updateWishlistUI } from './wishlist.js';
import { refreshNotifications } from './notifications.js';

export let notifyPollTimer = null;
export async function loadUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error('auth check failed');
    const data = await res.json();
    clearNetworkError();
    setCurrentUser(data.loggedIn ? data.user : null);
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
export function updateAccountMenu() {
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

export async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  setCurrentUser(null);
  setWishlistIds(new Set());
  updateWishlistUI();
  updateAccountMenu();
  $('notifyBtn')?.classList.add('hidden');
  showToast('تم تسجيل الخروج');
  setTimeout(() => { window.location.href = '/'; }, 600);
}

export function wireAuth() {
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
$('logoutBtn')?.addEventListener('click', logout);
}
