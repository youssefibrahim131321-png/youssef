/**
 * قاعدة بيانات PostgreSQL في الذاكرة (pg-mem) للاختبارات والتشغيل السريع
 * المحلي — عشان `npm test` يشتغل من غير ما يكون عندك سيرفر Postgres حقيقي.
 *
 * بتتفعّل تلقائيًا فقط أثناء الاختبارات (NODE_ENV=test). أي استخدام آخر
 * (تطوير محلي مثلًا) لازم يفعّلها **صراحةً** بـ ALLOW_MEMORY_DB=1، وإلا
 * الإقلاع يفشل برسالة واضحة. الهدف منع سيناريو "نسيت تظبط DATABASE_URL
 * فاشتغل المتجر بصمت على بيانات في الذاكرة بتضيع مع أول Restart".
 * ممنوعة تمامًا في NODE_ENV=production تحت أي ظرف.
 */
function isInMemoryAllowed() {
  if (process.env.DATABASE_URL) return false;
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.ALLOW_IN_MEMORY_DB === '0') return false;
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.ALLOW_MEMORY_DB === '1') return true;
  return false;
}


function createMemoryPool() {
  let newDb;
  try {
    ({ newDb } = require('pg-mem'));
  } catch (_) {
    throw new Error(
      'DATABASE_URL غير مظبوط، وحزمة pg-mem مش متثبتة. ثبّتها بـ `npm install` ' +
      '(devDependency) أو حدّد DATABASE_URL لقاعدة PostgreSQL حقيقية.'
    );
  }
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const { DataType } = require('pg-mem');
  // دوال Postgres أصلية مش متوفرة في pg-mem لكن استعلاماتنا بتستخدمها.
  // من غيرها الاستعلام بيرمي "function X does not exist" جوه الراوت،
  // فالطلب بيفضل معلّق والاختبار بيقع في timeout بدل ما يبان الخطأ.
  const register = (name, args, returns, implementation) => {
    try { db.public.registerFunction({ name, args, returns, implementation }); }
    catch (_) { /* مسجّلة قبل كده أو مدعومة أصلًا */ }
  };
  register('now', [], DataType.text, () => new Date().toISOString());
  register('trim', [DataType.text], DataType.text, (v) => (v == null ? null : String(v).trim()));
  register('btrim', [DataType.text], DataType.text, (v) => (v == null ? null : String(v).trim()));
  register('ltrim', [DataType.text], DataType.text, (v) => (v == null ? null : String(v).replace(/^\s+/, '')));
  register('rtrim', [DataType.text], DataType.text, (v) => (v == null ? null : String(v).replace(/\s+$/, '')));
  register('lower', [DataType.text], DataType.text, (v) => (v == null ? null : String(v).toLowerCase()));
  register('upper', [DataType.text], DataType.text, (v) => (v == null ? null : String(v).toUpperCase()));
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  pool.__inMemory = true;
  return pool;
}

module.exports = { isInMemoryAllowed, createMemoryPool };
