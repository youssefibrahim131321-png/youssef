/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, $$, esc, safeImageUrl, api, toast, money, dateFmt, openModal, html, setHTML, trustedHtml } from './core.js';
import { statusChip, STATUS_LABELS, paymentLabel } from './labels.js';
import { openProofViewer } from './proof-viewer.js';

let ordersPage = 1;
// (أداء) بنخزّن الـ cursor (آخر id) بتاع كل صفحة زُرناها، عشان "التالي" و
// "السابق" يستخدموا keyset pagination بدل OFFSET. orderCursors[i] هو الـ
// cursor المطلوب لجلب الصفحة رقم i+1؛ orderCursors[0] دايمًا null (الصفحة
// الأولى). لما الفلاتر تتغيّر بنصفّر المصفوفة دي عشان نرجع للصفحة الأولى.
let orderCursors = [null];

export async function loadOrders() {
  try {
    const cursor = orderCursors[ordersPage - 1];
    const params = new URLSearchParams({
      perPage: 20,
      status: $('#orderStatus').value,
      payment: $('#orderPayment').value,
      q: $('#orderSearch').value.trim(),
      from: $('#orderFrom').value,
      to: $('#orderTo').value
    });
    if (cursor !== null && cursor !== undefined) params.set('cursor', cursor);
    const data = await api(`/api/admin/orders?${params}`);
    // بنسجّل الـ cursor بتاع الصفحة اللي بعد دي (لو موجودة) عشان "التالي" ما يعملش OFFSET.
    if (data.nextCursor !== null && data.nextCursor !== undefined) orderCursors[ordersPage] = data.nextCursor;
    const hasNext = ordersPage < data.pages;
    $('#prevPage').disabled = ordersPage <= 1;
    $('#nextPage').disabled = !hasNext;
    $('#pageInfo').textContent = `${ordersPage} / ${data.pages} (${data.total} طلب)`;
    const summary = document.getElementById('ordersQuickSummary');
    if (summary) {
      summary.textContent = '';
      const parts = [
        ['إجمالي النتائج', data.total],
        ['قيد الانتظار بهذه الصفحة', data.orders.filter(o => o.status === 'pending').length],
        ['مدفوع بهذه الصفحة', data.orders.filter(o => o.payment_status === 'paid').length]
      ];
      parts.forEach(([label, value]) => {
        const span = document.createElement('span');
        const strong = document.createElement('b');
        strong.textContent = String(value);
        span.append(strong, ` ${label}`);
        summary.appendChild(span);
      });
    }
    setHTML($('#ordersBody'), data.orders.length ? data.orders.map((o) => html`
      <tr>
        <td class="mono">#${o.id}</td>
        <td>${o.customer_name}</td>
        <td class="mono">${o.customer_phone}</td>
        <td>${o.items.length} صنف</td>
        <td class="mono">${money(o.total_amount)}${o.discount ? html`<br><small class="muted">خصم ${money(o.discount)}</small>` : ''}</td>
        <td>${statusChip(o.status)}</td>
        <td><span class="chip ${o.payment_status === 'paid' ? 'paid' : 'pending'}">${o.payment_status === 'paid' ? 'مدفوع' : 'غير مدفوع'}</span></td>
        <td>${o.payment_proof_url ? html`
          <img alt="إيصال تحويل الطلب رقم ${o.id}" title="اضغط لفتح الإيصال بالحجم الكامل"
            data-proof-order="${o.id}" data-proof-img="${o.id}"
            class="proof-thumb" width="48" height="48" loading="lazy" decoding="async"
            data-proof-fallback="1">`
          : html`<span class="muted">${['vodafone-cash','instapay'].includes(o.payment_method) ? '⚠️ لا يوجد' : '—'}</span>`}</td>
        <td class="muted">${dateFmt(o.created_at)}</td>
        <td>
          <button class="btn btn-ghost btn-sm" data-view="${o.id}">تفاصيل</button>
          ${o.status === 'pending' ? html`<button class="btn btn-primary btn-sm" data-confirm="${o.id}">تأكيد</button>` : ''}
        </td>
      </tr>`) : trustedHtml('<tr><td colspan="10" class="empty">لا توجد طلبات مطابقة</td></tr>'));

    // (أمان) رابط الإيصال بيتحط عبر setAttribute مباشرة بدل تضمينه في سلسلة innerHTML.
    $$('[data-proof-img]').forEach((img) => {
      const order = data.orders.find((o) => o.id === Number(img.dataset.proofImg));
      if (order && order.payment_proof_url) {
        img.setAttribute('src', safeImageUrl(order.payment_proof_url));
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

// (أداء) البحث بالنص بيعمل LIKE '%...%' في قاعدة البيانات (مش قابل لاستخدام
// index)، فتشغيله مع كل حرف يتكتب كان بيبعت request جديد كل حرف — مع نمو
// جدول الطلبات ده حمل غير لازم. الـ debounce بيستنى المستخدم يوقف عن الكتابة
// شوية قبل ما يبعت. حقول الاختيار (status/payment) خفيفة ومفلترة بـ index،
// فسيبناها فورية.
function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
const debouncedLoadOrders = debounce(() => loadOrders(), 350);

function resetOrdersPaging() { ordersPage = 1; orderCursors = [null]; }

export function wireOrders() {
  ['orderSearch','orderStatus','orderPayment','orderFrom','orderTo'].forEach((id) => {
    const value = localStorage.getItem('adminOrderFilter:' + id);
    if (value !== null && $(`#${id}`)) $(`#${id}`).value = value;
  });
['orderStatus', 'orderPayment'].forEach((id) => {
  $(`#${id}`).addEventListener('input', () => { localStorage.setItem('adminOrderFilter:' + id, $(`#${id}`).value); resetOrdersPaging(); loadOrders(); });
});
['orderSearch', 'orderFrom', 'orderTo'].forEach((id) => {
  $(`#${id}`).addEventListener('input', () => { localStorage.setItem('adminOrderFilter:' + id, $(`#${id}`).value); resetOrdersPaging(); debouncedLoadOrders(); });
});
$('#prevPage').onclick = () => { if (ordersPage > 1) { ordersPage -= 1; loadOrders(); } };
$('#nextPage').onclick = () => { ordersPage += 1; loadOrders(); };
}

export function viewOrder(id, orders) {
  const order = orders.find((o) => o.id === id);
  if (!order) return;
  const items = order.items.map((item) => html`<tr><td>${item.name}</td><td class="mono">${item.quantity}</td><td class="mono">${money(item.price * item.quantity)}</td></tr>`);
  const timeline = (order.history || []).map((h) => html`<div class="list-item"><span>${statusChip(h.status)}</span><span class="muted" style="flex:1">${h.note || ''}</span><span class="muted">${dateFmt(h.at)}</span></div>`);
  openModal(`تفاصيل الطلب #${order.id}`, html`
    <p><strong>${order.customer_name}</strong> · <span class="mono">${order.customer_phone}</span></p>
    <p class="muted" style="margin-bottom:12px">${order.customer_address || 'بدون عنوان'}</p>
    ${order.notes ? html`<p class="muted">ملاحظات العميل: ${order.notes}</p>` : ''}
    <p class="muted">طريقة الدفع: <strong>${paymentLabel(order.payment_method)}</strong></p>
    ${order.payment_proof_url ? html`
      <div style="margin:10px 0;padding:10px;border:1px dashed var(--line);border-radius:10px">
        <div style="font-weight:700;margin-bottom:8px">إيصال التحويل المرفوع من العميل</div>
        <div class="muted" style="font-size:13px;margin-bottom:8px">رقم عملية التحويل: <strong class="mono">${order.transfer_ref ? order.transfer_ref : 'غير مسجّل'}</strong> — طابقه مع كشف المحفظة قبل ما تأكد الدفع.</div>
        <img src="${safeImageUrl(order.payment_proof_url)}" alt="إيصال تحويل الطلب رقم ${order.id}"
          data-proof="${order.payment_proof_url}" data-proof-order="${order.id}"
          class="proof-detail-thumb" width="72" height="72" loading="lazy" decoding="async">
        <div class="muted" style="font-size:12.5px;margin-top:6px">اضغط على الصورة لفتحها بالحجم الكامل قبل تأكيد الدفع.</div>
      </div>` : (['vodafone-cash','instapay'].includes(order.payment_method) ? html`<p class="muted">⚠️ لا يوجد إيصال مرفق لهذا الطلب.</p>` : '')}
    <div class="table-wrap"><table><thead><tr><th>المنتج</th><th>الكمية</th><th>الإجمالي</th></tr></thead><tbody>${items}</tbody></table></div>
    <div style="margin:14px 0;font-size:14px">
      <div>المجموع: <strong class="mono">${money(order.subtotal)}</strong></div>
      ${order.discount ? html`<div>الخصم: <strong class="mono">- ${money(order.discount)}</strong> ${order.coupon_code ? `(${esc(order.coupon_code)})` : ''}</div>` : ''}
      <div>الشحن: <strong class="mono">${order.shipping_fee ? money(order.shipping_fee) : 'مجاني'}</strong></div>
      <div style="font-size:17px;margin-top:6px">الإجمالي: <strong class="mono">${money(order.total_amount)}</strong></div>
    </div>
    <div class="section-title">مسار الطلب</div>${timeline}
    <div class="row" style="margin-top:14px">
      <div class="field"><label>حالة الطلب</label><select name="status">${Object.entries(STATUS_LABELS).map(([k, v]) => html`<option value="${k}" ${order.status === k ? 'selected' : ''}>${v}</option>`)}</select></div>
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

export function confirmOrder(id) {
  openModal(`تأكيد الطلب #${id}`, html`
    <p class="muted" style="margin-bottom:12px">سيصل العميل إشعار تأكيد فورًا، ويمكنك جدولة إشعار "طلبك في الطريق" بعد عدد من الدقائق.</p>
    <div class="field"><label>إرسال إشعار "في الطريق" بعد (دقيقة)</label><input name="notifyMinutes" type="number" min="0" max="1440" value="30"></div>
    <div class="field"><label>نص الإشعار (اختياري)</label><input name="notifyMessage" maxlength="300" placeholder="طلبك خرج من المحطة وفي الطريق إليك"></div>
  `, async (values) => {
    await api(`/api/admin/orders/${id}/confirm`, { method: 'POST', body: values });
    toast('تم تأكيد الطلب وجدولة الإشعار');
    loadOrders();
  });
}
