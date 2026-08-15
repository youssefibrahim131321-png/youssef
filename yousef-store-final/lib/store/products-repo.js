/**
 * المنتجات والأقسام والمخزون
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
module.exports = function createProductsRepo(sctx) {
  const {
    clampNumber,
    nowISO,
    pool,
    slugify,
    toBool,
    withTransaction
  } = sctx;
  // ربط متأخر: دوال بتعيش في موديولات تانية، بتتحل وقت النداء مش وقت التحميل.
  const decorateProduct = (...args) => sctx.decorateProduct(...args);
  const getSiteSettings = (...args) => sctx.getSiteSettings(...args);

  async function getProducts(activeOnly = true) {
    const { rows } = activeOnly
      ? await pool.query('SELECT * FROM products WHERE active = TRUE ORDER BY id DESC')
      : await pool.query('SELECT * FROM products ORDER BY id DESC');
    return rows.map(decorateProduct);
  }

  async function getProductById(id) {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [Number(id)]);
    return decorateProduct(rows[0]);
  }

  function sanitizeImageUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    if (/^data:/i.test(raw)) return '';
    const clean = raw.slice(0, 500);
    if (/["'<>\s]/.test(clean)) return '';
    if (/^\/(?!\/)/.test(clean)) return clean;
    if (/^https?:\/\/[^/]+\//i.test(clean) || /^https?:\/\/[^/]+$/i.test(clean)) return clean;
    return '';
  }

  async function createProduct(payload) {
    const now = nowISO();
    const images = Array.isArray(payload.images) ? payload.images.slice(0, 8) : [];
    const { rows } = await pool.query(`INSERT INTO products
      (sku, name, category, description, price, old_price, tag, image_url, images, stock, featured, sold, views, rating_sum, rating_count, active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, 0, 0, 0, $12, $13, $14) RETURNING id`,
      [
        String(payload.sku || '').slice(0, 40) || null,
        String(payload.name || '').trim().slice(0, 120),
        String(payload.category || 'عام').trim().slice(0, 60),
        String(payload.description || '').slice(0, 1200),
        clampNumber(payload.price, 0, 10000000, 0),
        payload.oldPrice ? clampNumber(payload.oldPrice, 0, 10000000, 0) : null,
        String(payload.tag || '').slice(0, 40),
        sanitizeImageUrl(payload.imageUrl || payload.imageData || payload.image_url || (images[0] || '')),
        JSON.stringify(images),
        clampNumber(payload.stock, 0, 1000000, 0),
        toBool(payload.featured),
        toBool(!(payload.active === 0 || payload.active === false)),
        now, now
      ]);
    const id = Number(rows[0].id);
    if (!payload.sku) await pool.query('UPDATE products SET sku = $1 WHERE id = $2', [`YS-${String(id).padStart(4, '0')}`, id]);
    return getProductById(id);
  }

  async function updateProduct(id, payload) {
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query('SELECT * FROM products WHERE id = $1', [Number(id)]);
      const product = rows[0];
      if (!product) return null;
      const images = payload.images !== undefined
        ? (Array.isArray(payload.images) ? payload.images.slice(0, 8) : [])
        : JSON.parse(product.images || '[]');
      const image = payload.imageUrl || payload.imageData || payload.image_url;
      const next = {
        name: payload.name !== undefined ? String(payload.name).trim().slice(0, 120) : product.name,
        category: payload.category !== undefined ? String(payload.category).trim().slice(0, 60) : product.category,
        description: payload.description !== undefined ? String(payload.description).slice(0, 1200) : product.description,
        price: payload.price !== undefined ? clampNumber(payload.price, 0, 10000000, product.price) : product.price,
        old_price: payload.oldPrice !== undefined ? (payload.oldPrice ? clampNumber(payload.oldPrice, 0, 10000000, 0) : null) : product.old_price,
        tag: payload.tag !== undefined ? String(payload.tag).slice(0, 40) : product.tag,
        stock: payload.stock !== undefined ? clampNumber(payload.stock, 0, 1000000, product.stock) : product.stock,
        sku: payload.sku !== undefined ? String(payload.sku).slice(0, 40) : product.sku,
        featured: payload.featured !== undefined ? toBool(payload.featured) : toBool(product.featured),
        active: payload.active !== undefined ? toBool(payload.active) : toBool(product.active),
        image_url: (image !== undefined && image !== null && image !== '') ? (sanitizeImageUrl(image) || product.image_url) : product.image_url,
        images: JSON.stringify(images)
      };
      await client.query(`UPDATE products SET name=$1, category=$2, description=$3, price=$4, old_price=$5, tag=$6, stock=$7, sku=$8, featured=$9, active=$10, image_url=$11, images=$12, updated_at=$13 WHERE id=$14`,
        [next.name, next.category, next.description, next.price, next.old_price, next.tag, next.stock, next.sku, next.featured, next.active, next.image_url, next.images, nowISO(), product.id]);
      const { rows: after } = await client.query('SELECT * FROM products WHERE id = $1', [product.id]);
      return decorateProduct(after[0]);
    });
  }

  async function deleteProduct(id) {
    const res = await pool.query('DELETE FROM products WHERE id = $1', [Number(id)]);
    return res.rowCount > 0;
  }

  async function adjustStock(id, delta) {
    return withTransaction(pool, async (client) => {
      const pid = Number(id);
      const { rows: exists } = await client.query('SELECT id FROM products WHERE id = $1', [pid]);
      if (!exists.length) return null;
      await client.query('UPDATE products SET stock = GREATEST(0, stock + $1), updated_at = $2 WHERE id = $3',
        [Number(delta) || 0, nowISO(), pid]);
      const { rows } = await client.query('SELECT * FROM products WHERE id = $1', [pid]);
      return decorateProduct(rows[0]);
    });
  }

  async function incrementProductViews(id) {
    await pool.query('UPDATE products SET views = views + 1 WHERE id = $1', [Number(id)]);
    return true;
  }

  async function getCategories() {
    const { rows } = await pool.query(`
      SELECT CASE WHEN category IS NULL OR TRIM(category) = '' THEN 'عام' ELSE TRIM(category) END as name,
             COUNT(*)::int as count, SUM(stock)::int as stock
      FROM products WHERE active = TRUE
      GROUP BY CASE WHEN category IS NULL OR TRIM(category) = '' THEN 'عام' ELSE TRIM(category) END
      ORDER BY count DESC
    `);
    return rows.map((row) => ({ name: row.name, slug: slugify(row.name), count: row.count, stock: row.stock || 0 }));
  }

  async function getLowStockProducts(threshold) {
    const s = await getSiteSettings();
    const limit = Number(threshold ?? s.lowStockThreshold ?? 5);
    const { rows } = await pool.query('SELECT * FROM products WHERE active = TRUE AND stock <= $1 ORDER BY stock ASC', [limit]);
    return rows.map(decorateProduct);
  }

  return {
    adjustStock,
    createProduct,
    deleteProduct,
    getCategories,
    getLowStockProducts,
    getProductById,
    getProducts,
    incrementProductViews,
    sanitizeImageUrl,
    updateProduct
  };
};
