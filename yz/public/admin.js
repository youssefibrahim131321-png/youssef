/* سكريبت لوحة التحكم — اتنقل من admin.html لملف خارجي عشان يتكاش ويتخفّف. */
/* ============================ الأدوات ============================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
// (تنظيف) نفس دالة الـ escape كانت متكررة في 4 ملفات — بقت في ui-utils.js.
const esc = window.YousefUI.escapeHtml;
const safeImage = window.YousefUI.safeImage;

// (أمان) رابط صورة صالح: مسار داخلي، http(s)، أو data:image فقط.
function isValidImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return true;
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(raw)) return true;
  if (/["'<>\s]/.test(raw)) return false;
  return /^\/(?!\/)/.test(raw) || /^https?:\/\/[^/]+(\/.*)?$/i.test(raw);
}
let SETTINGS = { currency: 'ج.م' };
const money = (v) => `${Number(v || 0).toLocaleString('en-US')} ${SETTINGS.currency || 'ج.م'}`;
const dateFmt = (v) => new Date(v).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });

function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3200);
}

function clearPrivilegedData() {
  // (أمان) قبل ما نطرد المستخدم لصفحة الدخول، بنمسح أي بيانات حساسة معروضة
  // على الشاشة عشان ما تفضلش ظاهرة في الـ DOM بعد انتهاء الجلسة.
  ['#kpiGrid', '#recentOrders', '#lowStockList', '#topCustomers', '#topProducts',
   '#ordersBody', '#productsBody', '#inventoryBody', '#couponsBody', '#reviewsBody',
   '#usersBody', '#activityList'].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) el.innerHTML = '';
  });
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (res.status === 401 || res.status === 403) {
    clearPrivilegedData();
    window.location.href = '/admin-login.html';
    // Never resolve/reject so callers just stop silently instead of racing
    // the redirect with more UI updates or throwing unhandled errors.
    return new Promise(() => {});
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'حدث خطأ غير متوقع');
  return data;
}

function openModal(title, html, onSubmit) {
  // (أمان) العنوان بيتهرّب هنا جوّه الدالة نفسها، مش في كل نداء — فأي نداء
  // جديد ينسى esc() ما يفتحش باب XSS في لوحة التحكم.
  $('#modalRoot').innerHTML = `<div class="modal-overlay"><div class="modal"><h3>${esc(title)}</h3><form id="modalForm">${html}
    <div class="toolbar" style="margin:18px 0 0"><button class="btn btn-primary" type="submit">حفظ</button>
    <button class="btn btn-ghost" type="button" id="modalCancel">إلغاء</button></div></form></div></div>`;
  $('#modalCancel').onclick = closeModal;
  $('.modal-overlay').onclick = (e) => { if (e.target.classList.contains('modal-overlay')) closeModal(); };
  $('#modalForm').onsubmit = async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target).entries());
    try { await onSubmit(values); closeModal(); } catch (error) { toast(error.message, 'err'); }
  };
}
const closeModal = () => { $('#modalRoot').innerHTML = ''; };

/* ============================ التنقل ============================ */
const PAGE_META = {
  overview: ['نظرة عامة', 'ملخص أداء المتجر اليوم'],
  orders: ['الطلبات', 'إدارة ومتابعة كل الطلبات'],
  products: ['المنتجات', 'إضافة وتعديل منتجات المتجر'],
  inventory: ['المخزون', 'متابعة الكميات وقيمة المخزون'],
  coupons: ['الكوبونات', 'أكواد الخصم والعروض'],
  reviews: ['التقييمات', 'مراجعة تقييمات العملاء'],
  broadcast: ['إشعار جماعي', 'أرسل رسالة لكل العملاء دفعة واحدة'],
  users: ['المستخدمون', 'العملاء والمسؤولون'],
  activity: ['سجل النشاط', 'كل ما تم داخل لوحة التحكم'],
  settings: ['الإعدادات', 'بيانات المتجر والشحن والأمان']
};

function go(page) {
  $$('.page').forEach((el) => el.classList.add('hidden'));
  $(`#page-${page}`).classList.remove('hidden');
  $$('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.page === page));
  const [title, sub] = PAGE_META[page] || ['', ''];
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
  $('#sidebar').classList.remove('open');
  location.hash = page;
  LOADERS[page] && LOADERS[page]();
}
$$('.nav-item[data-page]').forEach((btn) => btn.onclick = () => go(btn.dataset.page));
$$('[data-page-link]').forEach((btn) => btn.onclick = () => go(btn.dataset.pageLink));
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
$('#refreshBtn').onclick = () => { const page = location.hash.slice(1) || 'overview'; LOADERS[page] && LOADERS[page](); toast('تم التحديث'); };
$('#logoutBtn').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/admin-login.html'; };
$('#themeBtn').onclick = () => {
  const next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
  document.body.dataset.theme = next;
  localStorage.setItem('adminTheme', next);
};
if (localStorage.getItem('adminTheme') === 'light') document.body.dataset.theme = 'light';

/* ============================ نظرة عامة ============================ */
async function loadOverview() {
  try {
    const days = $('#rangeSelect').value;
    const data = await api(`/api/admin/dashboard?days=${days}`);
    const s = data.stats;
    $('#kpiGrid').innerHTML = [
      ['إيرادات اليوم', money(s.todayRevenue), `${s.todayOrders} طلب اليوم`, 'green'],
      ['إجمالي الإيرادات', money(s.totalRevenue), `متوسط الطلب ${money(s.averageOrder)}`, 'accent'],
      ['طلبات قيد الانتظار', s.pendingOrders, `${s.orders} طلب إجمالًا`, 'red'],
      ['العملاء', s.customers, `${s.users} حساب مسجل`, 'blue'],
      ['المنتجات النشطة', s.activeProducts, `${s.lowStock} منتج مخزونه منخفض`, ''],
      ['قيمة المخزون', money(s.inventoryValue), `${s.coupons} كوبون نشط`, '']
    ].map(([label, value, hint, tone]) => `
      <div class="card kpi ${tone}"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>
    `).join('');

    drawChart(data.series);
    drawStatusDonut(data.statusCounts || {});

    $('#topProducts').innerHTML = data.topProducts.length ? data.topProducts.map((p) => {
      const max = data.topProducts[0].quantity || 1;
      return `<div class="bar-row"><span style="width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(p.quantity / max) * 100}%"></div></div>
        <strong class="mono">${p.quantity}</strong></div>`;
    }).join('') : '<div class="empty">لا توجد مبيعات بعد</div>';

    $('#recentOrders').innerHTML = data.recentOrders.length ? data.recentOrders.map((o) => `
      <tr><td class="mono">#${o.id}</td><td>${esc(o.customer_name)}</td><td class="mono">${money(o.total_amount)}</td>
      <td>${statusChip(o.status)}</td><td class="muted">${dateFmt(o.created_at)}</td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">لا توجد طلبات بعد</td></tr>';

    $('#lowStockList').innerHTML = data.lowStockProducts.length ? data.lowStockProducts.slice(0, 6).map((p) => `
      <div class="list-item"><img class="thumb" width="44" height="44" loading="lazy" alt="" data-img-id="${p.id}"><div style="flex:1">${esc(p.name)}</div>
      <strong style="color:${p.stock === 0 ? 'var(--red)' : 'var(--accent)'}">${p.stock}</strong></div>`).join('')
      : '<div class="empty">كل المخزون في حالة جيدة ✅</div>';
    // (أمان) رابط الصورة بيتحط عبر setAttribute بدل تضمينه جوّه سلسلة innerHTML.
    $('#lowStockList').querySelectorAll('img[data-img-id]').forEach((img) => {
      const p = data.lowStockProducts.find((x) => x.id === Number(img.dataset.imgId));
      if (p) img.setAttribute('src', safeImage(p.image_url));
    });

    $('#topCustomers').innerHTML = data.topCustomers.length ? data.topCustomers.map((c) => `
      <div class="list-item"><div style="flex:1">${esc(c.name)}</div><span class="muted">${Number(c.orders || 0)} طلب</span>
      <strong class="mono">${money(c.total)}</strong></div>`).join('')
      : '<div class="empty">لا يوجد عملاء بعد</div>';

    $('#ordersBadge').textContent = s.pendingOrders;
    $('#ordersBadge').classList.toggle('hidden', !s.pendingOrders);
  } catch (error) {
    toast(error.message || 'تعذر تحميل نظرة عامة', 'err');
  }
}
$('#rangeSelect').onchange = loadOverview;

function drawChart(series) {
  const W = 700, H = 230, pad = 30;
  const max = Math.max(1, ...series.map((d) => d.revenue));
  const step = series.length > 1 ? (W - pad * 2) / (series.length - 1) : 0;
  const points = series.map((d, i) => [pad + i * step, H - pad - (d.revenue / max) * (H - pad * 2)]);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${points[points.length - 1][0]},${H - pad} L${points[0][0]},${H - pad} Z`;
  const grid = [0, .25, .5, .75, 1].map((r) => `<line x1="${pad}" y1="${pad + r * (H - pad * 2)}" x2="${W - pad}" y2="${pad + r * (H - pad * 2)}" stroke="currentColor" stroke-opacity=".08"/>`).join('');
  $('#salesChart').innerHTML = `
    <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#c8793f" stop-opacity=".35"/><stop offset="100%" stop-color="#c8793f" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#g1)"/>
    <path d="${line}" fill="none" stroke="#c8793f" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${points.map((p, i) => `<circle class="chart-dot" cx="${Number(p[0])}" cy="${Number(p[1])}" r="3.5"><title>${esc(series[i].date)}: ${money(series[i].revenue)} (${Number(series[i].orders || 0)} طلب)</title></circle>`).join('')}
    <text x="${pad}" y="${H - 8}" fill="currentColor" font-size="11" opacity=".6">${esc(series[0]?.date || '')}</text>
    <text x="${W - pad}" y="${H - 8}" text-anchor="end" fill="currentColor" font-size="11" opacity=".6">${esc(series[series.length - 1]?.date || '')}</text>`;
}

const STATUS_LABELS = { pending: 'قيد الانتظار', confirmed: 'مؤكد', shipping: 'في الطريق', done: 'تم التسليم', cancelled: 'ملغي' };
const STATUS_COLORS = { pending: '#c8793f', confirmed: '#5a8fb0', shipping: '#3f8f7d', done: '#3ecf8e', cancelled: '#e5483c' };
const statusChip = (status) => `<span class="chip ${status}">${STATUS_LABELS[status] || status}</span>`;

function drawStatusDonut(counts) {
  const order = ['pending', 'confirmed', 'shipping', 'done', 'cancelled'];
  const entries = order.map((k) => [k, counts[k] || 0]).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const donut = $('#statusDonut');
  const legend = $('#statusLegend');
  if (!total) {
    donut.innerHTML = `<circle cx="60" cy="60" r="46" fill="none" stroke="var(--line)" stroke-width="16"/>`;
    legend.innerHTML = '<div class="empty" style="padding:0">لا توجد طلبات بعد</div>';
    return;
  }
  const r = 46, cx = 60, cy = 60, circumference = 2 * Math.PI * r;
  let offset = 0;
  const arcs = entries.map(([status, count]) => {
    const frac = count / total;
    const dash = frac * circumference;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${esc(STATUS_COLORS[status])}" stroke-width="16"
      stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${esc(STATUS_LABELS[status])}: ${count}</title></circle>`;
    offset += dash;
    return seg;
  }).join('');
  donut.innerHTML = arcs + `<text x="${cx}" y="${cy - 3}" text-anchor="middle" fill="currentColor" font-size="20" font-weight="800">${total}</text><text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="currentColor" font-size="10" opacity=".6">طلب</text>`;
  legend.innerHTML = entries.map(([status, count]) => `
    <div style="display:flex;align-items:center;gap:8px">
      <span style="width:9px;height:9px;border-radius:50%;background:${esc(STATUS_COLORS[status])};flex-shrink:0"></span>
      <span style="flex:1;color:var(--muted)">${esc(STATUS_LABELS[status])}</span>
      <strong class="mono">${count}</strong>
    </div>`).join('');
}

/* ============================ الطلبات ============================ */
let ordersPage = 1;
async function loadOrders() {
  try {
    const params = new URLSearchParams({
      page: ordersPage,
      perPage: 20,
      status: $('#orderStatus').value,
      payment: $('#orderPayment').value,
      q: $('#orderSearch').value.trim(),
      from: $('#orderFrom').value,
      to: $('#orderTo').value
    });
    const data = await api(`/api/admin/orders?${params}`);
    $('#pageInfo').textContent = `${data.page} / ${data.pages} (${data.total} طلب)`;
    $('#ordersBody').innerHTML = data.orders.length ? data.orders.map((o) => `
      <tr>
        <td class="mono">#${o.id}</td>
        <td>${esc(o.customer_name)}</td>
        <td class="mono">${esc(o.customer_phone)}</td>
        <td>${o.items.length} صنف</td>
        <td class="mono">${money(o.total_amount)}${o.discount ? `<br><small class="muted">خصم ${money(o.discount)}</small>` : ''}</td>
        <td>${statusChip(o.status)}</td>
        <td><span class="chip ${o.payment_status === 'paid' ? 'paid' : 'pending'}">${o.payment_status === 'paid' ? 'مدفوع' : 'غير مدفوع'}</span></td>
        <td>${o.payment_proof_url ? `
          <img alt="إيصال تحويل الطلب رقم ${o.id}" title="اضغط لفتح الإيصال بالحجم الكامل"
            data-proof-order="${o.id}" data-proof-img="${o.id}"
            style="width:46px;height:46px;object-fit:cover;border-radius:8px;border:1px solid var(--line);cursor:zoom-in"
            data-proof-fallback="1">`
          : `<span class="muted">${['vodafone-cash','instapay'].includes(o.payment_method) ? '⚠️ لا يوجد' : '—'}</span>`}</td>
        <td class="muted">${dateFmt(o.created_at)}</td>
        <td>
          <button class="btn btn-ghost btn-sm" data-view="${o.id}">تفاصيل</button>
          ${o.status === 'pending' ? `<button class="btn btn-primary btn-sm" data-confirm="${o.id}">تأكيد</button>` : ''}
        </td>
      </tr>`).join('') : '<tr><td colspan="10" class="empty">لا توجد طلبات مطابقة</td></tr>';

    // (أمان) رابط الإيصال بيتحط عبر setAttribute مباشرة بدل تضمينه في سلسلة innerHTML.
    $$('[data-proof-img]').forEach((img) => {
      const order = data.orders.find((o) => o.id === Number(img.dataset.proofImg));
      if (order && order.payment_proof_url) {
        img.setAttribute('src', safeImage(order.payment_proof_url));
        img.dataset.proof = order.payment_proof_url;
      }
    });
    // (CSP) بدل onerror inline: بنربط بديل التحميل الفاشل بالـ JS مباشرة.
    $$('[data-proof]').forEach((img) => {
      img.onclick = () => openProofViewer(img.dataset.proof, img.dataset.proofOrder);
      if (img.dataset.proofFallback) {
        img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'تعذر تحميل الإيصال' }));
      }
    });
    $$('[data-view]').forEach((btn) => btn.onclick = () => viewOrder(Number(btn.dataset.view), data.orders));
    $$('[data-confirm]').forEach((btn) => btn.onclick = () => confirmOrder(Number(btn.dataset.confirm)));
  } catch (error) {
    toast(error.message || 'تعذر تحميل الطلبات', 'err');
  }
}
['orderSearch', 'orderStatus', 'orderPayment', 'orderFrom', 'orderTo'].forEach((id) => {
  $(`#${id}`).addEventListener('input', () => { ordersPage = 1; loadOrders(); });
});
$('#prevPage').onclick = () => { if (ordersPage > 1) { ordersPage -= 1; loadOrders(); } };
$('#nextPage').onclick = () => { ordersPage += 1; loadOrders(); };

const PAYMENT_LABELS = {
  'cash-on-delivery': 'الدفع عند الاستلام',
  'vodafone-cash': 'فودافون كاش',
  'instapay': 'إنستاباي',
  'whatsapp': 'تأكيد عبر واتساب'
};
const paymentLabel = (m) => PAYMENT_LABELS[m] || m || 'غير محدد';

function viewOrder(id, orders) {
  const order = orders.find((o) => o.id === id);
  if (!order) return;
  const items = order.items.map((item) => `<tr><td>${esc(item.name)}</td><td class="mono">${item.quantity}</td><td class="mono">${money(item.price * item.quantity)}</td></tr>`).join('');
  const timeline = (order.history || []).map((h) => `<div class="list-item"><span>${statusChip(h.status)}</span><span class="muted" style="flex:1">${esc(h.note || '')}</span><span class="muted">${dateFmt(h.at)}</span></div>`).join('');
  openModal(`تفاصيل الطلب #${order.id}`, `
    <p><strong>${esc(order.customer_name)}</strong> · <span class="mono">${esc(order.customer_phone)}</span></p>
    <p class="muted" style="margin-bottom:12px">${esc(order.customer_address) || 'بدون عنوان'}</p>
    ${order.notes ? `<p class="muted">ملاحظات العميل: ${esc(order.notes)}</p>` : ''}
    <p class="muted">طريقة الدفع: <strong>${esc(paymentLabel(order.payment_method))}</strong></p>
    ${order.payment_proof_url ? `
      <div style="margin:10px 0;padding:10px;border:1px dashed var(--line);border-radius:10px">
        <div style="font-weight:700;margin-bottom:8px">إيصال التحويل المرفوع من العميل</div>
        <div class="muted" style="font-size:13px;margin-bottom:8px">رقم عملية التحويل: <strong class="mono">${order.transfer_ref ? esc(order.transfer_ref) : 'غير مسجّل'}</strong> — طابقه مع كشف المحفظة قبل ما تأكد الدفع.</div>
        <img src="${safeImage(order.payment_proof_url)}" alt="إيصال تحويل الطلب رقم ${order.id}"
          data-proof="${esc(order.payment_proof_url)}" data-proof-order="${order.id}"
          style="max-width:260px;width:100%;border-radius:8px;border:1px solid var(--line);cursor:zoom-in">
        <div class="muted" style="font-size:12.5px;margin-top:6px">اضغط على الصورة لفتحها بالحجم الكامل قبل تأكيد الدفع.</div>
      </div>` : (['vodafone-cash','instapay'].includes(order.payment_method) ? '<p class="muted">⚠️ لا يوجد إيصال مرفق لهذا الطلب.</p>' : '')}
    <div class="table-wrap"><table><thead><tr><th>المنتج</th><th>الكمية</th><th>الإجمالي</th></tr></thead><tbody>${items}</tbody></table></div>
    <div style="margin:14px 0;font-size:14px">
      <div>المجموع: <strong class="mono">${money(order.subtotal)}</strong></div>
      ${order.discount ? `<div>الخصم: <strong class="mono">- ${money(order.discount)}</strong> ${order.coupon_code ? `(${esc(order.coupon_code)})` : ''}</div>` : ''}
      <div>الشحن: <strong class="mono">${order.shipping_fee ? money(order.shipping_fee) : 'مجاني'}</strong></div>
      <div style="font-size:17px;margin-top:6px">الإجمالي: <strong class="mono">${money(order.total_amount)}</strong></div>
    </div>
    <div class="section-title">مسار الطلب</div>${timeline}
    <div class="row" style="margin-top:14px">
      <div class="field"><label>حالة الطلب</label><select name="status">${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}" ${order.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>حالة الدفع</label><select name="paymentStatus">
        <option value="pending" ${order.payment_status === 'pending' ? 'selected' : ''}>غير مدفوع</option>
        <option value="paid" ${order.payment_status === 'paid' ? 'selected' : ''}>مدفوع</option>
        <option value="refunded" ${order.payment_status === 'refunded' ? 'selected' : ''}>مسترجع</option>
      </select></div>
    </div>
    <a class="btn btn-ghost btn-sm" href="/invoice/${order.id}" target="_blank">🧾 عرض الفاتورة</a>
  `, async (values) => {
    await api(`/api/admin/orders/${order.id}`, { method: 'PUT', body: values });
    toast('تم تحديث الطلب');
    loadOrders();
  });
}

function confirmOrder(id) {
  openModal(`تأكيد الطلب #${id}`, `
    <p class="muted" style="margin-bottom:12px">سيصل العميل إشعار تأكيد فورًا، ويمكنك جدولة إشعار "طلبك في الطريق" بعد عدد من الدقائق.</p>
    <div class="field"><label>إرسال إشعار "في الطريق" بعد (دقيقة)</label><input name="notifyMinutes" type="number" min="0" max="1440" value="30"></div>
    <div class="field"><label>نص الإشعار (اختياري)</label><input name="notifyMessage" maxlength="300" placeholder="طلبك خرج من المحطة وفي الطريق إليك"></div>
  `, async (values) => {
    await api(`/api/admin/orders/${id}/confirm`, { method: 'POST', body: values });
    toast('تم تأكيد الطلب وجدولة الإشعار');
    loadOrders();
  });
}

/* ============================ المنتجات ============================ */
let PRODUCTS = [];
async function loadProducts() {
  try {
    const data = await api('/api/admin/products');
    PRODUCTS = data.products;
    const categories = [...new Set(PRODUCTS.map((p) => p.category))];
    const filter = $('#productCategoryFilter');
    filter.innerHTML = `<option value="all">كل الأقسام</option>${categories.map((c) => `<option>${esc(c)}</option>`).join('')}`;
    renderProducts();
  } catch (error) {
    toast(error.message || 'تعذر تحميل المنتجات', 'err');
  }
}
function renderProducts() {
  const q = $('#productSearch').value.trim().toLowerCase();
  const category = $('#productCategoryFilter').value;
  const list = PRODUCTS.filter((p) => (category === 'all' || p.category === category)
    && (!q || `${p.name} ${p.category} ${p.sku}`.toLowerCase().includes(q)));
  $('#productsBody').innerHTML = list.length ? list.map((p) => `
    <tr>
      <td><img class="thumb" width="44" height="44" loading="lazy" alt="" data-img-id="${p.id}"></td>
      <td>${esc(p.name)}<br><small class="muted mono">${esc(p.sku || '')}</small></td>
      <td>${esc(p.category)}</td>
      <td class="mono">${money(p.price)}${p.old_price ? `<br><small class="muted"><del>${money(p.old_price)}</del></small>` : ''}</td>
      <td class="mono" style="color:${p.stock === 0 ? 'var(--red)' : p.stock <= 5 ? 'var(--accent)' : 'inherit'}">${p.stock}</td>
      <td class="mono">${Number(p.sold || 0)}</td>
      <td>${p.rating ? `⭐ ${Number(p.rating)} (${Number(p.reviews_count || 0)})` : '—'}</td>
      <td><span class="chip ${p.active ? 'done' : 'cancelled'}">${p.active ? 'نشط' : 'مخفي'}</span></td>
      <td>
        <button class="btn btn-ghost btn-sm" data-edit="${p.id}">تعديل</button>
        <button class="btn btn-danger btn-sm" data-del="${p.id}">حذف</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="9" class="empty">لا توجد منتجات مطابقة</td></tr>';
  // (أمان) رابط صورة المنتج بيتحط عبر setAttribute بدل تضمينه جوّه سلسلة innerHTML.
  $('#productsBody').querySelectorAll('img[data-img-id]').forEach((img) => {
    const p = list.find((x) => x.id === Number(img.dataset.imgId));
    if (p) img.setAttribute('src', safeImage(p.image_url));
  });
  $$('[data-edit]').forEach((btn) => btn.onclick = () => productForm(PRODUCTS.find((p) => p.id === Number(btn.dataset.edit))));
  $$('[data-del]').forEach((btn) => btn.onclick = async () => {
    if (!confirm('تأكيد حذف المنتج؟')) return;
    try { await api(`/api/admin/products/${btn.dataset.del}`, { method: 'DELETE' }); toast('تم حذف المنتج'); loadProducts(); }
    catch (error) { toast(error.message || 'تعذر حذف المنتج', 'err'); }
  });
}
$('#productSearch').oninput = renderProducts;
$('#productCategoryFilter').onchange = renderProducts;
$('#addProductBtn').onclick = () => productForm(null);

function productForm(product) {
  const p = product || {};
  openModal(product ? `تعديل: ${p.name}` : 'منتج جديد', `
    <div class="row">
      <div class="field"><label>اسم المنتج</label><input name="name" required value="${esc(p.name || '')}"></div>
      <div class="field"><label>القسم</label><input name="category" required value="${esc(p.category || '')}" list="catList">
        <datalist id="catList">${[...new Set(PRODUCTS.map((x) => x.category))].map((c) => `<option>${esc(c)}</option>`).join('')}</datalist></div>
    </div>
    <div class="row">
      <div class="field"><label>السعر</label><input name="price" type="number" min="0" step="0.01" required value="${p.price ?? ''}"></div>
      <div class="field"><label>السعر قبل الخصم</label><input name="oldPrice" type="number" min="0" value="${p.old_price ?? ''}"></div>
      <div class="field"><label>المخزون</label><input name="stock" type="number" min="0" value="${p.stock ?? 0}"></div>
    </div>
    <div class="row">
      <div class="field"><label>الكود SKU</label><input name="sku" value="${esc(p.sku || '')}"></div>
      <div class="field"><label>الوسم</label><input name="tag" value="${esc(p.tag || '')}" placeholder="عرض / جديد"></div>
    </div>
    <div class="field"><label>صورة المنتج</label>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <img id="imgPreview" src="${esc(p.image_url || '')}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid #ddd;${p.image_url ? '' : 'display:none;'}">
        <input type="file" id="productImageFile" accept="image/png,image/jpeg,image/webp">
        <span id="uploadStatus" style="font-size:13px;color:#888"></span>
      </div>
      <input name="imageUrl" id="productImageUrl" value="${esc(p.image_url || '')}" placeholder="ارفع صورة من جهازك، أو الصق رابط صورة (يبدأ بـ https:// أو /uploads/)">
      <small style="color:#888;font-size:12px">مسموح فقط بروابط تبدأ بـ https:// أو http:// أو مسار داخلي مثل /uploads/products/img.jpg</small>
    </div>
    <div class="field"><label>الوصف</label><textarea name="description" rows="3">${esc(p.description || '')}</textarea></div>
    <div class="row">
      <div class="field"><label>الحالة</label><select name="active"><option value="1" ${p.active !== 0 ? 'selected' : ''}>نشط</option><option value="0" ${p.active === 0 ? 'selected' : ''}>مخفي</option></select></div>
      <div class="field"><label>مميز في الصفحة الرئيسية</label><select name="featured"><option value="0" ${!p.featured ? 'selected' : ''}>لا</option><option value="1" ${p.featured ? 'selected' : ''}>نعم</option></select></div>
    </div>
  `, async (values) => {
    values.active = Number(values.active);
    values.featured = Number(values.featured);
    // (أمان) تحقق من شكل رابط الصورة قبل الإرسال — نفس التحقق بيتعاد على السيرفر.
    const imageValue = String(values.imageUrl || '').trim();
    if (imageValue && !isValidImageUrl(imageValue)) {
      toast('رابط الصورة غير صالح. لازم يبدأ بـ https:// أو http:// أو / ومن غير مسافات أو علامات تنصيص.', 'err');
      return;
    }
    values.imageUrl = imageValue;
    if (product) await api(`/api/admin/products/${product.id}`, { method: 'PUT', body: values });
    else await api('/api/admin/products', { method: 'POST', body: values });
    toast(product ? 'تم تحديث المنتج' : 'تمت إضافة المنتج');
    loadProducts();
  });
  $('#productImageFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = $('#uploadStatus');
    statusEl.textContent = 'جارٍ ضغط الصورة...';
    statusEl.style.color = '#888';
    try {
      const optimized = await compressImage(file);
      statusEl.textContent = 'جارٍ رفع الصورة...';
      const fd = new FormData();
      fd.append('image', optimized, optimized.name);
      const res = await fetch('/api/admin/upload-image', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) { window.location.href = '/admin-login.html'; return; }
      if (!res.ok) throw new Error(data.error || 'تعذر رفع الصورة');
      $('#productImageUrl').value = data.url;
      $('#imgPreview').src = data.url;
      $('#imgPreview').style.display = '';
      statusEl.textContent = 'تم رفع الصورة بنجاح ✅';
    } catch (error) {
      statusEl.textContent = `خطأ: ${error.message}`;
      statusEl.style.color = '#e05252';
    }
  };
}

/* ============================ المخزون ============================ */
async function loadInventory() {
  try {
    const { products } = await api('/api/admin/products');
    const totalValue = products.reduce((sum, p) => sum + p.price * p.stock, 0);
    const outOfStock = products.filter((p) => p.stock === 0).length;
    const low = products.filter((p) => p.stock > 0 && p.stock <= (SETTINGS.lowStockThreshold || 5)).length;
    $('#inventoryKpis').innerHTML = [
      ['قيمة المخزون', money(totalValue), '', 'accent'],
      ['نفد من المخزون', outOfStock, 'منتج', 'red'],
      ['مخزون منخفض', low, 'منتج', ''],
      ['إجمالي القطع', products.reduce((s, p) => s + p.stock, 0), 'قطعة', 'blue']
    ].map(([label, value, hint, tone]) => `<div class="card kpi ${tone}"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`).join('');

    $('#inventoryBody').innerHTML = products.sort((a, b) => a.stock - b.stock).map((p) => `
      <tr>
        <td>${esc(p.name)}</td>
        <td class="mono" style="color:${p.stock === 0 ? 'var(--red)' : 'inherit'}">${p.stock}</td>
        <td class="mono">${money(p.price * p.stock)}</td>
        <td>
          <button class="btn btn-ghost btn-sm" data-stock="${p.id}" data-delta="-1">−1</button>
          <button class="btn btn-ghost btn-sm" data-stock="${p.id}" data-delta="1">+1</button>
          <button class="btn btn-ghost btn-sm" data-stock="${p.id}" data-delta="10">+10</button>
        </td>
      </tr>`).join('');
    $$('[data-stock]').forEach((btn) => btn.onclick = async () => {
      try { await api(`/api/admin/products/${btn.dataset.stock}/stock`, { method: 'POST', body: { delta: Number(btn.dataset.delta) } }); loadInventory(); }
      catch (error) { toast(error.message || 'تعذر تحديث المخزون', 'err'); }
    });
  } catch (error) {
    toast(error.message || 'تعذر تحميل المخزون', 'err');
  }
}

/* ============================ الكوبونات ============================ */
async function loadCoupons() {
  try {
    const { coupons } = await api('/api/admin/coupons');
    $('#couponsBody').innerHTML = coupons.length ? coupons.map((c) => `
      <tr>
        <td class="mono"><strong>${esc(c.code)}</strong></td>
        <td>${c.type === 'percent' ? 'نسبة' : 'مبلغ'}</td>
        <td class="mono">${c.type === 'percent' ? `${Number(c.value)}%` : money(c.value)}</td>
        <td class="mono">${c.min_total ? money(c.min_total) : '—'}</td>
        <td class="mono">${Number(c.used || 0)}${c.max_uses ? ` / ${Number(c.max_uses)}` : ''}</td>
        <td><span class="chip ${c.active ? 'done' : 'cancelled'}">${c.active ? 'نشط' : 'موقوف'}</span></td>
        <td>
          <button class="btn btn-ghost btn-sm" data-toggle-coupon="${c.id}" data-active="${c.active ? 0 : 1}">${c.active ? 'إيقاف' : 'تفعيل'}</button>
          <button class="btn btn-danger btn-sm" data-del-coupon="${c.id}">حذف</button>
        </td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty">لا توجد كوبونات</td></tr>';
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
$('#couponForm').onsubmit = async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(new FormData(e.target).entries());
  try {
    await api('/api/admin/coupons', { method: 'POST', body: values });
    toast('تمت إضافة الكوبون'); e.target.reset(); loadCoupons();
  } catch (error) { toast(error.message, 'err'); }
};

/* ============================ التقييمات ============================ */
async function loadReviews() {
  try {
    const { reviews } = await api('/api/admin/reviews');
    $('#reviewsBody').innerHTML = reviews.length ? reviews.map((r) => `
      <tr>
        <td>${esc(r.product_name)}</td>
        <td>${esc(r.user_name)}</td>
        <td>${esc('⭐'.repeat(Math.max(0, Math.min(5, Number(r.rating) || 0))))}</td>
        <td style="white-space:normal;max-width:320px">${esc(r.comment || '—')}</td>
        <td class="muted">${dateFmt(r.created_at)}</td>
        <td><button class="btn btn-danger btn-sm" data-del-review="${r.id}">حذف</button></td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty">لا توجد تقييمات بعد</td></tr>';
    $$('[data-del-review]').forEach((btn) => btn.onclick = async () => {
      try { await api(`/api/admin/reviews/${btn.dataset.delReview}`, { method: 'DELETE' }); toast('تم حذف التقييم'); loadReviews(); }
      catch (error) { toast(error.message || 'تعذر حذف التقييم', 'err'); }
    });
  } catch (error) {
    toast(error.message || 'تعذر تحميل التقييمات', 'err');
  }
}

/* ============================ إشعار جماعي ============================ */
$('#broadcastForm').onsubmit = async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(new FormData(e.target).entries());
  try {
    const data = await api('/api/admin/broadcast', { method: 'POST', body: values });
    toast(`تم إرسال الإشعار إلى ${data.sent} عميل`);
    e.target.reset();
  } catch (error) { toast(error.message, 'err'); }
};

/* ============================ المستخدمون ============================ */
let USERS = [];
async function loadUsers() {
  try {
    const { users } = await api('/api/admin/users');
    USERS = users;
    renderUsers();
  } catch (error) {
    toast(error.message || 'تعذر تحميل المستخدمين', 'err');
  }
}
function renderUsers() {
  const q = $('#userSearch').value.trim().toLowerCase();
  const list = USERS.filter((u) => !q || `${u.name} ${u.email}`.toLowerCase().includes(q));
  $('#usersBody').innerHTML = list.map((u) => `
    <tr>
      <td class="mono">#${u.id}</td>
      <td>${esc(u.name)}</td>
      <td class="mono">${esc(u.email)}</td>
      <td class="mono">${esc(u.phone || '—')}</td>
      <td><span class="chip ${u.role === 'admin' ? 'confirmed' : 'done'}">${u.role === 'admin' ? 'مسؤول' : 'عميل'}</span></td>
      <td class="mono">${Number(u.orders_count || 0)}</td>
      <td class="mono">${money(u.total_spent)}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-edit-user="${u.id}">تعديل</button>
        <button class="btn btn-danger btn-sm" data-del-user="${u.id}">حذف</button>
      </td>
    </tr>`).join('');
  $$('[data-edit-user]').forEach((btn) => btn.onclick = () => userForm(USERS.find((u) => u.id === Number(btn.dataset.editUser))));
  $$('[data-del-user]').forEach((btn) => btn.onclick = async () => {
    if (!confirm('حذف المستخدم نهائيًا؟')) return;
    try { await api(`/api/admin/users/${btn.dataset.delUser}`, { method: 'DELETE' }); toast('تم الحذف'); loadUsers(); }
    catch (error) { toast(error.message, 'err'); }
  });
}
$('#userSearch').oninput = renderUsers;
$('#addUserBtn').onclick = () => userForm(null);

function userForm(user) {
  const u = user || {};
  openModal(user ? `تعديل: ${u.name}` : 'مستخدم جديد', `
    <div class="field"><label>الاسم</label><input name="name" required value="${esc(u.name || '')}"></div>
    <div class="field"><label>البريد الإلكتروني</label><input name="email" type="email" required value="${esc(u.email || '')}"></div>
    <div class="field"><label>الهاتف</label><input name="phone" value="${esc(u.phone || '')}"></div>
    <div class="field"><label>${user ? 'كلمة مرور جديدة (اختياري)' : 'كلمة المرور'}</label><input name="password" type="password" ${user ? '' : 'required'} minlength="8"></div>
    <div class="field"><label>الصلاحية</label><select name="role">
      <option value="customer" ${u.role !== 'admin' ? 'selected' : ''}>عميل</option>
      <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>مسؤول</option></select></div>
  `, async (values) => {
    if (!values.password) delete values.password;
    if (user) await api(`/api/admin/users/${user.id}`, { method: 'PUT', body: values });
    else await api('/api/admin/users', { method: 'POST', body: values });
    toast('تم الحفظ'); loadUsers();
  });
}

/* ============================ سجل النشاط ============================ */
async function loadActivity() {
  try {
    const { activity } = await api('/api/admin/activity');
    $('#activityList').innerHTML = activity.length ? activity.map((a) => `
      <div class="list-item"><strong style="min-width:150px">${esc(a.action)}</strong>
      <span class="muted" style="flex:1">${esc(a.details)}</span>
      <span>${esc(a.user_name)}</span><span class="muted">${dateFmt(a.created_at)}</span></div>`).join('')
      : '<div class="empty">لا يوجد نشاط مسجل</div>';
  } catch (error) {
    toast(error.message || 'تعذر تحميل سجل النشاط', 'err');
  }
}

/* ============================ الإعدادات ============================ */
async function loadSettings() {
  const { settings } = await api('/api/site/settings');
  SETTINGS = settings;
  const form = $('#settingsForm');
  Object.entries(settings).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value;
  });
}
$('#settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(new FormData(e.target).entries());
  try { const data = await api('/api/site/settings', { method: 'PUT', body: values }); SETTINGS = data.settings; toast('تم حفظ الإعدادات'); }
  catch (error) { toast(error.message, 'err'); }
};
$('#passwordForm').onsubmit = async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(new FormData(e.target).entries());
  try { await api('/api/auth/change-password', { method: 'POST', body: values }); toast('تم تغيير كلمة المرور'); e.target.reset(); $('#passwordWarning').classList.add('hidden'); }
  catch (error) { toast(error.message, 'err'); }
};
/* (تعديل) التحقق بخطوتين اتلغى تمامًا من لوحة التحكم. */

$('#backupBtn').onclick = async () => { await api('/api/admin/backup', { method: 'POST' }); toast('تم إنشاء نسخة احتياطية'); };
$('#logoutAllBtn').onclick = async () => {
  if (!confirm('هيتم تسجيل الخروج من كل الأجهزة التانية غير الجهاز ده. تكمل؟')) return;
  await api('/api/auth/logout-all-devices', { method: 'POST' });
  toast('تم تسجيل الخروج من كل الأجهزة الأخرى');
};

/* ============================ الإقلاع ============================ */
const LOADERS = {
  overview: loadOverview, orders: loadOrders, products: loadProducts, inventory: loadInventory,
  coupons: loadCoupons, reviews: loadReviews, users: loadUsers, activity: loadActivity,
  settings: async () => { await loadSettings(); }
};

(async function boot() {
  try {
    const me = await api('/api/auth/me');
    if (!me.loggedIn || me.user.role !== 'admin') { window.location.href = '/admin-login.html'; return; }
    if (me.mustChangePassword) $('#passwordWarning').classList.remove('hidden');
    await loadSettings();
    go(location.hash.slice(1) || 'overview');
    setInterval(() => { if (!document.hidden && (location.hash.slice(1) || 'overview') === 'overview') loadOverview(); }, 60000);
  } catch (error) {
    console.error(error);
  }
})();


/* ==========================================================================
 * (إصلاح 8) ضغط الصور قبل الرفع: تصغير لأقصى 1600px وتحويل لـ WebP في
 * المتصفح نفسه. النتيجة صفحات أخف بكتير بدل صور 5 ميجا كما هي.
 * ========================================================================== */
/* ============ عارض إيصالات التحويل (Lightbox) ============
 * قبل كده الإيصال كان بيتفتح في تاب جديد على مسار /api/... فأحيانًا كان
 * بيبان كملف تنزيل أو رسالة JSON. دلوقتي بيتفتح جوه اللوحة بضغطة واحدة
 * على الصورة اللي جمب كل عميل، مع زر تنزيل وفتح في تاب.
 */
function openProofViewer(url, orderId) {
  if (!url) return;
  // (إصلاح أمني) الرابط بيعدي على نفس فلتر البروتوكول المستخدم في باقي اللوحة،
  // فمستحيل رابط javascript: يتنفّذ في جلسة الأدمن.
  const safeUrl = window.YousefUI.safeImageUrl(url);
  if (!safeUrl) return;
  const lastFocused = document.activeElement;
  document.getElementById('proofViewer')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'proofViewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'إيصال التحويل');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999;display:flex;align-items:center;justify-content:center;padding:18px';
  overlay.innerHTML = `
    <div style="max-width:min(92vw,640px);width:100%;display:flex;flex-direction:column;gap:10px" data-proof-box>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;color:#fff;font-weight:700">
        <span>إيصال تحويل الطلب #${Number(orderId)}</span>
        <button type="button" data-proof-close class="btn btn-ghost btn-sm">✕ إغلاق</button>
      </div>
      <img src="${esc(safeUrl)}" alt="إيصال تحويل الطلب" style="width:100%;max-height:74vh;object-fit:contain;border-radius:12px;background:#fff">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn btn-primary btn-sm" href="${esc(safeUrl)}" download="proof-${esc(Number(orderId) || 'order')}.jpg">⬇️ تنزيل</a>
        <a class="btn btn-ghost btn-sm" href="${esc(safeUrl)}" target="_blank" rel="noopener">↗️ فتح في تاب جديد</a>
      </div>
    </div>`;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    // (إصلاح وصولية) رجوع التركيز لمكانه بعد غلق العارض.
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => { if (!e.target.closest('[data-proof-box]') || e.target.closest('[data-proof-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  overlay.querySelector('[data-proof-close]')?.focus();
}
document.addEventListener('click', (e) => {
  const img = e.target.closest('#modalBody [data-proof], .modal [data-proof]');
  if (img) openProofViewer(img.dataset.proof, img.dataset.proofOrder);
});

async function compressImage(file, maxDim = 1600, quality = 0.82) {
  if (!file || !file.type.startsWith('image/')) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, '') + '.webp';
    return new File([blob], name, { type: 'image/webp' });
  } catch (_) {
    return file;
  }
}

/* ==========================================================================
 * (إصلاح 4) التحقق بخطوتين لحساب المسؤول — إعداد/تفعيل/إيقاف.
 * ========================================================================== */
async function load2faStatus() {
  const box = document.querySelector('#twoFactorBox');
  if (!box) return;
  const res = await fetch('/api/auth/2fa/status');
  const data = await res.json().catch(() => ({}));
  box.dataset.enabled = data.enabled ? '1' : '0';
  const label = box.querySelector('#twoFactorState');
  if (label) label.textContent = data.enabled ? 'مفعّل ✅' : 'غير مفعّل';
}

async function start2faSetup() {
  const res = await fetch('/api/auth/2fa/setup', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || 'تعذر بدء الإعداد'); return null; }
  return data;
}

async function confirm2fa(code) {
  const res = await fetch('/api/auth/2fa/enable', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
  });
  const data = await res.json().catch(() => ({}));
  toast(res.ok ? 'تم تفعيل التحقق بخطوتين' : (data.error || 'الكود غير صحيح'));
  if (res.ok) load2faStatus();
  return res.ok;
}

async function disable2fa(password, code) {
  const res = await fetch('/api/auth/2fa/disable', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, code })
  });
  const data = await res.json().catch(() => ({}));
  toast(res.ok ? 'تم إيقاف التحقق بخطوتين' : (data.error || 'تعذر الإيقاف'));
  if (res.ok) load2faStatus();
  return res.ok;
}

window.twoFactor = { load: load2faStatus, setup: start2faSetup, confirm: confirm2fa, disable: disable2fa };
