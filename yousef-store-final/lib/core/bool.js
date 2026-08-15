/**
 * مساعد موحّد لقراءة القيم المنطقية الجاية من قاعدة البيانات.
 * -------------------------------------------------------------------------
 * بعد الانتقال لـ PostgreSQL بقت أعمدة BOOLEAN بترجع true/false بدل 1/0،
 * فأي مقارنة زي `x === 1` كانت بتفشل من غير ما تدي أي خطأ. الدالة دي
 * بتتعامل مع كل الأشكال: boolean، أرقام، ونصوص ('1' / 't' / 'true' / 'yes').
 */
function truthy(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 't' || s === 'true' || s === 'yes' || s === 'y' || s === 'on';
}

module.exports = { truthy };
