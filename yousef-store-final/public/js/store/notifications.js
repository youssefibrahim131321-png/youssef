/* مُولَّد من storefront.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, showToast, html, setHTML, trustedHtml } from './core.js';

export async function refreshNotifications() {
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
      setHTML(dropdown, notifications.length
        ? notifications.map((n) => html`<div class="notify-item"><strong>${n.title}</strong><span>${n.body}</span><time>${new Date(n.created_at).toLocaleString('ar-EG')}</time></div>`)
        : trustedHtml('<div class="notify-empty">لا توجد إشعارات بعد</div>'));
    }
  } catch (e) {
    const dropdown = $('notifyDropdown');
    if (dropdown) setHTML(dropdown, trustedHtml(trustedHtml('<div class="notify-empty">تعذر تحميل الإشعارات — <button type="button" id="notifyRetry" style="background:none;border:none;color:inherit;text-decoration:underline;cursor:pointer;font:inherit">إعادة المحاولة</button></div>')));
    $('notifyRetry')?.addEventListener('click', refreshNotifications);
  }
}

export function wireNotifications() {
$('notifyBtn')?.addEventListener('click', async () => {
  const dd = $('notifyDropdown');
  dd?.classList.toggle('hidden');
  if (dd && !dd.classList.contains('hidden')) {
    $('notifyBadge')?.classList.add('hidden');
    try {
      const res = await fetch('/api/notifications/mine');
      const { notifications } = await res.json();
      const unreadCount = notifications.filter((n) => !n.read).length;
      if (unreadCount) await fetch('/api/notifications/read-all', { method: 'POST' });
      $('notifyBadge')?.classList.add('hidden');
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
}
