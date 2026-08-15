/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, api, toast } from './core.js';

export function wireBroadcast() {
$('#broadcastForm').onsubmit = async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(new FormData(e.target).entries());
  try {
    const data = await api('/api/admin/broadcast', { method: 'POST', body: values });
    toast(`تم إرسال الإشعار إلى ${data.sent} عميل`);
    e.target.reset();
  } catch (error) { toast(error.message, 'err'); }
};
}
