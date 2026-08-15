/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, api, toast, dateFmt, html, setHTML, trustedHtml } from './core.js';

export async function loadActivity() {
  try {
    const { activity } = await api('/api/admin/activity');
    setHTML($('#activityList'), activity.length ? activity.map((a) => html`
      <div class="list-item"><strong style="min-width:150px">${a.action}</strong>
      <span class="muted" style="flex:1">${a.details}</span>
      <span>${a.user_name}</span><span class="muted">${dateFmt(a.created_at)}</span></div>`)
      : trustedHtml('<div class="empty">لا يوجد نشاط مسجل</div>'));
  } catch (error) {
    toast(error.message || 'تعذر تحميل سجل النشاط', 'err');
  }
}
