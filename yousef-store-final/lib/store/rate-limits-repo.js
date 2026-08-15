/**
 * حدود المحاولات الدائمة في قاعدة البيانات
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
module.exports = function createRateLimitsRepo(sctx) {
  const {
    pool,
    withTransaction
  } = sctx;

  async function rateLimitHit(key, windowMs) {
    return withTransaction(pool, async (client) => {
      const now = Date.now();
      const { rows } = await client.query('SELECT * FROM rate_limits WHERE key = $1', [key]);
      const row = rows[0];
      if (!row || Number(row.reset_at) <= now) {
        const resetAt = now + windowMs;
        await client.query('INSERT INTO rate_limits (key, count, reset_at) VALUES ($1, 1, $2) ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at', [key, resetAt]);
        return { count: 1, resetAt };
      }
      await client.query('UPDATE rate_limits SET count = count + 1 WHERE key = $1', [key]);
      return { count: row.count + 1, resetAt: Number(row.reset_at) };
    });
  }
  async function rateLimitGet(key) {
    const { rows } = await pool.query('SELECT count, reset_at FROM rate_limits WHERE key = $1', [key]);
    const row = rows[0];
    return row ? { count: row.count, resetAt: Number(row.reset_at) } : null;
  }
  async function rateLimitSet(key, count, resetAt) {
    await pool.query('INSERT INTO rate_limits (key, count, reset_at) VALUES ($1, $2, $3) ON CONFLICT(key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at',
      [key, Math.trunc(count), Math.trunc(resetAt)]);
    return true;
  }
  async function resetRateLimit(key) {
    const res = await pool.query('DELETE FROM rate_limits WHERE key = $1', [key]);
    return res.rowCount > 0;
  }
  async function purgeExpiredRateLimits() {
    const res = await pool.query('DELETE FROM rate_limits WHERE reset_at < $1', [Date.now()]);
    return res.rowCount;
  }

  return {
    purgeExpiredRateLimits,
    rateLimitGet,
    rateLimitHit,
    rateLimitSet,
    resetRateLimit
  };
};
