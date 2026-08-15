/**
 * التقييمات وقائمة المفضلة
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
module.exports = function createReviewsWishlistRepo(sctx) {
  const {
    clampNumber,
    nowISO,
    pool,
    withTransaction
  } = sctx;
  // ربط متأخر: دوال بتعيش في موديولات تانية، بتتحل وقت النداء مش وقت التحميل.
  const decorateProduct = (...args) => sctx.decorateProduct(...args);

  async function addReview({ productId, userId, userName, rating, comment }) {
    return withTransaction(pool, async (client) => {
      const { rows: prows } = await client.query('SELECT * FROM products WHERE id = $1', [Number(productId)]);
      const product = prows[0];
      if (!product) throw new Error('Product not found');
      const stars = clampNumber(rating, 1, 5, 5);
      const { rows: erows } = await client.query('SELECT * FROM reviews WHERE product_id = $1 AND user_id = $2', [product.id, Number(userId)]);
      const existing = erows[0];
      if (existing) {
        await client.query('UPDATE products SET rating_sum = rating_sum - $1 + $2 WHERE id = $3', [existing.rating, stars, product.id]);
        await client.query('UPDATE reviews SET rating=$1, comment=$2, updated_at=$3, approved=TRUE WHERE id=$4',
          [stars, String(comment || '').slice(0, 600), nowISO(), existing.id]);
        const { rows } = await client.query('SELECT * FROM reviews WHERE id = $1', [existing.id]);
        return rows[0];
      }
      const { rows: irows } = await client.query(`INSERT INTO reviews (product_id, user_id, user_name, rating, comment, approved, created_at)
                                VALUES ($1, $2, $3, $4, $5, TRUE, $6) RETURNING id`,
        [product.id, Number(userId), String(userName || 'عميل').slice(0, 60), stars, String(comment || '').slice(0, 600), nowISO()]);
      await client.query('UPDATE products SET rating_sum = rating_sum + $1, rating_count = rating_count + 1 WHERE id = $2', [stars, product.id]);
      const { rows } = await client.query('SELECT * FROM reviews WHERE id = $1', [Number(irows[0].id)]);
      return rows[0];
    });
  }

  async function getReviewsByProduct(productId) {
    const { rows } = await pool.query('SELECT * FROM reviews WHERE product_id = $1 AND approved = TRUE ORDER BY id DESC', [Number(productId)]);
    return rows;
  }

  async function getAllReviews() {
    const { rows } = await pool.query(`
      SELECT r.*, COALESCE(p.name, '—') as product_name FROM reviews r LEFT JOIN products p ON p.id = r.product_id ORDER BY r.id DESC
    `);
    return rows;
  }

  async function deleteReview(id) {
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query('SELECT * FROM reviews WHERE id = $1', [Number(id)]);
      const review = rows[0];
      if (!review) return false;
      await client.query('UPDATE products SET rating_sum = GREATEST(0, rating_sum - $1), rating_count = GREATEST(0, rating_count - 1) WHERE id = $2', [review.rating, review.product_id]);
      await client.query('DELETE FROM reviews WHERE id = $1', [review.id]);
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // المفضلة
  // -------------------------------------------------------------------------
  async function getWishlist(userId) {
    const { rows } = await pool.query(`
      SELECT p.* FROM products p INNER JOIN wishlists w ON w.product_id = p.id
      WHERE w.user_id = $1 AND p.active = TRUE ORDER BY w.created_at DESC
    `, [Number(userId)]);
    return rows.map(decorateProduct);
  }

  async function toggleWishlist(userId, productId) {
    const uid = Number(userId); const pid = Number(productId);
    const { rows: existing } = await pool.query('SELECT 1 FROM wishlists WHERE user_id = $1 AND product_id = $2', [uid, pid]);
    if (existing.length) { await pool.query('DELETE FROM wishlists WHERE user_id = $1 AND product_id = $2', [uid, pid]); return { inWishlist: false }; }
    await pool.query('INSERT INTO wishlists (user_id, product_id, created_at) VALUES ($1, $2, $3)', [uid, pid, nowISO()]);
    return { inWishlist: true };
  }

  return {
    addReview,
    deleteReview,
    getAllReviews,
    getReviewsByProduct,
    getWishlist,
    toggleWishlist
  };
};
