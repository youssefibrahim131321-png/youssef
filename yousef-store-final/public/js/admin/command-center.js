import { $, api, toast, money } from './core.js';

const state = { lastRun: null };

function metric(label, value, tone = '') {
  const card = document.createElement('div');
  card.className = `ops-metric ${tone}`;
  const strong = document.createElement('strong');
  strong.textContent = String(value);
  const span = document.createElement('span');
  span.textContent = label;
  card.append(strong, span);
  return card;
}

function renderInsights(data) {
  const box = $('#commandInsights');
  if (!box) return;
  const s = data.stats || {};
  const low = data.lowStockProducts || [];
  const pending = Number(s.pendingOrders || 0);
  const insights = [];
  if (pending) insights.push({ tone: 'warn', title: `${pending} طلب يحتاج متابعة`, body: 'افتح قائمة الطلبات وابدأ بالأقدم أولًا.', action: 'orders', label: 'إدارة الطلبات' });
  if (low.length) insights.push({ tone: 'danger', title: `${low.length} منتج منخفض المخزون`, body: 'راجع الكميات قبل نفاد المنتجات الأكثر طلبًا.', action: 'inventory', label: 'مراجعة المخزون' });
  if (!pending && !low.length) insights.push({ tone: 'ok', title: 'المتجر مستقر اليوم', body: 'لا توجد تنبيهات تشغيلية حرجة في البيانات الحالية.', action: 'overview', label: 'استعراض الأداء' });
  box.textContent = '';
  insights.slice(0, 3).forEach((item) => {
    const article = document.createElement('article');
    article.className = `insight-card ${item.tone}`;
    const title = document.createElement('strong'); title.textContent = item.title;
    const body = document.createElement('p'); body.textContent = item.body;
    const button = document.createElement('button'); button.className = 'btn btn-ghost btn-sm'; button.textContent = item.label;
    button.addEventListener('click', () => { window.location.hash = item.action; });
    article.append(title, body, button); box.appendChild(article);
  });
}

export function renderCommandMetrics(data) {
  const box = $('#commandMetrics');
  if (!box) return;
  const s = data.stats || {};
  box.textContent = '';
  box.append(
    metric('طلبات تحتاج متابعة', s.pendingOrders || 0, s.pendingOrders ? 'warn' : 'ok'),
    metric('مخزون منخفض', s.lowStock || 0, s.lowStock ? 'danger' : 'ok'),
    metric('إيرادات اليوم', money(s.todayRevenue || 0), 'accent'),
    metric('متوسط الطلب', money(s.averageOrder || 0), 'accent')
  );
  renderInsights(data);
}

async function runAutomationCheck() {
  const status = $('#automationStatus');
  if (!status) return;
  status.textContent = 'جاري الفحص...';
  try {
    const [health, paymob] = await Promise.allSettled([api('/api/health'), api('/api/admin/paymob/health')]);
    const ok = health.status === 'fulfilled' && health.value?.ok !== false;
    const paymobOk = paymob.status === 'fulfilled';
    status.textContent = ok && paymobOk ? 'كل الأنظمة تعمل' : 'تحتاج مراجعة';
    status.dataset.state = ok && paymobOk ? 'ok' : 'warn';
    state.lastRun = new Date();
    const stamp = $('#automationLastRun');
    if (stamp) stamp.textContent = `آخر فحص: ${state.lastRun.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
    toast(ok && paymobOk ? 'الفحص التشغيلي اكتمل بنجاح' : 'الفحص اكتشف نقطة تحتاج مراجعة', ok && paymobOk ? 'ok' : 'err');
  } catch (error) {
    status.textContent = 'تعذر إكمال الفحص';
    status.dataset.state = 'warn';
    toast(error.message || 'تعذر تشغيل الفحص', 'err');
  }
}

export function wireCommandCenter() {
  $('#runAutomationBtn')?.addEventListener('click', runAutomationCheck);
  $('#quickNewProduct')?.addEventListener('click', () => $('#addProductBtn')?.click());
  $('#quickExportOrders')?.addEventListener('click', () => document.querySelector('[data-export]')?.click());
  $('#quickBackup')?.addEventListener('click', async () => {
    try { await api('/api/admin/backup', { method: 'POST', body: {} }); toast('تم إنشاء النسخة الاحتياطية بنجاح', 'ok'); }
    catch (error) { toast(error.message || 'تعذر إنشاء النسخة الاحتياطية', 'err'); }
  });
}

export { runAutomationCheck };
