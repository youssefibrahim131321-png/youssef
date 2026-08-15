/**
 * سياسة كلمة المرور (موحّدة لكل المسارات)
 * ---------------------------------------------------------------------------
 * (إصلاح) كان كل مسار بيفحص الطول (>= 8) بس وبدون أي شرط تعقيد، والحسابات دي
 * فيها عناوين عملاء وبيانات طلبات ودفع. دلوقتي: 8 أحرف على الأقل + حرف + رقم،
 * مع رفض قائمة صغيرة من كلمات المرور الشائعة جدًا. نفس القاعدة بالحرف في
 * التسجيل، تغيير كلمة المرور، إعادة التعيين، وإنشاء/تعديل مستخدم من الأدمن.
 */
const MIN_LENGTH = 8;
const MAX_LENGTH = 100;

// أشهر كلمات المرور المسرّبة — رفض مباشر بدون أي اتصال خارجي.
const COMMON = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'password123',
  'qwerty123', 'iloveyou', 'admin123', 'welcome1', 'abc12345', 'letmein1',
  '11111111', '00000000', 'passw0rd', 'football1', 'sunshine1', 'qwertyui'
]);

/** @returns {string|null} رسالة الخطأ بالعربي، أو null لو كلمة المرور مقبولة. */
function passwordPolicyError(value) {
  const password = String(value == null ? '' : value);
  if (!password) return 'كلمة المرور مطلوبة';
  if (password.length < MIN_LENGTH) return `كلمة المرور يجب ألا تقل عن ${MIN_LENGTH} أحرف`;
  if (password.length > MAX_LENGTH) return 'كلمة المرور طويلة جدًا';
  if (!/[A-Za-z\u0600-\u06FF]/.test(password) || !/[0-9]/.test(password)) {
    return 'كلمة المرور يجب أن تحتوي على حرف ورقم على الأقل';
  }
  if (COMMON.has(password.toLowerCase())) return 'كلمة المرور دي شائعة جدًا وسهلة التخمين — اختر واحدة أقوى';
  return null;
}

module.exports = { passwordPolicyError, MIN_LENGTH, MAX_LENGTH };
