/**
 * إعدادات المتجر والأسرار وسجل النشاط
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
module.exports = function createSettingsRepo(sctx) {
  const {
    DEFAULT_SETTINGS,
    SETTINGS_NUMERIC_KEYS,
    clampNumber,
    crypto,
    nowISO,
    pool,
    withTransaction
  } = sctx;

  async function getSiteSettings(client) {
    const c = client || pool;
    const { rows } = await c.query('SELECT key, value FROM site_settings');
    const stored = {};
    rows.forEach((r) => { stored[r.key] = r.value; });
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    Object.keys(merged).forEach((key) => {
      if (SETTINGS_NUMERIC_KEYS.has(key)) merged[key] = Number(merged[key]);
    });
    return merged;
  }

  async function updateSiteSettings(payload) {
    return withTransaction(pool, async (client) => {
      const allowedText = ['name', 'tagline', 'phone', 'address', 'whatsappNumber', 'email', 'facebook', 'instagram', 'currency', 'announcement', 'vodafoneCashNumber', 'instapayNumber', 'logoUrl', 'coverUrl', 'primaryColor'];
      const upsert = async (key, value) => client.query('INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
      for (const key of allowedText) { if (payload[key] !== undefined) await upsert(key, String(payload[key]).slice(0, 300)); }
      if (payload.shippingFee !== undefined) await upsert('shippingFee', String(clampNumber(payload.shippingFee, 0, 100000, 0)));
      if (payload.freeShippingOver !== undefined) await upsert('freeShippingOver', String(clampNumber(payload.freeShippingOver, 0, 1000000, 0)));
      if (payload.taxPercent !== undefined) await upsert('taxPercent', String(clampNumber(payload.taxPercent, 0, 100, 0)));
      if (payload.lowStockThreshold !== undefined) await upsert('lowStockThreshold', String(clampNumber(payload.lowStockThreshold, 0, 10000, 5)));
      if (payload.storeOpen !== undefined) await upsert('storeOpen', String(payload.storeOpen ? 1 : 0));
      return getSiteSettings(client);
    });
  }

  async function getOrCreateSessionSecret() {
    const { rows } = await pool.query("SELECT value FROM meta WHERE key = 'sessionSecret'");
    if (rows[0]) return rows[0].value;
    const secret = crypto.randomBytes(48).toString('hex');
    await pool.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO NOTHING', ['sessionSecret', secret]);
    const { rows: after } = await pool.query("SELECT value FROM meta WHERE key = 'sessionSecret'");
    return after[0].value;
  }

  async function getOrCreateVapidKeys(generator) {
    const { rows } = await pool.query("SELECT value FROM meta WHERE key = 'vapid'");
    if (rows[0]) { try { const parsed = JSON.parse(rows[0].value); if (parsed.publicKey && parsed.privateKey) return parsed; } catch (_) { /* تجاهل */ } }
    const keys = generator();
    await pool.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value', ['vapid', JSON.stringify(keys)]);
    return keys;
  }

  // -------------------------------------------------------------------------
  // سجل نشاط الأدمن
  // -------------------------------------------------------------------------
  async function logActivity({ userId, userName, action, details }) {
    await pool.query('INSERT INTO activity_log (user_id, user_name, action, details, created_at) VALUES ($1, $2, $3, $4, $5)',
      [userId || null, userName || 'نظام', action, String(details || '').slice(0, 300), nowISO()]);
    await pool.query('DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT 500)');
    return true;
  }

  async function getActivityLog(limit = 100) {
    const { rows } = await pool.query('SELECT * FROM activity_log ORDER BY id DESC LIMIT $1', [limit]);
    return rows;
  }

  return {
    getActivityLog,
    getOrCreateSessionSecret,
    getOrCreateVapidKeys,
    getSiteSettings,
    logActivity,
    updateSiteSettings
  };
};
