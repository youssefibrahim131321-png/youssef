/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { toast } from './core.js';

export function wireExportLinks() {
// (إصلاح) روابط التصدير كانت بتفتح الرد الخام لو الجلسة انتهت (401/302).
// دلوقتي بنجيب الملف بـ fetch ونعرض رسالة مفهومة بدل صفحة JSON غامضة.
document.addEventListener('click', async (event) => {
  const link = event.target.closest && event.target.closest('a[data-export]');
  if (!link) return;
  event.preventDefault();
  try {
    const res = await fetch(link.getAttribute('href'), { credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403 || res.redirected) {
      toast('انتهت جلستك — سجّل الدخول تاني وجرّب التصدير.', 'err');
      return;
    }
    if (!res.ok) { toast('تعذر التصدير، حاول تاني.', 'err'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = link.getAttribute('download') || 'export';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (_) {
    toast('تعذر الاتصال بالخادم أثناء التصدير.', 'err');
  }
});
}
