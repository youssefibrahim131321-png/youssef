/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, esc, api, toast, money, dateFmt, html, setHTML, trustedHtml } from './core.js';
import { safeImageUrl } from './core.js';
import { renderCommandMetrics } from './command-center.js';
import { statusChip } from './labels.js';
import { animateKpiCounters, trendBadge, drawChart, drawStatusDonut, renderPaymentBreakdown, renderCustomerSegments } from './widgets.js';

export async function loadOverview() {
  try {
    setHTML($('#kpiGrid'), Array.from({ length: 8 }).map(() => html`
      <div class="card kpi"><div class="label skeleton" style="width:70%;height:13px">&nbsp;</div><div class="value skeleton" style="width:50%;height:28px;margin-top:8px">&nbsp;</div><div class="hint skeleton" style="width:60%;height:12px;margin-top:4px">&nbsp;</div></div>
    `));
    const days = $('#rangeSelect').value;
    const data = await api(`/api/admin/dashboard?days=${days}`);
    const s = data.stats;
    renderCommandMetrics(data);
    const growth = data.growth || {};
    const bestCat = data.bestCategory;
    setHTML($('#kpiGrid'), [
      ['إيرادات اليوم', money(s.todayRevenue), `${s.todayOrders} طلب اليوم`, 'green'],
      ['إجمالي الإيرادات', money(s.totalRevenue), `متوسط الطلب ${money(s.averageOrder)}${trendBadge(growth.revenuePct)}`, 'accent'],
      ['طلبات قيد الانتظار', s.pendingOrders, `${s.orders} طلب إجمالًا${trendBadge(growth.ordersPct)}`, 'red'],
      ['العملاء', s.customers, `${s.users} حساب مسجل`, 'blue'],
      ['معدل التحويل', `${(s.conversionRate || 0).toFixed(1)}%`, 'من مشاهدات المنتجات لطلبات', 'purple'],
      ['متوسط قِطع الطلب', (s.avgItemsPerOrder || 0).toFixed(1), 'قطعة في كل طلب مكتمل', ''],
      ['المنتجات النشطة', s.activeProducts, `${s.lowStock} منتج مخزونه منخفض`, ''],
      [bestCat ? 'أفضل قسم مبيعًا' : 'قيمة المخزون', bestCat ? esc(bestCat.name) : money(s.inventoryValue), bestCat ? `إيرادات ${money(bestCat.revenue)}` : `${s.coupons} كوبون نشط`, 'accent2']
    ].map(([label, value, hint, tone]) => html`
      <div class="card kpi ${tone}"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>
    `));
    animateKpiCounters();

    drawChart(data.series);
    drawStatusDonut(data.statusCounts || {});
    renderPaymentBreakdown(data.paymentCounts);
    renderCustomerSegments(data.customerSegments);

    setHTML($('#topProducts'), data.topProducts.length ? data.topProducts.map((p) => {
      const max = data.topProducts[0].quantity || 1;
      return html`<div class="bar-row"><span style="width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.name}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(p.quantity / max) * 100}%"></div></div>
        <strong class="mono">${p.quantity}</strong></div>`;
    }) : trustedHtml('<div class="empty">لا توجد مبيعات بعد</div>'));

    setHTML($('#recentOrders'), data.recentOrders.length ? data.recentOrders.map((o) => html`
      <tr><td class="mono">#${o.id}</td><td>${o.customer_name}</td><td class="mono">${money(o.total_amount)}</td>
      <td>${statusChip(o.status)}</td><td class="muted">${dateFmt(o.created_at)}</td></tr>`)
      : trustedHtml('<tr><td colspan="5" class="empty">لا توجد طلبات بعد</td></tr>'));

    setHTML($('#lowStockList'), data.lowStockProducts.length ? data.lowStockProducts.slice(0, 6).map((p) => html`
      <div class="list-item"><img class="thumb" width="44" height="44" loading="lazy" alt="" data-img-id="${p.id}"><div style="flex:1">${p.name}</div>
      <strong style="color:${p.stock === 0 ? 'var(--red)' : 'var(--accent)'}">${p.stock}</strong></div>`)
      : trustedHtml('<div class="empty">كل المخزون في حالة جيدة ✅</div>'));
    // (أمان) رابط الصورة بيتحط عبر setAttribute بدل تضمينه جوّه سلسلة innerHTML.
    $('#lowStockList').querySelectorAll('img[data-img-id]').forEach((img) => {
      const p = data.lowStockProducts.find((x) => x.id === Number(img.dataset.imgId));
      if (p) img.setAttribute('src', safeImageUrl(p.image_url));
    });

    setHTML($('#topCustomers'), data.topCustomers.length ? data.topCustomers.map((c) => html`
      <div class="list-item"><div style="flex:1">${c.name}</div><span class="muted">${Number(c.orders || 0)} طلب</span>
      <strong class="mono">${money(c.total)}</strong></div>`)
      : trustedHtml('<div class="empty">لا يوجد عملاء بعد</div>'));

    $('#ordersBadge').textContent = s.pendingOrders;
    $('#ordersBadge').classList.toggle('hidden', !s.pendingOrders);
  } catch (error) {
    toast(error.message || 'تعذر تحميل نظرة عامة', 'err');
  }
}

export function wireOverview() {
  $('#rangeSelect').onchange = loadOverview;
}
