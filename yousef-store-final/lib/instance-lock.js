/**
 * قفل بين النسخ (Instance Lock) عبر Postgres advisory locks
 * -------------------------------------------------------------------------
 * المشكلة: المهام المجدولة (الإشعارات المؤجلة، النسخ الاحتياطي، تنبيه الطلبات
 * المعلّقة، التنظيف الدوري) كانت بتشتغل في كل عملية/نسخة على حدة. لو شغّلت
 * أكتر من instance (scale) العميل كان بياخد نفس الإشعار مرتين، والنسخ
 * الاحتياطي بيتعمل بالتزامن.
 *
 * الحل: كل مهمة دورية بتلفّ جوه withLock('اسم المهمة'). النسخة اللي تنجح تاخد
 * الـ advisory lock هي اللي بتشتغل، والباقي بيتخطّى بهدوء (مش خطأ). القفل
 * جلسة-مستوى (session level) وبيتحرّر في finally أو تلقائيًا لو العملية وقعت،
 * فمفيش احتمال قفل عالق للأبد.
 *
 * لو الـ pool مش متاح (اختبارات/تشغيل محلي بذاكرة) بنشتغل عادي بدون قفل مع
 * حماية محلية من التزامن على نفس المفتاح في نفس العملية.
 */
const crypto = require('crypto');

// مفتاح رقمي ثابت (bigint) من اسم المهمة — نفس الاسم = نفس المفتاح في كل نسخة.
function lockKey(name) {
  const hash = crypto.createHash('sha1').update(`yousef-store:${name}`).digest();
  // 63 بت عشان تفضل داخل نطاق bigint الموجب في Postgres.
  return (hash.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString();
}

function createInstanceLock({ pool = null, logger = console, enabled = true } = {}) {
  const localBusy = new Set();

  async function withLock(name, fn) {
    if (localBusy.has(name)) return { skipped: true, reason: 'busy-local' };
    localBusy.add(name);
    try {
      if (!enabled || !pool || typeof pool.connect !== 'function') {
        return { ran: true, value: await fn() };
      }
      let client;
      try {
        client = await pool.connect();
      } catch (error) {
        // القاعدة مش متاحة دلوقتي: منشتغلش عمياني عشان ما نكرّرش المهمة.
        logger.error(`[instance-lock] تعذر الاتصال لقفل «${name}»:`, error.message);
        return { skipped: true, reason: 'no-connection' };
      }
      const key = lockKey(name);
      try {
        const { rows } = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [key]);
        if (!rows[0] || rows[0].ok !== true) return { skipped: true, reason: 'locked-elsewhere' };
        try {
          return { ran: true, value: await fn() };
        } finally {
          try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]); }
          catch (error) { logger.error(`[instance-lock] تعذر تحرير قفل «${name}»:`, error.message); }
        }
      } finally {
        client.release();
      }
    } finally {
      localBusy.delete(name);
    }
  }

  // مساعد جاهز للاستخدام مع setInterval: بيمسك أي خطأ عشان التايمر ما يوقعش العملية.
  function scheduled(name, fn) {
    return async () => {
      try { await withLock(name, fn); }
      catch (error) { logger.error(`[instance-lock] «${name}» فشلت:`, error.message); }
    };
  }

  return { withLock, scheduled, lockKey };
}

module.exports = { createInstanceLock, lockKey };
