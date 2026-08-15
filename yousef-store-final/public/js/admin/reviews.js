/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, $$, api, toast, dateFmt, html, setHTML, trustedHtml } from './core.js';

export async function loadReviews() {
  try {
    const { reviews } = await api('/api/admin/reviews');
    setHTML($('#reviewsBody'), reviews.length ? reviews.map((r) => html`
      <tr>
        <td>${r.product_name}</td>
        <td>${r.user_name}</td>
        <td>${'⭐'.repeat(Math.max(0, Math.min(5, Number(r.rating) || 0)))}</td>
        <td style="white-space:normal;max-width:320px">${r.comment || '—'}</td>
        <td class="muted">${dateFmt(r.created_at)}</td>
        <td><button class="btn btn-danger btn-sm" data-del-review="${r.id}">حذف</button></td>
      </tr>`) : trustedHtml('<tr><td colspan="6" class="empty">لا توجد تقييمات بعد</td></tr>'));
    $$('[data-del-review]').forEach((btn) => btn.onclick = async () => {
      try { await api(`/api/admin/reviews/${btn.dataset.delReview}`, { method: 'DELETE' }); toast('تم حذف التقييم'); loadReviews(); }
      catch (error) { toast(error.message || 'تعذر حذف التقييم', 'err'); }
    });
  } catch (error) {
    toast(error.message || 'تعذر تحميل التقييمات', 'err');
  }
}
