// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
module.exports = async function createOffsiteBackup(deps = {}) {
  const { BACKUP_DIR, everyInstances, fs, path, store } = deps;
  // ---------------------------------------------------------------------------
  // (إصلاح) نسخة احتياطية خارج الديسك
  // ---------------------------------------------------------------------------
  // نسخة احتياطية على نفس السيرفر مش نسخة احتياطية: لو الـ Volume ضاع، ضاعت
  // النسخة معاه. لو ظبّطت BACKUP_UPLOAD_URL (أي endpoint بيقبل PUT/POST لملف
  // ثنائي — S3 presigned، R2، Bunny، أو سيرفر بتاعك) بنرفع آخر نسخة هناك بعد
  // كل عملية backup. BACKUP_UPLOAD_TOKEN اختياري (بيتبعت كـ Authorization).
  const BACKUP_UPLOAD_URL = String(process.env.BACKUP_UPLOAD_URL || '').trim();
  const BACKUP_UPLOAD_METHOD = (process.env.BACKUP_UPLOAD_METHOD || 'PUT').toUpperCase() === 'POST' ? 'POST' : 'PUT';
  if (!BACKUP_UPLOAD_URL && process.env.NODE_ENV === 'production') {
    console.warn('\x1b[33m⚠️  مفيش نسخ احتياطي خارجي (BACKUP_UPLOAD_URL). النسخ كلها على نفس الديسك — أي فقدان للـ Volume = فقدان كامل للطلبات.\x1b[0m');
    // (إصلاح) زي باقي أعلام REQUIRE_*: تحذير بس افتراضيًا (عشان مش كل نشر
    // عنده S3/R2 جاهز من أول يوم)، لكن REQUIRE_OFFSITE_BACKUP=1 يحوّلها
    // لإيقاف تشغيل صريح لو قررت إنك مش عايز تشتغل في الإنتاج من غير نسخة
    // احتياطية خارج القرص أبدًا.
    if (process.env.REQUIRE_OFFSITE_BACKUP === '1') {
      console.error('\x1b[31m⛔ التشغيل اتوقف: REQUIRE_OFFSITE_BACKUP=1 بس BACKUP_UPLOAD_URL مش مظبوط.\x1b[0m');
      process.exit(1);
    }
  }
  function latestBackupFile() {
    try {
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('store-') && f.endsWith('.db')).sort();
      return files.length ? path.join(BACKUP_DIR, files[files.length - 1]) : null;
    } catch (_) {
      return null;
    }
  }
  async function uploadBackupOffsite() {
    if (!BACKUP_UPLOAD_URL) return {
      ok: false,
      skipped: true
    };
    const file = latestBackupFile();
    if (!file) return {
      ok: false,
      error: 'مفيش نسخة احتياطية للرفع'
    };
    try {
      const body = fs.readFileSync(file);
      const headers = {
        'Content-Type': 'application/octet-stream',
        'X-Backup-Filename': path.basename(file)
      };
      if (process.env.BACKUP_UPLOAD_TOKEN) headers.Authorization = `Bearer ${process.env.BACKUP_UPLOAD_TOKEN}`;
      const url = BACKUP_UPLOAD_URL.endsWith('/') ? BACKUP_UPLOAD_URL + path.basename(file) : BACKUP_UPLOAD_URL;
      const res = await fetch(url, {
        method: BACKUP_UPLOAD_METHOD,
        headers,
        body
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(`[backup] اترفعت نسخة خارجية: ${path.basename(file)}`);
      return {
        ok: true,
        file: path.basename(file)
      };
    } catch (error) {
      console.error('[backup] فشل الرفع الخارجي:', error.message);
      return {
        ok: false,
        error: error.message
      };
    }
  }

  // نسخة احتياطية تلقائية كل 6 ساعات + رفعها خارج السيرفر لو متظبط
  setInterval(everyInstances('auto-backup', async () => {
    if (await store.backup()) await uploadBackupOffsite();
  }), 6 * 60 * 60 * 1000).unref();
  return { BACKUP_UPLOAD_URL, uploadBackupOffsite };
};
