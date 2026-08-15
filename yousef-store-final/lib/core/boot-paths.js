// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
module.exports = function resolveBootPaths(deps = {}) {
  const { projectRoot, activeProvider, checkConfig, fs, imageOptimize, path, storageGuard } = deps;
  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  const PUBLIC_DIR = path.join(projectRoot, 'public');
  // مسارات التخزين: قابلة للتوجيه لمجلد Persistent Volume عبر متغيرات البيئة
  // (DATA_DIR / UPLOADS_DIR). على Railway اعمل Volume على /data وظبّط
  // DATA_DIR=/data و UPLOADS_DIR=/data/uploads/products، وإلا أي إعادة نشر
  // هتمسح قاعدة البيانات والصور المرفوعة.
  // (إصلاح) لو في Volume متركّب على Railway، بنستخدمه تلقائيًا كمجلد بيانات
  // حتى لو نسيت تظبّط DATA_DIR — ده كان أشهر سبب لتوقف التشغيل وضياع البيانات.
  const VOLUME_MOUNT = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
  const RESOLVED_DATA_DIR = process.env.DATA_DIR || VOLUME_MOUNT || path.join(projectRoot, 'data');
  const DATA_DIR = path.resolve(RESOLVED_DATA_DIR);
  if (!process.env.DATA_DIR) process.env.DATA_DIR = DATA_DIR;
  // (إصلاح) لو ظبّطت DATA_DIR على Volume دائم، الصور المرفوعة بتتبعه تلقائيًا
  // من غير ما تفتكر تظبّط UPLOADS_DIR كمان — أشهر سبب لضياع صور المنتجات.
  const USING_EXTERNAL_DATA_DIR = DATA_DIR !== path.resolve(path.join(projectRoot, 'data'));
  const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || (USING_EXTERNAL_DATA_DIR ? path.join(DATA_DIR, 'uploads', 'products') : path.join(PUBLIC_DIR, 'uploads', 'products')));

  // صور إثبات التحويل (فودافون كاش / انستا باي). بتتخزن برّه مجلد public عشان
  // ما تكونش متاحة لأي حد بمجرد معرفة اسم الملف — بتتقدّم من مسار محمي بس.
  const PROOFS_DIR = path.resolve(process.env.PROOFS_DIR || path.join(DATA_DIR, 'payment-proofs'));
  const DB_PATH = path.join(DATA_DIR, 'store.json');
  fs.mkdirSync(DATA_DIR, {
  recursive: true
  });
  fs.mkdirSync(UPLOADS_DIR, {
  recursive: true
  });
  fs.mkdirSync(PROOFS_DIR, {
  recursive: true
  });
  // (أمان) مجلد حجر صحي مؤقت خارج أي مسار static: أي ملف مرفوع بيتكتب هنا
  // الأول وبيتفحص من محتواه الحقيقي (magic bytes) قبل ما يتنقل لمجلد
  // الصور/الإيصالات النهائي، عشان ملف مرفوض ما يتقدّمش أبدًا عبر أي static route.
  const QUARANTINE_DIR = path.resolve(process.env.QUARANTINE_DIR || path.join(DATA_DIR, 'incoming-uploads'));
  fs.mkdirSync(QUARANTINE_DIR, {
  recursive: true
  });
  checkConfig({
  dataDir: DATA_DIR,
  mailProvider: activeProvider()
  });
  // (إصلاح 6) تحذير صريح: من غير مزوّد بريد، رسائل التفعيل واستعادة كلمة المرور
  // مش بتوصل خالص — وده كان بيبان كأنه «الرسالة اتبعتت» وهي مش موجودة.
  if (activeProvider() === 'console') {
  console.warn('\x1b[31m⚠️  مفيش مزوّد بريد متظبط (RESEND_API_KEY أو SMTP_URL أو MAIL_WEBHOOK_URL). رسائل التفعيل واستعادة كلمة المرور مش هتوصل لحد.\x1b[0m');
  // (إصلاح 6) في الإنتاج ده مش تحذير — ده عطل صامت: العميل اللي ينسى كلمة
  // مروره بيتقفل برّه المتجر للأبد من غير أي تفسير. البديل الوحيد المطبّق
  // حاليًا (كتابة الرابط في ملف + طباعته في اللوج) شغّال للأدمن بس، مش
  // للعملاء، فمفيش أي طريقة تانية يوصلهم بيها الرابط. زي sharp بالظبط تحت:
  // افتراضيًا بنوقف التشغيل في الإنتاج، وREQUIRE_MAIL_PROVIDER=0 لتجاوزه لو
  // عارف إنك مش محتاج "نسيت كلمة المرور" (مثلًا لسه بتختبر).
  if (process.env.NODE_ENV === 'production' && process.env.REQUIRE_MAIL_PROVIDER !== '0') {
    console.error('\x1b[31m⛔ التشغيل اتوقف: مفيش مزوّد بريد في الإنتاج، فأي عميل ينسى كلمة مروره هيفضل عالق للأبد. ظبّط RESEND_API_KEY أو SMTP_URL أو MAIL_WEBHOOK_URL، أو ظبّط REQUIRE_MAIL_PROVIDER=0 لو متأكد إنك عايز تكمل من غيره.\x1b[0m');
    process.exit(1);
  }
  }
  // (إصلاح) sharp اختيارية: لو مش متثبتة الصور بترفع من غير ضغط من غير أي إشعار.
  if (!imageOptimize.isAvailable()) {
  console.warn('\x1b[33mℹ️  مكتبة sharp مش متاحة: الصور هتترفع من غير ضغط على السيرفر (الضغط في المتصفح بس).\x1b[0m');
  // (إصلاح) في الإنتاج، رفع صور بحجمها الأصلي = استهلاك مساحة وباندويدث
  // وبطء في المتجر. REQUIRE_IMAGE_OPTIMIZE=1 بيمنع التشغيل من غير sharp.
  // (إصلاح أمني) في الإنتاج إعادة ترميز الصور هي أهم طبقة حماية في الرفع،
  // فغيابها بقى يوقف التشغيل افتراضيًا (REQUIRE_IMAGE_OPTIMIZE=0 لتجاوزه).
  if (process.env.REQUIRE_IMAGE_OPTIMIZE === '1'
      || (process.env.NODE_ENV === 'production' && process.env.REQUIRE_IMAGE_OPTIMIZE !== '0')) {
    console.error('\x1b[31m⛔ التشغيل اتوقف: REQUIRE_IMAGE_OPTIMIZE=1 بس sharp مش متثبتة (npm i sharp).\x1b[0m');
    process.exit(1);
  }
  }
  // (إصلاح) تحذير واضح: لو الصور والداتا جوه مجلد المشروع على منصة سحابية، أي
  // إعادة نشر هتمسحها. لازم Volume + DATA_DIR/UPLOADS_DIR.
  // (إصلاح) النسخة الاحتياطية الافتراضية بقت جنب مجلد البيانات مش جوّاه، عشان
  // تفضل نسخة حقيقية لو ملف قاعدة البيانات نفسه اتلخبط أو اتمسح.
  // (إصلاح) على Volume دائم، النسخ الاحتياطي لازم يفضل جوه الـ Volume نفسه
  // (مثلاً /data/backups) مش برّه (/store-backups) لأن برّه بيتمسح مع كل نشر.
  const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || (USING_EXTERNAL_DATA_DIR ? path.join(DATA_DIR, 'backups') : path.join(DATA_DIR, '..', 'store-backups')));
  // (إصلاح) store.js بيقرأ BACKUP_DIR من البيئة كمان. من غير السطر ده كان بيتعمل
  // مجلدين نسخ احتياطي مختلفين (واحد جوّه مجلد البيانات) والنسخة تبقى على نفس الديسك.
  process.env.BACKUP_DIR = BACKUP_DIR;
  fs.mkdirSync(BACKUP_DIR, {
  recursive: true
  });
  const storageStatus = storageGuard.checkStorage({
  projectRoot: projectRoot,
  dataDir: DATA_DIR,
  uploadsDir: UPLOADS_DIR,
  backupDir: BACKUP_DIR
  });
  if (storageStatus.fatal) {
  // على منصة سحابية في وضع الإنتاج، التشغيل بتخزين مؤقت = فقدان مؤكد للبيانات
  // مع أول إعادة نشر. بنقف هنا بدل ما نكتشف ده بعد ضياع الطلبات.
  process.exit(1);
  }
  // (إصلاح 7) قاعدة البيانات بقت Postgres مشتركة (مش SQLite ملف واحد)، فمفيش
  // مشكلة تعدد نسخ من ناحيتها. القفل ده لسه مفيد لحاجة تانية: DATA_DIR بيتضمن
  // كمان ملفات محلية على القرص (كاش الصور، النسخ الاحتياطية، ملف كلمة سر
  // الأدمن الأولية) مش متزامنة بين نسختين بيكتبوا في نفس المجلد في نفس الوقت.
  // لو شغّلت أكتر من instance فعليًا على نفس الـ Volume، فعّل ALLOW_MULTI_INSTANCE=1.
  const instanceLock = storageGuard.acquireInstanceLock(DATA_DIR);
  if (!instanceLock.ok && process.env.ALLOW_MULTI_INSTANCE !== '1') process.exit(1);
  return { PORT, HOST, PUBLIC_DIR, DATA_DIR, UPLOADS_DIR, PROOFS_DIR, DB_PATH, QUARANTINE_DIR, BACKUP_DIR, instanceLock };
};
