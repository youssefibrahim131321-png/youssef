/**
 * رفع الصور وإيصالات الدفع والتحقق منها وتنظيفها
 * -------------------------------------------------------------------------
 * موديول اتفصل من server.js عشان الملف ما يبقاش آلاف السطور. كل الاعتماديات
 * (الـ store والحدود والمساعدات) بتتمرّر من server.js في كائن deps واحد،
 * فالسلوك زي ما هو بالحرف بس التنظيم بقى أوضح.
 */
module.exports = function registerUploadRoutes(app, deps) {
  const {
    PROOFS_DIR,
    QUARANTINE_DIR,
    UPLOADS_DIR,
    audit,
    crypto,
    fs,
    fsp,
    imageOptimize,
    multer,
    path,
    requireAdmin,
    requireAuth,
    store,
    warmImageVariants,
    writeLimiter
  } = deps;

  const ALLOWED_IMAGE_TYPES = {
    'image/jpeg': {
      ext: '.jpg',
      magic: [[0, [0xff, 0xd8, 0xff]]]
    },
    'image/png': {
      ext: '.png',
      magic: [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]]
    },
    'image/webp': {
      ext: '.webp',
      magic: [[0, [0x52, 0x49, 0x46, 0x46]], [8, [0x57, 0x45, 0x42, 0x50]]]
    }
  };
  const upload = multer({
    storage: multer.diskStorage({
      // (أمان) بيتكتب في مجلد الحجر الصحي مش في UPLOADS_DIR مباشرة، عشان أي
      // ملف مرفوض يتمسح قبل ما يبقى متاح عبر أي static route.
      destination: (_req, _file, cb) => cb(null, QUARANTINE_DIR),
      filename: (_req, _file, cb) => cb(null, crypto.randomUUID())
    }),
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 1
    },
    fileFilter: (_req, file, cb) => {
      // النوع الحقيقي بيتأكد من محتوى الملف بعد الرفع (detectImageType)، فبنسمح
      // هنا بأي نوع صورة أو نوع مجهول بدل ما نرفض صور موبايل سليمة. الاعتماد
      // الفعلي في القرار النهائي على sniffing المحتوى فقط (finalizeUploadedImage).
      const mt = String(file.mimetype || '').toLowerCase();
      if (mt.startsWith('image/')) return cb(null, true);
      // (إصلاح) الأنواع المجهولة (بعض متصفحات الموبايل بتبعت octet-stream) بتتقبل
      // بس لو الامتداد صورة معروفة — بدل ما أي ملف مهما كان يتكتب على القرص
      // قبل ما يترفض. القرار النهائي فاضل على sniffing المحتوى.
      const ext = path.extname(String(file.originalname || '')).toLowerCase();
      const extOk = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
      if ((mt === 'application/octet-stream' || mt === '') && extOk) return cb(null, true);
      cb(new Error('الملف المختار مش صورة — اختر صورة JPG أو PNG أو WEBP'));
    }
  });

  // يتحقق من أول بايتات الملف الفعلية (magic bytes) بدل الاكتفاء بامتداد الملف
  // أو الـ mimetype اللي المتصفح بيبعته (ممكن يتزوّر بسهولة).
  async function readFileHeader(filePath, length) {
    const fh = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      const {
        bytesRead
      } = await fh.read(buf, 0, length, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }
  function headerMatchesType(header, mimetype) {
    const rule = ALLOWED_IMAGE_TYPES[mimetype];
    if (!rule) return false;
    return rule.magic.every(([offset, bytes]) => bytes.every((b, i) => header[offset + i] === b));
  }

  // (إصلاح أداء) قراءة واحدة غير متزامنة لأول بايتات الملف بدل عدة قراءات
  // متزامنة (openSync/readSync) كانت بتوقف الـ event loop في قلب مسار الرفع.
  async function detectImageType(filePath) {
    let header;
    try {
      header = await readFileHeader(filePath, 16);
    } catch (_) {
      return null;
    }
    for (const [mimetype, rule] of Object.entries(ALLOWED_IMAGE_TYPES)) {
      if (headerMatchesType(header, mimetype)) return {
        mimetype,
        ext: rule.ext
      };
    }
    return null;
  }
  async function finalizeUploadedImage(srcDir, filename, destDir) {
    const current = path.join(srcDir, filename);
    if (path.dirname(current) !== path.resolve(srcDir)) return null;
    const detected = await detectImageType(current);
    if (!detected) {
      // (أمان) الملف مرفوض من محتواه الفعلي — بيتمسح فورًا من الحجر الصحي
      // ومستحيل يتقدّم لمجلد بيتقدّم منه static route.
      fs.unlink(current, () => {});
      return null;
    }
    const finalName = `${filename}${detected.ext}`;
    const target = path.join(path.resolve(destDir), finalName);
    try {
      fs.renameSync(current, target);
    } catch (_) {
      try {
        fs.copyFileSync(current, target);
        fs.unlinkSync(current);
      } catch (moveError) {
        fs.unlink(current, () => {});
        return null;
      }
    }
    return finalName;
  }

  // ---------------------------------------------------------------------------
  // إثبات التحويل (فودافون كاش / انستا باي) — رفع من جهاز العميل
  // ---------------------------------------------------------------------------
  const uploadProof = multer({
    storage: multer.diskStorage({
      // (أمان) نفس مبدأ رفع صور المنتجات: يتكتب في الحجر الصحي أولًا.
      destination: (_req, _file, cb) => cb(null, QUARANTINE_DIR),
      filename: (_req, _file, cb) => cb(null, crypto.randomUUID())
    }),
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 1
    },
    fileFilter: (_req, file, cb) => {
      const mt = String(file.mimetype || '').toLowerCase();
      if (mt.startsWith('image/') || mt === 'application/octet-stream' || mt === '') return cb(null, true);
      cb(new Error('الملف المختار مش صورة — صوّر سكرين شوت للتحويل وارفعه'));
    }
  });
  app.post('/api/payment-proof', requireAuth, writeLimiter, (req, res) => {
    uploadProof.single('proof')(req, res, async err => {
      if (err) {
        const tooBig = err.code === 'LIMIT_FILE_SIZE';
        return res.status(400).json({
          error: tooBig ? 'حجم الصورة كبير — الحد الأقصى 5 ميجابايت' : err.message || 'تعذر رفع الصورة'
        });
      }
      if (!req.file) return res.status(400).json({
        error: 'من فضلك اختر صورة إيصال التحويل'
      });
      const finalName = await finalizeUploadedImage(QUARANTINE_DIR, req.file.filename, PROOFS_DIR);
      if (!finalName) {
        return res.status(400).json({
          error: 'الصورة دي بصيغة مش مدعومة (زي HEIC). خد سكرين شوت للتحويل وارفعه، أو اختار صورة JPG/PNG.'
        });
      }
      req.file.filename = finalName;
      const filePath = path.join(PROOFS_DIR, finalName);
      // (إصلاح) بصمة الصورة: أشهر تحايل على الدفع اليدوي هو رفع نفس صورة
      // التحويل تاني (أو صورة اتسربت من حد تاني). البصمة بتمنع ده قبل ما الطلب
      // يتسجّل أصلًا، مش بعد ما الأدمن يراجعه.
      let proofHash = null;
      try {
        proofHash = crypto.createHash('sha256').update(await fsp.readFile(filePath)).digest('hex');
      } catch (e) {
        console.error('[payment-proof] تعذر حساب بصمة الصورة:', e.message);
      }
      // (إصلاح IDOR) بنسجّل مين رفع الصورة، فحتى قبل ما ترتبط بطلب مفيش حد
      // تاني يقدر يفتحها حتى لو عرف اسم الملف.
      // (إصلاح سباق) رفض التكرار بقى من القيد الفريد على البصمة داخل القاعدة،
      // مش من فحص SELECT قبل الكتابة (اللي رفعتين متزامنتين كانوا يعدّوا منه).
      try {
        await store.recordPaymentProof(req.file.filename, req.user.id, proofHash);
      } catch (e) {
        fs.unlink(filePath, () => {});
        if (e.code === 'DUPLICATE_PROOF') {
          return res.status(409).json({
            error: 'صورة التحويل دي اتستخدمت قبل كده. ارفع صورة التحويل الجديد بتاعك.'
          });
        }
        console.error('[payment-proof] تعذر تسجيل مالك الإيصال:', e.message);
        return res.status(500).json({
          error: 'تعذر رفع الصورة، حاول تاني'
        });
      }
      res.json({
        ok: true,
        url: `/api/payment-proof/${req.file.filename}`
      });
    });
  });

  // (إصلاح) مكنسة الإيصالات اليتيمة: أي إيصال اترفع ومحصلش طلب خلال 24 ساعة
  // بيتمسح من الديسك ومن القاعدة، بدل ما يتراكم للأبد.
  const PROOF_ORPHAN_TTL_MS = Number(process.env.PROOF_ORPHAN_HOURS || 24) * 60 * 60 * 1000;
  async function sweepOrphanPaymentProofs() {
    let removed = 0;
    try {
      for (const filename of await store.getOrphanPaymentProofs(PROOF_ORPHAN_TTL_MS)) {
        const target = path.join(PROOFS_DIR, path.basename(filename));
        if (path.dirname(target) !== PROOFS_DIR) continue;
        try {
          fs.unlinkSync(target);
        } catch (_) {/* الملف مش موجود */}
        await store.deletePaymentProof(filename);
        removed += 1;
      }
    } catch (error) {
      console.error('[payment-proof sweep]', error.message);
    }
    return removed;
  }
  setTimeout(sweepOrphanPaymentProofs, 60 * 1000).unref();
  setInterval(sweepOrphanPaymentProofs, 6 * 60 * 60 * 1000).unref();

  // عرض صورة الإيصال: الأدمن يشوف أي إيصال، والعميل يشوف إيصاله هو بس.
  // الصور اللي لسه ما اترفقتش بأي طلب يقدر يشوفها صاحب الجلسة اللي رفعها فقط
  // بعد ربطها بالطلب — قبل كده مفيش أي وصول عام.
  app.get('/api/payment-proof/:file', requireAuth, async (req, res) => {
    const filename = path.basename(String(req.params.file || ''));
    if (!/^[a-f0-9-]{36}\.(jpg|png|webp)$/i.test(filename)) return res.status(400).json({
      error: 'اسم ملف غير صالح'
    });
    const filePath = path.join(PROOFS_DIR, filename);
    if (path.dirname(filePath) !== PROOFS_DIR || !fs.existsSync(filePath)) return res.status(404).json({
      error: 'الصورة غير موجودة'
    });
    if (req.user.role !== 'admin') {
      const order = await store.getOrderByProofFilename(filename);
      // الملكية بقت في قاعدة البيانات (بدل ملف .owner جانبي). بنقرأ الملف القديم
      // كخطة رجوع للإيصالات اللي اترفعت قبل الترقية، ونهاجرها لقاعدة البيانات.
      // الملكية بتتقرأ من قاعدة البيانات بس (ملفات .owner القديمة اتشالت خالص —
      // مفيش حاجة بتكتبها، فقراءتها كانت سطح هجوم زيادة بلا فايدة).
      let owner = null;
      try {
        owner = await store.getPaymentProofOwner(filename);
      } catch (_) {
        owner = null;
      }
      const isOrderOwner = order && Number(order.user_id) === Number(req.user.id);
      const isUploader = owner && Number(owner) === Number(req.user.id);
      // لازم يكون صاحب الطلب أو اللي رفع الصورة أصلًا — مجرد معرفة اسم الملف
      // مش كافية خالص.
      if (!isOrderOwner && !isUploader) return res.status(403).json({
        error: 'غير مسموح'
      });
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // (إصلاح race) الملف ممكن يكون اتمسح بالمكنسة بين فحص الوجود والإرسال،
    // فالنتيجة بتتعالج هنا بـ 404 نظيف بدل استثناء غير متوقع.
    res.sendFile(filePath, err => {
      if (err && !res.headersSent) res.status(404).json({
        error: 'الصورة غير موجودة'
      });
    });
  });
  app.post('/api/admin/upload-image', requireAdmin, writeLimiter, (req, res) => {
    upload.single('image')(req, res, async err => {
      if (err) return res.status(400).json({
        error: err.message || 'تعذر رفع الصورة'
      });
      if (!req.file) return res.status(400).json({
        error: 'من فضلك اختر صورة'
      });
      const storedName = await finalizeUploadedImage(QUARANTINE_DIR, req.file.filename, UPLOADS_DIR);
      if (!storedName) return res.status(400).json({
        error: 'الملف المرفوع ليس صورة صالحة (JPG / PNG / WEBP)'
      });
      // (إصلاح 8) الصورة بتتضغط وتتصغّر (WebP) بدل ما تتخزن زي ما هي.
      const finalName = await imageOptimize.optimizeInPlace(UPLOADS_DIR, storedName);
      // (أداء) بنولّد نسخ AVIF/WebP هنا مرة واحدة بدل ما أول زائر يستنّى
      // التحويل جوه طلبه. مش بنعمل await عشان ما نأخّرش رد الرفع.
      if (typeof warmImageVariants === 'function') {
        Promise.resolve(warmImageVariants(finalName)).catch(() => {});
      }
      audit(req, 'رفع صورة منتج', finalName);
      res.json({
        ok: true,
        url: `/uploads/products/${finalName}`
      });
    });
  });

  // يمسح صورة قديمة من مجلد uploads لو مش مستخدمة في أي منتج تاني (يُستدعى بعد
  // تعديل/حذف منتج غيّر صورته لمنع تراكم ملفات يتيمة على القرص).
  async function cleanupOldProductImage(oldUrl, newUrl) {
    if (!oldUrl || oldUrl === newUrl || !oldUrl.startsWith('/uploads/products/')) return;
    const stillUsed = (await store.getProducts(false)).some(p => p.image_url === oldUrl);
    if (stillUsed) return;
    const filename = path.basename(oldUrl);
    const filePath = path.join(UPLOADS_DIR, filename);
    if (path.dirname(filePath) === UPLOADS_DIR) fs.unlink(filePath, () => {});
  }

  return {
    cleanupOldProductImage
  };
};
