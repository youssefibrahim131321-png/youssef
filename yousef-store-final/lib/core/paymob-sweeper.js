// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
module.exports = async function startPaymobSweeper(deps = {}) {
  const { everyInstances, store } = deps;
  // ---------------------------------------------------------------------------
  // (إصلاح) مكنسة طلبات Paymob غير المدفوعة
  // ---------------------------------------------------------------------------
  // المخزون بيتخصم فور إنشاء طلب Paymob (createOrder)، قبل ما العميل يخلّص
  // الدفع فعليًا. لو العميل فتح صفحة الدفع وسابها، أو الدفع فشل والـ webhook
  // ما وصلش لأي سبب، الطلب بيفضل pending/failed للأبد والمخزون فضل محجوز
  // بلا داعي — ممكن يستغَل عمدًا لإظهار منتج وكأنه نفد (Business DoS).
  // كل PAYMOB_STALE_MINUTES دقيقة بنلغي (status='cancelled') أي طلب Paymob
  // لسه معلّق فوق المهلة دي وحالة دفعه pending أو failed؛ updateOrder نفسها
  // بتحرّر المخزون تلقائيًا عند التحويل لـ cancelled (وتحت قفل صف الطلب
  // FOR UPDATE، فمفيش تعارض مع webhook بيوصل في نفس اللحظة).
  const PAYMOB_STALE_MS = Math.max(5, Number(process.env.PAYMOB_STALE_MINUTES || 45)) * 60 * 1000;
  async function sweepStalePaymobOrders() {
    let cancelled = 0;
    try {
      const staleIds = await store.getStalePaymobOrders(PAYMOB_STALE_MS);
      for (const orderId of staleIds) {
        try {
          const updated = await store.updateOrder(
            orderId,
            { status: 'cancelled', payment_status: 'failed' },
            'إلغاء تلقائي لطلب دفع أونلاين لم يكتمل خلال المهلة المحددة، وتحرير المخزون.',
            { skipIfPaymentStatusIn: ['paid', 'refunded'] }
          );
          if (updated && !updated.skipped) cancelled += 1;
          // (مراقبة) توثيق محاولة المكنسة في paymob_events عشان تظهر في تقرير
          // المصالحة وسجل المحاولات، زي أي مسار تعامل تاني مع Paymob.
          if (store.logPaymobEvent) {
            store.logPaymobEvent({
              stage: 'sweeper',
              outcome: updated && updated.skipped ? 'already_final' : 'stale_cancelled',
              success: false,
              orderId,
              detail: updated && updated.skipped ? 'الطلب اتدفع في نفس اللحظة، تم تخطيه' : 'إلغاء تلقائي بعد انتهاء مهلة الدفع'
            }).catch(() => {});
          }
        } catch (error) {
          console.error('[paymob-stale-sweep] فشل إلغاء الطلب', orderId, error.message);
          if (store.logPaymobEvent) {
            store.logPaymobEvent({ stage: 'sweeper', outcome: 'error', orderId, detail: error.message }).catch(() => {});
          }
        }
      }
    } catch (error) {
      console.error('[paymob-stale-sweep]', error.message);
    }
    return cancelled;
  }
  const sweepStalePaymobOrdersOnce = everyInstances('paymob-stale-sweep', sweepStalePaymobOrders);
  setTimeout(sweepStalePaymobOrdersOnce, 45 * 1000).unref();
  setInterval(sweepStalePaymobOrdersOnce, 10 * 60 * 1000).unref();
  return { PAYMOB_STALE_MS, sweepStalePaymobOrdersOnce };
};
