/**
 * ---------------------------------------------------------------------------
 * طبقة البيانات (Data Layer) - متجر يوسف
 * ---------------------------------------------------------------------------
 * (ترقية) دلوقتي بتستخدم PostgreSQL مُدارة (زي Railway Postgres) عن طريق
 * مكتبة pg (Pool موصّل بـ DATABASE_URL) بدل SQLite/better-sqlite3.
 * كل دالة هنا بقت async لأن كل استعلام بيتبعت فعليًا على الشبكة، ومفيش أي
 * عملية متزامنة (blocking) للـ event loop زي ما كان في SQLite.
 *
 * الواجهة العامة (أسماء الدوال، المدخلات، شكل الرجوع) **زي ما هي** قدر
 * الإمكان، فرق واحد بس: كل دالة بترجع Promise دلوقتي، فلازم await في أي
 * مكان بتتستخدم فيه (server.js اترقّى بالكامل عشان يعمل كده).
 *
 * النسخ الاحتياطي: Railway Postgres عنده نسخ احتياطي مُدار تلقائيًا (managed
 * backups)، فمفهوم VACUUM INTO بتاع SQLite اتشال نهائيًا. دالتي flush/backup
 * فضلوا موجودين بس كـ no-op متوافق مع الكود القديم (شوف التعليق فوق backup()).
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const createShapers = require('./lib/store/shapers');
const createUsersRepo = require('./lib/store/users-repo');
const createAuthTokensRepo = require('./lib/store/auth-tokens-repo');
const createRateLimitsRepo = require('./lib/store/rate-limits-repo');
const createProductsRepo = require('./lib/store/products-repo');
const createCouponsRepo = require('./lib/store/coupons-repo');
const createOrdersRepo = require('./lib/store/orders-repo');
const createPaymentProofsRepo = require('./lib/store/payment-proofs-repo');
const createOrderStatusRepo = require('./lib/store/order-status-repo');
const createPaymobMonitorRepo = require('./lib/store/paymob-monitor-repo');
const createReviewsWishlistRepo = require('./lib/store/reviews-wishlist-repo');
const createNotificationsRepo = require('./lib/store/notifications-repo');
const createSettingsRepo = require('./lib/store/settings-repo');
const createAnalyticsRepo = require('./lib/store/analytics-repo');
const createMaintenanceRepo = require('./lib/store/maintenance-repo');
const buildStoreApi = require('./lib/store/public-api');

const SCHEMA_VERSION = 5; // 5 = PostgreSQL عبر pg (4 كانت SQLite عبر better-sqlite3)

function nowISO() { return new Date().toISOString(); }
function clampNumber(value, min, max, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}
function slugify(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 60);
}
function toBool(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return !(v === '' || v === '0' || v.toLowerCase() === 'false');
  return !!v;
}

function defaultProductsSeed() {
  const base = [
    ['زيت محرك 5W-30', 'زيوت ومحركات', 'زيت محرك أصلي عالي الجودة يحمي المحرك ويطيل عمره.', 850, 980, 'الأكثر مبيعًا', 6725328, 48],
    ['فلتر هواء السيارة', 'فلاتر', 'فلتر هواء عالي الجودة يحافظ على كفاءة المحرك ويقلل استهلاك الوقود.', 145, 180, 'مميز', 7092182, 75],
    ['بطارية 70 أمبير', 'بطاريات وإطارات', 'بطارية قوية للاستخدام اليومي توفر بدء تشغيل موثوقًا في كل الظروف.', 2200, 2600, 'عرض', 161635, 38],
    ['مساحات زجاج أمامي', 'مساحات وكهرباء', 'مساحات مقاومة للمطر لرؤية أوضح في الأمطار القوية.', 180, 220, 'عرض', 243243, 61],
    ['طفاية حريق سيارة', 'إكسسوارات وأمان', 'طفاية صغيرة وخفيفة للتثبيت داخل السيارة في حالات الطوارئ.', 150, 190, 'جديد', 745005, 92],
    ['لمبات LED أمامية', 'مساحات وكهرباء', 'لمبات LED ساطعة تدعم رؤية الليل وتحافظ على طاقة البطارية.', 420, 500, 'جديد', 1516708, 53],
    ['شاحن سيارة سريع USB-C', 'إكسسوارات وأمان', 'شاحن مزدوج USB-C يدعم الشحن السريع لهاتفك أثناء التنقل.', 215, 260, 'شائع', 1160934, 82],
    ['غطاء مقود جلد للسيارة', 'إكسسوارات وأمان', 'غطاء مقود جلدي أنيق يمنح سيارتك مظهرًا فخمًا ويحسن القبضة.', 280, 340, 'فخم', 937983, 46],
    ['كاميرا خلفية للسيارة', 'كاميرات وأمان', 'كاميرا خلفية واضحة تساعدك على الرجوع بثقة وتوفر زاوية رؤية واسعة.', 540, 620, 'الأكثر مبيعًا', 8259711, 34]
  ];
  return base.map((row, index) => ({
    name: row[0], category: row[1], description: row[2], price: row[3], old_price: row[4], tag: row[5],
    image_url: `/uploads/products/p${index + 1}.jpg`,
    stock: row[7], sku: `YS-${String(index + 1).padStart(4, '0')}`, featured: index < 3 ? 1 : 0
  }));
}

const DEFAULT_SETTINGS = {
  name: 'يوسف لمستلزمات العربيات',
  tagline: 'كل مستلزمات عربيتك في مكان واحد',
  // (إصلاح) مفيش أرقام تواصل افتراضية وهمية: لو الأدمن مضبطش الرقم، الواجهة
  // بتخفي أزرار الاتصال/واتساب بدل ما تدّي العميل رقم مش شغّال.
  phone: '',
  address: '',
  whatsappNumber: '',
  email: '',
  facebook: '',
  instagram: '',
  currency: 'ج.م',
  shippingFee: 40,
  freeShippingOver: 1000,
  taxPercent: 0,
  lowStockThreshold: 5,
  storeOpen: 1,
  announcement: '',
  vodafoneCashNumber: '',
  instapayNumber: '',
  logoUrl: '',
  coverUrl: '',
  primaryColor: '#c8793f'
};
const SETTINGS_NUMERIC_KEYS = new Set(['shippingFee', 'freeShippingOver', 'taxPercent', 'lowStockThreshold', 'storeOpen']);

// ---------------------------------------------------------------------------
// DDL بلهجة Postgres: SERIAL بدل AUTOINCREMENT، فهارس جزئية (partial unique
// indexes) لنفس قيود السباق اللي كانت بتتضمن بـ SQLite.
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  session_version INTEGER NOT NULL DEFAULT 0,
  normalized_email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified_at TIMESTAMPTZ,
  totp_secret TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  totp_last_code TEXT,
  totp_last_at BIGINT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_normalized_email ON users(normalized_email);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  sku TEXT,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'عام',
  description TEXT DEFAULT '',
  price DOUBLE PRECISION DEFAULT 0,
  old_price DOUBLE PRECISION,
  tag TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  images TEXT DEFAULT '[]',
  stock INTEGER DEFAULT 0,
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  sold INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  rating_sum DOUBLE PRECISION DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

CREATE TABLE IF NOT EXISTS coupons (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'percent',
  value DOUBLE PRECISION DEFAULT 0,
  min_total DOUBLE PRECISION DEFAULT 0,
  max_uses INTEGER DEFAULT 0,
  used INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_phone TEXT,
  customer_address TEXT,
  payment_method TEXT,
  payment_status TEXT DEFAULT 'pending',
  status TEXT DEFAULT 'pending',
  notes TEXT DEFAULT '',
  subtotal DOUBLE PRECISION DEFAULT 0,
  discount DOUBLE PRECISION DEFAULT 0,
  coupon_code TEXT,
  shipping_fee DOUBLE PRECISION DEFAULT 0,
  tax DOUBLE PRECISION DEFAULT 0,
  total_amount DOUBLE PRECISION DEFAULT 0,
  notify_minutes INTEGER,
  notify_at TIMESTAMPTZ,
  notify_message TEXT,
  notified BOOLEAN NOT NULL DEFAULT TRUE,
  confirmed_at TIMESTAMPTZ,
  payment_proof_url TEXT,
  transfer_ref TEXT,
  history TEXT DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_payment_proof ON orders(payment_proof_url) WHERE payment_proof_url IS NOT NULL;
-- (أداء) صفحة الطلبات بتفلتر بالتاريخ (from/to) وبطريقة الدفع باستمرار، ومع
-- كبر جدول الطلبات كان ده بيرجع لـ full scan. status مع created_at كمان
-- تركيبة شائعة (مثلاً "الطلبات المعلّقة من الأسبوع ده").
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_payment_method ON orders(payment_method);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER,
  name TEXT,
  price DOUBLE PRECISION,
  image_url TEXT,
  quantity INTEGER
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT,
  rating INTEGER,
  comment TEXT DEFAULT '',
  approved BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ,
  UNIQUE(product_id, user_id)
);

CREATE TABLE IF NOT EXISTS wishlists (
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  order_id INTEGER,
  title TEXT,
  body TEXT,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  keys TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  user_name TEXT,
  action TEXT,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id SERIAL PRIMARY KEY,
  coupon_code TEXT NOT NULL,
  user_id INTEGER,
  order_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(coupon_code, order_id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_code ON coupon_redemptions(coupon_code);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user ON coupon_redemptions(coupon_code, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_coupon_redemptions_user ON coupon_redemptions(coupon_code, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- توكنات المصادقة: استعادة كلمة المرور + تفعيل البريد الإلكتروني.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, type);

-- حدود المعدّل (Rate limiting) متخزّنة في قاعدة البيانات، فمش بتتصفّر مع
-- إعادة تشغيل السيرفر ولا بتضيع مع أكتر من عملية (process) شغالة.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at);

-- ملكية إيصالات الدفع في قاعدة البيانات بدل ملفات .owner جانبية على الديسك.
CREATE TABLE IF NOT EXISTS payment_proofs (
  filename TEXT PRIMARY KEY,
  user_id INTEGER,
  order_id INTEGER,
  sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_user ON payment_proofs(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_sha ON payment_proofs(sha256);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payment_proofs_sha ON payment_proofs(sha256) WHERE sha256 IS NOT NULL;

-- توثيق كل محاولة تعامل مع بوابة Paymob (webhook/نية دفع/رجوع/مكنسة). بيستخدم
-- في تقرير مصالحة المخزون وفي تنبيهات فشل المزامنة. مفيش أي payload خام أو
-- توقيعات متخزّنة هنا — بس نتيجة المعالجة والمبلغ ومعرّف المعاملة.
CREATE TABLE IF NOT EXISTS paymob_events (
  id SERIAL PRIMARY KEY,
  order_id INTEGER,
  stage TEXT NOT NULL,
  outcome TEXT NOT NULL,
  success BOOLEAN NOT NULL DEFAULT FALSE,
  hmac_valid BOOLEAN,
  txn_id TEXT,
  amount_cents INTEGER,
  expected_amount DOUBLE PRECISION,
  detail TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paymob_events_order ON paymob_events(order_id);
CREATE INDEX IF NOT EXISTS idx_paymob_events_created ON paymob_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paymob_events_outcome ON paymob_events(outcome, created_at DESC);
`;

// ---------------------------------------------------------------------------
// Pool موصّل بـ DATABASE_URL (Railway) — SSL تلقائي لأي هوست غير localhost،
// قابل للتعطيل صراحةً بـ PGSSL=0 (مفيد لبيئة تطوير محلية بشهادة ذاتية التوقيع).
// ---------------------------------------------------------------------------
function buildPool(connectionString) {
  const cs = connectionString || process.env.DATABASE_URL;
  if (!cs) {
    // بديل الاختبارات/التطوير المحلي: PostgreSQL في الذاكرة (pg-mem) بدل ما
    // كل واحد يبقى مضطر يشغّل Postgres حقيقية عشان `npm test` يعدّي.
    const { isInMemoryAllowed, createMemoryPool } = require('./lib/memory-db');
    if (isInMemoryAllowed()) {
      if (process.env.NODE_ENV !== 'test') {
        if (process.env.ALLOW_MEMORY_DB === '1') console.warn('\x1b[33m⚠️  [store] ALLOW_MEMORY_DB=1 — قاعدة بيانات في الذاكرة فقط. أي إعادة تشغيل = ضياع كل البيانات. ممنوع استخدام ده في بيئة حقيقية.\x1b[0m');
        if (process.env.STORE_QUIET !== '1') console.warn('[store] DATABASE_URL فاضي — شغّالين على قاعدة بيانات في الذاكرة. البيانات هتضيع مع إعادة التشغيل.');
      }
      return createMemoryPool();
    }
    throw new Error(
      'DATABASE_URL غير مظبوط. المتجر بيرفض الإقلاع على قاعدة بيانات في الذاكرة بصمت ' +
      'عشان البيانات بتضيع مع أول Restart. لو التشغيل ده تطوير محلي مقصود بدون ' +
      'Postgres حقيقية، فعّل ذلك صراحةً بـ ALLOW_MEMORY_DB=1 (ولازم pg-mem مثبتة). ' +
      'غير كده، ظبّط DATABASE_URL على رابط اتصال PostgreSQL حقيقي.'
    );
  }
  const isLocal = /(^|@)(localhost|127\.0\.0\.1|::1)([:/]|$)/.test(cs);
  const sslDisabled = process.env.PGSSL === '0';
  const ssl = (!isLocal && !sslDisabled) ? { rejectUnauthorized: false } : false;
  return new Pool({ connectionString: cs, ssl, max: Number(process.env.PG_POOL_MAX || 10) });
}

// ---------------------------------------------------------------------------
// تطبيع نتائج الاستعلامات (Normalization)
// ---------------------------------------------------------------------------
// بعد تحويل الأعمدة لـ TIMESTAMPTZ و BOOLEAN، مكتبة pg بترجّع كائنات Date
// وقيَم true/false. عشان نحافظ على نفس شكل الـ API القديم (نصوص ISO و 0/1)
// من غير ما نلمس كل الواجهات والفرونت-إند، بنلفّ الـ Pool ونحوّل القيم دي
// وقت القراءة بس. الكتابة بتفضل booleans حقيقية على مستوى قاعدة البيانات.
function normalizeValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}
function normalizeResult(result) {
  if (!result || !Array.isArray(result.rows)) return result;
  for (const row of result.rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      const next = normalizeValue(row[key]);
      if (next !== row[key]) row[key] = next;
    }
  }
  return result;
}
function wrapQueryable(target) {
  if (!target || target.__normalized) return target;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === '__normalized') return true;
      if (prop === 'query') return async (...args) => normalizeResult(await obj.query(...args));
      if (prop === 'connect') return async (...args) => wrapQueryable(await obj.connect(...args));
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === 'function' ? value.bind(obj) : value;
    }
  });
}

// ---------------------------------------------------------------------------
// هجرة أنواع الأعمدة: TEXT -> TIMESTAMPTZ و INTEGER -> BOOLEAN
// ---------------------------------------------------------------------------
// idempotent بالكامل: بنقرأ الأنواع الحالية من information_schema، ولو العمود
// بقى بالنوع الصح بنعدّيه من غير أي تعديل. قواعد البيانات الجديدة بتتعمل
// بالأنواع الصح من الأول فالهجرة دي بتبقى no-op عندها.
const TIMESTAMP_COLUMNS = [
  ['users', 'created_at', 'NOT NULL'], ['users', 'email_verified_at', ''],
  ['products', 'created_at', 'NOT NULL'], ['products', 'updated_at', 'NOT NULL'],
  ['coupons', 'expires_at', ''], ['coupons', 'created_at', 'NOT NULL'],
  ['orders', 'notify_at', ''], ['orders', 'confirmed_at', ''], ['orders', 'created_at', 'NOT NULL'],
  ['reviews', 'created_at', 'NOT NULL'], ['reviews', 'updated_at', ''],
  ['wishlists', 'created_at', 'NOT NULL'],
  ['notifications', 'created_at', 'NOT NULL'],
  ['push_subscriptions', 'created_at', 'NOT NULL'],
  ['activity_log', 'created_at', 'NOT NULL'],
  ['coupon_redemptions', 'created_at', 'NOT NULL'],
  ['auth_tokens', 'expires_at', 'NOT NULL'], ['auth_tokens', 'used_at', ''], ['auth_tokens', 'created_at', 'NOT NULL'],
  ['payment_proofs', 'created_at', 'NOT NULL'],
  ['paymob_events', 'created_at', 'NOT NULL']
];
const BOOLEAN_COLUMNS = [
  ['users', 'must_change_password', 'FALSE'],
  ['users', 'email_verified', 'FALSE'],
  ['users', 'totp_enabled', 'FALSE'],
  ['products', 'featured', 'FALSE'],
  ['products', 'active', 'TRUE'],
  ['coupons', 'active', 'TRUE'],
  ['orders', 'notified', 'TRUE'],
  ['reviews', 'approved', 'TRUE'],
  ['notifications', 'read', 'FALSE']
];

async function migrateColumnTypes(pool) {
  let types;
  try {
    const { rows } = await pool.query(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'"
    );
    types = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, String(r.data_type).toLowerCase()]));
  } catch (error) {
    console.error('[store] تعذّرت قراءة أنواع الأعمدة، تم تخطي هجرة الأنواع:', error.message);
    return;
  }

  for (const [table, column, nullability] of TIMESTAMP_COLUMNS) {
    const current = types.get(`${table}.${column}`);
    if (!current || current.startsWith('timestamp')) continue;
    try {
      await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`);
      await pool.query(
        `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE TIMESTAMPTZ USING NULLIF(${column}::text, '')::timestamptz`
      );
      if (nullability === 'NOT NULL') {
        await pool.query(`UPDATE ${table} SET ${column} = NOW() WHERE ${column} IS NULL`);
        await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`);
      }
      console.log(`[store] هجرة: ${table}.${column} -> TIMESTAMPTZ`);
    } catch (error) {
      console.error(`[store] فشلت هجرة ${table}.${column} إلى TIMESTAMPTZ:`, error.message);
    }
  }

  for (const [table, column, defaultValue] of BOOLEAN_COLUMNS) {
    const current = types.get(`${table}.${column}`);
    if (!current || current.startsWith('bool')) continue;
    try {
      await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`);
      await pool.query(
        `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE BOOLEAN USING (CASE
           WHEN ${column} IS NULL THEN NULL
           WHEN ${column}::text IN ('0', 'f', 'false', 'FALSE', 'no', '') THEN FALSE
           ELSE TRUE END)`
      );
      await pool.query(`UPDATE ${table} SET ${column} = ${defaultValue} WHERE ${column} IS NULL`);
      await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${defaultValue}`);
      await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`);
      console.log(`[store] هجرة: ${table}.${column} -> BOOLEAN`);
    } catch (error) {
      console.error(`[store] فشلت هجرة ${table}.${column} إلى BOOLEAN:`, error.message);
    }
  }
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* لا شيء */ }
    throw error;
  } finally {
    client.release();
  }
}

async function ensureColumn(pool, table, column, definition) {
  const { rows } = await pool.query(
    'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
    [table, column]
  );
  if (!rows.length) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// (إصلاح) هجرات مرقّمة ومتتبَّعة على schema_migrations
// ---------------------------------------------------------------------------
// SCHEMA_SQL فوق بيبني الجداول الأساسية بـ CREATE TABLE IF NOT EXISTS، وده
// كويس للتشغيل الأول لكنه مش "هجرة" حقيقية: أي تعديل لاحق (عمود جديد، تعبئة
// بيانات قديمة...) كان بيتضاف كـ ensureColumn متفرقة جوّه createStore بلا أي
// تتبّع — شغّالة صح (idempotent) بس مفيش طريقة تعرف بيها "احنا واقفين عند
// إيه" غير قراءة الكود كله. من دلوقتي أي تعديل Schema بعد الإصدار الأولي
// لازم يتضاف كخطوة مرقّمة جديدة في MIGRATIONS تحت (id تصاعدي، ما يتغيّرش
// ولا يتعاد استخدامه أبدًا)؛ كل خطوة بتتسجّل في schema_migrations بعد أول
// نجاح وما بتتنفّذش تاني.
const MIGRATIONS = [
  {
    id: 1,
    name: 'orders.transfer_ref',
    run: async (pool) => { await ensureColumn(pool, 'orders', 'transfer_ref', 'TEXT'); }
  },
  {
    id: 2,
    name: 'users.normalized_email + تعبئة القيم القديمة',
    run: async (pool) => {
      await ensureColumn(pool, 'users', 'normalized_email', 'TEXT');
      const { normalizeEmail } = require('./email-guard');
      const { rows: missing } = await pool.query(
        "SELECT id, email FROM users WHERE normalized_email IS NULL OR normalized_email = ''"
      );
      for (const u of missing) {
        await pool.query('UPDATE users SET normalized_email = $1 WHERE id = $2', [normalizeEmail(u.email), u.id]);
      }
    }
  }
];

async function runMigrations(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const { rows } = await pool.query('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((r) => Number(r.id)));
  const pending = [...MIGRATIONS].sort((a, b) => a.id - b.id).filter((m) => !applied.has(m.id));
  for (const m of pending) {
    try {
      await m.run(pool);
      await pool.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [m.id, m.name]);
      console.log(`[store] هجرة مطبّقة: #${m.id} ${m.name}`);
    } catch (error) {
      console.error(`[store] فشلت الهجرة #${m.id} (${m.name}):`, error.message);
      throw error;
    }
  }
}

async function createStore(jsonDbPathHint, options = {}) {
  const rawPool = options.pool || buildPool(options.connectionString);
  const pool = wrapQueryable(rawPool);
  await pool.query(SCHEMA_SQL);
  // هجرة أنواع الأعمدة لقواعد البيانات القديمة (TEXT/INTEGER -> TIMESTAMPTZ/BOOLEAN)
  await migrateColumnTypes(pool);

  // هجرات مرقّمة ومتتبَّعة (schema_migrations) — شوف MIGRATIONS فوق.
  await runMigrations(pool);

  const { rows: productCountRows } = await pool.query('SELECT COUNT(*)::int AS c FROM products');
  if (productCountRows[0].c === 0) await seedDefaultsIfEmpty(pool);

  // -------------------------------------------------------------------------
  // أدوات مساعدة عامة (Pure JS — من غير أي استعلام قاعدة بيانات)
  // -------------------------------------------------------------------------
  // كائن السياق المشترك: كل موديول بيقرأ منه اللي محتاجه وبيضيف دواله عليه،
  // فالموديولات تقدر تنادي بعضها بنفس الأسماء القديمة بالظبط.
  const sctx = {
    DEFAULT_SETTINGS,
    SCHEMA_VERSION,
    SETTINGS_NUMERIC_KEYS,
    bcrypt,
    clampNumber,
    crypto,
    nowISO,
    pool,
    slugify,
    toBool,
    withTransaction
  };
  Object.assign(sctx, createShapers(sctx));

  // -------------------------------------------------------------------------
  // المستخدمون
  // -------------------------------------------------------------------------
  Object.assign(sctx, createUsersRepo(sctx));

  // -------------------------------------------------------------------------
  // توكنات المصادقة: استعادة كلمة المرور وتفعيل البريد
  // -------------------------------------------------------------------------
  Object.assign(sctx, createAuthTokensRepo(sctx));

  // -------------------------------------------------------------------------
  // Rate limiting دائم (يبقى بعد إعادة التشغيل)
  // -------------------------------------------------------------------------
  Object.assign(sctx, createRateLimitsRepo(sctx));

  // -------------------------------------------------------------------------
  // المنتجات
  // -------------------------------------------------------------------------
  Object.assign(sctx, createProductsRepo(sctx));

  // -------------------------------------------------------------------------
  // الكوبونات
  // -------------------------------------------------------------------------
  Object.assign(sctx, createCouponsRepo(sctx));

  // -------------------------------------------------------------------------
  // الطلبات
  // -------------------------------------------------------------------------
  Object.assign(sctx, createOrdersRepo(sctx));

  Object.assign(sctx, createPaymentProofsRepo(sctx));

  Object.assign(sctx, createOrderStatusRepo(sctx));

  // -------------------------------------------------------------------------
  // مراقبة مزامنة Paymob وتقارير مصالحة المخزون
  // -------------------------------------------------------------------------
  Object.assign(sctx, createPaymobMonitorRepo(sctx));

  // -------------------------------------------------------------------------
  // التقييمات
  // -------------------------------------------------------------------------
  Object.assign(sctx, createReviewsWishlistRepo(sctx));

  // -------------------------------------------------------------------------
  // الإشعارات + الاشتراكات
  // -------------------------------------------------------------------------
  Object.assign(sctx, createNotificationsRepo(sctx));

  // -------------------------------------------------------------------------
  // الإعدادات والأسرار
  // -------------------------------------------------------------------------
  Object.assign(sctx, createSettingsRepo(sctx));

  // -------------------------------------------------------------------------
  // الإحصائيات والتحليلات
  // -------------------------------------------------------------------------
  Object.assign(sctx, createAnalyticsRepo(sctx));

  // -------------------------------------------------------------------------
  // النظام: نسخ احتياطي، لقطة كاملة
  // -------------------------------------------------------------------------
  // (ترقية) SQLite كانت بتحتاج flush/checkpoint يدوي (WAL). PostgreSQL بيكتب
  // كل COMMIT فورًا، فمفيش حاجة تتعمل هنا — الدالة فضلت كـ no-op متوافق مع
  // أي كود قديم بينادي عليها (shutdown handlers مثلًا).
  Object.assign(sctx, createMaintenanceRepo(sctx));

  return buildStoreApi(sctx);
}

async function seedDefaultsIfEmpty(pool) {
  const { rows } = await pool.query('SELECT COUNT(*)::int as c FROM products');
  if (rows[0].c > 0) return;
  const now = nowISO();
  for (const p of defaultProductsSeed()) {
    await pool.query(`INSERT INTO products (sku, name, category, description, price, old_price, tag, image_url, images, stock, featured, sold, views, rating_sum, rating_count, active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '[]', $9, $10, 0, 0, 0, 0, TRUE, $11, $12)`,
      [p.sku, p.name, p.category, p.description, p.price, p.old_price, p.tag, p.image_url, p.stock, toBool(p.featured), now, now]);
  }
  await pool.query(`INSERT INTO coupons (code, type, value, min_total, max_uses, used, expires_at, active, created_at) VALUES ('WELCOME10','percent',10,300,200,0,NULL,TRUE,$1)`, [now]);
}

module.exports = { createStore, buildPool };
