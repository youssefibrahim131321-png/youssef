/**
 * المستخدمون وحساب الأدمن
 * -------------------------------------------------------------------------
 * موديول اتفصل من store.js. كل حاجة مشتركة (الـ pool، المعاملات، المساعدات،
 * ودوال الموديولات التانية) بتيجي من كائن السياق sctx، والدوال المصدَّرة
 * بتتجمّع في نفس واجهة الـ store القديمة بالحرف.
 */
module.exports = function createUsersRepo(sctx) {
  const {
    bcrypt,
    crypto,
    nowISO,
    pool,
    toBool,
    withTransaction
  } = sctx;
  // ربط متأخر: دوال بتعيش في موديولات تانية، بتتحل وقت النداء مش وقت التحميل.
  const sanitizeUser = (...args) => sctx.sanitizeUser(...args);

  // (إصلاح S4) تكلفة bcrypt اترفعت من 10 لـ 12 حسب التوصيات الحديثة.
  // الهاشات القديمة (cost 10) فضلت شغّالة عادي — bcrypt بيقرأ التكلفة من الهاش نفسه.
  const BCRYPT_COST = Number(process.env.BCRYPT_COST || 12);

  async function hasAdmin() {
    const { rows } = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    return !!rows.length;
  }
  async function getAdminUsers() {
    const { rows } = await pool.query("SELECT id, email, name FROM users WHERE role = 'admin'");
    return rows;
  }
  async function getStalePendingOrders(olderThanMs) {
    const cutoff = new Date(Date.now() - Number(olderThanMs || 0)).toISOString();
    const { rows } = await pool.query("SELECT id, created_at, total_amount, customer_name FROM orders WHERE status = 'pending' AND created_at < $1 ORDER BY created_at", [cutoff]);
    return rows;
  }

  async function ensureAdmin({ email, password, force = false }) {
    return withTransaction(pool, async (client) => {
      const { normalizeEmail } = require('../../email-guard');
      const target = (email || 'admin@store.com').toLowerCase();
      const { rows: existingRows } = await client.query("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
      const existing = existingRows[0];
      if (existing) {
        // (إصلاح) كلمة مرور الأدمن الموجود ما تتغيّرش تلقائيًا عند كل تشغيل.
        // التغيير بيحصل بس بقرار صريح (ADMIN_PASSWORD_RESET=1).
        if (password && force) {
          await client.query('UPDATE users SET password_hash = $1, email = $2, normalized_email = $3, must_change_password = FALSE WHERE id = $4',
            [bcrypt.hashSync(password, BCRYPT_COST), target, normalizeEmail(target), existing.id]);
        }
        return { created: false, email: (password && force) ? target : existing.email };
      }
      const finalPassword = password || crypto.randomBytes(12).toString('base64url');
      await client.query(`INSERT INTO users (name, email, normalized_email, password_hash, role, phone, address, must_change_password, email_verified, created_at)
                  VALUES ($1, $2, $3, $4, 'admin', '', '', $5, TRUE, $6)`,
        ['أدمن المتجر', target, normalizeEmail(target), bcrypt.hashSync(finalPassword, BCRYPT_COST), !password, nowISO()]);
      return { created: true, email: target, usingDefaultPassword: false, generatedPassword: password ? null : finalPassword };
    });
  }

  async function getUsers() {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY id DESC');
    return rows.map(sanitizeUser);
  }

  async function getUsersWithStats() {
    const { rows } = await pool.query(`
      SELECT u.*,
             COALESCE(o.orders_count, 0) AS orders_count,
             COALESCE(o.total_spent, 0) AS total_spent
      FROM users u
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS orders_count, SUM(total_amount) AS total_spent
        FROM orders WHERE status != 'cancelled' AND user_id IS NOT NULL GROUP BY user_id
      ) o ON o.user_id = u.id
      ORDER BY u.id DESC
    `);
    return rows.map((row) => ({ ...sanitizeUser(row), orders_count: Number(row.orders_count), total_spent: Number(row.total_spent) }));
  }

  async function findUserByNormalizedEmail(normalized) {
    const target = String(normalized || '').trim().toLowerCase();
    if (!target.includes('@')) return null;
    const { rows } = await pool.query('SELECT * FROM users WHERE normalized_email = $1', [target]);
    return rows[0] || null;
  }

  async function findUserByEmail(email) {
    const lookup = (email || '').trim().toLowerCase();
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = $1', [lookup]);
    return rows[0] || null;
  }
  async function findUserById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [Number(id)]);
    return rows[0] || null;
  }

  async function createUser({ name, email, password, role = 'customer', phone = '', address = '', emailVerified = false }) {
    const { normalizeEmail } = require('../../email-guard');
    const target = String(email).trim().toLowerCase();
    if (await findUserByEmail(target)) throw new Error('Email already exists');
    const { rows } = await pool.query(`INSERT INTO users (name, email, normalized_email, password_hash, role, phone, address, must_change_password, email_verified, created_at)
                              VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9) RETURNING id`,
      [String(name).trim().slice(0, 80), target, normalizeEmail(target), bcrypt.hashSync(password, BCRYPT_COST), role, String(phone || '').slice(0, 30), String(address || '').slice(0, 300), toBool(emailVerified), nowISO()]);
    return Number(rows[0].id);
  }

  const DUMMY_PASSWORD_HASH = bcrypt.hashSync('yousef-store-dummy-password', BCRYPT_COST);
  async function verifyPassword(email, password) {
    const user = await findUserByEmail(email);
    const hash = (user && user.password_hash) || DUMMY_PASSWORD_HASH;
    let match = false;
    try { match = bcrypt.compareSync(String(password ?? ''), hash); } catch (_) { match = false; }
    return user && match ? user : null;
  }

  async function updateUser(id, payload) {
    const { normalizeEmail } = require('../../email-guard');
    const user = await findUserById(id);
    if (!user) return null;
    if (user.role === 'admin' && payload.role && payload.role !== 'admin') {
      const { rows } = await pool.query("SELECT COUNT(*)::int as c FROM users WHERE role = 'admin'");
      if (rows[0].c <= 1) throw new Error('Cannot demote last admin');
    }
    const updatedEmail = payload.email ? String(payload.email).trim().toLowerCase() : user.email;
    if (updatedEmail !== user.email) {
      const clash = await findUserByEmail(updatedEmail);
      if (clash && clash.id !== user.id) throw new Error('Email already exists');
    }
    const next = {
      name: payload.name ? String(payload.name).trim().slice(0, 80) : user.name,
      email: payload.email ? updatedEmail : user.email,
      password_hash: payload.password ? bcrypt.hashSync(payload.password, BCRYPT_COST) : user.password_hash,
      must_change_password: payload.password ? false : toBool(user.must_change_password),
      role: payload.role || user.role,
      phone: payload.phone !== undefined ? String(payload.phone || '').slice(0, 30) : user.phone,
      address: payload.address !== undefined ? String(payload.address || '').slice(0, 300) : user.address,
      session_version: (payload.password || payload.email) ? (user.session_version || 0) + 1 : user.session_version,
      email_verified: payload.emailVerified !== undefined
        ? toBool(payload.emailVerified)
        : (payload.email && updatedEmail !== user.email ? false : toBool(user.email_verified))
    };
    await pool.query('UPDATE users SET name=$1, email=$2, normalized_email=$3, password_hash=$4, must_change_password=$5, role=$6, phone=$7, address=$8, session_version=$9, email_verified=$10 WHERE id=$11',
      [next.name, next.email, normalizeEmail(next.email), next.password_hash, next.must_change_password, next.role, next.phone, next.address, next.session_version, next.email_verified, user.id]);
    return sanitizeUser(await findUserById(user.id));
  }

  async function bumpSessionVersion(id) {
    const user = await findUserById(id);
    if (!user) return null;
    await pool.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [user.id]);
    return sanitizeUser(await findUserById(user.id));
  }

  async function deleteUser(id) {
    const user = await findUserById(id);
    if (!user) return false;
    if (user.role === 'admin') {
      const { rows } = await pool.query("SELECT COUNT(*)::int as c FROM users WHERE role = 'admin'");
      if (rows[0].c <= 1) throw new Error('Cannot delete last admin');
    }
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    return true;
  }

  return {
    DUMMY_PASSWORD_HASH,
    bumpSessionVersion,
    createUser,
    deleteUser,
    ensureAdmin,
    findUserByEmail,
    findUserById,
    findUserByNormalizedEmail,
    getAdminUsers,
    getStalePendingOrders,
    getUsers,
    getUsersWithStats,
    hasAdmin,
    updateUser,
    verifyPassword
  };
};
