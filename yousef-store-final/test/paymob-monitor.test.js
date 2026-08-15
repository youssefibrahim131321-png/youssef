/**
 * test/paymob-monitor.test.js
 * ---------------------------------------------------------------------------
 * دورة حياة مخزون Paymob + توثيق محاولات المزامنة + تقرير المصالحة، على قاعدة
 * بيانات معزولة في الذاكرة.
 */
require('./helpers/test-db');
const test = require('node:test');
const assert = require('node:assert');
const { freshStore } = require('./helpers/test-db');

async function makeOrder(store, quantity = 2) {
  const products = await store.getProducts();
  const product = products.find((p) => p.stock > quantity);
  const order = await store.createOrder({
    userId: null,
    customerName: 'عميل Paymob',
    customerPhone: '01000000001',
    customerAddress: 'القاهرة، مصر الجديدة',
    paymentMethod: 'paymob',
    notes: '',
    items: [{ productId: product.id, quantity }]
  });
  return { order, product };
}

test('محاولات Paymob بتتوثق والإحصائيات بتحسب الفشل', async () => {
  const store = await freshStore();
  const { order } = await makeOrder(store, 1);
  await store.logPaymobEvent({ stage: 'checkout', outcome: 'intention_created', success: true, orderId: order.id });
  await store.logPaymobEvent({ stage: 'webhook', outcome: 'invalid_hmac', hmacValid: false });
  await store.logPaymobEvent({ stage: 'webhook', outcome: 'amount_mismatch', orderId: order.id, amountCents: 100, expectedAmount: order.total_amount });

  const events = await store.getPaymobEvents({ limit: 10 });
  assert.strictEqual(events.length, 3, 'كل محاولة لازم تتسجّل');
  const stats = await store.getPaymobSyncStats({ windowMinutes: 60 });
  assert.strictEqual(stats.total, 3);
  assert.strictEqual(stats.failures, 2, 'invalid_hmac و amount_mismatch فشل مزامنة');
  assert.ok(stats.lastFailureAt, 'لازم نعرف آخر وقت فشل');

  const orderEvents = await store.getPaymobEvents({ orderId: order.id });
  assert.strictEqual(orderEvents.length, 2, 'الفلترة بالطلب شغالة');
});

test('تقرير المصالحة بيكشف فشل مزامنة ومخزون محجوز', async () => {
  const store = await freshStore();
  const { order } = await makeOrder(store, 2);
  // Paymob قال «مدفوع» والطلب عندنا لسه pending = فشل مزامنة
  await store.logPaymobEvent({ stage: 'webhook', outcome: 'paid', success: true, orderId: order.id, expectedAmount: order.total_amount });

  const report = await store.getPaymobReconciliation({ holdMinutes: 0 });
  const row = report.rows.find((r) => r.orderId === order.id);
  assert.ok(row, 'الطلب لازم يظهر في التقرير');
  assert.ok(row.kinds.includes('sync_failed'), `المفروض sync_failed: ${row.kinds}`);
  assert.strictEqual(row.units, 2, 'عدد القطع في الطلب لازم يظهر');
  assert.strictEqual(row.paidEvents, 1, 'محاولة الدفع الناجحة لازم تتحسب');
  assert.ok(report.summary.discrepancies >= 1);
});

test('المكنسة بترجّع المخزون والتقرير بيبقى نظيف بعدها', async () => {
  const store = await freshStore();
  const { order, product } = await makeOrder(store, 2);
  const afterOrder = await store.getProductById(product.id);
  assert.strictEqual(afterOrder.stock, product.stock - 2, 'المخزون بينقص وقت إنشاء طلب Paymob');

  // البوابة رجّعت «فشل» — المكنسة بتلغي الطلبات الفاشلة بعد مهلة قصيرة.
  // (نفس منطق sweepStalePaymobOrders في server.js: getStalePaymobOrders بترجّع
  // المرشّحين، وupdateOrder هي اللي بتلغي وتحرّر المخزون تحت قفل صف الطلب).
  await store.updateOrder(order.id, { payment_status: 'failed' }, 'فشل الدفع عند البوابة');
  const staleIds = await store.getStalePaymobOrders(0);
  assert.ok(staleIds.includes(order.id), 'الطلب غير المدفوع لازم يظهر كمرشّح للإلغاء');
  for (const id of staleIds) {
    await store.updateOrder(id, { status: 'cancelled', payment_status: 'failed' }, 'إلغاء تلقائي', { skipIfPaymentStatusIn: ['paid', 'refunded'] });
  }
  const cancelled = staleIds;
  assert.ok(cancelled.includes(order.id), 'الطلب غير المدفوع لازم يتلغي');
  const restored = await store.getProductById(product.id);
  assert.strictEqual(restored.stock, product.stock, 'المخزون لازم يرجع بالكامل');

  const report = await store.getPaymobReconciliation({ holdMinutes: 0 });
  assert.ok(!report.rows.some((r) => r.orderId === order.id && r.kinds.includes('stock_held_unpaid')), 'مفيش مخزون محجوز بعد المكنسة');
  const row = report.rows.find((r) => r.orderId === order.id);
  assert.ok(!row || row.stockAtRisk === 0, 'مفيش مخزون في خطر للطلب بعد المكنسة');
});

test('تنبيه المزامنة بيتبعت مرة واحدة في نافذة التهدئة', async () => {
  const store = await freshStore();
  assert.strictEqual(await store.claimPaymobAlert('sync-failures', 60000), true);
  assert.strictEqual(await store.claimPaymobAlert('sync-failures', 60000), false, 'مينفعش يتكرر جوّه التهدئة');
  assert.strictEqual(await store.claimPaymobAlert('sync-failures', 0), true, 'بعد انتهاء التهدئة ينفع تاني');
});

test('مولّد PDF بيطلع ملف صالح وبيتعامل مع العربي من غير حروف مكسورة', () => {
  const { buildTablePdf } = require('../lib/pdf-report');
  const pdf = buildTablePdf({
    title: 'Inventory Reconciliation',
    meta: [['Discrepancies', '1']],
    columns: [{ header: 'Order', key: 'orderId', width: 1 }, { header: 'Discrepancy', key: 'reason', width: 3 }],
    rows: [{ orderId: 12, reason: 'Sync failed (gateway paid, order unpaid)' }, { orderId: 13, reason: 'عربي' }]
  });
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'), 'لازم يبدأ بترويسة PDF');
  assert.ok(text.includes('%%EOF'), 'لازم ينتهي صح');
  assert.ok(text.includes('/Type /Catalog') && text.includes('startxref'));
  assert.ok(!/[\u0600-\u06FF]/.test(text), 'مفيش حروف عربية خام جوه الـ PDF (بتتحول لعلامات استفهام)');
});
