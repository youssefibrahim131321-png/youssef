/**
 * لوحة التحكم: تقارير مصالحة المخزون + صحة مزامنة Paymob
 * -------------------------------------------------------------------------
 * كل المسارات هنا للأدمن بس. التقرير بيقارن حالة طلبات Paymob عندنا بسجل
 * محاولات المزامنة (جدول paymob_events) ويطلع الفروقات اللي بتأثر على المخزون
 * أو على الفلوس، بصيغتين: CSV (بالعربي، للمراجعة في Excel) و PDF (بالإنجليزي،
 * لأن خطوط PDF المدمجة مش بتدعم العربي — شوف lib/pdf-report.js).
 */
const { buildTablePdf } = require('../pdf-report');

// شرح مختصر لكل نوع فرق: بالعربي للـ CSV/الواجهة، وبالإنجليزي للـ PDF.
const KIND_LABELS = {
  sync_failed: { ar: 'فشل مزامنة: Paymob أكّد الدفع والطلب لسه غير مدفوع', en: 'Sync failed (gateway paid, order unpaid)' },
  paid_but_cancelled: { ar: 'مدفوع لكن ملغي: المخزون رجع ومعانا فلوس العميل', en: 'Paid but cancelled (stock returned)' },
  stock_held_unpaid: { ar: 'مخزون محجوز بدون دفع بعد مدة السماح', en: 'Stock held without payment' },
  amount_mismatch: { ar: 'مبلغ Paymob مختلف عن إجمالي الطلب', en: 'Amount mismatch' },
  paid_without_log: { ar: 'مدفوع بدون أي محاولة مسجّلة (تأكيد يدوي)', en: 'Paid with no logged attempt' }
};
const ACTION_HINTS = {
  sync_failed: 'راجع الطلب وأكّد الدفع يدويًا بعد التأكد من Paymob',
  paid_but_cancelled: 'ارجع للعميل المبلغ أو أعد تنشيط الطلب',
  stock_held_unpaid: 'شغّل مكنسة الطلبات غير المدفوعة لتحرير المخزون',
  amount_mismatch: 'راجع المعاملة في لوحة Paymob قبل التسليم',
  paid_without_log: 'تأكد إن الـ webhook شغّال ومظبوط على السيرفر'
};

const escapeCsv = (value) => {
  let text = String(value === null || value === undefined ? '' : value).replace(/\r\n|\r|\n/g, ' ');
  // حماية من CSV Injection زي باقي التصديرات.
  if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

const kindsAr = (kinds) => kinds.map((k) => (KIND_LABELS[k] ? KIND_LABELS[k].ar : k)).join(' | ');
const kindsEn = (kinds) => kinds.map((k) => (KIND_LABELS[k] ? KIND_LABELS[k].en : k)).join(' + ');
const hints = (kinds) => kinds.map((k) => ACTION_HINTS[k] || '').filter(Boolean).join(' | ');

module.exports = function registerAdminReportRoutes(app, deps) {
  const { adminBulkLimiter, adminWriteLimiter, audit, requireAdmin, store, paymobSweepNow, paymobHoldMinutes } = deps;

  const readRange = (req) => ({
    from: req.query.from ? String(req.query.from) : undefined,
    to: req.query.to ? String(req.query.to) : undefined,
    holdMinutes: Number(req.query.holdMinutes) || paymobHoldMinutes || 45
  });

  // -------------------------------------------------------------------------
  // التقرير كـ JSON (اللوحة بتستخدمه للعرض قبل التنزيل)
  // -------------------------------------------------------------------------
  app.get('/api/admin/reports/inventory-reconciliation', requireAdmin, adminBulkLimiter, async (req, res) => {
    const report = await store.getPaymobReconciliation(readRange(req));
    res.json({
      ...report,
      rows: report.rows.map((row) => ({ ...row, reasons: kindsAr(row.kinds), action: hints(row.kinds) }))
    });
  });

  // -------------------------------------------------------------------------
  // CSV (عربي + BOM عشان Excel يقرأ العربي صح)
  // -------------------------------------------------------------------------
  app.get('/api/admin/reports/inventory-reconciliation.csv', requireAdmin, adminBulkLimiter, async (req, res) => {
    const { summary, rows } = await store.getPaymobReconciliation(readRange(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory-reconciliation.csv"');
    res.setHeader('Cache-Control', 'no-store');
    const out = [];
    out.push('\uFEFF' + ['رقم الطلب', 'العميل', 'حالة الطلب', 'حالة الدفع', 'الإجمالي', 'عدد القطع', 'قطع محجوزة بالخطأ', 'محاولات المزامنة', 'محاولات ناجحة', 'محاولات فاشلة', 'عمر الطلب (ساعة)', 'تاريخ الطلب', 'آخر محاولة', 'نوع الفرق', 'الإجراء المقترح'].join(','));
    for (const row of rows) {
      out.push([
        row.orderId, row.customerName || '', row.status, row.paymentStatus, row.totalAmount, row.units,
        row.stockAtRisk, row.events, row.paidEvents, row.failedEvents + row.mismatchEvents,
        row.ageHours, row.createdAt, row.lastEventAt || '', kindsAr(row.kinds), hints(row.kinds)
      ].map(escapeCsv).join(','));
    }
    out.push('');
    out.push(['ملخص', `طلبات مفحوصة: ${summary.scannedOrders}`, `فروقات: ${summary.discrepancies}`, `قطع محجوزة: ${summary.stockAtRisk}`, `مبلغ محل شك: ${summary.amountAtRisk}`, `وقت التقرير: ${summary.generatedAt}`].map(escapeCsv).join(','));
    audit(req, 'تقرير مصالحة المخزون', `CSV — ${summary.discrepancies} فرق`);
    res.send(out.join('\n'));
  });

  // -------------------------------------------------------------------------
  // PDF
  // -------------------------------------------------------------------------
  app.get('/api/admin/reports/inventory-reconciliation.pdf', requireAdmin, adminBulkLimiter, async (req, res) => {
    const { summary, rows } = await store.getPaymobReconciliation(readRange(req));
    const pdf = buildTablePdf({
      title: 'Inventory Reconciliation Report - Paymob discrepancies',
      subtitle: 'Yousef Store / matn store records against logged Paymob sync attempts',
      meta: [
        ['Generated at (UTC)', summary.generatedAt],
        ['Period', `${summary.from || 'all time'} .. ${summary.to || 'now'}`],
        ['Grace period (minutes)', String(summary.holdMinutes)],
        ['Paymob orders scanned', String(summary.scannedOrders)],
        ['Discrepancies found', String(summary.discrepancies)],
        ['Units held by mistake', String(summary.stockAtRisk)],
        ['Amount at risk (EGP)', String(summary.amountAtRisk)]
      ],
      columns: [
        { header: 'Order', key: 'orderId', width: 0.6, align: 'right' },
        { header: 'Status', key: 'status', width: 1 },
        { header: 'Payment', key: 'paymentStatus', width: 1 },
        { header: 'Total', key: 'totalAmount', width: 0.9, align: 'right' },
        { header: 'Units', key: 'units', width: 0.6, align: 'right' },
        { header: 'Held', key: 'stockAtRisk', width: 0.6, align: 'right' },
        { header: 'Attempts', key: 'events', width: 0.8, align: 'right' },
        { header: 'Age (h)', key: 'ageHours', width: 0.8, align: 'right' },
        { header: 'Created at', key: 'createdAt', width: 1.9 },
        { header: 'Discrepancy', key: 'reason', width: 3.2 }
      ],
      rows: rows.map((row) => ({ ...row, reason: kindsEn(row.kinds) })),
      footer: 'Report is English-only because built-in PDF fonts do not support Arabic. Use the CSV export for the Arabic version.'
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory-reconciliation.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    audit(req, 'تقرير مصالحة المخزون', `PDF — ${summary.discrepancies} فرق`);
    res.send(pdf);
  });

  // -------------------------------------------------------------------------
  // صحة مزامنة Paymob + سجل المحاولات
  // -------------------------------------------------------------------------
  app.get('/api/admin/paymob/health', requireAdmin, async (req, res) => {
    const windowMinutes = Math.min(10080, Math.max(5, Number(req.query.windowMinutes) || 60));
    const [stats, recon, events] = await Promise.all([
      store.getPaymobSyncStats({ windowMinutes }),
      store.getPaymobReconciliation({ holdMinutes: paymobHoldMinutes || 45, limit: 2000 }),
      store.getPaymobEvents({ limit: 20 })
    ]);
    res.json({ stats, summary: recon.summary, recentEvents: events });
  });

  app.get('/api/admin/paymob/events', requireAdmin, async (req, res) => {
    res.json({
      events: await store.getPaymobEvents({
        orderId: req.query.orderId,
        outcome: req.query.outcome,
        stage: req.query.stage,
        limit: req.query.limit
      })
    });
  });

  // تشغيل مكنسة تحرير المخزون فورًا (بدل انتظار الدورة كل 5 دقايق).
  app.post('/api/admin/paymob/sweep', requireAdmin, adminWriteLimiter, async (req, res) => {
    if (typeof paymobSweepNow !== 'function') return res.status(503).json({ error: 'المكنسة غير متاحة' });
    const cancelled = await paymobSweepNow();
    audit(req, 'تحرير مخزون Paymob', `${Array.isArray(cancelled) ? cancelled.length : Number(cancelled) || 0} طلب`);
    res.json({ ok: true, cancelled: Array.isArray(cancelled) ? cancelled.length : Number(cancelled) || 0 });
  });
};

module.exports.KIND_LABELS = KIND_LABELS;
