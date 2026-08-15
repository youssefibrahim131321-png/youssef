/**
 * test/helpers/test-db.js
 * ---------------------------------------------------------------------------
 * تهيئة قاعدة بيانات الاختبارات. لازم يتعمله require **قبل** أي require لـ
 * store.js أو server.js.
 *
 * المشكلة اللي بيحلها: الاختبارات كانت بتعتمد على قاعدة البيانات المتاحة في
 * البيئة. لو DATABASE_URL مظبوط (جهاز مطوّر أو CI) الاختبارات كانت هتكتب في
 * قاعدة حقيقية، ولو مش مظبوط كانت بتنجح بالحظ على الـ fallback. دلوقتي:
 *
 *   - DATABASE_URL بيتشال من بيئة الاختبار بالقوة → مفيش أي احتمال نلمس قاعدة
 *     حقيقية بالغلط.
 *   - كل اختبار بياخد قاعدة PostgreSQL في الذاكرة (pg-mem) معزولة تمامًا.
 *   - لو pg-mem مش متثبتة بنفشل برسالة واضحة بدل فشل غامض في أول استعلام.
 *   - بنسكّت تحذير "DATABASE_URL فاضي" عشان مخرج الاختبارات يبقى نظيف.
 *
 * الاستخدام:
 *   const { testEnv, freshStore } = require('./helpers/test-db');
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// (1) عزل تام عن أي قاعدة بيانات في البيئة.
delete process.env.DATABASE_URL;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.ALLOW_EPHEMERAL_STORAGE = '1';
process.env.STORE_QUIET = '1';

// (2) fail fast لو محرك القاعدة في الذاكرة مش متاح.
try {
  require.resolve('pg-mem');
} catch (_) {
  throw new Error(
    'الاختبارات محتاجة pg-mem (devDependency) عشان تشتغل على قاعدة بيانات في الذاكرة. شغّل: npm install'
  );
}

/** متغيرات البيئة اللي بتتمرّر لأي سيرفر بيتشغّل كـ child process في الاختبارات. */
function testEnv(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ys-test-'));
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: '',
    ALLOW_EPHEMERAL_STORAGE: '1',
    STORE_QUIET: '1',
    DATA_DIR: dataDir,
    UPLOADS_DIR: path.join(dataDir, 'uploads'),
    BACKUP_DIR: path.join(dataDir, 'backups'),
    REQUIRE_EMAIL_VERIFICATION: '0',
    EMAIL_GUARD_MX: '0',
    REQUIRE_IMAGE_OPTIMIZE: '0',
    ...extra
  };
  delete env.PAYMOB_SECRET_KEY;
  delete env.PAYMOB_HMAC_SECRET;
  return { env, dataDir };
}

/** مخزن جديد معزول (قاعدة في الذاكرة) لكل اختبار. */
async function freshStore() {
  const { createStore } = require('../../store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ys-store-'));
  return createStore(path.join(dir, 'store.json'));
}

module.exports = { testEnv, freshStore };
