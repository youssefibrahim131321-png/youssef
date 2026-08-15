// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
module.exports = async function ensureAdminAccount(deps = {}) {
  const { DATA_DIR, crypto, fs, path, store } = deps;
  // ---------------------------------------------------------------------------
  // حساب الأدمن: يُقرأ من متغيرات البيئة إن وُجدت. لو أول تشغيل للموقع (مفيش
  // أدمن لسه) ومفيش ADMIN_PASSWORD متحدد، نولّد كلمة مرور قوية عشوائية بدل
  // admin123 المعروفة للجميع، ونطبعها في السجل مرة واحدة بس. مهم: ده بيحصل بس
  // لو مفيش أدمن أصلًا، عشان إعادة تشغيل السيرفر (على Railway مثلًا) ما تعملش
  // إعادة تعيين لكلمة مرور غيّرها صاحب المتجر بنفسه من قبل.
  const adminAlreadyExists = await store.hasAdmin();
  // (إصلاح) ADMIN_PASSWORD_RESET=1 = ولّد كلمة مرور جديدة للأدمن دلوقتي حتى لو
  // الحساب موجود. ده طوق النجاة لما كلمة السر تضيع ومفيش بريد شغّال: ظبّط
  // المتغير، أعد التشغيل، هتلاقي كلمة المرور في اللوج وفي ملف داخل مجلد البيانات،
  // ادخل بيها وغيّرها من لوحة التحكم، وبعدين شيل المتغير.
  const FORCE_ADMIN_RESET = String(process.env.ADMIN_PASSWORD_RESET || '') === '1';
  let generatedAdminPassword = null;
  // (إصلاح جوهري) كلمة مرور الأدمن بقت ثابتة: أول تشغيل بس — أو
  // ADMIN_PASSWORD_RESET=1 صراحةً — هو اللي بيحدد أو يغيّر كلمة المرور.
  // قبل كده وجود ADMIN_PASSWORD في متغيرات البيئة كان بيعيد كتابة كلمة المرور
  // مع كل إعادة تشغيل/نشر، فأي كلمة مرور بيغيّرها صاحب المتجر من اللوحة كانت
  // بترجع للقديمة بعد أول تحديث للموقع.
  let effectiveAdminPassword = null;
  if (!adminAlreadyExists || FORCE_ADMIN_RESET) {
    effectiveAdminPassword = process.env.ADMIN_PASSWORD || null;
    if (!effectiveAdminPassword) {
      generatedAdminPassword = crypto.randomBytes(9).toString('base64url');
      effectiveAdminPassword = generatedAdminPassword;
    }
  } else if (process.env.ADMIN_PASSWORD) {
    console.warn('\x1b[33mℹ️  ADMIN_PASSWORD موجود في متغيرات البيئة لكن حساب الأدمن معمول من قبل، فكلمة المرور الحالية سايبينها زي ما هي. لو عايز تغيّرها فعلًا: ADMIN_PASSWORD_RESET=1 مرة واحدة بس.\x1b[0m');
  }
  const adminInfo = await store.ensureAdmin({
    email: process.env.ADMIN_EMAIL,
    password: effectiveAdminPassword,
    force: FORCE_ADMIN_RESET
  });
  const ADMIN_PASSWORD_FILE = path.join(DATA_DIR, 'INITIAL-ADMIN-PASSWORD.txt');
  const ADMIN_RESET_LINK_FILE = path.join(DATA_DIR, 'LAST-ADMIN-RESET-LINK.txt');
  const PRINT_ADMIN_PASSWORD = String(process.env.ADMIN_PRINT_PASSWORD || '') === '1';
  if (generatedAdminPassword) {
    // (إصلاح أمني) كلمة مرور الأدمن مش بتتطبع في اللوج افتراضيًا خلاص — اللوج
    // بيتخزّن ويتشارك على منصات النشر، فطباعتها كانت تسريب فعلي. بتتكتب في ملف
    // بصلاحيات 0600 جوه مجلد البيانات وبيتمسح أول ما تتغيّر من اللوحة.
    // لو محتاج تشوفها في اللوج مرة واحدة (بيئة تطوير): ADMIN_PRINT_PASSWORD=1
    let savedToFile = false;
    try {
      fs.writeFileSync(ADMIN_PASSWORD_FILE, `${adminInfo.email}\n${generatedAdminPassword}\n`, { mode: 0o600 });
      savedToFile = true;
    } catch (error) {
      console.warn('[admin] تعذر حفظ ملف كلمة المرور الأولية:', error.message);
    }
    console.warn('\n\x1b[33m🔑 أول تشغيل: تم إنشاء حساب أدمن بكلمة مرور عشوائية قوية.');
    console.warn(`    البريد: ${adminInfo.email}`);
    if (savedToFile) console.warn(`    كلمة المرور محفوظة في ملف محمي: ${ADMIN_PASSWORD_FILE}`);
    console.warn('    مش بنطبعها في اللوج لأسباب أمنية. لو مش قادر توصل للملف:');
    console.warn('      npm run admin:reset-password   (أو ظبّط ADMIN_EMAIL/ADMIN_PASSWORD بنفسك)');
    if (PRINT_ADMIN_PASSWORD && process.env.NODE_ENV !== 'production') {
      console.warn(`    [ADMIN_PRINT_PASSWORD=1] كلمة المرور: ${generatedAdminPassword}`);
    }
    console.warn('    سجّل دخول وغيّرها فورًا من لوحة التحكم.\x1b[0m\n');
  } else if (fs.existsSync(ADMIN_PASSWORD_FILE)) {
    // فاضل تنبيه إن كلمة المرور الأولية لسه ما اتغيّرتش — من غير طباعتها.
    console.warn(`\n\x1b[33m⚠️  كلمة مرور الأدمن الأولية لسه ما اتغيّرتش (${ADMIN_PASSWORD_FILE}). غيّرها من لوحة التحكم وهيتمسح تلقائيًا.\x1b[0m\n`);
  }
  return { ADMIN_PASSWORD_FILE, ADMIN_RESET_LINK_FILE };
};
