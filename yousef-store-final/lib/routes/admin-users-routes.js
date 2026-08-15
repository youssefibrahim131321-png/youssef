/**
 * لوحة التحكم: المستخدمون، البث، السجل، النسخ الاحتياطي والتصدير
 * -------------------------------------------------------------------------
 * موديول اتفصل من server.js عشان الملف ما يبقاش آلاف السطور. كل الاعتماديات
 * (الـ store والحدود والمساعدات) بتتمرّر من server.js في كائن deps واحد،
 * فالسلوك زي ما هو بالحرف بس التنظيم بقى أوضح.
 */
const { passwordPolicyError } = require('../core/password-policy');
module.exports = function registerAdminUsersRoutes(app, deps) {
  const {
    BACKUP_UPLOAD_URL,
    adminBulkLimiter,
    adminWriteLimiter,
    asText,
    audit,
    requireAdmin,
    sendPushToUser,
    setSessionCookie,
    store,
    uploadBackupOffsite,
    validate,
    writeLimiter
  } = deps;

  app.get('/api/admin/users', requireAdmin, async (_req, res) => {
    // (أداء) التجميع بقى في SQL بدل O(عملاء × طلبات) في الذاكرة.
    res.json({
      users: await store.getUsersWithStats()
    });
  });
  app.post('/api/admin/users', requireAdmin, writeLimiter, async (req, res) => {
    const {
      errors,
      value
    } = validate({
      name: {
        required: true,
        label: 'الاسم',
        minLength: 2,
        maxLength: 80
      },
      email: {
        required: true,
        label: 'البريد الإلكتروني',
        type: 'email',
        maxLength: 190
      },
      password: {
        required: true,
        label: 'كلمة المرور',
        minLength: 8,
        maxLength: 100
      },
      role: {
        label: 'الصلاحية',
        enum: ['customer', 'admin'],
        default: 'customer'
      }
    }, req.body);
    if (errors.length) return res.status(400).json({
      error: errors[0]
    });
    try {
      // حساب أنشأه الأدمن بنفسه يُعتبر بريده موثوقًا (مفيش رابط تفعيل للعميل).
      const userId = await store.createUser({
        ...value,
        role: value.role || 'customer',
        emailVerified: true
      });
      audit(req, 'إضافة مستخدم', value.email);
      return res.json({
        ok: true,
        userId
      });
    } catch (error) {
      if (error.message === 'Email already exists') return res.status(409).json({
        error: 'البريد الإلكتروني مسجل بالفعل'
      });
      return res.status(500).json({
        error: 'تعذر إنشاء المستخدم'
      });
    }
  });
  app.put('/api/admin/users/:id', requireAdmin, adminWriteLimiter, async (req, res) => {
    const body = req.body || {};
    const {
      password,
      role
    } = body;
    // (إصلاح) نفس سياسة كلمة المرور الموحّدة المستخدمة في مسارات المصادقة.
    const passwordError = password ? passwordPolicyError(password) : null;
    if (passwordError) return res.status(400).json({
      error: passwordError
    });
    if (role && !['customer', 'admin'].includes(role)) return res.status(400).json({
      error: 'الصلاحية غير صالحة'
    });
    // (إصلاح أمني) تصعيد الصلاحيات أو إعادة تعيين كلمة سر حساب تاني لازم
    // إعادة تأكيد كلمة سر المسؤول الحالي (step-up)، عشان جلسة مسروقة لوحدها
    // ما تكفيش لعمل أدمن جديد.
    const targetIsOther = String(req.params.id) !== String(req.user.id);
    const sensitive = (role && role !== 'customer') || (password && targetIsOther);
    if (sensitive) {
      const confirmPassword = String(body.currentPassword || '');
      if (!confirmPassword) return res.status(401).json({
        error: 'من فضلك أكّد كلمة مرورك للمتابعة.',
        code: 'PASSWORD_CONFIRM_REQUIRED'
      });
      if (!(await store.verifyPassword(req.user.email, confirmPassword))) {
        return res.status(401).json({ error: 'كلمة المرور غير صحيحة.' });
      }
    }
    delete body.currentPassword;
    // (إصلاح) المسار ده كان بيعدي الاسم/البريد/الهاتف/العنوان من غير أي تحقق
    // من الصيغة (بريد من غير @ كان بيتخزن عادي). بنستخدم نفس قواعد التسجيل.
    const patch = {};
    ['name', 'email', 'phone', 'address'].forEach(k => {
      if (body[k] !== undefined) patch[k] = body[k];
    });
    if (Object.keys(patch).length) {
      const rules = {};
      if (patch.name !== undefined) rules.name = {
        required: true,
        label: 'الاسم',
        minLength: 2,
        maxLength: 80
      };
      if (patch.email !== undefined) rules.email = {
        required: true,
        label: 'البريد الإلكتروني',
        type: 'email',
        maxLength: 190
      };
      if (patch.phone !== undefined) rules.phone = {
        label: 'رقم الهاتف',
        maxLength: 30
      };
      if (patch.address !== undefined) rules.address = {
        label: 'العنوان',
        maxLength: 300
      };
      const {
        errors
      } = validate(rules, patch);
      if (errors.length) return res.status(400).json({
        error: errors[0]
      });
    }
    try {
      const user = await store.updateUser(req.params.id, body);
      if (!user) return res.status(404).json({
        error: 'المستخدم غير موجود'
      });
      if (req.user.id === user.id) setSessionCookie(res, {
        userId: user.id,
        role: user.role,
        email: user.email,
        sv: user.session_version || 0
      });
      audit(req, 'تعديل مستخدم', user.email);
      return res.json({
        ok: true,
        user
      });
    } catch (error) {
      if (error.message === 'Email already exists') return res.status(409).json({
        error: 'البريد الإلكتروني مسجل بالفعل'
      });
      return res.status(500).json({
        error: 'تعذر تعديل المستخدم'
      });
    }
  });
  app.delete('/api/admin/users/:id', requireAdmin, adminWriteLimiter, async (req, res) => {
    if (Number(req.params.id) === req.user.id) return res.status(400).json({
      error: 'لا يمكنك حذف حسابك الحالي'
    });
    try {
      if (!(await store.deleteUser(req.params.id))) return res.status(404).json({
        error: 'المستخدم غير موجود'
      });
      audit(req, 'حذف مستخدم', req.params.id);
      return res.json({
        ok: true
      });
    } catch (_) {
      return res.status(400).json({
        error: 'لا يمكن حذف آخر حساب مسؤول'
      });
    }
  });
  app.post('/api/admin/broadcast', requireAdmin, writeLimiter, async (req, res) => {
    const title = asText((req.body || {}).title, 80);
    const body = asText((req.body || {}).body, 300);
    if (!title || !body) return res.status(400).json({
      error: 'العنوان والنص مطلوبان'
    });
    const userIds = await store.broadcastNotification({
      title,
      body
    });
    userIds.forEach(id => sendPushToUser(id, {
      title,
      body,
      url: '/index.html'
    }));
    audit(req, 'إشعار جماعي', title);
    res.json({
      ok: true,
      sent: userIds.length
    });
  });
  app.get('/api/admin/activity', requireAdmin, async (_req, res) => res.json({
    activity: await store.getActivityLog(120)
  }));
  app.post('/api/admin/backup', requireAdmin, adminBulkLimiter, async (req, res) => {
    const ok = await store.backup();
    // النسخة بتتحاول تترفع برّه السيرفر فورًا لو BACKUP_UPLOAD_URL متظبط.
    const offsite = ok ? await uploadBackupOffsite() : {
      ok: false,
      skipped: true
    };
    // (إصلاح S1) الرد بقى صريح: النسخ اليدوي مش مدعوم من داخل التطبيق،
    // فبنرجّع 501 برسالة واضحة بدل رد بيتقري غلط على إنه نجاح.
    if (!ok) {
      audit(req, 'محاولة نسخة احتياطية يدوية', 'غير مدعومة');
      return res.status(501).json({
        ok: false,
        error: 'النسخ الاحتياطي بيتم تلقائيًا عبر Railway (managed backups) — مفيش نسخ يدوي من داخل التطبيق. استخدم «تصدير البيانات JSON» لو عايز نسخة فورية.',
        offsite: false,
        offsiteConfigured: Boolean(BACKUP_UPLOAD_URL)
      });
    }
    audit(req, 'إنشاء نسخة احتياطية', offsite.ok ? 'مع رفع خارجي' : '');
    res.json({
      ok,
      offsite: offsite.ok,
      offsiteConfigured: Boolean(BACKUP_UPLOAD_URL)
    });
  });
  app.get('/api/admin/export.json', requireAdmin, adminBulkLimiter, async (req, res) => {
    // (إصلاح) تصدير كامل للبيانات (مستخدمين، طلبات...) — أخطر عملية قراءة في
    // اللوحة، لازم تظهر في سجل التدقيق حتى لو مفيش تعديل فعلي.
    audit(req, 'تصدير كامل للبيانات (JSON)', '');
    const snapshot = await store.getRawSnapshot();
    delete snapshot.sessionSecret;
    delete snapshot.vapid;
    // (أمان) sanitizeUser بيشيل password_hash *و* أسرار الـ 2FA (totp_secret وغيره)
    // عشان تصدير البيانات ما يبقاش طريق لنسخ المصادقة الثنائية لأي حساب.
    snapshot.users = snapshot.users.map(u => store.sanitizeUser(u));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="yousef-store-export.json"');
    // (إصلاح أداء) بنبعت الأقسام الكبيرة على دفعات بدل تسلسل الملف كله مرة واحدة.
    res.write('{\n');
    const keys = Object.keys(snapshot);
    keys.forEach((key, index) => {
      res.write(`  ${JSON.stringify(key)}: ${JSON.stringify(snapshot[key])}${index === keys.length - 1 ? '' : ','}\n`);
    });
    res.end('}\n');
  });
};
