/**
 * مراقبة مزامنة Paymob + مصالحة المخزون
 * -------------------------------------------------------------------------
 * الموديول ده مسؤول عن تلات حاجات:
 *   1) توثيق **كل** محاولة تعامل مع Paymob في جدول paymob_events (webhook،
 *      إنشاء نية دفع، صفحة الرجوع، المكنسة) — نجحت ولا فشلت ولا اتخطّت.
 *   2) إحصائيات فشل المزامنة في نافذة زمنية، عشان التنبيهات التلقائية.
 *   3) تقرير مصالحة المخزون: أي طلب Paymob حالته عندنا مش متسقة مع اللي
 *      Paymob قاله، أو ماسك مخزون وهو مش مدفوع.
 *
 * ملاحظة أمنية: ما بنخزّنش أي payload خام من Paymob ولا توقيعات — بس معرّف
 * المعاملة والمبلغ ونتيجة المعالجة، عشان السجل يبقى مفيد للتشخيص من غير ما
 * يبقى مخزن بيانات حساسة.
 */
module.exports = function createPaymobMonitorRepo(sctx) {
  const { nowISO, pool } = sctx;

  const STAGES = ['checkout', 'webhook', 'return', 'sweeper'];
  // النتائج اللي بتتحسب «فشل مزامنة» في التنبيهات والتقارير.
  const FAILURE_OUTCOMES = ['invalid_hmac', 'amount_mismatch', 'failed', 'error', 'unknown_reference', 'order_not_found', 'not_configured', 'gateway_error'];

  const trim = (value, max) => {
    if (value === null || value === undefined) return null;
    return String(value).replace(/\s+/g, ' ').trim().slice(0, max) || null;
  };

  /** بيسجّل محاولة واحدة. بيرجّع الصف المسجّل، وما بيرمي أبدًا (اللوج مش مفروض يكسر دفع). */
  async function logPaymobEvent(event = {}) {
    const stage = STAGES.includes(event.stage) ? event.stage : 'webhook';
    const outcome = trim(event.outcome, 40) || 'unknown';
    try {
      const { rows } = await pool.query(
        `INSERT INTO paymob_events (order_id, stage, outcome, success, hmac_valid, txn_id, amount_cents, expected_amount, detail, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          Number.isFinite(Number(event.orderId)) ? Number(event.orderId) : null,
          stage,
          outcome,
          event.success === true,
          event.hmacValid === undefined ? null : !!event.hmacValid,
          trim(event.txnId, 80),
          Number.isFinite(Number(event.amountCents)) ? Math.round(Number(event.amountCents)) : null,
          Number.isFinite(Number(event.expectedAmount)) ? Number(event.expectedAmount) : null,
          trim(event.detail, 300) || '',
          nowISO()
        ]
      );
      return rows[0] || null;
    } catch (error) {
      console.error('[paymob-monitor] تعذر تسجيل محاولة Paymob:', error.message);
      return null;
    }
  }

  async function getPaymobEvents({ orderId, outcome, stage, limit = 50 } = {}) {
    const where = [];
    const args = [];
    if (orderId) { args.push(Number(orderId)); where.push(`order_id = $${args.length}`); }
    if (outcome && outcome !== 'all') { args.push(String(outcome)); where.push(`outcome = $${args.length}`); }
    if (stage && stage !== 'all') { args.push(String(stage)); where.push(`stage = $${args.length}`); }
    args.push(Math.min(500, Math.max(1, Number(limit) || 50)));
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM paymob_events ${clause} ORDER BY id DESC LIMIT $${args.length}`, args);
    return rows;
  }

  /** إحصائيات المزامنة في آخر N دقيقة (افتراضي ساعة). */
  async function getPaymobSyncStats({ windowMinutes = 60 } = {}) {
    const minutes = Math.min(60 * 24 * 7, Math.max(1, Number(windowMinutes) || 60));
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const { rows } = await pool.query(
      'SELECT outcome, COUNT(*) AS n, MAX(created_at) AS last_at FROM paymob_events WHERE created_at >= $1 GROUP BY outcome',
      [since]
    );
    const byOutcome = {};
    let total = 0;
    let failures = 0;
    let lastFailureAt = null;
    for (const row of rows) {
      const n = Number(row.n || 0);
      byOutcome[row.outcome] = n;
      total += n;
      if (FAILURE_OUTCOMES.includes(row.outcome)) {
        failures += n;
        if (!lastFailureAt || String(row.last_at) > String(lastFailureAt)) lastFailureAt = row.last_at;
      }
    }
    return {
      windowMinutes: minutes,
      since,
      total,
      failures,
      paid: byOutcome.paid || 0,
      failureRate: total ? Number((failures / total).toFixed(3)) : 0,
      lastFailureAt,
      byOutcome
    };
  }

  /**
   * تقرير مصالحة المخزون: بيقارن حالة كل طلب Paymob عندنا بسجل محاولات
   * المزامنة، ويطلع الفروقات اللي ليها أثر على المخزون أو على الفلوس.
   *
   * أنواع الفروقات:
   *   sync_failed          Paymob أكّد الدفع (فيه محاولة paid) والطلب عندنا لسه مش paid.
   *   paid_but_cancelled   الطلب مدفوع بس ملغي — يعني المخزون رجع ومعانا فلوس العميل.
   *   stock_held_unpaid    طلب غير مدفوع عدّى مدة السماح وماسك مخزون لسه.
   *   amount_mismatch      Paymob بعت مبلغ مختلف عن إجمالي الطلب.
   *   paid_without_log     الطلب مدفوع بس مفيش أي محاولة مسجّلة (تأكيد يدوي).
   */
  async function getPaymobReconciliation({ from, to, holdMinutes = 45, limit = 5000 } = {}) {
    const args = [];
    const where = ["payment_method = 'paymob'"];
    if (from) { args.push(new Date(from).toISOString()); where.push(`created_at >= $${args.length}`); }
    if (to) { args.push(`${String(to)}T23:59:59.999Z`); where.push(`created_at <= $${args.length}`); }
    args.push(Math.min(20000, Math.max(1, Number(limit) || 5000)));
    // ملحوظة: بنجيب الطلبات والتجميعات في استعلامين بسيطين وبنركّبهم في JS
    // بدل استعلامات فرعية مترابطة (correlated subqueries) — أوضح وأسرع، وكمان
    // بيشتغل على محرك الاختبارات في الذاكرة.
    const { rows } = await pool.query(
      `SELECT id, status, payment_status, total_amount, created_at, customer_name
         FROM orders
        WHERE ${where.join(' AND ')}
        ORDER BY id DESC
        LIMIT $${args.length}`,
      args
    );
    const orderIds = rows.map((r) => Number(r.id));
    const unitsByOrder = new Map();
    const statsByOrder = new Map();
    // القيم أرقام مضمونة (جاية من عمود id) فتركيبها في الاستعلام آمن تمامًا.
    const idList = orderIds.join(', ');
    if (orderIds.length) {
      const { rows: unitRows } = await pool.query(
        `SELECT order_id, SUM(quantity) AS units FROM order_items WHERE order_id IN (${idList}) GROUP BY order_id`);
      for (const r of unitRows) unitsByOrder.set(Number(r.order_id), Number(r.units || 0));
      const { rows: eventRows } = await pool.query(
        `SELECT order_id, outcome, COUNT(*) AS n, MAX(created_at) AS last_at FROM paymob_events WHERE order_id IN (${idList}) GROUP BY order_id, outcome`);
      for (const r of eventRows) {
        const key = Number(r.order_id);
        const entry = statsByOrder.get(key) || { events: 0, paid: 0, failed: 0, mismatch: 0, lastAt: null };
        const n = Number(r.n || 0);
        entry.events += n;
        if (r.outcome === 'paid') entry.paid += n;
        if (r.outcome === 'failed') entry.failed += n;
        if (r.outcome === 'amount_mismatch') entry.mismatch += n;
        if (r.last_at && (!entry.lastAt || String(r.last_at) > String(entry.lastAt))) entry.lastAt = r.last_at;
        statsByOrder.set(key, entry);
      }
    }

    const holdMs = Math.max(0, Number(holdMinutes) || 45) * 60 * 1000;
    const now = Date.now();
    const rowsOut = [];
    for (const row of rows) {
      const kinds = [];
      const stat = statsByOrder.get(Number(row.id)) || { events: 0, paid: 0, failed: 0, mismatch: 0, lastAt: null };
      const units = unitsByOrder.get(Number(row.id)) || 0;
      const paidEvents = stat.paid;
      const mismatchEvents = stat.mismatch;
      const ageMs = now - new Date(row.created_at).getTime();
      if (paidEvents > 0 && row.payment_status !== 'paid') kinds.push('sync_failed');
      if (row.payment_status === 'paid' && row.status === 'cancelled') kinds.push('paid_but_cancelled');
      if (['pending', 'failed'].includes(row.payment_status) && row.status !== 'cancelled' && ageMs > holdMs) kinds.push('stock_held_unpaid');
      if (mismatchEvents > 0) kinds.push('amount_mismatch');
      if (row.payment_status === 'paid' && stat.events === 0) kinds.push('paid_without_log');
      if (!kinds.length) continue;
      rowsOut.push({
        orderId: row.id,
        status: row.status,
        paymentStatus: row.payment_status,
        totalAmount: Number(row.total_amount || 0),
        customerName: row.customer_name || '',
        units,
        // الكمية المحجوزة فعليًا بسبب الفرق (بتتحسب بس للفروقات اللي بتأثر على المخزون).
        stockAtRisk: kinds.includes('stock_held_unpaid') ? units : 0,
        events: stat.events,
        paidEvents,
        failedEvents: stat.failed,
        mismatchEvents,
        ageHours: Number((ageMs / 3600000).toFixed(1)),
        createdAt: row.created_at,
        lastEventAt: stat.lastAt || null,
        kinds
      });
    }

    const summary = {
      generatedAt: nowISO(),
      from: from || null,
      to: to || null,
      holdMinutes: Math.max(0, Number(holdMinutes) || 45),
      scannedOrders: rows.length,
      discrepancies: rowsOut.length,
      stockAtRisk: rowsOut.reduce((sum, r) => sum + r.stockAtRisk, 0),
      amountAtRisk: Number(rowsOut.reduce((sum, r) => sum + (r.kinds.includes('sync_failed') || r.kinds.includes('paid_but_cancelled') ? r.totalAmount : 0), 0).toFixed(2)),
      byKind: {}
    };
    for (const r of rowsOut) for (const k of r.kinds) summary.byKind[k] = (summary.byKind[k] || 0) + 1;
    return { summary, rows: rowsOut };
  }

  /**
   * قفل تنبيه: بيرجّع true مرة واحدة بس كل cooldownMs عشان ما نغرقش الأدمن
   * بنفس التنبيه كل دورة مراقبة. الحالة متخزّنة في جدول meta فبتشتغل صح مع
   * أكتر من نسخة من السيرفر.
   */
  async function claimPaymobAlert(key, cooldownMs = 60 * 60 * 1000) {
    const metaKey = `paymob_alert:${String(key || 'default').slice(0, 60)}`;
    const now = Date.now();
    try {
      const { rows } = await pool.query('SELECT value FROM meta WHERE key = $1', [metaKey]);
      if (!rows.length) {
        await pool.query('INSERT INTO meta (key, value) VALUES ($1, $2)', [metaKey, String(now)]);
        return true;
      }
      const last = Number(rows[0].value) || 0;
      if (now - last < Math.max(0, Number(cooldownMs) || 0)) return false;
      await pool.query('UPDATE meta SET value = $1 WHERE key = $2', [String(now), metaKey]);
      return true;
    } catch (error) {
      console.error('[paymob-monitor] تعذر تسجيل التنبيه:', error.message);
      return false;
    }
  }

  /** تنضيف السجل القديم عشان الجدول ما يكبرش للأبد (افتراضي 180 يوم). */
  async function purgeOldPaymobEvents(days = 180) {
    const cutoff = new Date(Date.now() - Math.max(7, Number(days) || 180) * 24 * 60 * 60 * 1000).toISOString();
    const res = await pool.query('DELETE FROM paymob_events WHERE created_at < $1', [cutoff]);
    return res.rowCount || 0;
  }

  return {
    PAYMOB_FAILURE_OUTCOMES: FAILURE_OUTCOMES,
    claimPaymobAlert,
    getPaymobEvents,
    getPaymobReconciliation,
    getPaymobSyncStats,
    logPaymobEvent,
    purgeOldPaymobEvents
  };
};
