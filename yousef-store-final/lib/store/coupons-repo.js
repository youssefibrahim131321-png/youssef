/**
 * الكوبونات وحساب الخصم
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
module.exports = function createCouponsRepo(sctx) {
  const {
    clampNumber,
    nowISO,
    pool,
    toBool
  } = sctx;

  async function getCoupons() {
    const { rows } = await pool.query('SELECT * FROM coupons ORDER BY id DESC');
    return rows;
  }

  async function createCoupon(payload) {
    const code = String(payload.code || '').trim().toUpperCase().slice(0, 30);
    if (!code) throw new Error('Coupon code required');
    const { rows: existing } = await pool.query('SELECT id FROM coupons WHERE code = $1', [code]);
    if (existing.length) throw new Error('Coupon already exists');
    const { rows } = await pool.query(`INSERT INTO coupons (code, type, value, min_total, max_uses, used, expires_at, active, created_at)
                              VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8) RETURNING id`,
      [code, payload.type === 'fixed' ? 'fixed' : 'percent',
        clampNumber(payload.value, 0, payload.type === 'fixed' ? 100000 : 100, 0),
        clampNumber(payload.minTotal, 0, 1000000, 0), clampNumber(payload.maxUses, 0, 1000000, 0),
        payload.expiresAt ? new Date(payload.expiresAt).toISOString() : null,
        toBool(!(payload.active === 0 || payload.active === false)), nowISO()]);
    const { rows: created } = await pool.query('SELECT * FROM coupons WHERE id = $1', [Number(rows[0].id)]);
    return created[0];
  }

  async function updateCoupon(id, payload) {
    const { rows } = await pool.query('SELECT * FROM coupons WHERE id = $1', [Number(id)]);
    const coupon = rows[0];
    if (!coupon) return null;
    const next = {
      type: payload.type ? (payload.type === 'fixed' ? 'fixed' : 'percent') : coupon.type,
      value: 0,
      min_total: payload.minTotal !== undefined ? clampNumber(payload.minTotal, 0, 1000000, 0) : coupon.min_total,
      max_uses: payload.maxUses !== undefined ? clampNumber(payload.maxUses, 0, 1000000, 0) : coupon.max_uses,
      expires_at: payload.expiresAt !== undefined ? (payload.expiresAt ? new Date(payload.expiresAt).toISOString() : null) : coupon.expires_at,
      active: payload.active !== undefined ? toBool(payload.active) : toBool(coupon.active)
    };
    const valueCap = next.type === 'fixed' ? 100000 : 100;
    next.value = clampNumber(payload.value !== undefined ? payload.value : coupon.value, 0, valueCap, 0);
    await pool.query('UPDATE coupons SET type=$1, value=$2, min_total=$3, max_uses=$4, expires_at=$5, active=$6 WHERE id=$7',
      [next.type, next.value, next.min_total, next.max_uses, next.expires_at, next.active, coupon.id]);
    const { rows: after } = await pool.query('SELECT * FROM coupons WHERE id = $1', [coupon.id]);
    return after[0];
  }

  async function deleteCoupon(id) {
    const res = await pool.query('DELETE FROM coupons WHERE id = $1', [Number(id)]);
    return res.rowCount > 0;
  }

  async function evaluateCoupon(code, subtotal, userId, client) {
    const c = client || pool;
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) return { valid: false, error: 'أدخل كود الخصم' };
    const safeSubtotal = Number(subtotal);
    if (!Number.isFinite(safeSubtotal) || safeSubtotal < 0) return { valid: false, error: 'قيمة الطلب غير صحيحة' };
    // (إصلاح سباق) جوّه معاملة الطلب بنقفل صف الكوبون (FOR UPDATE) فالتحقق
    // والاستهلاك بيحصلوا ذرّيًا؛ برّه المعاملة (معاينة فقط) بنقرأ بدون قفل.
    const { rows } = await c.query(
      client ? 'SELECT * FROM coupons WHERE code = $1 FOR UPDATE' : 'SELECT * FROM coupons WHERE code = $1',
      [clean]);
    const coupon = rows[0];
    if (!coupon || !coupon.active) return { valid: false, error: 'كود الخصم غير صالح' };
    if (coupon.expires_at && new Date(coupon.expires_at).getTime() < Date.now()) return { valid: false, error: 'انتهت صلاحية الكوبون' };
    if (coupon.max_uses && coupon.used >= coupon.max_uses) return { valid: false, error: 'تم استهلاك هذا الكوبون بالكامل' };
    // (إصلاح S3) مسار الطلب الحقيقي بيفرض requireAuth، فـ userId لازم يبقى موجود
    // جوّه معاملة الطلب. لو حد ضاف مسار "طلب كضيف" مستقبلًا، الرفض الصريح ده
    // بيمنع إعادة استخدام نفس الكوبون بلا حدود بدل ما يعدّي بصمت.
    if (client && !userId) {
      return { valid: false, error: 'لازم تسجّل الدخول لاستخدام كود الخصم' };
    }
    if (userId) {
      const { rows: usedRows } = await c.query('SELECT COUNT(*)::int AS c FROM coupon_redemptions WHERE coupon_code = $1 AND user_id = $2', [coupon.code, Number(userId)]);
      if (usedRows[0].c > 0) return { valid: false, error: 'سبق لك استخدام هذا الكوبون من قبل' };
    }
    if (coupon.min_total && subtotal < coupon.min_total) return { valid: false, error: `الكوبون يبدأ من ${coupon.min_total} في إجمالي الطلب` };
    const percent = Math.min(100, Math.max(0, Number(coupon.value) || 0));
    const discount = coupon.type === 'percent'
      ? Math.min(subtotal, Math.round((subtotal * percent) / 100))
      : Math.min(Number(coupon.value) || 0, subtotal);
    return { valid: true, code: coupon.code, type: coupon.type, value: coupon.value, discount };
  }

  return {
    createCoupon,
    deleteCoupon,
    evaluateCoupon,
    getCoupons,
    updateCoupon
  };
};
