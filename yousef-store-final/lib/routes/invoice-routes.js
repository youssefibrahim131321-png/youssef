/**
 * صفحة الفاتورة المطبوعة
 * -------------------------------------------------------------------------
 * موديول اتفصل من server.js عشان الملف ما يبقاش آلاف السطور. كل الاعتماديات
 * (الـ store والحدود والمساعدات) بتتمرّر من server.js في كائن deps واحد،
 * فالسلوك زي ما هو بالحرف بس التنظيم بقى أوضح.
 */
module.exports = function registerInvoiceRoutes(app, deps) {
  const {
    escapeHtml,
    requireAuth,
    store
  } = deps;

  app.get('/invoice/:id', requireAuth, async (req, res) => {
    const order = await store.getOrderById(req.params.id);
    if (!order) return res.status(404).send('الطلب غير موجود');
    const isOwner = order.user_id && order.user_id === req.user.id;
    if (!isOwner && req.user.role !== 'admin') return res.status(403).send('غير مصرح بعرض هذه الفاتورة');
    const settings = await store.getSiteSettings();
    const money = value => `${Number(value || 0).toLocaleString('en-US')} ${settings.currency}`;
    const rows = (order.items || []).map(item => `<tr>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.quantity)}</td>
        <td>${money(item.price)}</td>
        <td>${money(Number(item.price) * Number(item.quantity || 1))}</td>
      </tr>`).join('');
    res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"/>
  <title>فاتورة #${order.id}</title>
  <style>
    body{font-family:Tahoma,Arial,sans-serif;padding:36px;color:#111;background:#fff}
    .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #c8793f;padding-bottom:16px;margin-bottom:22px}
    h1{margin:0;font-size:26px}.muted{color:#666;font-size:13px}
    table{width:100%;border-collapse:collapse;margin-top:18px}
    th,td{border:1px solid #ddd;padding:10px;text-align:right;font-size:14px}
    th{background:#f7f7f7}
    .totals{margin-top:18px;margin-inline-start:auto;width:320px}
    .totals div{display:flex;justify-content:space-between;padding:6px 0;font-size:15px}
    .grand{border-top:2px solid #111;font-weight:800;font-size:19px;margin-top:6px;padding-top:10px}
    .btn{margin-top:26px;padding:10px 20px;background:#c8793f;border:none;border-radius:8px;font-weight:700;cursor:pointer}
    @media print{.btn{display:none}}
  </style></head><body>
  <div class="head">
    <div>
      <h1>${escapeHtml(settings.name)}</h1>
      <div class="muted">${escapeHtml(settings.address)} · ${escapeHtml(settings.phone)}</div>
    </div>
    <div style="text-align:left">
      <h1>فاتورة #${order.id}</h1>
      <div class="muted">${new Date(order.created_at).toLocaleString('ar-EG')}</div>
    </div>
  </div>
  <p><strong>العميل:</strong> ${escapeHtml(order.customer_name)} · ${escapeHtml(order.customer_phone)}</p>
  <p><strong>العنوان:</strong> ${escapeHtml(order.customer_address)}</p>
  <p><strong>طريقة الدفع:</strong> ${escapeHtml(order.payment_method)} · <strong>الحالة:</strong> ${escapeHtml(order.status)}</p>
  <table><thead><tr><th>المنتج</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="totals">
    <div><span>المجموع الفرعي</span><span>${money(order.subtotal)}</span></div>
    ${order.discount ? `<div><span>الخصم${order.coupon_code ? ` (${escapeHtml(order.coupon_code)})` : ''}</span><span>- ${money(order.discount)}</span></div>` : ''}
    <div><span>الشحن</span><span>${order.shipping_fee ? money(order.shipping_fee) : 'مجاني'}</span></div>
    ${order.tax ? `<div><span>الضريبة</span><span>${money(order.tax)}</span></div>` : ''}
    <div class="grand"><span>الإجمالي</span><span>${money(order.total_amount)}</span></div>
  </div>
  <button class="btn" id="printBtn">طباعة الفاتورة</button>
  <script nonce="${res.locals.cspNonce}">document.getElementById('printBtn').addEventListener('click', function(){ window.print(); });</script>
  </body></html>`);
  });
};
