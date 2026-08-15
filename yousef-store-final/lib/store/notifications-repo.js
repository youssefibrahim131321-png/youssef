/**
 * إشعارات الحساب واشتراكات الـ push
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
module.exports = function createNotificationsRepo(sctx) {
  const {
    nowISO,
    pool,
    withTransaction
  } = sctx;

  async function addNotification({ userId, orderId, title, body }) {
    const { rows } = await pool.query('INSERT INTO notifications (user_id, order_id, title, body, read, created_at) VALUES ($1, $2, $3, $4, FALSE, $5) RETURNING id',
      [Number(userId), orderId || null, title, body, nowISO()]);
    const id = Number(rows[0].id);
    if (id % 100 === 0) {
      await pool.query(`DELETE FROM notifications WHERE user_id = $1 AND id NOT IN (
        SELECT id FROM notifications WHERE user_id = $2 ORDER BY id DESC LIMIT 1000)`, [Number(userId), Number(userId)]);
    }
    const { rows: after } = await pool.query('SELECT * FROM notifications WHERE id = $1', [id]);
    return after[0];
  }

  async function getNotificationsByUser(userId) {
    const { rows } = await pool.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 40', [Number(userId)]);
    return rows;
  }

  async function markNotificationRead(id, userId) {
    await pool.query('UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2', [Number(id), Number(userId)]);
    const { rows } = await pool.query('SELECT * FROM notifications WHERE id = $1', [Number(id)]);
    return rows[0] || null;
  }

  async function markAllNotificationsRead(userId) {
    await pool.query('UPDATE notifications SET read = TRUE WHERE user_id = $1', [Number(userId)]);
    return true;
  }

  async function broadcastNotification({ title, body }) {
    return withTransaction(pool, async (client) => {
      const { rows: customers } = await client.query("SELECT id FROM users WHERE role != 'admin'");
      for (const u of customers) {
        await client.query('INSERT INTO notifications (user_id, order_id, title, body, read, created_at) VALUES ($1, NULL, $2, $3, FALSE, $4)', [u.id, title, body, nowISO()]);
      }
      return customers.map((u) => u.id);
    });
  }

  const MAX_PUSH_SUBS_PER_USER = 10;
  async function addPushSubscription(userId, subscription) {
    const { rows: existing } = await pool.query('SELECT 1 FROM push_subscriptions WHERE endpoint = $1', [subscription.endpoint]);
    if (!existing.length) {
      const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [Number(userId)]);
      const count = countRows[0].n;
      if (count >= MAX_PUSH_SUBS_PER_USER) {
        await pool.query('DELETE FROM push_subscriptions WHERE id IN (SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY id ASC LIMIT $2)',
          [Number(userId), count - MAX_PUSH_SUBS_PER_USER + 1]);
      }
      await pool.query('INSERT INTO push_subscriptions (user_id, endpoint, keys, created_at) VALUES ($1, $2, $3, $4)',
        [Number(userId), subscription.endpoint, JSON.stringify(subscription.keys || {}), nowISO()]);
    }
    return true;
  }

  async function removePushSubscription(endpoint, userId = null) {
    if (userId == null) {
      await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    } else {
      await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, Number(userId)]);
    }
    return true;
  }

  async function getPushSubscriptionsByUser(userId) {
    const { rows } = await pool.query('SELECT * FROM push_subscriptions WHERE user_id = $1', [Number(userId)]);
    return rows.map((row) => ({ endpoint: row.endpoint, keys: JSON.parse(row.keys || '{}') }));
  }

  return {
    MAX_PUSH_SUBS_PER_USER,
    addNotification,
    addPushSubscription,
    broadcastNotification,
    getNotificationsByUser,
    getPushSubscriptionsByUser,
    markAllNotificationsRead,
    markNotificationRead,
    removePushSubscription
  };
};
