/**
 * توكنات وأكواد المصادقة وتفعيل البريد والتحقق بخطوتين
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
const { encryptSecret, decryptSecret } = require('../secret-crypto');

module.exports = function createAuthTokensRepo(sctx) {
  const {
    bcrypt,
    crypto,
    nowISO,
    pool,
    withTransaction
  } = sctx;
  // ربط متأخر: دوال بتعيش في موديولات تانية، بتتحل وقت النداء مش وقت التحميل.
  const findUserById = (...args) => sctx.findUserById(...args);
  const sanitizeUser = (...args) => sctx.sanitizeUser(...args);

  // (إصلاح S4) نفس تكلفة bcrypt المرفوعة المستخدمة في users-repo.
  const BCRYPT_COST = Number(process.env.BCRYPT_COST || 12);

  const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

  async function createAuthToken({ userId, type, ttlMs }) {
    const raw = crypto.randomBytes(32).toString('base64url');
    await pool.query('DELETE FROM auth_tokens WHERE user_id = $1 AND type = $2', [Number(userId), type]);
    await pool.query('INSERT INTO auth_tokens (user_id, type, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)',
      [Number(userId), type, hashToken(raw), new Date(Date.now() + ttlMs).toISOString(), nowISO()]);
    return raw;
  }

  async function createAuthCode({ userId, type, ttlMs, digits = 6 }) {
    const max = 10 ** digits;
    const code = String(crypto.randomInt(0, max)).padStart(digits, '0');
    await pool.query('DELETE FROM auth_tokens WHERE user_id = $1 AND type = $2', [Number(userId), type]);
    await pool.query('INSERT INTO auth_tokens (user_id, type, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)',
      [Number(userId), type, hashToken(`${Number(userId)}:${code}`), new Date(Date.now() + ttlMs).toISOString(), nowISO()]);
    return code;
  }

  async function consumeAuthCode(userId, code, type) {
    return withTransaction(pool, async (client) => {
      const clean = String(code || '').replace(/\D/g, '');
      if (!clean || !userId) return null;
      const { rows } = await client.query('SELECT * FROM auth_tokens WHERE token_hash = $1 AND type = $2 AND user_id = $3',
        [hashToken(`${Number(userId)}:${clean}`), type, Number(userId)]);
      const row = rows[0];
      if (!row || row.used_at) return null;
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await client.query('DELETE FROM auth_tokens WHERE id = $1', [row.id]);
        return null;
      }
      const upd = await client.query('UPDATE auth_tokens SET used_at = $1 WHERE id = $2 AND used_at IS NULL', [nowISO(), row.id]);
      if (!upd.rowCount) return null;
      const { rows: userRows } = await client.query('SELECT * FROM users WHERE id = $1', [row.user_id]);
      return userRows[0] || null;
    });
  }

  async function consumeAuthToken(raw, type) {
    return withTransaction(pool, async (client) => {
      if (!raw) return null;
      const { rows } = await client.query('SELECT * FROM auth_tokens WHERE token_hash = $1 AND type = $2', [hashToken(raw), type]);
      const row = rows[0];
      if (!row || row.used_at) return null;
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await client.query('DELETE FROM auth_tokens WHERE id = $1', [row.id]);
        return null;
      }
      const upd = await client.query('UPDATE auth_tokens SET used_at = $1 WHERE id = $2 AND used_at IS NULL', [nowISO(), row.id]);
      if (!upd.rowCount) return null;
      const { rows: userRows } = await client.query('SELECT * FROM users WHERE id = $1', [row.user_id]);
      return userRows[0] || null;
    });
  }

  async function peekAuthToken(raw, type) {
    if (!raw) return false;
    const { rows } = await pool.query(`SELECT t.used_at, t.expires_at, u.*
      FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.type = $2`, [hashToken(raw), type]);
    const row = rows[0];
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return false;
    return sanitizeUser(row);
  }

  async function invalidateAuthTokens(userId, type) {
    const res = await pool.query('DELETE FROM auth_tokens WHERE user_id = $1 AND type = $2', [Number(userId), type]);
    return res.rowCount;
  }

  async function purgeExpiredAuthTokens() {
    const res = await pool.query('DELETE FROM auth_tokens WHERE expires_at < $1', [nowISO()]);
    return res.rowCount;
  }

  async function markEmailVerified(userId) {
    await pool.query('UPDATE users SET email_verified = TRUE, email_verified_at = $1 WHERE id = $2', [nowISO(), Number(userId)]);
    return sanitizeUser(await findUserById(userId));
  }

  async function setUserPassword(userId, password) {
    const user = await findUserById(userId);
    if (!user) return null;
    await pool.query('UPDATE users SET password_hash = $1, must_change_password = FALSE, session_version = session_version + 1 WHERE id = $2',
      [bcrypt.hashSync(String(password), BCRYPT_COST), user.id]);
    return sanitizeUser(await findUserById(user.id));
  }

  // -------------------------------------------------------------------------
  // التحقق بخطوتين (TOTP)
  // -------------------------------------------------------------------------
  // (إصلاح S2) السر بيتخزّن مشفّر AES-256-GCM بمفتاح تطبيق منفصل.
  async function setTotpSecret(userId, secret) {
    await pool.query('UPDATE users SET totp_secret = $1, totp_enabled = FALSE WHERE id = $2', [encryptSecret(secret), Number(userId)]);
    return true;
  }
  async function enableTotp(userId) {
    await pool.query('UPDATE users SET totp_enabled = TRUE WHERE id = $1 AND totp_secret IS NOT NULL', [Number(userId)]);
    return sanitizeUser(await findUserById(userId));
  }
  async function disableAllTotp() {
    await pool.query('UPDATE users SET totp_secret = NULL, totp_enabled = FALSE, totp_last_code = NULL, totp_last_at = NULL WHERE totp_enabled = TRUE OR totp_secret IS NOT NULL');
  }
  async function disableTotp(userId) {
    await pool.query('UPDATE users SET totp_secret = NULL, totp_enabled = FALSE WHERE id = $1', [Number(userId)]);
    return sanitizeUser(await findUserById(userId));
  }
  async function claimTotpCode(userId, code) {
    return withTransaction(pool, async (client) => {
      const clean = String(code || '').replace(/\D/g, '');
      const { rows } = await client.query('SELECT totp_last_code, totp_last_at FROM users WHERE id = $1', [Number(userId)]);
      const row = rows[0];
      if (!row) return false;
      const now = Date.now();
      if (row.totp_last_code === clean && Number(row.totp_last_at || 0) > now - 180000) return false;
      await client.query('UPDATE users SET totp_last_code = $1, totp_last_at = $2 WHERE id = $3', [clean, now, Number(userId)]);
      return true;
    });
  }
  async function getTotpSecret(userId) {
    const { rows } = await pool.query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [Number(userId)]);
    const row = rows[0];
    if (!row) return null;
    // فك التشفير وقت التحقق بس؛ الأسرار القديمة النص الصريح بتشتغل زي ما هي.
    return { ...row, totp_secret: decryptSecret(row.totp_secret) };
  }

  return {
    claimTotpCode,
    consumeAuthCode,
    consumeAuthToken,
    createAuthCode,
    createAuthToken,
    disableAllTotp,
    disableTotp,
    enableTotp,
    getTotpSecret,
    hashToken,
    invalidateAuthTokens,
    markEmailVerified,
    peekAuthToken,
    purgeExpiredAuthTokens,
    setTotpSecret,
    setUserPassword
  };
};
