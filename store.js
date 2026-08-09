/**
 * ---------------------------------------------------------------------------
 * طبقة البيانات (Data Layer) - متجر يوسف
 * ---------------------------------------------------------------------------
 * هذه النسخة تستخدم قاعدة بيانات SQL حقيقية (SQLite عبر مكتبة better-sqlite3
 * المستقرة والمستخدمة في الإنتاج) بدل وحدة node:sqlite التجريبية غير المستقرة.
 *
 * لماذا SQLite ومدمجة في Node تحديدًا؟
 *  - قاعدة بيانات SQL حقيقية: جداول، علاقات (Foreign Keys)، فهارس، Transactions
 *    ذرّية (ACID) — نفس مستوى الجدية اللي هتلاقيه في PostgreSQL لمشروع بالحجم ده.
 *  - ملف واحد (data/store.db) سهل النسخ الاحتياطي والنقل.
 *  - لو حبيت تكبر المشروع بعدين وتنقله لـ PostgreSQL، الكود هنا SQL قياسي
 *    99% منه هينقل زي ما هو (نفس الجداول، نفس الاستعلامات تقريبًا).
 *
 * الواجهة العامة (كل الدوال المُصدَّرة) **مطابقة تمامًا** للنسخة القديمة القائمة
 * على JSON، فمفيش أي تعديل مطلوب في server.js — نفس الأسماء، نفس المدخلات،
 * نفس الشكل اللي بيرجع. الهجرة تلقائية بالكامل من data/store.json القديم أول
 * ما السيرفر يشتغل (لو موجود ومفيش قاعدة بيانات لسه).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 4; // 4 = SQLite عبر better-sqlite3 (3 كانت node:sqlite التجريبية)

function nowISO() { return new Date().toISOString(); }
function clampNumber(value, min, max, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}
function slugify(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 60);
}
function boolToInt(v) { return v ? 1 : 0; }

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
  phone: '01000000000',
  address: 'الحي الرئيسي - المدينة',
  whatsappNumber: '201000000000',
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

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  must_change_password INTEGER DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0,
  normalized_email TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'عام',
  description TEXT DEFAULT '',
  price REAL DEFAULT 0,
  old_price REAL,
  tag TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  images TEXT DEFAULT '[]',
  stock INTEGER DEFAULT 0,
  featured INTEGER DEFAULT 0,
  sold INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  rating_sum REAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'percent',
  value REAL DEFAULT 0,
  min_total REAL DEFAULT 0,
  max_uses INTEGER DEFAULT 0,
  used INTEGER DEFAULT 0,
  expires_at TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  customer_name TEXT,
  customer_phone TEXT,
  customer_address TEXT,
  payment_method TEXT,
  payment_status TEXT DEFAULT 'pending',
  status TEXT DEFAULT 'pending',
  notes TEXT DEFAULT '',
  subtotal REAL DEFAULT 0,
  discount REAL DEFAULT 0,
  coupon_code TEXT,
  shipping_fee REAL DEFAULT 0,
  tax REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  notify_minutes INTEGER,
  notify_at TEXT,
  notify_message TEXT,
  notified INTEGER DEFAULT 1,
  confirmed_at TEXT,
  payment_proof_url TEXT,
  history TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER,
  name TEXT,
  price REAL,
  image_url TEXT,
  quantity INTEGER,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT,
  rating INTEGER,
  comment TEXT DEFAULT '',
  approved INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE(product_id, user_id)
);

CREATE TABLE IF NOT EXISTS wishlists (
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  order_id INTEGER,
  title TEXT,
  body TEXT,
  read INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  keys TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  user_name TEXT,
  action TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_code TEXT NOT NULL,
  user_id INTEGER,
  order_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(coupon_code, order_id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_code ON coupon_redemptions(coupon_code);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user ON coupon_redemptions(coupon_code, user_id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- (1)(2) توكنات المصادقة: استعادة كلمة المرور + تفعيل البريد الإلكتروني.
-- بنخزّن hash للتوكن مش التوكن نفسه، فحتى لو حد قرأ قاعدة البيانات مش هيقدر
-- يستخدم الروابط المُرسلة.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, type);

-- (3) حدود المعدّل (Rate limiting) متخزّنة في قاعدة البيانات، فمش بتتصفّر مع
-- إعادة تشغيل السيرفر ولا بتضيع مع أكتر من عملية (process) شغالة.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at);

-- ملكية إيصالات الدفع بقت في قاعدة البيانات بدل ملفات .owner جانبية على
-- الديسك (كانت بتضيع مع أي نسخ/نشر وما بتشتغلش مع أكتر من instance).
CREATE TABLE IF NOT EXISTS payment_proofs (
  filename TEXT PRIMARY KEY,
  user_id INTEGER,
  order_id INTEGER,
  sha256 TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_user ON payment_proofs(user_id);
-- بصمة الصورة: نفس صورة التحويل ما تتقبلش مرتين (ولا من نفس العميل ولا من غيره).
CREATE INDEX IF NOT EXISTS idx_payment_proofs_sha ON payment_proofs(sha256);

-- (إصلاح) إبطال الجلسة عند تسجيل الخروج: الجلسة موقّعة stateless، فمن غير
-- سجل إبطال كان التوكن المسروق يفضل صالح لحد ما تخلص مدته حتى بعد الخروج.
CREATE TABLE IF NOT EXISTS revoked_sessions (
  jti TEXT PRIMARY KEY,
  user_id INTEGER,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_sessions_exp ON revoked_sessions(expires_at);
`;

function createStore(jsonDbPathHint) {
  const dataDir = path.dirname(jsonDbPathHint);
  // (إصلاح) النسخ الاحتياطي على نفس الديسك = مش نسخة احتياطية. BACKUP_DIR
  // بيوجّهها لمسار/Volume تاني.
  const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  const dbPath = path.join(dataDir, 'store.db');
  const legacyJsonPath = jsonDbPathHint.endsWith('.json') ? jsonDbPathHint : path.join(dataDir, 'store.json');
  const isFreshDb = !fs.existsSync(dbPath);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // (تحسين أداء) SQLite هنا متزامنة بطبيعتها، فبنقلل زمن كل عملية لأقصى درجة:
  // مهلة انتظار للقفل بدل رمي خطأ فوري، كاش أكبر في الذاكرة، وقراءة عبر mmap
  // (بتخلي القراءات شبه مجانية بدل نسخ من القرص)، وتخزين مؤقت في الذاكرة.
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -32000');   // ~32MB كاش صفحات
  db.pragma('temp_store = MEMORY');
  try { db.pragma('mmap_size = 268435456'); } catch (_) { /* مش مدعوم في كل بيئة */ }
  db.pragma('wal_autocheckpoint = 512');
  db.exec(SCHEMA_SQL);

  // -------------------------------------------------------------------------
  // هجرة أعمدة آمنة لقواعد البيانات القديمة (لو الجدول كان موجود من قبل بدون
  // عمود معيّن، نضيفه هنا بدل ما نفترض إنه موجود دايمًا).
  // -------------------------------------------------------------------------
  function ensureColumn(table, column, definition) {
    const cols = db.pragma(`table_info(${table})`);
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      return true;
    }
    return false;
  }
  ensureColumn('users', 'session_version', 'INTEGER NOT NULL DEFAULT 0');
  // (جديد) بصمة صورة التحويل + رقم عملية التحويل: الاتنين بيقفلوا أشهر تحايل
  // على الدفع اليدوي (إعادة استخدام نفس صورة الإيصال أو إيصال حد تاني).
  ensureColumn('payment_proofs', 'sha256', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_payment_proofs_sha ON payment_proofs(sha256)');
  ensureColumn('orders', 'transfer_ref', 'TEXT');
  // (أداء) بريد مطبّع مفهرس: بديل الفحص اللي كان بيقرأ كل جدول المستخدمين.
  const normalizedEmailJustAdded = ensureColumn('users', 'normalized_email', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_normalized_email ON users(normalized_email)');
  if (normalizedEmailJustAdded) {
    const { normalizeEmail } = require('./email-guard');
    const rows = db.prepare('SELECT id, email FROM users').all();
    const upd = db.prepare('UPDATE users SET normalized_email = ? WHERE id = ?');
    rows.forEach((u) => upd.run(normalizeEmail(u.email), u.id));
  }
  // أي صف ناقص (بيانات قديمة أو مهاجرة من JSON) يتعبّى هنا.
  try {
    const { normalizeEmail } = require('./email-guard');
    const missing = db.prepare('SELECT id, email FROM users WHERE normalized_email IS NULL OR normalized_email = \'\'').all();
    if (missing.length) {
      const upd = db.prepare('UPDATE users SET normalized_email = ? WHERE id = ?');
      missing.forEach((u) => upd.run(normalizeEmail(u.email), u.id));
    }
  } catch (error) { console.error('[store] تعذر تعبئة البريد المطبّع:', error.message); }
  // (2) تفعيل البريد الإلكتروني و (6) التحقق بخطوتين للأدمن
  const emailVerifiedJustAdded = ensureColumn('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'email_verified_at', 'TEXT');
  ensureColumn('users', 'totp_secret', 'TEXT');
  ensureColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
  // (6) منع إعادة استخدام نفس كود TOTP داخل نفس النافذة الزمنية.
  ensureColumn('users', 'totp_last_code', 'TEXT');
  ensureColumn('users', 'totp_last_at', 'INTEGER');
  // الحسابات اللي كانت موجودة قبل ما نضيف ميزة التفعيل تُعتبر مفعّلة مرة واحدة
  // بس (وقت الترقية)، عشان ما نقفلش الباب على عملاء قدامى. التفعيل إلزامي
  // للحسابات الجديدة فقط.
  if (emailVerifiedJustAdded) db.exec('UPDATE users SET email_verified = 1');

  // (إصلاح) الكوبون كان ممكن يُستخدم مرتين لنفس العميل: الفحص كان SELECT COUNT
  // بينما القيد الفريد كان على (الكود، الطلب) — فطلبين في نفس اللحظة يعدّوا.
  // القيد الصح: فريد على (الكود، المستخدم)، فقاعدة البيانات نفسها ترفض التكرار
  // مهما كان التزامن. بنشيل أي تكرار قديم قبل إنشاء القيد.
  try {
    db.exec(`DELETE FROM coupon_redemptions WHERE user_id IS NOT NULL AND id NOT IN (
      SELECT MIN(id) FROM coupon_redemptions WHERE user_id IS NOT NULL GROUP BY coupon_code, user_id
    )`);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_coupon_redemptions_user ON coupon_redemptions(coupon_code, user_id) WHERE user_id IS NOT NULL');
  } catch (error) {
    console.error('[store] تعذر إنشاء القيد الفريد على استخدام الكوبونات:', error.message);
  }

  // (إصلاح) نفس صورة التحويل كانت ممكن تموّل أكتر من طلب: الفحص كان بيتم في
  // السيرفر قبل المعاملة، فطلبين متزامنين بنفس الإيصال يعدّوا الاتنين. القيد
  // الفريد على مستوى القاعدة بيقفل السباق نهائيًا.
  try {
    db.exec(`DELETE FROM payment_proofs WHERE sha256 IS NOT NULL AND rowid NOT IN (
      SELECT MIN(rowid) FROM payment_proofs WHERE sha256 IS NOT NULL GROUP BY sha256
    )`);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_payment_proofs_sha ON payment_proofs(sha256) WHERE sha256 IS NOT NULL');
  } catch (error) {
    console.error('[store] تعذر إنشاء القيد الفريد على بصمة الإيصال:', error.message);
  }
  try {
    db.exec(`UPDATE orders SET payment_proof_url = NULL WHERE payment_proof_url IS NOT NULL AND id NOT IN (
      SELECT MIN(id) FROM orders WHERE payment_proof_url IS NOT NULL GROUP BY payment_proof_url
    )`);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_payment_proof ON orders(payment_proof_url) WHERE payment_proof_url IS NOT NULL');
  } catch (error) {
    console.error('[store] تعذر إنشاء القيد الفريد على إيصال الطلب:', error.message);
  }

  // -------------------------------------------------------------------------
  // هجرة تلقائية من store.json القديم (إن وُجد) عند أول تشغيل فقط
  // -------------------------------------------------------------------------
  if (isFreshDb && fs.existsSync(legacyJsonPath)) {
    try {
      migrateFromLegacyJson(db, legacyJsonPath);
      console.log('[store] ✅ تم نقل جميع بياناتك القديمة من store.json إلى قاعدة بيانات SQLite جديدة (data/store.db) بنجاح.');
      const migratedName = `${legacyJsonPath}.migrated-${Date.now()}`;
      try { fs.renameSync(legacyJsonPath, migratedName); } catch (_) { /* لا مشكلة لو فشل، النسخة الأصلية تبقى كما هي */ }
    } catch (error) {
      console.error('[store] فشلت هجرة البيانات القديمة تلقائيًا:', error.message);
      console.error('[store] سيتم البدء بقاعدة بيانات جديدة فارغة بدل التوقف الكامل.');
    }
  }
  if (isFreshDb) seedDefaultsIfEmpty(db);

  // -------------------------------------------------------------------------
  // أدوات مساعدة عامة
  // -------------------------------------------------------------------------
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* لا شيء */ }
      throw error;
    }
  }

  function sanitizeUser(user) {
    if (!user) return null;
    const { password_hash: _ph, totp_secret: _ts, totp_last_code: _tc, totp_last_at: _ta, ...safe } = user;
    return { ...safe, totp_enabled: user.totp_enabled ? 1 : 0, email_verified: user.email_verified ? 1 : 0 };
  }

  function decorateProduct(product) {
    if (!product) return null;
    const rating = product.rating_count ? Number((product.rating_sum / product.rating_count).toFixed(1)) : 0;
    let images = [];
    try { images = JSON.parse(product.images || '[]'); } catch (_) { images = []; }
    return { ...product, images, rating, reviews_count: product.rating_count || 0 };
  }

  function loadOrderItems(orderId) {
    return db.prepare('SELECT product_id as productId, name, price, image_url, quantity FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
  }

  function shapeOrder(order) {
    if (!order) return null;
    let history = [];
    try { history = JSON.parse(order.history || '[]'); } catch (_) { history = []; }
    return { ...order, history, items: loadOrderItems(order.id) };
  }

  // -------------------------------------------------------------------------
  // المستخدمون
  // -------------------------------------------------------------------------
  const hasAdmin = () => !!db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  /** كل حسابات الأدمن — بنستخدمها لتنبيهات الطلبات المعلّقة. */
  const getAdminUsers = () => db.prepare("SELECT id, email, name FROM users WHERE role = 'admin'").all();
  /** طلبات لسه pending وعدّى عليها أكتر من المدة دي (تنبيه SLA للأدمن). */
  const getStalePendingOrders = (olderThanMs) => {
    const cutoff = new Date(Date.now() - Number(olderThanMs || 0)).toISOString();
    return db.prepare("SELECT id, created_at, total_amount, customer_name FROM orders WHERE status = 'pending' AND created_at < ? ORDER BY created_at").all(cutoff);
  };

  function ensureAdmin({ email, password }) {
    return tx(() => {
      const target = (email || 'admin@store.com').toLowerCase();
      const existing = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
      if (existing) {
        if (password) {
          db.prepare('UPDATE users SET password_hash = ?, email = ?, normalized_email = ?, must_change_password = 0 WHERE id = ?')
            .run(bcrypt.hashSync(password, 10), target, require('./email-guard').normalizeEmail(target), existing.id);
        }
        return { created: false, email: password ? target : existing.email };
      }
      // (أمان) مفيش كلمة مرور افتراضية معروفة خالص. لو مفيش ADMIN_PASSWORD
      // بنولّد كلمة عشوائية قوية ونرجّعها للسيرفر عشان يطبعها مرة واحدة.
      const finalPassword = password || require('crypto').randomBytes(12).toString('base64url');
      db.prepare(`INSERT INTO users (name, email, normalized_email, password_hash, role, phone, address, must_change_password, email_verified, created_at)
                  VALUES (?, ?, ?, ?, 'admin', '', '', ?, 1, ?)`)
        .run('أدمن المتجر', target, require('./email-guard').normalizeEmail(target), bcrypt.hashSync(finalPassword, 10), password ? 0 : 1, nowISO());
      return { created: true, email: target, usingDefaultPassword: false, generatedPassword: password ? null : finalPassword };
    });
  }

  const getUsers = () => db.prepare('SELECT * FROM users ORDER BY id DESC').all().map(sanitizeUser);

  // (أداء) بدل O(عملاء × طلبات) في الـ JS: تجميع واحد في SQL.
  const getUsersWithStats = () => db.prepare(`
    SELECT u.*, 
           COALESCE(o.orders_count, 0) AS orders_count,
           COALESCE(o.total_spent, 0) AS total_spent
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS orders_count, SUM(total_amount) AS total_spent
      FROM orders WHERE status != 'cancelled' AND user_id IS NOT NULL GROUP BY user_id
    ) o ON o.user_id = u.id
    ORDER BY u.id DESC
  `).all().map((row) => ({ ...sanitizeUser(row), orders_count: Number(row.orders_count), total_spent: Number(row.total_spent) }));

  // (جديد) بيدوّر على حساب بنفس البريد بعد التطبيع (نقط gmail و +tag) عشان
  // محدش يعمل عشرات الحسابات الوهمية من نفس صندوق البريد.
  function findUserByNormalizedEmail(normalized) {
    const target = String(normalized || '').trim().toLowerCase();
    if (!target.includes('@')) return null;
    // (أداء) استعلام مفهرس على عمود normalized_email بدل قراءة كل جدول
    // المستخدمين في كل تسجيل جديد (كان O(n) وبيتقل مع نمو المتجر).
    return db.prepare('SELECT * FROM users WHERE normalized_email = ?').get(target) || null;
  }

  function findUserByEmail(email) {
    const lookup = (email || '').trim().toLowerCase();
    return db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(lookup) || null;
  }
  const findUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;

  function createUser({ name, email, password, passwordHash, role = 'customer', phone = '', address = '', emailVerified = false }) {
    const target = String(email).trim().toLowerCase();
    if (findUserByEmail(target)) throw new Error('Email already exists');
    const hash = passwordHash || bcrypt.hashSync(password, 10);
    const info = db.prepare(`INSERT INTO users (name, email, normalized_email, password_hash, role, phone, address, must_change_password, email_verified, created_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(String(name).trim().slice(0, 80), target, require('./email-guard').normalizeEmail(target), hash, role, String(phone || '').slice(0, 30), String(address || '').slice(0, 300), emailVerified ? 1 : 0, nowISO());
    return Number(info.lastInsertRowid);
  }

  // (أمان) مقارنة ثابتة الزمن عمليًا: حتى لو الإيميل مش موجود بنعمل مقارنة
  // bcrypt على hash وهمي، فالرد بياخد نفس الوقت تقريبًا ومحدش يقدر يعرف
  // الإيميلات المسجّلة من فرق التوقيت (user enumeration عبر التوقيت).
  const DUMMY_PASSWORD_HASH = bcrypt.hashSync('yousef-store-dummy-password', 10);
  function verifyPassword(email, password) {
    const user = findUserByEmail(email);
    const hash = (user && user.password_hash) || DUMMY_PASSWORD_HASH;
    let match = false;
    try { match = bcrypt.compareSync(String(password ?? ''), hash); } catch (_) { match = false; }
    return user && match ? user : null;
  }

  // (إصلاح أداء) bcrypt المتزامن كان بيقفل الـ event loop على كل دخول/تسجيل.
  // النسخ دي async: الهاشينج بيتقسّم على دورات الـ event loop فالسيرفر بيفضل
  // بيرد على باقي الطلبات أثناء الحساب.
  const hashPasswordAsync = (password) => bcrypt.hash(String(password), 10);
  const comparePasswordAsync = (password, hash) =>
    bcrypt.compare(String(password ?? ''), hash).catch(() => false);
  async function verifyPasswordAsync(email, password) {
    const user = findUserByEmail(email);
    const hash = (user && user.password_hash) || DUMMY_PASSWORD_HASH;
    const match = await comparePasswordAsync(password, hash);
    return user && match ? user : null;
  }
  async function createUserAsync(payload) {
    const passwordHash = await hashPasswordAsync(payload.password);
    return createUser({ ...payload, password: undefined, passwordHash });
  }
  async function setUserPasswordAsync(userId, password) {
    const passwordHash = await hashPasswordAsync(password);
    return setUserPasswordHash(userId, passwordHash);
  }
  async function updateUserPasswordAsync(userId, password) {
    const passwordHash = await hashPasswordAsync(password);
    return updateUser(userId, { passwordHash });
  }

  function updateUser(id, payload) {
    const user = findUserById(id);
    if (!user) return null;
    // (أمان) نفس حماية deleteUser: ممنوع تنزيل صلاحية آخر أدمن، عشان المتجر
    // ما يقعدش من غير أي حساب إدارة.
    if (user.role === 'admin' && payload.role && payload.role !== 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get().c;
      if (adminCount <= 1) throw new Error('Cannot demote last admin');
    }
    const updatedEmail = payload.email ? String(payload.email).trim().toLowerCase() : user.email;
    if (updatedEmail !== user.email) {
      const clash = findUserByEmail(updatedEmail);
      if (clash && clash.id !== user.id) throw new Error('Email already exists');
    }
    const next = {
      name: payload.name ? String(payload.name).trim().slice(0, 80) : user.name,
      email: payload.email ? updatedEmail : user.email,
      password_hash: payload.passwordHash || (payload.password ? bcrypt.hashSync(payload.password, 10) : user.password_hash),
      must_change_password: payload.password ? 0 : user.must_change_password,
      role: payload.role || user.role,
      phone: payload.phone !== undefined ? String(payload.phone || '').slice(0, 30) : user.phone,
      address: payload.address !== undefined ? String(payload.address || '').slice(0, 300) : user.address,
      // أي تغيير في كلمة المرور أو الإيميل يبطل كل الجلسات القديمة (كوكيز) فورًا.
      session_version: (payload.password || payload.passwordHash || payload.email) ? (user.session_version || 0) + 1 : user.session_version,
      // (2) أي تغيير للبريد الإلكتروني يلغي التفعيل السابق ويستلزم تفعيل جديد.
      email_verified: payload.emailVerified !== undefined
        ? (payload.emailVerified ? 1 : 0)
        : (payload.email && updatedEmail !== user.email ? 0 : (user.email_verified || 0))
    };
    db.prepare('UPDATE users SET name=?, email=?, normalized_email=?, password_hash=?, must_change_password=?, role=?, phone=?, address=?, session_version=?, email_verified=? WHERE id=?')
      .run(next.name, next.email, require('./email-guard').normalizeEmail(next.email), next.password_hash, next.must_change_password, next.role, next.phone, next.address, next.session_version, next.email_verified, user.id);
    return sanitizeUser(findUserById(user.id));
  }

  // يبطل كل الجلسات المفتوحة لمستخدم مُعيّن (تسجيل خروج من كل الأجهزة) من غير
  // ما يغيّر كلمة المرور أو أي بيانات تانية.
  function bumpSessionVersion(id) {
    const user = findUserById(id);
    if (!user) return null;
    db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(user.id);
    return sanitizeUser(findUserById(user.id));
  }

  function deleteUser(id) {
    const user = findUserById(id);
    if (!user) return false;
    if (user.role === 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get().c;
      if (adminCount <= 1) throw new Error('Cannot delete last admin');
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    return true;
  }

  // -------------------------------------------------------------------------
  // (1)(2) توكنات المصادقة: استعادة كلمة المرور وتفعيل البريد
  // -------------------------------------------------------------------------
  const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

  function createAuthToken({ userId, type, ttlMs }) {
    const raw = crypto.randomBytes(32).toString('base64url');
    // توكن جديد يلغي أي توكن قديم من نفس النوع لنفس المستخدم.
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND type = ?').run(Number(userId), type);
    db.prepare('INSERT INTO auth_tokens (user_id, type, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(Number(userId), type, hashToken(raw), new Date(Date.now() + ttlMs).toISOString(), nowISO());
    return raw;
  }

  // (2) كود تحقق رقمي (6 أرقام) بدل الروابط — بيتخزن hash مربوط بالمستخدم عشان
  // كودين متطابقين لمستخدمين مختلفين ما يتعارضوش، وبيلغي أي كود قديم لنفس النوع.
  function createAuthCode({ userId, type, ttlMs, digits = 6 }) {
    const max = 10 ** digits;
    const code = String(crypto.randomInt(0, max)).padStart(digits, '0');
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND type = ?').run(Number(userId), type);
    db.prepare('INSERT INTO auth_tokens (user_id, type, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(Number(userId), type, hashToken(`${Number(userId)}:${code}`), new Date(Date.now() + ttlMs).toISOString(), nowISO());
    return code;
  }

  // يستهلك الكود ذرّيًا لمستخدم محدد (مرة واحدة بس).
  function consumeAuthCode(userId, code, type) {
    return tx(() => {
      const clean = String(code || '').replace(/\D/g, '');
      if (!clean || !userId) return null;
      const row = db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ? AND type = ? AND user_id = ?')
        .get(hashToken(`${Number(userId)}:${clean}`), type, Number(userId));
      if (!row || row.used_at) return null;
      if (new Date(row.expires_at).getTime() < Date.now()) {
        db.prepare('DELETE FROM auth_tokens WHERE id = ?').run(row.id);
        return null;
      }
      const changes = db.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(nowISO(), row.id).changes;
      if (!changes) return null;
      return findUserById(row.user_id);
    });
  }

  // يستهلك التوكن ذرّيًا: مرة واحدة بس، ولازم يكون صالح وغير منتهي.
  function consumeAuthToken(raw, type) {
    return tx(() => {
      if (!raw) return null;
      const row = db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ? AND type = ?').get(hashToken(raw), type);
      if (!row || row.used_at) return null;
      if (new Date(row.expires_at).getTime() < Date.now()) {
        db.prepare('DELETE FROM auth_tokens WHERE id = ?').run(row.id);
        return null;
      }
      const changes = db.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(nowISO(), row.id).changes;
      if (!changes) return null;
      return findUserById(row.user_id);
    });
  }

  const invalidateAuthTokens = (userId, type) =>
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND type = ?').run(Number(userId), type).changes;

  const purgeExpiredAuthTokens = () =>
    db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(nowISO()).changes;

  function markEmailVerified(userId) {
    db.prepare('UPDATE users SET email_verified = 1, email_verified_at = ? WHERE id = ?').run(nowISO(), Number(userId));
    return sanitizeUser(findUserById(userId));
  }

  // تغيير كلمة المرور مباشرةً (استعادة) — يبطل كل الجلسات المفتوحة.
  function setUserPasswordHash(userId, passwordHash) {
    const user = findUserById(userId);
    if (!user) return null;
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1 WHERE id = ?')
      .run(passwordHash, user.id);
    return sanitizeUser(findUserById(user.id));
  }
  function setUserPassword(userId, password) {
    return setUserPasswordHash(userId, bcrypt.hashSync(String(password), 10));
  }

  // -------------------------------------------------------------------------
  // (إصلاح) إبطال الجلسات الفردية (تسجيل الخروج الحقيقي)
  // -------------------------------------------------------------------------
  function revokeSession(jti, userId, expiresAtMs) {
    if (!jti) return false;
    db.prepare('INSERT OR REPLACE INTO revoked_sessions (jti, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(String(jti), userId ? Number(userId) : null, Number(expiresAtMs) || (Date.now() + 30 * 24 * 3600 * 1000), nowISO());
    return true;
  }
  function isSessionRevoked(jti) {
    if (!jti) return false;
    const row = db.prepare('SELECT expires_at FROM revoked_sessions WHERE jti = ?').get(String(jti));
    return !!(row && row.expires_at > Date.now());
  }
  const purgeExpiredRevokedSessions = () =>
    db.prepare('DELETE FROM revoked_sessions WHERE expires_at < ?').run(Date.now()).changes;

  // -------------------------------------------------------------------------
  // (6) التحقق بخطوتين (TOTP)
  // -------------------------------------------------------------------------
  const setTotpSecret = (userId, secret) => {
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, Number(userId));
    return true;
  };
  const enableTotp = (userId) => {
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ? AND totp_secret IS NOT NULL').run(Number(userId));
    return sanitizeUser(findUserById(userId));
  };
  const disableTotp = (userId) => {
    db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(Number(userId));
    return sanitizeUser(findUserById(userId));
  };
  // (6) بيسجّل آخر كود TOTP اتقبل، ويرفض إعادة استخدامه خلال 3 دقايق (أطول من
  // نافذة الصلاحية ±30 ثانية)، فحتى لو حد شاف الكود على الشاشة مش هيقدر يعيده.
  function claimTotpCode(userId, code) {
    return tx(() => {
      const clean = String(code || '').replace(/\D/g, '');
      const row = db.prepare('SELECT totp_last_code, totp_last_at FROM users WHERE id = ?').get(Number(userId));
      if (!row) return false;
      const now = Date.now();
      if (row.totp_last_code === clean && Number(row.totp_last_at || 0) > now - 180000) return false;
      db.prepare('UPDATE users SET totp_last_code = ?, totp_last_at = ? WHERE id = ?').run(clean, now, Number(userId));
      return true;
    });
  }

  const getTotpSecret = (userId) => {
    const row = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(Number(userId));
    return row || null;
  };

  // -------------------------------------------------------------------------
  // (3) Rate limiting دائم (يبقى بعد إعادة التشغيل)
  // -------------------------------------------------------------------------
  function rateLimitHit(key, windowMs) {
    return tx(() => {
      const now = Date.now();
      const row = db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key);
      if (!row || row.reset_at <= now) {
        const resetAt = now + windowMs;
        db.prepare('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at')
          .run(key, resetAt);
        return { count: 1, resetAt };
      }
      db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
      return { count: row.count + 1, resetAt: row.reset_at };
    });
  }
  // (إصلاح) قراءة/كتابة مباشرة للعدّاد عشان طبقة الـ write-behind في
  // lib/rate-limit.js تقدر تسترجع الحدود بعد إعادة التشغيل.
  function rateLimitGet(key) {
    const row = db.prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?').get(key);
    return row ? { count: row.count, resetAt: row.reset_at } : null;
  }
  function rateLimitSet(key, count, resetAt) {
    db.prepare('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at')
      .run(key, Math.trunc(count), Math.trunc(resetAt));
    return true;
  }
  const resetRateLimit = (key) => db.prepare('DELETE FROM rate_limits WHERE key = ?').run(key).changes > 0;
  const purgeExpiredRateLimits = () => db.prepare('DELETE FROM rate_limits WHERE reset_at < ?').run(Date.now()).changes;

  // -------------------------------------------------------------------------
  // المنتجات
  // -------------------------------------------------------------------------
  const getProducts = (activeOnly = true) => {
    const rows = activeOnly
      ? db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id DESC').all()
      : db.prepare('SELECT * FROM products ORDER BY id DESC').all();
    return rows.map(decorateProduct);
  };

  const getProductById = (id) => decorateProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id)));

  // (أمان) تحقق من شكل رابط الصورة قبل التخزين: مسار محلي، http(s)، أو
  // data:image بس. أي نص تاني (زي محاولة حقن HTML) بيترفض ويترجع فاضي.
  function sanitizeImageUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    // (إصلاح) ممنوع تمامًا تخزين صور base64 جوه العمود: كانت بتوصل 3 ميجا
    // للصورة الواحدة، فتضخّم القاعدة وتبطّئ *كل* قراءة منتجات. الصور بترفع
    // على القرص عبر /api/admin/upload-image وبنخزن المسار بس.
    if (/^data:/i.test(raw)) return '';
    const clean = raw.slice(0, 500);
    if (/["'<>\s]/.test(clean)) return '';
    if (/^\/(?!\/)/.test(clean)) return clean;
    if (/^https?:\/\/[^/]+\//i.test(clean) || /^https?:\/\/[^/]+$/i.test(clean)) return clean;
    return '';
  }

  function createProduct(payload) {
    const now = nowISO();
    const images = Array.isArray(payload.images) ? payload.images.slice(0, 8) : [];
    const info = db.prepare(`INSERT INTO products
      (sku, name, category, description, price, old_price, tag, image_url, images, stock, featured, sold, views, rating_sum, rating_count, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?)`)
      .run(
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
        boolToInt(payload.featured),
        boolToInt(!(payload.active === 0 || payload.active === false)),
        now, now
      );
    const id = Number(info.lastInsertRowid);
    if (!payload.sku) db.prepare('UPDATE products SET sku = ? WHERE id = ?').run(`YS-${String(id).padStart(4, '0')}`, id);
    return getProductById(id);
  }

  function updateProduct(id, payload) {
    // (إصلاح) القراءة + الكتابة في معاملة واحدة عشان تعديلين متزامنين على نفس
    // المنتج ما يضيّعوش بعض.
    return tx(() => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
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
      featured: payload.featured !== undefined ? boolToInt(payload.featured) : product.featured,
      active: payload.active !== undefined ? boolToInt(payload.active) : product.active,
      image_url: (image !== undefined && image !== null && image !== '') ? (sanitizeImageUrl(image) || product.image_url) : product.image_url,
      images: JSON.stringify(images)
    };
    db.prepare(`UPDATE products SET name=?, category=?, description=?, price=?, old_price=?, tag=?, stock=?, sku=?, featured=?, active=?, image_url=?, images=?, updated_at=? WHERE id=?`)
      .run(next.name, next.category, next.description, next.price, next.old_price, next.tag, next.stock, next.sku, next.featured, next.active, next.image_url, next.images, nowISO(), product.id);
    return getProductById(product.id);
    });
  }

  const deleteProduct = (id) => db.prepare('DELETE FROM products WHERE id = ?').run(Number(id)).changes > 0;

  // (إصلاح) تعديل المخزون بقى ذرّي داخل معاملة واحدة: القراءة والكتابة مش
  // منفصلين، فمستحيل تعديلين متزامنين يضيّعوا بعض (lost update).
  const adjustStock = (id, delta) => tx(() => {
    const pid = Number(id);
    const exists = db.prepare('SELECT id FROM products WHERE id = ?').get(pid);
    if (!exists) return null;
    db.prepare('UPDATE products SET stock = MAX(0, stock + ?), updated_at = ? WHERE id = ?')
      .run(Number(delta) || 0, nowISO(), pid);
    return getProductById(pid);
  });

  const incrementProductViews = (id) => {
    db.prepare('UPDATE products SET views = views + 1 WHERE id = ?').run(Number(id));
    return true;
  };

  const getCategories = () => db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(category), ''), 'عام') as name, COUNT(*) as count, SUM(stock) as stock
    FROM products WHERE active = 1 GROUP BY COALESCE(NULLIF(TRIM(category), ''), 'عام') ORDER BY count DESC
  `).all().map((row) => ({ name: row.name, slug: slugify(row.name), count: row.count, stock: row.stock || 0 }));

  const getLowStockProducts = (threshold) => {
    const s = getSiteSettings();
    const limit = Number(threshold ?? s.lowStockThreshold ?? 5);
    return db.prepare('SELECT * FROM products WHERE active = 1 AND stock <= ? ORDER BY stock ASC').all(limit).map(decorateProduct);
  };

  // -------------------------------------------------------------------------
  // الكوبونات
  // -------------------------------------------------------------------------
  const getCoupons = () => db.prepare('SELECT * FROM coupons ORDER BY id DESC').all();

  function createCoupon(payload) {
    const code = String(payload.code || '').trim().toUpperCase().slice(0, 30);
    if (!code) throw new Error('Coupon code required');
    if (db.prepare('SELECT id FROM coupons WHERE code = ?').get(code)) throw new Error('Coupon already exists');
    const info = db.prepare(`INSERT INTO coupons (code, type, value, min_total, max_uses, used, expires_at, active, created_at)
                              VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`)
      .run(code, payload.type === 'fixed' ? 'fixed' : 'percent',
        // (9) كوبون النسبة المئوية لا يتعدى 100% أبدًا (كان ممكن يوصل 100000%).
        clampNumber(payload.value, 0, payload.type === 'fixed' ? 100000 : 100, 0),
        clampNumber(payload.minTotal, 0, 1000000, 0), clampNumber(payload.maxUses, 0, 1000000, 0),
        payload.expiresAt ? new Date(payload.expiresAt).toISOString() : null,
        boolToInt(!(payload.active === 0 || payload.active === false)), nowISO());
    return db.prepare('SELECT * FROM coupons WHERE id = ?').get(Number(info.lastInsertRowid));
  }

  function updateCoupon(id, payload) {
    const coupon = db.prepare('SELECT * FROM coupons WHERE id = ?').get(Number(id));
    if (!coupon) return null;
    const next = {
      type: payload.type ? (payload.type === 'fixed' ? 'fixed' : 'percent') : coupon.type,
      value: 0, // يتحدد تحت بعد معرفة نوع الكوبون النهائي
      min_total: payload.minTotal !== undefined ? clampNumber(payload.minTotal, 0, 1000000, 0) : coupon.min_total,
      max_uses: payload.maxUses !== undefined ? clampNumber(payload.maxUses, 0, 1000000, 0) : coupon.max_uses,
      expires_at: payload.expiresAt !== undefined ? (payload.expiresAt ? new Date(payload.expiresAt).toISOString() : null) : coupon.expires_at,
      active: payload.active !== undefined ? boolToInt(payload.active) : coupon.active
    };
    // (9) السقف يعتمد على النوع النهائي: النسبة المئوية 100% كحد أقصى.
    const valueCap = next.type === 'fixed' ? 100000 : 100;
    next.value = clampNumber(payload.value !== undefined ? payload.value : coupon.value, 0, valueCap, 0);
    db.prepare('UPDATE coupons SET type=?, value=?, min_total=?, max_uses=?, expires_at=?, active=? WHERE id=?')
      .run(next.type, next.value, next.min_total, next.max_uses, next.expires_at, next.active, coupon.id);
    return db.prepare('SELECT * FROM coupons WHERE id = ?').get(coupon.id);
  }

  const deleteCoupon = (id) => db.prepare('DELETE FROM coupons WHERE id = ?').run(Number(id)).changes > 0;

  function evaluateCoupon(code, subtotal, userId) {
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) return { valid: false, error: 'أدخل كود الخصم' };
    const safeSubtotal = Number(subtotal);
    if (!Number.isFinite(safeSubtotal) || safeSubtotal < 0) return { valid: false, error: 'قيمة الطلب غير صحيحة' };
    const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(clean);
    if (!coupon || !coupon.active) return { valid: false, error: 'كود الخصم غير صالح' };
    if (coupon.expires_at && new Date(coupon.expires_at).getTime() < Date.now()) return { valid: false, error: 'انتهت صلاحية الكوبون' };
    if (coupon.max_uses && coupon.used >= coupon.max_uses) return { valid: false, error: 'تم استهلاك هذا الكوبون بالكامل' };
    if (userId) {
      const usedBefore = db.prepare('SELECT COUNT(*) AS c FROM coupon_redemptions WHERE coupon_code = ? AND user_id = ?').get(coupon.code, Number(userId)).c;
      if (usedBefore > 0) return { valid: false, error: 'سبق لك استخدام هذا الكوبون من قبل' };
    }
    if (coupon.min_total && subtotal < coupon.min_total) return { valid: false, error: `الكوبون يبدأ من ${coupon.min_total} في إجمالي الطلب` };
    // (9) حماية إضافية وقت الحساب: النسبة أقصاها 100%، والخصم لا يتعدى قيمة الطلب.
    const percent = Math.min(100, Math.max(0, Number(coupon.value) || 0));
    const discount = coupon.type === 'percent'
      ? Math.min(subtotal, Math.round((subtotal * percent) / 100))
      : Math.min(Number(coupon.value) || 0, subtotal);
    return { valid: true, code: coupon.code, type: coupon.type, value: coupon.value, discount };
  }

  // -------------------------------------------------------------------------
  // الطلبات
  // -------------------------------------------------------------------------
  function createOrder({ userId, customerName, customerPhone, customerAddress, paymentMethod, notes, items, couponCode, paymentProofUrl, transferRef }) {
    return tx(() => {
      const safeItems = [];
      const stockIssues = [];
      (items || []).forEach((item) => {
        const requested = Number(item.quantity);
        // (7) رفض الكميات السالبة/الصفر/غير الرقمية بدل تصحيحها بصمت
        if (!Number.isFinite(requested) || !Number.isInteger(requested) || requested < 1 || requested > 999) {
          const err = new Error('Invalid quantity');
          err.code = 'INVALID_QUANTITY';
          throw err;
        }
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(item.productId ?? item.id));
        if (!product || product.active !== 1) {
          stockIssues.push({ productId: Number(item.productId ?? item.id), name: item.name || 'منتج', available: 0, requested });
          return;
        }
        const available = Math.max(0, Number(product.stock || 0));
        // (6) لو الكمية المطلوبة أكبر من المخزون: نوقف الطلب ونبلّغ العميل صراحةً
        if (requested > available) {
          stockIssues.push({ productId: product.id, name: product.name, available, requested });
          return;
        }
        safeItems.push({ productId: product.id, name: product.name, price: Number(product.price), image_url: product.image_url || '', quantity: requested });
      });

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
      const settings = getSiteSettings();

      let discount = 0;
      let appliedCoupon = null;
      if (couponCode) {
        const result = evaluateCoupon(couponCode, subtotal, userId);
        // (9) لو الكوبون مش صالح (منتهي/مستهلك/مستخدم قبل كده) نرفض الطلب بدل تجاهله بصمت
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

      // (إصلاح سباق) إعادة استخدام نفس الإيصال بتتفحص جوّه نفس المعاملة، مش
      // في السيرفر قبلها — والقيد الفريد تحت بيمسك أي تزامن باقي.
      if (paymentProofUrl) {
        const used = db.prepare('SELECT id FROM orders WHERE payment_proof_url = ?').get(String(paymentProofUrl).slice(0, 200));
        if (used) {
          const err = new Error('Payment proof already used');
          err.code = 'PROOF_REUSED';
          throw err;
        }
      }

      const info = db.prepare(`INSERT INTO orders
        (user_id, customer_name, customer_phone, customer_address, payment_method, payment_status, status, notes,
         subtotal, discount, coupon_code, shipping_fee, tax, total_amount, notify_minutes, notify_at, notify_message, notified, confirmed_at, payment_proof_url, transfer_ref, history, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, NULL, ?, ?, ?, ?)`)
        .run(userId || null, String(customerName).trim().slice(0, 80), String(customerPhone).trim().slice(0, 30), String(customerAddress || '').slice(0, 300),
          paymentMethod, String(notes || '').slice(0, 500), subtotal, discount, appliedCoupon, shippingFee, tax, totalAmount,
          paymentProofUrl ? String(paymentProofUrl).slice(0, 200) : null,
          transferRef ? String(transferRef).trim().slice(0, 40) : null,
          JSON.stringify(history), nowISO());
      const orderId = Number(info.lastInsertRowid);

      const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, name, price, image_url, quantity) VALUES (?, ?, ?, ?, ?, ?)');
      safeItems.forEach((item) => {
        insertItem.run(orderId, item.productId, item.name, item.price, item.image_url, item.quantity);
        db.prepare('UPDATE products SET stock = MAX(0, stock - ?), sold = sold + ? WHERE id = ?').run(item.quantity, item.quantity, item.productId);
      });
      if (appliedCoupon) {
        // (9) الاستخدام يتسجل مرة واحدة لكل (كوبون + طلب) ويُحسب على العميل نفسه،
        // فمش ممكن يتكرر بإنشاء طلب ثم إلغائه.
        // العميل المسجّل: الإدخال العادي يعتمد على القيد الفريد (الكود، المستخدم)،
        // فأي طلبين متزامنين واحد بس منهم بينجح والتاني بيتلغى بالكامل (rollback).
        if (userId) {
          try {
            db.prepare('INSERT INTO coupon_redemptions (coupon_code, user_id, order_id, created_at) VALUES (?, ?, ?, ?)')
              .run(appliedCoupon, Number(userId), orderId, nowISO());
          } catch (error) {
            if (String(error.code || '').includes('CONSTRAINT')) {
              const err = new Error('سبق لك استخدام هذا الكوبون من قبل');
              err.code = 'INVALID_COUPON';
              err.reason = 'سبق لك استخدام هذا الكوبون من قبل';
              throw err;
            }
            throw error;
          }
        } else {
          db.prepare('INSERT OR IGNORE INTO coupon_redemptions (coupon_code, order_id, created_at) VALUES (?, ?, ?)')
            .run(appliedCoupon, orderId, nowISO());
        }
        // حد الاستخدام الكلي كذلك بقى ذري: التحديث نفسه بيتحقق من max_uses.
        const bumped = db.prepare('UPDATE coupons SET used = used + 1 WHERE code = ? AND (max_uses IS NULL OR max_uses = 0 OR used < max_uses)')
          .run(appliedCoupon).changes;
        if (!bumped) {
          const err = new Error('تم استهلاك هذا الكوبون بالكامل');
          err.code = 'INVALID_COUPON';
          err.reason = 'تم استهلاك هذا الكوبون بالكامل';
          throw err;
        }
      }

      return shapeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
    });
  }

  // ملكية إيصالات الدفع (بدل ملفات .owner على الديسك).
  // (إصلاح سباق) الفحص القديم كان SELECT قبل INSERT، فرفعتين متزامنتين لنفس
  // الصورة كانوا يعدّوا الاتنين. دلوقتي القاعدة نفسها هي اللي بترفض التكرار،
  // وبنترجم خطأ القيد لكود واضح للسيرفر.
  const recordPaymentProof = (filename, userId, sha256 = null) => {
    try {
      return db
        .prepare('INSERT INTO payment_proofs (filename, user_id, sha256, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(filename) DO UPDATE SET user_id = excluded.user_id, sha256 = excluded.sha256')
        .run(String(filename), userId === null || userId === undefined ? null : Number(userId), sha256 ? String(sha256) : null, nowISO()).changes > 0;
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
        const err = new Error('Duplicate payment proof');
        err.code = 'DUPLICATE_PROOF';
        throw err;
      }
      throw error;
    }
  };
  /** بيرجع أول إيصال مسجّل بنفس بصمة الصورة (لمنع إعادة استخدام نفس الصورة). */
  const getPaymentProofByHash = (sha256) => {
    if (!sha256) return null;
    return db.prepare('SELECT filename, user_id FROM payment_proofs WHERE sha256 = ? ORDER BY created_at LIMIT 1').get(String(sha256)) || null;
  };
  const getPaymentProofOwner = (filename) => {
    const row = db.prepare('SELECT user_id FROM payment_proofs WHERE filename = ?').get(String(filename));
    return row ? row.user_id : null;
  };
  const deletePaymentProof = (filename) => db.prepare('DELETE FROM payment_proofs WHERE filename = ?').run(String(filename)).changes > 0;

  // (إصلاح) إيصالات يتيمة: اترفعت ومحصلش طلب. بنرجّعها عشان مكنسة السيرفر
  // تحذفها من الديسك ومن القاعدة بدل ما تتراكم للأبد.
  const getOrphanPaymentProofs = (olderThanMs = 24 * 60 * 60 * 1000) => {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return db.prepare(`SELECT filename FROM payment_proofs
      WHERE created_at < ?
        AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.payment_proof_url LIKE '%/' || payment_proofs.filename)`)
      .all(cutoff).map((r) => r.filename);
  };

  // بيرجع الطلب المرتبط بصورة تحويل معيّنة (للتحقق من صلاحية عرض الصورة).
  const getOrderByProofFilename = (filename) => {
    const row = db.prepare("SELECT * FROM orders WHERE payment_proof_url LIKE ?").get(`%/${String(filename)}`);
    return row ? shapeOrder(row) : null;
  };

  // (إصلاح احتيال) نفس رقم عملية التحويل ما يتقبلش في أكتر من طلب.
  const getOrderByTransferRef = (ref) => {
    const value = String(ref || '').trim().toLowerCase();
    if (!value) return null;
    const row = db.prepare('SELECT * FROM orders WHERE lower(trim(transfer_ref)) = ?').get(value);
    return row ? shapeOrder(row) : null;
  };

  const getOrders = () => db.prepare('SELECT * FROM orders ORDER BY id DESC').all().map(shapeOrder);

  // (أداء) لوحة التحكم كانت بتحمّل كل الطلبات في الذاكرة وتفلتر بالـ JS — مع
  // آلاف الطلبات ده بيجمّد الـ event loop (better-sqlite3 متزامنة) ويعطّل
  // المتجر نفسه. الفلترة والترقيم بقوا في SQL.
  function queryOrders({ status, payment, from, to, q, page = 1, perPage = 20 } = {}) {
    const where = [];
    const args = [];
    if (status && status !== 'all') { where.push('status = ?'); args.push(String(status)); }
    if (payment && payment !== 'all') { where.push('payment_method = ?'); args.push(String(payment)); }
    if (from) { where.push('created_at >= ?'); args.push(new Date(from).toISOString()); }
    if (to) { where.push('created_at <= ?'); args.push(`${String(to)}T23:59:59.999Z`); }
    if (q) {
      where.push("(CAST(id AS TEXT) LIKE ? OR lower(customer_name) LIKE ? OR customer_phone LIKE ? OR lower(customer_address) LIKE ?)");
      const needle = `%${String(q).toLowerCase()}%`;
      args.push(needle, needle, needle, needle);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM orders ${clause}`).get(...args).n || 0);
    const safePage = Math.max(1, Number(page) || 1);
    const safePerPage = Math.min(100, Math.max(5, Number(perPage) || 20));
    const rows = db.prepare(`SELECT * FROM orders ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, safePerPage, (safePage - 1) * safePerPage);
    return {
      orders: rows.map(shapeOrder),
      total,
      page: safePage,
      perPage: safePerPage,
      pages: Math.max(1, Math.ceil(total / safePerPage))
    };
  }

  /** الطلبات للتصدير (بنفس فلاتر اللوحة) من غير ترقيم صفحات. */
  const getOrdersForExport = (filters = {}) => queryOrders({ ...filters, page: 1, perPage: 100000 }).orders;

  const getRecentOrders = (limit = 8) => db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?').all(Math.max(1, Number(limit) || 8)).map(shapeOrder);
  const getOrdersByUser = (userId) => db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(Number(userId)).map(shapeOrder);
  const getOrderById = (id) => shapeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id)));

  function restoreStockForOrder(orderId) {
    loadOrderItems(orderId).forEach((item) => {
      db.prepare('UPDATE products SET stock = stock + ?, sold = MAX(0, sold - ?) WHERE id = ?').run(item.quantity, item.quantity, item.productId);
    });
  }

  // (8) لو الطلب رجع من حالة «ملغي» لأي حالة نشطة تاني، لازم نخصم المخزون من
  // جديد — قبل كده كان الإلغاء بيرجّع الكمية والتراجع عن الإلغاء ما بيخصمش،
  // فكان المخزون بيتضخّم من غير سبب. لو الكمية مش متاحة دلوقتي نرفض العملية.
  function deductStockForOrder(orderId) {
    const items = loadOrderItems(orderId);
    const issues = [];
    items.forEach((item) => {
      const product = db.prepare('SELECT id, name, stock FROM products WHERE id = ?').get(item.productId);
      if (!product) { issues.push({ productId: item.productId, name: item.name, available: 0, requested: item.quantity }); return; }
      if (Number(product.stock || 0) < item.quantity) {
        issues.push({ productId: product.id, name: product.name, available: Number(product.stock || 0), requested: item.quantity });
      }
    });
    if (issues.length) {
      const err = new Error('Insufficient stock');
      err.code = 'INSUFFICIENT_STOCK';
      err.issues = issues;
      throw err;
    }
    items.forEach((item) => {
      db.prepare('UPDATE products SET stock = MAX(0, stock - ?), sold = sold + ? WHERE id = ?')
        .run(item.quantity, item.quantity, item.productId);
    });
  }

  const ORDER_STATUS_VALUES = ['pending', 'confirmed', 'shipping', 'done', 'cancelled'];
  const PAYMENT_STATUS_VALUES = ['pending', 'paid', 'failed', 'refunded'];

  function updateOrder(id, updates, note) {
    // (إصلاح) قائمة مسموحة صارمة: حالة غير معروفة كانت بتتخزّن عادي من غير ما
    // يتنفّذ خصم/استرجاع المخزون، فتفضل البيانات غير متسقة من غير أي خطأ.
    if (updates && updates.status !== undefined && !ORDER_STATUS_VALUES.includes(updates.status)) {
      throw new Error('حالة الطلب غير صالحة');
    }
    if (updates && updates.payment_status !== undefined && !PAYMENT_STATUS_VALUES.includes(updates.payment_status)) {
      throw new Error('حالة الدفع غير صالحة');
    }
    return tx(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
      if (!order) return null;
      const previousStatus = order.status;
      const fieldMap = {
        status: 'status', payment_status: 'payment_status', notes: 'notes', customer_name: 'customer_name',
        customer_phone: 'customer_phone', customer_address: 'customer_address', payment_proof_url: 'payment_proof_url'
      };
      const sets = [];
      const params = [];
      Object.keys(updates).forEach((key) => {
        if (updates[key] !== undefined && fieldMap[key]) { sets.push(`${fieldMap[key]} = ?`); params.push(updates[key]); }
      });
      let history = [];
      try { history = JSON.parse(order.history || '[]'); } catch (_) { history = []; }
      if (updates.status && updates.status !== previousStatus) {
        history.push({ status: updates.status, at: nowISO(), note: note || '' });
        sets.push('history = ?'); params.push(JSON.stringify(history));
        if (updates.status === 'cancelled' && previousStatus !== 'cancelled') {
          restoreStockForOrder(order.id);
          // (9) لا نُرجّع رصيد الكوبون عند الإلغاء — ده كان بيسمح بإعادة استخدام
          // نفس الكوبون عدد لا نهائي من المرات عبر (اطلب ثم ألغِ).
        }
        // (8) التراجع عن الإلغاء يخصم المخزون تاني (داخل نفس الـ transaction،
        // فلو الكمية مش متاحة العملية كلها بترجع زي ما كانت).
        if (previousStatus === 'cancelled' && updates.status !== 'cancelled') {
          deductStockForOrder(order.id);
        }
        if (updates.status === 'done' && order.payment_status === 'pending') { sets.push('payment_status = ?'); params.push('paid'); }
      }
      if (sets.length) {
        params.push(order.id);
        db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      }
      return shapeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
    });
  }

  function scheduleOrderNotification(id, { notifyMinutes, notifyMessage }) {
    return tx(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
      if (!order) return null;
      let history = [];
      try { history = JSON.parse(order.history || '[]'); } catch (_) { history = []; }
      history.push({ status: 'confirmed', at: nowISO(), note: 'تم تأكيد الطلب من لوحة التحكم' });
      const minutes = Number(notifyMinutes);
      let notifyAt = null; let notifyMsg = null; let notified = 1;
      if (minutes > 0) {
        notifyAt = new Date(Date.now() + minutes * 60000).toISOString();
        notifyMsg = String(notifyMessage || '').slice(0, 300) || null;
        notified = 0;
      }
      db.prepare(`UPDATE orders SET status='confirmed', confirmed_at=?, history=?, notify_minutes=?, notify_at=?, notify_message=?, notified=? WHERE id=?`)
        .run(nowISO(), JSON.stringify(history), minutes > 0 ? minutes : null, notifyAt, notifyMsg, notified, order.id);
      return shapeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
    });
  }

  const markOrderNotified = (id) => {
    db.prepare('UPDATE orders SET notified = 1 WHERE id = ?').run(Number(id));
    return getOrderById(id);
  };

  // (10) حجز ذرّي للإشعار: يرجع true لمرة واحدة بس، فمفيش إشعار مكرر لو اشتغل
  // المؤقّت والمكنسة في نفس اللحظة. لو الإرسال فشل بنفك الحجز بـ releaseOrderNotification
  // عشان تتم إعادة المحاولة، بدل ما يتحط notified = 1 قبل الإرسال الفعلي.
  const claimOrderNotification = (id) =>
    db.prepare('UPDATE orders SET notified = 1 WHERE id = ? AND notified = 0').run(Number(id)).changes > 0;
  const releaseOrderNotification = (id) =>
    db.prepare('UPDATE orders SET notified = 0 WHERE id = ?').run(Number(id)).changes > 0;

  const getPendingScheduledNotifications = () => db.prepare('SELECT * FROM orders WHERE notify_at IS NOT NULL AND notified = 0').all().map(shapeOrder);

  // -------------------------------------------------------------------------
  // التقييمات
  // -------------------------------------------------------------------------
  function addReview({ productId, userId, userName, rating, comment }) {
    return tx(() => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(productId));
      if (!product) throw new Error('Product not found');
      const stars = clampNumber(rating, 1, 5, 5);
      const existing = db.prepare('SELECT * FROM reviews WHERE product_id = ? AND user_id = ?').get(product.id, Number(userId));
      if (existing) {
        db.prepare('UPDATE products SET rating_sum = rating_sum - ? + ? WHERE id = ?').run(existing.rating, stars, product.id);
        db.prepare('UPDATE reviews SET rating=?, comment=?, updated_at=?, approved=1 WHERE id=?')
          .run(stars, String(comment || '').slice(0, 600), nowISO(), existing.id);
        return db.prepare('SELECT * FROM reviews WHERE id = ?').get(existing.id);
      }
      const info = db.prepare(`INSERT INTO reviews (product_id, user_id, user_name, rating, comment, approved, created_at)
                                VALUES (?, ?, ?, ?, ?, 1, ?)`)
        .run(product.id, Number(userId), String(userName || 'عميل').slice(0, 60), stars, String(comment || '').slice(0, 600), nowISO());
      db.prepare('UPDATE products SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE id = ?').run(stars, product.id);
      return db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(info.lastInsertRowid));
    });
  }

  const getReviewsByProduct = (productId) => db.prepare('SELECT * FROM reviews WHERE product_id = ? AND approved = 1 ORDER BY id DESC').all(Number(productId));

  const getAllReviews = () => db.prepare(`
    SELECT r.*, COALESCE(p.name, '—') as product_name FROM reviews r LEFT JOIN products p ON p.id = r.product_id ORDER BY r.id DESC
  `).all();

  const deleteReview = (id) => tx(() => {
    const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(id));
    if (!review) return false;
    db.prepare('UPDATE products SET rating_sum = MAX(0, rating_sum - ?), rating_count = MAX(0, rating_count - 1) WHERE id = ?').run(review.rating, review.product_id);
    db.prepare('DELETE FROM reviews WHERE id = ?').run(review.id);
    return true;
  });

  // -------------------------------------------------------------------------
  // المفضلة
  // -------------------------------------------------------------------------
  const getWishlist = (userId) => db.prepare(`
    SELECT p.* FROM products p INNER JOIN wishlists w ON w.product_id = p.id
    WHERE w.user_id = ? AND p.active = 1 ORDER BY w.created_at DESC
  `).all(Number(userId)).map(decorateProduct);

  const toggleWishlist = (userId, productId) => {
    const uid = Number(userId); const pid = Number(productId);
    const existing = db.prepare('SELECT 1 FROM wishlists WHERE user_id = ? AND product_id = ?').get(uid, pid);
    if (existing) { db.prepare('DELETE FROM wishlists WHERE user_id = ? AND product_id = ?').run(uid, pid); return { inWishlist: false }; }
    db.prepare('INSERT INTO wishlists (user_id, product_id, created_at) VALUES (?, ?, ?)').run(uid, pid, nowISO());
    return { inWishlist: true };
  };

  // -------------------------------------------------------------------------
  // الإشعارات + الاشتراكات
  // -------------------------------------------------------------------------
  function addNotification({ userId, orderId, title, body }) {
    const info = db.prepare('INSERT INTO notifications (user_id, order_id, title, body, read, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(Number(userId), orderId || null, title, body, nowISO());
    // (إصلاح أداء) التنظيف كان بيتنفّذ مع كل إشعار (وده بيتضاعف مع البث
    // الجماعي). دلوقتي بيتنفّذ كل 100 إشعار للمستخدم بس — نفس النتيجة بتكلفة
    // أقل بكتير.
    if (Number(info.lastInsertRowid) % 100 === 0) {
      db.prepare(`DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
        SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1000)`).run(Number(userId), Number(userId));
    }
    return db.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(info.lastInsertRowid));
  }

  const getNotificationsByUser = (userId) => db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 40').all(Number(userId));

  const markNotificationRead = (id, userId) => {
    db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(Number(id), Number(userId));
    return db.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(id)) || null;
  };

  const markAllNotificationsRead = (userId) => {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(Number(userId));
    return true;
  };

  const broadcastNotification = ({ title, body }) => tx(() => {
    const customers = db.prepare("SELECT id FROM users WHERE role != 'admin'").all();
    const insert = db.prepare('INSERT INTO notifications (user_id, order_id, title, body, read, created_at) VALUES (?, NULL, ?, ?, 0, ?)');
    customers.forEach((u) => insert.run(u.id, title, body, nowISO()));
    return customers.map((u) => u.id);
  });

  const MAX_PUSH_SUBS_PER_USER = 10;
  const addPushSubscription = (userId, subscription) => {
    const existing = db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ?').get(subscription.endpoint);
    if (!existing) {
      // (إصلاح) سقف لكل مستخدم: بنشيل أقدم اشتراك بدل ما نكدّس آلاف اشتراكات.
      const count = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(Number(userId)).n;
      if (count >= MAX_PUSH_SUBS_PER_USER) {
        db.prepare('DELETE FROM push_subscriptions WHERE id IN (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id ASC LIMIT ?)')
          .run(Number(userId), count - MAX_PUSH_SUBS_PER_USER + 1);
      }
      db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, keys, created_at) VALUES (?, ?, ?, ?)')
        .run(Number(userId), subscription.endpoint, JSON.stringify(subscription.keys || {}), nowISO());
    }
    return true;
  };

  const removePushSubscription = (endpoint) => {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    return true;
  };

  const getPushSubscriptionsByUser = (userId) => db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(Number(userId))
    .map((row) => ({ endpoint: row.endpoint, keys: JSON.parse(row.keys || '{}') }));

  // -------------------------------------------------------------------------
  // الإعدادات والأسرار
  // -------------------------------------------------------------------------
  function getSiteSettings() {
    const rows = db.prepare('SELECT key, value FROM site_settings').all();
    const stored = {};
    rows.forEach((r) => { stored[r.key] = r.value; });
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    Object.keys(merged).forEach((key) => {
      if (SETTINGS_NUMERIC_KEYS.has(key)) merged[key] = Number(merged[key]);
    });
    return merged;
  }

  function updateSiteSettings(payload) {
    return tx(() => {
      const allowedText = ['name', 'tagline', 'phone', 'address', 'whatsappNumber', 'email', 'facebook', 'instagram', 'currency', 'announcement', 'vodafoneCashNumber', 'instapayNumber', 'logoUrl', 'coverUrl', 'primaryColor'];
      const upsert = db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      allowedText.forEach((key) => { if (payload[key] !== undefined) upsert.run(key, String(payload[key]).slice(0, 300)); });
      if (payload.shippingFee !== undefined) upsert.run('shippingFee', String(clampNumber(payload.shippingFee, 0, 100000, 0)));
      if (payload.freeShippingOver !== undefined) upsert.run('freeShippingOver', String(clampNumber(payload.freeShippingOver, 0, 1000000, 0)));
      if (payload.taxPercent !== undefined) upsert.run('taxPercent', String(clampNumber(payload.taxPercent, 0, 100, 0)));
      if (payload.lowStockThreshold !== undefined) upsert.run('lowStockThreshold', String(clampNumber(payload.lowStockThreshold, 0, 10000, 5)));
      if (payload.storeOpen !== undefined) upsert.run('storeOpen', String(payload.storeOpen ? 1 : 0));
      return getSiteSettings();
    });
  }

  const getOrCreateSessionSecret = () => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'sessionSecret'").get();
    if (row) return row.value;
    const secret = crypto.randomBytes(48).toString('hex');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('sessionSecret', secret);
    return secret;
  };

  const getOrCreateVapidKeys = (generator) => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'vapid'").get();
    if (row) { try { const parsed = JSON.parse(row.value); if (parsed.publicKey && parsed.privateKey) return parsed; } catch (_) { /* تجاهل */ } }
    const keys = generator();
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('vapid', JSON.stringify(keys));
    return keys;
  };

  // -------------------------------------------------------------------------
  // سجل نشاط الأدمن
  // -------------------------------------------------------------------------
  const logActivity = ({ userId, userName, action, details }) => {
    db.prepare('INSERT INTO activity_log (user_id, user_name, action, details, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId || null, userName || 'نظام', action, String(details || '').slice(0, 300), nowISO());
    db.prepare(`DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT 500)`).run();
    return true;
  };

  const getActivityLog = (limit = 100) => db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?').all(limit);

  // -------------------------------------------------------------------------
  // الإحصائيات والتحليلات
  // -------------------------------------------------------------------------
  function getAnalytics(days = 14) {
    // (إصلاح أداء) الداشبورد كان بيعمل استعلام منفصل لكل طلب عشان يجيب عناصره
    // (N+1) وبيحمّل كل حاجة في الذاكرة. دلوقتي الأعمدة المطلوبة بس، وأعلى
    // المنتجات بتتحسب بـ GROUP BY في SQL.
    const orders = db.prepare('SELECT id, user_id, status, payment_status, payment_method, total_amount, customer_name, created_at FROM orders').all();
    const products = db.prepare('SELECT * FROM products').all();
    const settings = getSiteSettings();
    const paidOrders = orders.filter((o) => o.status !== 'cancelled');
    const revenue = paidOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayOrders = paidOrders.filter((o) => new Date(o.created_at) >= today);

    const series = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - i);
      const next = new Date(day); next.setDate(next.getDate() + 1);
      const dayOrders = paidOrders.filter((o) => { const at = new Date(o.created_at); return at >= day && at < next; });
      series.push({ date: day.toISOString().slice(0, 10), orders: dayOrders.length, revenue: dayOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0) });
    }

    const topProductRows = db.prepare(`
      SELECT oi.product_id as productId, MAX(oi.name) as name,
             SUM(oi.quantity) as quantity, SUM(oi.quantity * oi.price) as revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status != 'cancelled'
      GROUP BY oi.product_id
      ORDER BY quantity DESC
      LIMIT 8
    `).all();

    const statusCounts = orders.reduce((acc, o) => { acc[o.status] = (acc[o.status] || 0) + 1; return acc; }, {});
    const paymentCounts = orders.reduce((acc, o) => { acc[o.payment_method] = (acc[o.payment_method] || 0) + 1; return acc; }, {});

    const customerTotals = new Map();
    paidOrders.forEach((o) => {
      if (!o.user_id) return;
      const entry = customerTotals.get(o.user_id) || { userId: o.user_id, name: o.customer_name, orders: 0, total: 0 };
      entry.orders += 1;
      entry.total += Number(o.total_amount || 0);
      customerTotals.set(o.user_id, entry);
    });

    const usersCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const customersCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role != 'admin'").get().c;
    const reviewsCount = db.prepare('SELECT COUNT(*) as c FROM reviews').get().c;
    const couponsActive = db.prepare('SELECT COUNT(*) as c FROM coupons WHERE active = 1').get().c;

    return {
      stats: {
        orders: orders.length,
        products: products.length,
        activeProducts: products.filter((p) => p.active === 1).length,
        users: usersCount,
        customers: customersCount,
        pendingOrders: orders.filter((o) => o.status === 'pending').length,
        confirmedOrders: orders.filter((o) => o.status === 'confirmed').length,
        doneOrders: orders.filter((o) => o.status === 'done').length,
        cancelledOrders: orders.filter((o) => o.status === 'cancelled').length,
        totalRevenue: revenue,
        todayRevenue: todayOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0),
        todayOrders: todayOrders.length,
        averageOrder: paidOrders.length ? Math.round(revenue / paidOrders.length) : 0,
        lowStock: products.filter((p) => p.active === 1 && Number(p.stock || 0) <= Number(settings.lowStockThreshold || 5)).length,
        inventoryValue: products.reduce((sum, p) => sum + Number(p.price || 0) * Number(p.stock || 0), 0),
        reviews: reviewsCount,
        coupons: couponsActive
      },
      series,
      topProducts: topProductRows.map((r) => ({ productId: r.productId, name: r.name, quantity: Number(r.quantity || 0), revenue: Number(r.revenue || 0) })),
      topCustomers: [...customerTotals.values()].sort((a, b) => b.total - a.total).slice(0, 6),
      statusCounts,
      paymentCounts,
      categories: getCategories()
    };
  }

  // -------------------------------------------------------------------------
  // النظام: حفظ فوري (SQLite يكتب فورًا)، نسخ احتياطي، لقطة كاملة
  // -------------------------------------------------------------------------
  const flush = () => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) { /* لا شيء */ } };

  const backup = () => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      // ⚠️ تحذير أمني هام: VACUUM INTO بتتنفذ عن طريق بناء نص SQL يدويًا —
      // sqlite ما بيدعمش parameter binding لاسم الملف في VACUUM INTO. عشان كده
      // لازم نتأكد إن المسار مبني بالكامل من عندنا (stamp ISO ثابت الشكل)،
      // مش من أي مدخل خارجي، وإنه فعليًا جوه backupDir، ومفيهوش quotes أو
      // حروف تقدر تكسر جملة الـ SQL أو تعمل path traversal.
      const target = path.join(backupDir, `store-${stamp}.db`);
      const resolvedTarget = path.resolve(target);
      const resolvedBackupDir = path.resolve(backupDir);
      const isInsideBackupDir = resolvedTarget === resolvedBackupDir
        || resolvedTarget.startsWith(resolvedBackupDir + path.sep);
      if (!isInsideBackupDir || /['"\x00]/.test(resolvedTarget)) {
        throw new Error('مسار النسخة الاحتياطية غير آمن، تم إلغاء العملية');
      }
      db.exec(`VACUUM INTO '${resolvedTarget.replace(/'/g, "''")}'`);
      const files = fs.readdirSync(backupDir).filter((f) => f.startsWith('store-') && f.endsWith('.db')).sort();
      while (files.length > 20) { const oldest = files.shift(); try { fs.unlinkSync(path.join(backupDir, oldest)); } catch (_) { /* لا شيء */ } }
      return true;
    } catch (error) {
      console.error('[store] فشل إنشاء نسخة احتياطية:', error.message);
      return false;
    }
  };

  const getRawSnapshot = () => ({
    schemaVersion: SCHEMA_VERSION,
    users: db.prepare('SELECT * FROM users').all(),
    products: db.prepare('SELECT * FROM products').all().map(decorateProduct),
    orders: db.prepare('SELECT * FROM orders').all().map(shapeOrder),
    coupons: db.prepare('SELECT * FROM coupons').all(),
    reviews: db.prepare('SELECT * FROM reviews').all(),
    wishlists: db.prepare('SELECT * FROM wishlists').all(),
    notifications: db.prepare('SELECT * FROM notifications').all(),
    pushSubscriptions: db.prepare('SELECT * FROM push_subscriptions').all(),
    activityLog: db.prepare('SELECT * FROM activity_log').all(),
    siteSettings: getSiteSettings(),
    sessionSecret: null,
    vapid: null
  });

  return {
    // نظام
    flush, backup, ensureAdmin, getRawSnapshot, getAdminUsers, getStalePendingOrders,
    // مستخدمون
    getUsers, getUsersWithStats, findUserByEmail, findUserByNormalizedEmail, findUserById, createUser, createUserAsync, verifyPassword, verifyPasswordAsync, hashPasswordAsync, comparePasswordAsync, updateUser, updateUserPasswordAsync, deleteUser, sanitizeUser, bumpSessionVersion, hasAdmin,
    // توكنات المصادقة، تفعيل البريد، وكلمة المرور
    createAuthToken, consumeAuthToken, createAuthCode, consumeAuthCode, invalidateAuthTokens, purgeExpiredAuthTokens, markEmailVerified, setUserPassword, setUserPasswordHash, setUserPasswordAsync,
    // إبطال الجلسات
    revokeSession, isSessionRevoked, purgeExpiredRevokedSessions,
    // التحقق بخطوتين
    setTotpSecret, enableTotp, disableTotp, getTotpSecret, claimTotpCode,
    // حدود المعدّل الدائمة
    rateLimitHit, rateLimitGet, rateLimitSet, resetRateLimit, purgeExpiredRateLimits,
    // منتجات
    getProducts, getProductById, createProduct, updateProduct, deleteProduct, adjustStock,
    incrementProductViews, getCategories, getLowStockProducts,
    // كوبونات
    getCoupons, createCoupon, updateCoupon, deleteCoupon, evaluateCoupon,
    // طلبات
    createOrder, getOrders, queryOrders, getOrdersForExport, getRecentOrders, getOrdersByUser, getOrderById, updateOrder, getOrderByProofFilename, getOrderByTransferRef,
    recordPaymentProof, getPaymentProofOwner, getPaymentProofByHash, deletePaymentProof, getOrphanPaymentProofs,
    scheduleOrderNotification, markOrderNotified, claimOrderNotification, releaseOrderNotification,
    getPendingScheduledNotifications,
    // تقييمات ومفضلة
    addReview, getReviewsByProduct, getAllReviews, deleteReview, getWishlist, toggleWishlist,
    // إشعارات
    addNotification, getNotificationsByUser, markNotificationRead, markAllNotificationsRead,
    broadcastNotification, addPushSubscription, removePushSubscription, getPushSubscriptionsByUser,
    // إعدادات
    getSiteSettings, updateSiteSettings, getOrCreateSessionSecret, getOrCreateVapidKeys,
    // سجل وتحليلات
    logActivity, getActivityLog, getAnalytics
  };
}

// ---------------------------------------------------------------------------
// هجرة البيانات من store.json القديم إلى قاعدة بيانات SQLite الجديدة
// ---------------------------------------------------------------------------
function migrateFromLegacyJson(db, legacyJsonPath) {
  const raw = JSON.parse(fs.readFileSync(legacyJsonPath, 'utf8'));

  db.exec('BEGIN IMMEDIATE');
  try {
    const insertUser = db.prepare(`INSERT INTO users (id, name, email, password_hash, role, phone, address, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (raw.users || []).forEach((u) => insertUser.run(u.id, u.name, u.email, u.password_hash, u.role, u.phone || '', u.address || '', u.must_change_password ? 1 : 0, u.created_at || nowISO()));

    const insertProduct = db.prepare(`INSERT INTO products (id, sku, name, category, description, price, old_price, tag, image_url, images, stock, featured, sold, views, rating_sum, rating_count, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (raw.products || []).forEach((p) => insertProduct.run(
      p.id, p.sku || `YS-${String(p.id).padStart(4, '0')}`, p.name, p.category || 'عام', p.description || '',
      Number(p.price) || 0, p.old_price != null ? Number(p.old_price) : null, p.tag || '', p.image_url || '', JSON.stringify(p.images || []),
      Number(p.stock) || 0, p.featured ? 1 : 0, Number(p.sold) || 0, Number(p.views) || 0, Number(p.rating_sum) || 0, Number(p.rating_count) || 0,
      p.active === 0 ? 0 : 1, p.created_at || nowISO(), p.updated_at || p.created_at || nowISO()
    ));

    const insertCoupon = db.prepare(`INSERT INTO coupons (id, code, type, value, min_total, max_uses, used, expires_at, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (raw.coupons || []).forEach((c) => insertCoupon.run(c.id, c.code, c.type || 'percent', Number(c.value) || 0, Number(c.min_total) || 0, Number(c.max_uses) || 0, Number(c.used) || 0, c.expires_at || null, c.active === 0 ? 0 : 1, c.created_at || nowISO()));

    const insertOrder = db.prepare(`INSERT INTO orders (id, user_id, customer_name, customer_phone, customer_address, payment_method, payment_status, status, notes, subtotal, discount, coupon_code, shipping_fee, tax, total_amount, notify_minutes, notify_at, notify_message, notified, confirmed_at, payment_proof_url, history, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertOrderItem = db.prepare('INSERT INTO order_items (order_id, product_id, name, price, image_url, quantity) VALUES (?, ?, ?, ?, ?, ?)');
    (raw.orders || []).forEach((o) => {
      let items = [];
      try { items = JSON.parse(o.items_json || '[]'); } catch (_) { items = []; }
      insertOrder.run(
        o.id, o.user_id || null, o.customer_name || '', o.customer_phone || '', o.customer_address || '', o.payment_method || '',
        o.payment_status || 'pending', o.status || 'pending', o.notes || '', Number(o.subtotal) || 0, Number(o.discount) || 0,
        o.coupon_code || null, Number(o.shipping_fee) || 0, Number(o.tax) || 0, Number(o.total_amount) || 0,
        o.notify_minutes || null, o.notify_at || null, o.notify_message || null, o.notified === false ? 0 : 1,
        o.confirmed_at || null, o.payment_proof_url || null, JSON.stringify(o.history || []), o.created_at || nowISO()
      );
      items.forEach((item) => insertOrderItem.run(o.id, item.productId, item.name, item.price, item.image_url || '', item.quantity));
    });

    const insertReview = db.prepare(`INSERT INTO reviews (id, product_id, user_id, user_name, rating, comment, approved, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (raw.reviews || []).forEach((r) => insertReview.run(r.id, r.product_id, r.user_id, r.user_name || 'عميل', r.rating || 5, r.comment || '', r.approved === 0 ? 0 : 1, r.created_at || nowISO(), r.updated_at || null));

    const insertWishlist = db.prepare('INSERT OR IGNORE INTO wishlists (user_id, product_id, created_at) VALUES (?, ?, ?)');
    (raw.wishlists || []).forEach((w) => insertWishlist.run(w.user_id, w.product_id, w.created_at || nowISO()));

    const insertNotif = db.prepare('INSERT INTO notifications (id, user_id, order_id, title, body, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    (raw.notifications || []).forEach((n) => insertNotif.run(n.id, n.user_id, n.order_id || null, n.title, n.body, n.read ? 1 : 0, n.created_at || nowISO()));

    const insertSub = db.prepare('INSERT OR IGNORE INTO push_subscriptions (user_id, endpoint, keys, created_at) VALUES (?, ?, ?, ?)');
    (raw.pushSubscriptions || []).forEach((sub) => insertSub.run(sub.userId, sub.endpoint, JSON.stringify(sub.keys || {}), sub.created_at || nowISO()));

    const insertActivity = db.prepare('INSERT INTO activity_log (id, user_id, user_name, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    (raw.activityLog || []).forEach((a) => insertActivity.run(a.id, a.user_id || null, a.user_name || 'نظام', a.action, a.details || '', a.created_at || nowISO()));

    const settings = raw.siteSettings || {};
    const upsertSetting = db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    Object.keys(settings).forEach((key) => { if (settings[key] !== undefined && settings[key] !== null) upsertSetting.run(key, String(settings[key])); });

    if (raw.sessionSecret) db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('sessionSecret', raw.sessionSecret);
    if (raw.vapid) db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('vapid', JSON.stringify(raw.vapid));

    // ملاحظة: SQLite يحدّث عدّاد AUTOINCREMENT (sqlite_sequence) تلقائيًا كل ما
    // نُدرج صفًا بمعرّف صريح أكبر من الحالي، فمفيش داعي لأي مواءمة يدوية هنا —
    // الصفوف الجديدة بعد الهجرة هتاخد IDs تالية صح من غير أي تصادم.

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function seedDefaultsIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
  if (count > 0) return;
  const now = nowISO();
  const insert = db.prepare(`INSERT INTO products (sku, name, category, description, price, old_price, tag, image_url, images, stock, featured, sold, views, rating_sum, rating_count, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 0, 0, 0, 0, 1, ?, ?)`);
  defaultProductsSeed().forEach((p) => insert.run(p.sku, p.name, p.category, p.description, p.price, p.old_price, p.tag, p.image_url, p.stock, p.featured, now, now));
  db.prepare(`INSERT INTO coupons (code, type, value, min_total, max_uses, used, expires_at, active, created_at) VALUES ('WELCOME10','percent',10,300,200,0,NULL,1,?)`).run(now);
}

module.exports = { createStore };
