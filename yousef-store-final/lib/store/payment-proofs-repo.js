/**
 * إيصالات التحويل: البصمة والمالك والتنظيف
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
module.exports = function createPaymentProofsRepo(sctx) {
  const {
    nowISO,
    pool
  } = sctx;
  // ربط متأخر: دوال بتعيش في موديولات تانية، بتتحل وقت النداء مش وقت التحميل.
  const shapeOrder = (...args) => sctx.shapeOrder(...args);

  async function recordPaymentProof(filename, userId, sha256 = null) {
    try {
      const res = await pool.query('INSERT INTO payment_proofs (filename, user_id, sha256, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT(filename) DO UPDATE SET user_id = excluded.user_id, sha256 = excluded.sha256',
        [String(filename), userId === null || userId === undefined ? null : Number(userId), sha256 ? String(sha256) : null, nowISO()]);
      return res.rowCount > 0;
    } catch (error) {
      if (error.code === '23505') {
        const err = new Error('Duplicate payment proof');
        err.code = 'DUPLICATE_PROOF';
        throw err;
      }
      throw error;
    }
  }
  async function getPaymentProofByHash(sha256) {
    if (!sha256) return null;
    const { rows } = await pool.query('SELECT filename, user_id FROM payment_proofs WHERE sha256 = $1 ORDER BY created_at LIMIT 1', [String(sha256)]);
    return rows[0] || null;
  }
  async function getPaymentProofOwner(filename) {
    const { rows } = await pool.query('SELECT user_id FROM payment_proofs WHERE filename = $1', [String(filename)]);
    return rows.length ? rows[0].user_id : null;
  }
  async function deletePaymentProof(filename) {
    const res = await pool.query('DELETE FROM payment_proofs WHERE filename = $1', [String(filename)]);
    return res.rowCount > 0;
  }

  async function getOrphanPaymentProofs(olderThanMs = 24 * 60 * 60 * 1000) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    // الربط بين الإيصال والطلب بيتعمل على مرحلتين (مش subquery مرتبط) عشان
    // يشتغل على أي محرّك: نجيب المرشحين القدام، وبعدين نستبعد اللي مربوط بطلب.
    const { rows } = await pool.query('SELECT filename FROM payment_proofs WHERE created_at < $1', [cutoff]);
    if (!rows.length) return [];
    const { rows: used } = await pool.query('SELECT payment_proof_url FROM orders WHERE payment_proof_url IS NOT NULL');
    const linked = new Set(used.map((r) => String(r.payment_proof_url).split('/').pop()));
    return rows.map((r) => r.filename).filter((filename) => !linked.has(filename));
  }

  async function getOrderByProofFilename(filename) {
    const { rows } = await pool.query('SELECT * FROM orders WHERE payment_proof_url LIKE $1', [`%/${String(filename)}`]);
    return rows[0] ? shapeOrder(null, rows[0]) : null;
  }

  return {
    deletePaymentProof,
    getOrderByProofFilename,
    getOrphanPaymentProofs,
    getPaymentProofByHash,
    getPaymentProofOwner,
    recordPaymentProof
  };
};
