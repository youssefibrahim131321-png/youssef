/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, $$, money, html, setHTML, trustedHtml } from './core.js';
import { paymentLabel, PAYMENT_ICONS, STATUS_LABELS, STATUS_COLORS } from './labels.js';

/* عداد متحرك للـ KPIs — بياخد النص الجاهز (زي "12,340 ج.م") ويطلعه بيعدّ من صفر
   لحد الرقم الحقيقي، من غير ما يغيّر أي منطق تنسيق موجود أصلًا. */
const REDUCE_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function animateKpiCounters() {
  $$('.kpi .value').forEach((el) => {
    const full = el.textContent.trim();
    const m = full.match(/^-?[\d,]+(\.\d+)?/);
    if (!m || REDUCE_MOTION) return;
    const target = parseFloat(m[0].replace(/,/g, ''));
    if (!isFinite(target)) return;
    const suffix = full.slice(m[0].length);
    const decimals = (m[1] || '').length ? m[1].length - 1 : 0;
    const dur = 700;
    const t0 = performance.now();
    el.textContent = `0${suffix}`;
    function tick(now) {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      const cur = target * eased;
      el.textContent = `${cur.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`;
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

/* شارة اتجاه صغيرة (▲/▼ نسبة%) بتتحط جنب أي رقم — مقارنة بالفترة اللي قبلها. */
export function trendBadge(pct) {
  if (pct === undefined || pct === null || !isFinite(pct) || Math.abs(pct) < 0.05) return '';
  const up = pct > 0;
  return html` <span style="color:${up ? 'var(--green)' : 'var(--red)'};font-weight:800">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</span>`;
}

export function renderPaymentBreakdown(counts) {
  const entries = Object.entries(counts || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const max = Number(entries.length ? entries[0][1] : 1) || 1;
  setHTML($('#paymentBreakdown'), entries.length ? entries.map(([k, rawV]) => html`
    <div class="bar-row"><span style="width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${PAYMENT_ICONS[k] || '💳'} ${paymentLabel(k)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(Number(rawV) / Number(max)) * 100}%"></div></div>
      <strong class="mono">${Number(rawV)}</strong></div>`) : trustedHtml('<div class="empty">لا توجد بيانات كافية بعد</div>'));
}

export function renderCustomerSegments(seg) {
  const n = Number(seg?.new || 0), r = Number(seg?.returning || 0), total = n + r;
  if (!total) { setHTML($('#customerSegments'), trustedHtml(trustedHtml('<div class="empty">لا توجد بيانات كافية بعد</div>'))); return; }
  const newPct = Math.round((n / total) * 100), retPct = 100 - newPct;
  setHTML($('#customerSegments'), html`
    <div class="bar-row"><span style="width:120px">🆕 عملاء جدد</span>
      <div class="bar-track"><div class="bar-fill" style="width:${newPct}%;background:linear-gradient(90deg,var(--green),#7ee9b8)"></div></div>
      <strong class="mono">${n} (${newPct}%)</strong></div>
    <div class="bar-row"><span style="width:120px">🔁 عملاء عائدين</span>
      <div class="bar-track"><div class="bar-fill" style="width:${retPct}%;background:linear-gradient(90deg,var(--blue),#8fd8ff)"></div></div>
      <strong class="mono">${r} (${retPct}%)</strong></div>
    <p class="muted" style="font-size:12px;margin-top:10px">خلال الفترة المختارة أعلاه (${Number($('#rangeSelect').value) || 0} يوم)</p>`);
}

export function drawChart(series) {
  const W = 700, H = 230, pad = 30;
  const max = Math.max(1, ...series.map((d) => d.revenue));
  const step = series.length > 1 ? (W - pad * 2) / (series.length - 1) : 0;
  const points = series.map((d, i) => [pad + i * step, H - pad - (d.revenue / max) * (H - pad * 2)]);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${points[points.length - 1][0]},${H - pad} L${points[0][0]},${H - pad} Z`;
  const grid = [0, .25, .5, .75, 1].map((r) => html`<line x1="${pad}" y1="${pad + r * (H - pad * 2)}" x2="${W - pad}" y2="${pad + r * (H - pad * 2)}" stroke="currentColor" stroke-opacity=".08"/>`);
  // (إتاحة) مخطط الإيرادات بقى له اسم واضح لقارئات الشاشة.
  const chartEl = $('#salesChart');
  chartEl.setAttribute('role', 'img');
  chartEl.setAttribute('aria-label',
    `مخطط الإيرادات من ${series[0]?.date || ''} إلى ${series[series.length - 1]?.date || ''} — الإجمالي ${money(series.reduce((sum, d) => sum + Number(d.revenue || 0), 0))}`);
  setHTML(chartEl, html`
    <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e8632c" stop-opacity=".35"/><stop offset="100%" stop-color="#e8632c" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#g1)"/>
    <path d="${line}" fill="none" stroke="#e8632c" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${points.map((p, i) => html`<circle class="chart-dot" cx="${Number(p[0])}" cy="${Number(p[1])}" r="3.5"><title>${series[i].date}: ${money(series[i].revenue)} (${Number(series[i].orders || 0)} طلب)</title></circle>`)}
    <text x="${pad}" y="${H - 8}" fill="currentColor" font-size="11" opacity=".6">${series[0]?.date || ''}</text>
    <text x="${W - pad}" y="${H - 8}" text-anchor="end" fill="currentColor" font-size="11" opacity=".6">${series[series.length - 1]?.date || ''}</text>`);
}

export function drawStatusDonut(counts) {
  const order = ['pending', 'confirmed', 'shipping', 'done', 'cancelled'];
  const entries = order.map((k) => [k, counts[k] || 0]).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const donut = $('#statusDonut');
  const legend = $('#statusLegend');
  if (!total) {
    setHTML(donut, html`<circle cx="60" cy="60" r="46" fill="none" stroke="var(--line)" stroke-width="16"/>`);
    setHTML(legend, trustedHtml(trustedHtml('<div class="empty" style="padding:0">لا توجد طلبات بعد</div>')));
    return;
  }
  const r = 46, cx = 60, cy = 60, circumference = 2 * Math.PI * r;
  let offset = 0;
  const arcs = entries.map(([status, count]) => {
    const frac = count / total;
    const dash = frac * circumference;
    const seg = html`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${STATUS_COLORS[status]}" stroke-width="16"
      stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${STATUS_LABELS[status]}: ${count}</title></circle>`;
    offset += dash;
    return seg;
  });
  // (إتاحة) المخطط بقى له اسم ووصف نصي لقارئات الشاشة بدل SVG مجهول.
  donut.setAttribute('role', 'img');
  donut.setAttribute('aria-label',
    `توزيع حالات الطلبات: ${entries.map(([status, count]) => `${STATUS_LABELS[status] || status} ${count}`).join('، ')} — الإجمالي ${total} طلب`);
  setHTML(donut, [arcs, html`<text x="${cx}" y="${cy - 3}" text-anchor="middle" fill="currentColor" font-size="20" font-weight="800">${total}</text><text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="currentColor" font-size="10" opacity=".6">طلب</text>`]);
  setHTML(legend, entries.map(([status, count]) => html`
    <div style="display:flex;align-items:center;gap:8px">
      <span style="width:9px;height:9px;border-radius:50%;background:${STATUS_COLORS[status]};flex-shrink:0"></span>
      <span style="flex:1;color:var(--muted)">${STATUS_LABELS[status]}</span>
      <strong class="mono">${count}</strong>
    </div>`));
}
