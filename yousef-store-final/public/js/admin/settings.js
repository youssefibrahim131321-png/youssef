/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, api, toast, setSettings } from './core.js';

export async function loadSettings() {
  const { settings } = await api('/api/site/settings');
  setSettings(settings);
  const form = $('#settingsForm');
  Object.entries(settings).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value;
  });
}

async function refreshTotpStatus() {
  const status = await api('/api/auth/2fa/status');
  $('#totpStatus').textContent = status.enabled
    ? '✅ التحقق بخطوتين مفعّل على حسابك.'
    : '⚠️ التحقق بخطوتين مش مفعّل على حسابك.';
  $('#totpOn').classList.toggle('hidden', !status.enabled);
  $('#totpOff').classList.toggle('hidden', !!status.enabled);
  $('#totpSetupBox').classList.add('hidden');
  return status;
}

export function wireSettings() {
$('#settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(new FormData(e.target).entries());
  try { const data = await api('/api/site/settings', { method: 'PUT', body: values }); setSettings(data.settings); toast('تم حفظ الإعدادات'); }
  catch (error) { toast(error.message, 'err'); }
};
$('#passwordForm').onsubmit = async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(new FormData(e.target).entries());
  try { await api('/api/auth/change-password', { method: 'POST', body: values }); toast('تم تغيير كلمة المرور'); e.target.reset(); $('#passwordWarning').classList.add('hidden'); }
  catch (error) { toast(error.message, 'err'); }
};

refreshTotpStatus().catch((error) => toast(error.message, 'err'));

$('#totpSetupBtn').onclick = async () => {
  try {
    const data = await api('/api/auth/2fa/setup', { method: 'POST' });
    $('#totpSecretText').textContent = data.secret;
    $('#totpSetupBox').classList.remove('hidden');
  } catch (error) { toast(error.message, 'err'); }
};
$('#totpEnableForm').onsubmit = async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(new FormData(e.target).entries());
  try {
    await api('/api/auth/2fa/enable', { method: 'POST', body: values });
    toast('تم تفعيل التحقق بخطوتين ✅');
    e.target.reset();
    await refreshTotpStatus();
  } catch (error) { toast(error.message, 'err'); }
};
$('#totpDisableForm').onsubmit = async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(new FormData(e.target).entries());
  if (!confirm('متأكد إنك عايز تلغي التحقق بخطوتين؟')) return;
  try {
    await api('/api/auth/2fa/disable', { method: 'POST', body: values });
    toast('تم إلغاء التحقق بخطوتين');
    e.target.reset();
    await refreshTotpStatus();
  } catch (error) { toast(error.message, 'err'); }
};

// (إصلاح S1) زرار «نسخة احتياطية الآن» اتشال: الـ endpoint بقى بيرجّع ok:false دايمًا
// (النسخ الاحتياطي مسؤولية Railway managed backups)، والواجهة كانت بتعرض نجاح وهمي.
$('#logoutAllBtn').onclick = async () => {
  if (!confirm('هيتم تسجيل الخروج من كل الأجهزة التانية غير الجهاز ده. تكمل؟')) return;
  await api('/api/auth/logout-all-devices', { method: 'POST' });
  toast('تم تسجيل الخروج من كل الأجهزة الأخرى');
};
}
