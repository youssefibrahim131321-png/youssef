const { truthy } = require('../core/bool');
/**
 * إنشاء الطلب وخصم المخزون داخل معاملة واحدة
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
module.exports = function createOrdersRepo(sctx) {
  const {
    nowISO,
    pool,
    withTransaction
  } = sctx;
  // ربط متأخر: دوال بتعيش في موديولات تانية، بتتحل وقت النداء مش وقت التحميل.
  const evaluateCoupon = (...args) => sctx.evaluateCoupon(...args);
  const getSiteSettings = (...args) => sctx.getSiteSettings(...args);
  const shapeOrder = (...args) => sctx.shapeOrder(...args);

  async function createOrder({ userId, customerName, customerPhone, customerAddress, paymentMethod, notes, items, couponCode, paymentProofUrl, transferRef }) {
    return withTransaction(pool, async (client) => {
      const safeItems = [];
      const stockIssues = [];
      // (إصلاح سباق/جمود) بنقفل صفوف المنتجات بترتيب ثابت بالـ id عشان طلبين
      // متزامنين ما يقفلوش نفس الصفوف بترتيب معاكس ويحصل deadlock.
      const orderedItems = [...(items || [])].sort(
        (a, b) => Number(a.productId ?? a.id) - Number(b.productId ?? b.id));
      for (const item of orderedItems) {
        const requested = Number(item.quantity);
        if (!Number.isFinite(requested) || !Number.isInteger(requested) || requested < 1 || requested > 999) {
          const err = new Error('Invalid quantity');
          err.code = 'INVALID_QUANTITY';
          throw err;
        }
        const { rows: prows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [Number(item.productId ?? item.id)]);
        const product = prows[0];
        if (!product || !truthy(product.active)) {
          stockIssues.push({ productId: Number(item.productId ?? item.id), name: item.name || 'منتج', available: 0, requested });
          continue;
        }
        const available = Math.max(0, Number(product.stock || 0));
        if (requested > available) {
          stockIssues.push({ productId: product.id, name: product.name, available, requested });
          continue;
        }
        safeItems.push({ productId: product.id, name: product.name, price: Number(product.price), image_url: product.image_url || '', quantity: requested });
      }

      if (stockIssues.length) {
        const err = new Error('Insufficient stock');
        err.code = 'INSUFFICIENT_STOCK';
        err.issues = stockIssues;
        throw err;
      }

      if (!safeItems.length) {
        const err = new Error('No valid items in order');
        err.code = 'NO_VALID_ITEMS';
        throw err;
      }

      const subtotal = safeItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const settings = await getSiteSettings(client);

      let discount = 0;
      let appliedCoupon = null;
      if (couponCode) {
        const result = await evaluateCoupon(couponCode, subtotal, userId, client);
        if (!result.valid) {
          const err = new Error(result.error || 'Invalid coupon');
          err.code = 'INVALID_COUPON';
          err.reason = result.error;
          throw err;
        }
        discount = result.discount; appliedCoupon = result.code;
      }

      const afterDiscount = Math.max(0, subtotal - discount);
      const shippingFee = settings.freeShippingOver && afterDiscount >= Number(settings.freeShippingOver) ? 0 : Number(settings.shippingFee || 0);
      const tax = Math.round((afterDiscount * Number(settings.taxPercent || 0)) / 100);
      const totalAmount = afterDiscount + shippingFee + tax;
      const history = [{ status: 'pending', at: nowISO(), note: 'تم استلام الطلب' }];

      if (paymentProofUrl) {
        const { rows: used } = await client.query('SELECT id FROM orders WHERE payment_proof_url = $1', [String(paymentProofUrl).slice(0, 200)]);
        if (used.length) {
          const err = new Error('Payment proof already used');
          err.code = 'PROOF_REUSED';
          throw err;
        }
      }

      const { rows: orderRows } = await client.query(`INSERT INTO orders
        (user_id, customer_name, customer_phone, customer_address, payment_method, payment_status, status, notes,
         subtotal, discount, coupon_code, shipping_fee, tax, total_amount, notify_minutes, notify_at, notify_message, notified, confirmed_at, payment_proof_url, transfer_ref, history, created_at)
        VALUES ($1, $2, $3, $4, $5, 'pending', 'pending', $6, $7, $8, $9, $10, $11, $12, NULL, NULL, NULL, TRUE, NULL, $13, $14, $15, $16) RETURNING id`,
        [userId || null, String(customerName).trim().slice(0, 80), String(customerPhone).trim().slice(0, 30), String(customerAddress || '').slice(0, 300),
          paymentMethod, String(notes || '').slice(0, 500), subtotal, discount, appliedCoupon, shippingFee, tax, totalAmount,
          paymentProofUrl ? String(paymentProofUrl).slice(0, 200) : null,
          transferRef ? String(transferRef).trim().slice(0, 40) : null,
          JSON.stringify(history), nowISO()]);
      const orderId = Number(orderRows[0].id);

      for (const item of safeItems) {
        await client.query('INSERT INTO order_items (order_id, product_id, name, price, image_url, quantity) VALUES ($1, $2, $3, $4, $5, $6)',
          [orderId, item.productId, item.name, item.price, item.image_url, item.quantity]);
        // (إصلاح oversell) الخصم شرطي وذرّي: لو الكمية مش متاحة الصف ما يتحدّثش
        // والمعاملة كلها تترفض بدل ما نبيع حاجة مش موجودة.
        const deducted = await client.query(
          'UPDATE products SET stock = stock - $1::int, sold = sold + $2::int WHERE id = $3 AND stock >= $4::int RETURNING stock',
          [item.quantity, item.quantity, item.productId, item.quantity]);
        if (!deducted.rowCount) {
          const err = new Error('Insufficient stock');
          err.code = 'INSUFFICIENT_STOCK';
          err.issues = [{ productId: item.productId, name: item.name, available: 0, requested: item.quantity }];
          throw err;
        }
      }
      if (appliedCoupon) {
        if (userId) {
          try {
            await client.query('INSERT INTO coupon_redemptions (coupon_code, user_id, order_id, created_at) VALUES ($1, $2, $3, $4)',
              [appliedCoupon, Number(userId), orderId, nowISO()]);
          } catch (error) {
            if (error.code === '23505') {
              const err = new Error('سبق لك استخدام هذا الكوبون من قبل');
              err.code = 'INVALID_COUPON';
              err.reason = 'سبق لك استخدام هذا الكوبون من قبل';
              throw err;
            }
            throw error;
          }
        } else {
          await client.query('INSERT INTO coupon_redemptions (coupon_code, order_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [appliedCoupon, orderId, nowISO()]);
        }
        const bump = await client.query('UPDATE coupons SET used = used + 1 WHERE code = $1 AND (max_uses IS NULL OR max_uses = 0 OR used < max_uses)', [appliedCoupon]);
        if (!bump.rowCount) {
          const err = new Error('تم استهلاك هذا الكوبون بالكامل');
          err.code = 'INVALID_COUPON';
          err.reason = 'تم استهلاك هذا الكوبون بالكامل';
          throw err;
        }
      }

      const { rows: finalRows } = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      return shapeOrder(client, finalRows[0]);
    });
  }

  return {
    createOrder
  };
};
