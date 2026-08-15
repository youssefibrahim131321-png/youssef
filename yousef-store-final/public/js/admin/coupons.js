/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, $$, api, toast, money, html, setHTML, trustedHtml } from './core.js';

export async function loadCoupons() {
  try {
    const { coupons } = await api('/api/admin/coupons');
    setHTML($('#couponsBody'), coupons.length ? coupons.map((c) => html`
      <tr>
        <td class="mono"><strong>${c.code}</strong></td>
        <td>${c.type === 'percent' ? 'نسبة' : 'مبلغ'}</td>
        <td class="mono">${c.type === 'percent' ? `${Number(c.value)}%` : money(c.value)}</td>
        <td class="mono">${c.min_total ? money(c.min_total) : '—'}</td>
        <td class="mono">${Number(c.used || 0)}${c.max_uses ? ` / ${Number(c.max_uses)}` : ''}</td>
        <td><span class="chip ${c.active ? 'done' : 'cancelled'}">${c.active ? 'نشط' : 'موقوف'}</span></td>
        <td>
          <button class="btn btn-ghost btn-sm" data-toggle-coupon="${c.id}" data-active="${c.active ? 0 : 1}">${c.active ? 'إيقاف' : 'تفعيل'}</button>
          <button class="btn btn-danger btn-sm" data-del-coupon="${c.id}">حذف</button>
        </td>
      </tr>`) : trustedHtml('<tr><td colspan="7" class="empty">لا توجد كوبونات</td></tr>'));
    $$('[data-toggle-coupon]').forEach((btn) => btn.onclick = async () => {
      try { await api(`/api/admin/coupons/${btn.dataset.toggleCoupon}`, { method: 'PUT', body: { active: Number(btn.dataset.active) } }); loadCoupons(); }
      catch (error) { toast(error.message || 'تعذر تحديث الكوبون', 'err'); }
    });
    $$('[data-del-coupon]').forEach((btn) => btn.onclick = async () => {
      if (!confirm('حذف الكوبون؟')) return;
      try { await api(`/api/admin/coupons/${btn.dataset.delCoupon}`, { method: 'DELETE' }); toast('تم حذف الكوبون'); loadCoupons(); }
      catch (error) { toast(error.message || 'تعذر حذف الكوبون', 'err'); }
    });
  } catch (error) {
    toast(error.message || 'تعذر تحميل الكوبونات', 'err');
  }
}

export function wireCoupons() {
$('#couponForm').onsubmit = async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(new FormData(e.target).entries());
  try {
    await api('/api/admin/coupons', { method: 'POST', body: values });
    toast('تمت إضافة الكوبون'); e.target.reset(); loadCoupons();
  } catch (error) { toast(error.message, 'err'); }
};
}
