/**
 * تسجيل/دخول/خروج، البروفايل، كلمة المرور، التحقق بالبريد، جوجل، 2FA
 * -------------------------------------------------------------------------
 * موديول اتفصل من server.js عشان الملف ما يبقاش آلاف السطور. كل الاعتماديات
 * (الـ store والحدود والمساعدات) بتتمرّر من server.js في كائن deps واحد،
 * فالسلوك زي ما هو بالحرف بس التنظيم بقى أوضح.
 */
const { truthy } = require('../core/bool');
const { publicBaseUrl } = require('../core/public-url');
const { passwordPolicyError } = require('../core/password-policy');

module.exports = function registerAuthRoutes(app, deps) {
  const {
    ADMIN_PASSWORD_FILE,
    ADMIN_RESET_LINK_FILE,
    EMAIL_VERIFICATION_AVAILABLE,
    EMAIL_VERIFY_MODE,
    REQUIRE_EMAIL_VERIFICATION,
    RESET_TOKEN_TTL_MS,
    TOTP_PENDING_TTL_MS,
    VERIFY_CODE_TTL_MS,
    accountLockedFor,
    activeProvider,
    asText,
    audit,
    authLimiter,
    clearSessionCookie,
    crypto,
    emailGuard,
    emailVerificationEnforced,
    fs,
    googleAuth,
    isEmail,
    noteFailedLogin,
    noteMailFailure,
    noteMailSuccess,
    passwordResetLimiter,
    registerAccountLimiter,
    requireAuth,
    sendMail,
    setSessionCookie,
    shouldExposeLink,
    store,
    totp,
    turnstile,
    validate,
    writeLimiter
  } = deps;

  // (إصلاح 4) خطوة التحقق بخطوتين: بعد نجاح الباسورد لحساب مفعّل عليه TOTP،
  // منرجعش سيشن كامل على طول — بنرجّع توكن "معلّق" قصير العمر لازم يتأكّد
  // بكود TOTP الأول قبل ما نعمل setSessionCookie فعليًا.
  async function issueTotpChallenge(user) {
    const pendingToken = await store.createAuthToken({
      userId: user.id,
      type: 'totp_login',
      ttlMs: TOTP_PENDING_TTL_MS
    });
    return {
      ok: true,
      twoFactorRequired: true,
      pendingToken,
      expiresInSeconds: Math.floor(TOTP_PENDING_TTL_MS / 1000)
    };
  }

  async function completeLogin(res, user) {
    setSessionCookie(res, {
      userId: user.id,
      role: user.role,
      email: user.email,
      sv: user.session_version || 0
    });
  }

  app.post('/api/auth/register', authLimiter, registerAccountLimiter, async (req, res) => {
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
      phone: {
        label: 'رقم الهاتف',
        maxLength: 30
      },
      address: {
        label: 'العنوان',
        maxLength: 200
      }
    }, req.body);
    if (errors.length) return res.status(400).json({
      error: errors[0],
      errors
    });
    // (إصلاح) سياسة موحّدة: حرف + رقم + رفض الشائع، مش الطول بس.
    const registerPasswordError = passwordPolicyError((req.body || {}).password);
    if (registerPasswordError) return res.status(400).json({
      error: registerPasswordError,
      errors: [registerPasswordError]
    });

    // (إصلاح 12) كابتشا اختيارية (Cloudflare Turnstile): لو صاحب المتجر
    // فعّلها بـ TURNSTILE_SECRET_KEY، لازم توكن صحيح قبل ما نكمل. لو مش
    // مفعّلة أصلًا، verify() بترجع ok:true فورًا (no-op) فمفيش أي تغيير في
    // السلوك الافتراضي.
    const captcha = await turnstile.verify((req.body || {}).captchaToken, req.ip);
    if (!captcha.ok) return res.status(400).json({
      error: captcha.reason || 'تعذر التحقق من الكابتشا'
    });

    // (جديد) بوابة البريد الوهمي: بترفض البريد المؤقت، الأخطاء الإملائية،
    // والنطاقات اللي مش بتستقبل بريد أصلًا — قبل ما نعمل الحساب.
    const guard = await emailGuard.checkEmail(value.email);
    if (!guard.ok) return res.status(400).json({
      error: guard.reason,
      code: 'EMAIL_REJECTED'
    });
    // منع تكرار نفس الإيميل بصيغ مختلفة (نقط gmail أو +tag).
    const twin = store.findUserByNormalizedEmail ? await store.findUserByNormalizedEmail(guard.normalized) : null;
    if (twin) return res.status(409).json({
      error: 'البريد الإلكتروني مسجل بالفعل',
      code: 'EMAIL_TAKEN'
    });
    try {
      // (إصلاح) الحساب بيتعمل *غير مفعّل*. مفيش أي طريقة يتعلّم بيها مفعّل غير
      // كود بيوصل على نفس البريد أو دخول بجوجل — فمستحيل حد يسجّل ببريد غيره
      // ويستخدمه كأنه بتاعه.
      await store.createUser({
        ...value,
        role: 'customer',
        emailVerified: false
      });
      const user = await store.findUserByEmail(value.email);
      let devCode = null;
      if (EMAIL_VERIFICATION_AVAILABLE) {
        // (إصلاح التعليق) إرسال كود التفعيل كان بيتعمل await جوه الطلب نفسه،
        // فلو مزوّد البريد بطيء أو واقع، العميل بيفضل مستني "لحظات..." لدقايق
        // رغم إن الحساب اتعمل خلاص. دلوقتي بننتظر مهلة قصيرة بس (عشان نرجّع كود
        // التطوير لو الإرسال سريع) وبعدها بنكمّل الرد والإرسال بيخلص في الخلفية.
        const sending = issueVerificationEmail(req, user).catch((err) => {
          console.error('[verify-email] فشل إرسال كود التفعيل:', err.message);
          return null;
        });
        const RESPOND_AFTER_MS = Number(process.env.REGISTER_MAIL_WAIT_MS || 2500);
        devCode = await Promise.race([
          sending,
          new Promise((resolve) => setTimeout(() => resolve(null), RESPOND_AFTER_MS))
        ]);
      }
      setSessionCookie(res, {
        userId: user.id,
        role: user.role,
        email: user.email,
        sv: user.session_version || 0
      });
      return res.json({
        ok: true,
        user: store.sanitizeUser(user),
        emailVerificationRequired: REQUIRE_EMAIL_VERIFICATION,
        emailVerificationAvailable: EMAIL_VERIFICATION_AVAILABLE,
        message: EMAIL_VERIFICATION_AVAILABLE ? 'تم إنشاء الحساب. بعتنالك كود تفعيل من 6 أرقام على بريدك — أدخله عشان نتأكد إن البريد بتاعك فعلًا.' : 'تم إنشاء الحساب. مرحبًا بيك في متجر يوسف!',
        ...(devCode ? {
          devVerifyCode: devCode
        } : {})
      });
    } catch (error) {
      if (error.message === 'Email already exists') return res.status(409).json({
        error: 'البريد الإلكتروني مسجل بالفعل',
        code: 'EMAIL_TAKEN'
      });
      console.error('[register]', error);
      return res.status(500).json({
        error: 'تعذر إنشاء الحساب'
      });
    }
  });
  app.post('/api/auth/login', authLimiter, async (req, res) => {
    const email = asText((req.body || {}).email, 190).trim().toLowerCase();
    const password = (req.body || {}).password;
    const requiredRole = (req.body || {}).role;
    if (!email || !password) return res.status(400).json({
      error: 'من فضلك أدخل البريد الإلكتروني وكلمة المرور'
    });
    const lockedFor = await accountLockedFor(email);
    if (lockedFor) {
      res.setHeader('Retry-After', lockedFor);
      return res.status(429).json({
        error: 'محاولات دخول كثيرة جدًا على هذا الحساب، حاول مرة أخرى بعد قليل.'
      });
    }
    const user = await store.verifyPassword(email, password);
    if (!user) {
      await noteFailedLogin(email);
      return res.status(401).json({
        error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة'
      });
    }
    if (requiredRole && user.role !== requiredRole) {
      return res.status(403).json({
        error: requiredRole === 'admin' ? 'هذا الحساب ليس حساب مسؤول. استخدم صفحة تسجيل دخول العملاء.' : 'هذا حساب مسؤول. استخدم صفحة تسجيل دخول المسؤول.'
      });
    }
    // (إصلاح 4) لو الحساب مفعّل عليه TOTP، منديش سيشن قبل ما نتأكد من الكود.
    const totpRow = await store.getTotpSecret(user.id);
    if (totpRow && totpRow.totp_enabled) {
      return res.json(await issueTotpChallenge(user));
    }
    setSessionCookie(res, {
      userId: user.id,
      role: user.role,
      email: user.email,
      sv: user.session_version || 0
    });
    // (إصلاح) الملف مكانش المفروض يتمسح هنا: كان أي دخول ناجح بيمسح كلمة المرور
    // الأولية قبل ما صاحب المتجر يغيّرها، وبعدها لو الجلسة ضاعت مفيش أي طريقة
    // يرجع بيها. بيتمسح دلوقتي بعد تغيير كلمة المرور فعليًا (change-password).
    res.json({
      ok: true,
      user: store.sanitizeUser(user),
      mustChangePassword: truthy(user.must_change_password),
      emailVerified: truthy(user.email_verified),
      twoFactorEnabled: false
    });
  });
  app.post('/api/auth/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({
      ok: true
    });
  });
  app.get('/api/auth/me', async (req, res) => {
    if (!req.user) return res.json({
      loggedIn: false
    });
    const totpRow = await store.getTotpSecret(req.user.id);
    res.json({
      loggedIn: true,
      user: store.sanitizeUser(req.user),
      mustChangePassword: truthy(req.user.must_change_password),
      emailVerified: truthy(req.user.email_verified),
      emailVerificationRequired: emailVerificationEnforced(),
      twoFactorEnabled: !!(totpRow && totpRow.totp_enabled)
    });
  });
  app.put('/api/auth/profile', requireAuth, writeLimiter, async (req, res) => {
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
      phone: {
        label: 'رقم الهاتف',
        maxLength: 30
      },
      address: {
        label: 'العنوان',
        maxLength: 300
      }
    }, req.body);
    if (errors.length) return res.status(400).json({
      error: errors[0]
    });
    const user = await store.updateUser(req.user.id, value);
    res.json({
      ok: true,
      user
    });
  });
  app.post('/api/auth/change-password', requireAuth, authLimiter, async (req, res) => {
    const {
      currentPassword,
      newPassword
    } = req.body || {};
    if (!(await store.verifyPassword(req.user.email, currentPassword))) {
      return res.status(400).json({
        error: 'كلمة المرور الحالية غير صحيحة'
      });
    }
    const newPasswordError = passwordPolicyError(newPassword);
    if (newPasswordError) {
      return res.status(400).json({
        error: newPasswordError
      });
    }
    const user = await store.updateUser(req.user.id, {
      password: newPassword
    });
    // كلمة المرور اتغيّرت فعلًا ← ملف كلمة المرور الأولية مالوش لزوم على الديسك.
    if (user.role === 'admin') {
      try {
        fs.unlinkSync(ADMIN_PASSWORD_FILE);
      } catch (_) {/* مش موجود */}
    }
    // نحدّث كوكي الجهاز الحالي بالإصدار الجديد؛ أي جهاز/جلسة تانية هتتسجل خروج تلقائيًا.
    setSessionCookie(res, {
      userId: user.id,
      role: user.role,
      email: user.email,
      sv: user.session_version || 0
    });
    res.json({
      ok: true
    });
  });

  // تسجيل خروج من كل الأجهزة (يبطل كل الجلسات القديمة حتى لو الكوكي لسه موجود عند حد تاني)
  app.post('/api/auth/logout-all-devices', requireAuth, async (req, res) => {
    const user = await store.bumpSessionVersion(req.user.id);
    setSessionCookie(res, {
      userId: user.id,
      role: user.role,
      email: user.email,
      sv: user.session_version || 0
    });
    audit(req, 'تسجيل خروج من كل الأجهزة', '');
    res.json({
      ok: true
    });
  });

  // ---------------------------------------------------------------------------
  // (1) استعادة كلمة المرور — للعميل وللأدمن على السواء
  // (2) تفعيل البريد الإلكتروني
  // ---------------------------------------------------------------------------
  // (إصلاح أمني حرج) كان: `${req.protocol}://${req.get('host')}` — هيدر Host
  // يتحكم فيه المهاجم بالكامل، فكان يقدر يسمّم رابط استعادة كلمة المرور اللي
  // بيتبعت للضحية بالبريد (استيلاء على الحساب). دلوقتي الرابط بيتبني من
  // SITE_URL/PUBLIC_BASE_URL أو هوست موجود في ALLOWED_HOSTS فقط، ولو مفيش
  // أصل موثوق بنرفض إرسال الرابط بدل ما نبعت رابط مسموم.
  const baseUrl = req => publicBaseUrl(req, { fallbackToHost: true });

  // (إصلاح 9) كل إرسال بريد بيعدّي من هنا عشان نعرف إن المزوّد وقع وندخل الوضع
  // المتدهور بدل ما المتجر يتقفل على كل العملاء.
  async function sendMailTracked(options) {
    try {
      const result = await sendMail(options);
      noteMailSuccess();
      return result;
    } catch (error) {
      noteMailFailure();
      throw error;
    }
  }

  // بيرجّع الرابط نصًا لو إحنا في وضع تطوير من غير مزوّد بريد، عشان تقدر تجرّب.
  // (2) بقينا نبعت كود رقمي من 6 أرقام بدل رابط: أسهل على العميل، ومش محتاج
  // دومين عام ولا رابط يشتغل، وصالح 15 دقيقة بس ويُستخدم مرة واحدة.
  async function issueVerificationEmail(req, user) {
    const code = await store.createAuthCode({
      userId: user.id,
      type: 'verify',
      ttlMs: VERIFY_CODE_TTL_MS
    });
    await sendMailTracked({
      to: user.email,
      subject: 'كود تفعيل بريدك الإلكتروني — متجر يوسف',
      text: `كود التفعيل بتاعك هو: ${code} — صالح 15 دقيقة، وما تديهوش لحد.`
    });
    // في وضع التطوير (من غير مزوّد بريد) بنرجّع الكود عشان تقدر تجرّب محليًا.
    return shouldExposeLink() ? code : null;
  }
  app.post('/api/auth/forgot-password', passwordResetLimiter, async (req, res) => {
    const email = asText((req.body || {}).email, 190).trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).json({
      error: 'البريد الإلكتروني غير صحيح'
    });
    const user = await store.findUserByEmail(email);
    let devLink = null;
    if (user) {
      const token = await store.createAuthToken({
        userId: user.id,
        type: 'reset',
        ttlMs: RESET_TOKEN_TTL_MS
      });
      const base = baseUrl(req);
      if (!base) {
        console.error('[forgot-password] مفيش أصل موقع موثوق (SITE_URL/PUBLIC_BASE_URL/ALLOWED_HOSTS) — تم إلغاء إرسال رابط الاستعادة بدل بناء رابط من هيدر Host غير موثوق.');
        return res.json({
          ok: true,
          message: 'لو البريد ده مسجّل عندنا، هيوصلك رابط لإعادة تعيين كلمة المرور خلال دقائق.'
        });
      }
      const link = `${base}/reset-password.html?token=${encodeURIComponent(token)}`;
      await sendMailTracked({
        to: user.email,
        subject: 'استعادة كلمة المرور — متجر يوسف',
        text: 'لو إنت اللي طلبت استعادة كلمة المرور، افتح الرابط ده (صالح ساعة واحدة). لو مش إنت، تجاهل الرسالة.',
        link
      });
      devLink = shouldExposeLink() ? link : null;
      // (إصلاح) لو مفيش مزوّد بريد متظبط، رسالة الاستعادة مكانتش بتوصل لحد وكان
      // صاحب المتجر بيتقفل بره لوحته من غير أي بديل. بالنسبة لحساب الأدمن بس،
      // بنكتب الرابط في ملف محمي جوه مجلد البيانات وبنطبعه في لوج السيرفر (مش
      // في رد الـ API أبدًا) عشان صاحب المتجر يقدر يستعيد حسابه من الاستضافة.
      if (user.role === 'admin' && activeProvider() === 'console') {
        try {
          fs.writeFileSync(ADMIN_RESET_LINK_FILE, `${new Date().toISOString()}\n${link}\n`, {
            mode: 0o600
          });
        } catch (error) {
          console.warn('[admin] تعذر حفظ رابط الاستعادة:', error.message);
        }
        console.warn(`\x1b[33m🔗 مفيش مزوّد بريد متظبط — رابط استعادة كلمة مرور الأدمن (صالح ساعة):\n    ${link}\n    (اتحفظ كمان في ${ADMIN_RESET_LINK_FILE})\x1b[0m`);
      }
      await store.logActivity({
        userId: user.id,
        userName: user.name,
        action: 'طلب استعادة كلمة المرور',
        details: user.email
      });
    }
    // ردّ واحد ثابت سواء البريد موجود أو لأ، عشان محدش يعرف مين مسجّل عندنا
    // (user enumeration).
    return res.json({
      ok: true,
      message: 'لو البريد ده مسجّل عندنا، هيوصلك رابط لإعادة تعيين كلمة المرور خلال دقائق.',
      ...(devLink ? {
        devResetLink: devLink
      } : {})
    });
  });

  // التحقق من صلاحية التوكن قبل عرض الفورم (من غير ما نستهلكه)
  app.get('/api/auth/reset-password/check', passwordResetLimiter, async (req, res) => {
    const token = String(req.query.token || '');
    // (إصلاح) تحقق حقيقي من وجود التوكن وصلاحيته في القاعدة من غير ما نستهلكه،
    // بدل فحص الطول اللي كان بيعرض فورم «صالح» لتوكن منتهي أو مزوّر.
    res.json({
      ok: token.length >= 20 && (await store.peekAuthToken(token, 'reset'))
    });
  });
  app.post('/api/auth/reset-password', passwordResetLimiter, async (req, res) => {
    const {
      token,
      password
    } = req.body || {};
    if (!token) return res.status(400).json({
      error: 'رابط غير صالح'
    });
    const passwordError = passwordPolicyError(password);
    if (passwordError) return res.status(400).json({
      error: passwordError
    });
    const user = await store.consumeAuthToken(String(token), 'reset');
    if (!user) return res.status(400).json({
      error: 'الرابط غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.'
    });
    await store.setUserPassword(user.id, String(password));
    // أي جلسة مفتوحة (حتى بتاعة المهاجم) بتتلغي فورًا مع تغيير كلمة المرور.
    await store.logActivity({
      userId: user.id,
      userName: user.name,
      action: 'إعادة تعيين كلمة المرور',
      details: user.email
    });
    clearSessionCookie(res);
    res.json({
      ok: true,
      message: 'تم تغيير كلمة المرور بنجاح. سجّل الدخول بكلمة المرور الجديدة.'
    });
  });

  // (إصلاح) تفعيل حقيقي بكود 6 أرقام بيتبعت على البريد نفسه، صالح 15 دقيقة،
  // ويُستخدم مرة واحدة. مفيش أي مسار بيعلّم الحساب مفعّل من غير الكود ده.
  app.post('/api/auth/resend-verification', requireAuth, passwordResetLimiter, async (req, res) => {
    if (truthy(req.user.email_verified)) {
      return res.json({
        ok: true,
        alreadyVerified: true,
        message: 'حسابك مفعّل بالفعل.'
      });
    }
    if (!EMAIL_VERIFICATION_AVAILABLE) {
      return res.status(503).json({
        error: 'خدمة إرسال البريد مش مفعّلة حاليًا — تواصل معانا لتفعيل حسابك.'
      });
    }
    let devCode = null;
    try {
      devCode = await issueVerificationEmail(req, req.user);
    } catch (err) {
      console.error('[verify-email]', err.message);
      return res.status(502).json({
        error: 'تعذر إرسال كود التفعيل دلوقتي، حاول بعد شوية.'
      });
    }
    return res.json({
      ok: true,
      message: 'بعتنالك كود تفعيل جديد على بريدك (صالح 15 دقيقة).',
      ...(devCode ? {
        devVerifyCode: devCode
      } : {})
    });
  });
  app.post('/api/auth/verify-email', requireAuth, authLimiter, async (req, res) => {
    if (truthy(req.user.email_verified)) return res.json({
      ok: true,
      message: 'حسابك مفعّل بالفعل.'
    });
    const code = String((req.body || {}).code || '').replace(/\D/g, '');
    if (code.length !== 6) return res.status(400).json({
      error: 'الكود لازم يكون 6 أرقام'
    });
    const user = await store.consumeAuthCode(req.user.id, code, 'verify');
    if (!user) return res.status(400).json({
      error: 'الكود غير صحيح أو انتهت صلاحيته. اطلب كود جديد.'
    });
    await store.markEmailVerified(user.id);
    await store.logActivity({
      userId: user.id,
      userName: user.name,
      action: 'تفعيل البريد الإلكتروني',
      details: user.email
    });
    return res.json({
      ok: true,
      message: 'تم تفعيل بريدك بنجاح ✅'
    });
  });

  // ---------------------------------------------------------------------------
  // (جديد) الدخول/التسجيل بحساب جوجل — إثبات ملكية البريد من غير كود ولا رابط
  // ---------------------------------------------------------------------------
  app.get('/api/auth/config', (_req, res) => {
    res.json({
      googleEnabled: googleAuth.isEnabled(),
      googleClientId: googleAuth.isEnabled() ? googleAuth.clientId() : null,
      emailVerifyMode: EMAIL_VERIFY_MODE,
      captchaEnabled: turnstile.isEnabled(),
      captchaSiteKey: turnstile.isEnabled() ? turnstile.siteKey() : null
    });
  });
  app.post('/api/auth/google', authLimiter, async (req, res) => {
    if (!googleAuth.isEnabled()) {
      return res.status(503).json({
        error: 'الدخول بجوجل غير مفعّل على هذا الموقع.'
      });
    }
    const profile = await googleAuth.verifyIdToken((req.body || {}).credential);
    if (!profile) return res.status(401).json({
      error: 'تعذر التحقق من حساب جوجل. جرّب تاني.'
    });
    let user = await store.findUserByEmail(profile.email);
    if (!user) {
      // حساب جديد بكلمة مرور عشوائية (المستخدم بيدخل بجوجل، ويقدر يعمل
      // "نسيت كلمة المرور" لو حب يستخدم كلمة مرور عادية بعدين).
      await store.createUser({
        name: profile.name,
        email: profile.email,
        password: crypto.randomBytes(24).toString('base64url'),
        role: 'customer',
        emailVerified: true
      });
      user = await store.findUserByEmail(profile.email);
      await store.logActivity({
        userId: user.id,
        userName: user.name,
        action: 'إنشاء حساب بجوجل',
        details: user.email
      });
    } else if (!truthy(user.email_verified)) {
      await store.markEmailVerified(user.id);
      user = await store.findUserByEmail(profile.email);
    }
    // (إصلاح) الدخول بجوجل كان بيتخطى التحقق بخطوتين: جوجل بتثبت ملكية البريد
    // بس، مش العامل التاني. لو الحساب مفعّل عليه TOTP لازم كود صحيح زي مسار
    // كلمة المرور بالظبط.
    const totpRow = await store.getTotpSecret(user.id);
    if (totpRow && totpRow.totp_enabled) {
      return res.json(await issueTotpChallenge(user));
    }
    setSessionCookie(res, {
      userId: user.id,
      role: user.role,
      email: user.email,
      sv: user.session_version || 0
    });
    return res.json({
      ok: true,
      user: store.sanitizeUser(user),
      emailVerified: true,
      provider: 'google'
    });
  });

  // ---------------------------------------------------------------------------
  // (6) التحقق بخطوتين (2FA) — TOTP اختياري لأي حساب (مهم بالذات لحساب الأدمن).
  // ---------------------------------------------------------------------------
  app.get('/api/auth/2fa/status', requireAuth, async (req, res) => {
    const row = await store.getTotpSecret(req.user.id);
    const enabled = !!(row && row.totp_enabled);
    const pending = !!(row && row.totp_secret && !row.totp_enabled);
    res.json({ enabled, pending });
  });

  // خطوة 1: توليد سر جديد + رابط otpauth (لعرضه كـ QR في الواجهة). الحساب
  // لسه مش مفعّل عليه TOTP لحد ما يتأكد الكود في خطوة enable.
  app.post('/api/auth/2fa/setup', requireAuth, writeLimiter, async (req, res) => {
    const secret = totp.generateSecret();
    await store.setTotpSecret(req.user.id, secret);
    res.json({
      ok: true,
      secret,
      otpauthUrl: totp.otpauthUrl({ secret, label: req.user.email, issuer: 'متجر يوسف' })
    });
  });

  // خطوة 2: تأكيد أول كود من تطبيق المصادقة قبل ما نفعّل TOTP فعليًا.
  app.post('/api/auth/2fa/enable', requireAuth, writeLimiter, async (req, res) => {
    const code = String((req.body || {}).code || '').replace(/\D/g, '');
    if (code.length !== 6) return res.status(400).json({
      error: 'الكود لازم يكون 6 أرقام'
    });
    const row = await store.getTotpSecret(req.user.id);
    if (!row || !row.totp_secret) return res.status(400).json({
      error: 'لازم تعمل إعداد التحقق بخطوتين الأول'
    });
    if (!totp.verify(row.totp_secret, code) || !(await store.claimTotpCode(req.user.id, code))) {
      return res.status(400).json({
        error: 'الكود غير صحيح أو منتهي الصلاحية'
      });
    }
    const user = await store.enableTotp(req.user.id);
    await store.logActivity({
      userId: req.user.id,
      userName: req.user.name,
      action: 'تفعيل التحقق بخطوتين',
      details: req.user.email
    });
    res.json({ ok: true, user, twoFactorEnabled: true });
  });

  // إلغاء التفعيل: لازم كود TOTP صحيح حالي (مش مجرد طلب) عشان محدش يقفله
  // بجلسة مسروقة من غير ما يملك جهاز المصادقة فعليًا.
  app.post('/api/auth/2fa/disable', requireAuth, writeLimiter, async (req, res) => {
    const code = String((req.body || {}).code || '').replace(/\D/g, '');
    const row = await store.getTotpSecret(req.user.id);
    if (!row || !row.totp_enabled) return res.json({ ok: true, twoFactorEnabled: false });
    if (code.length !== 6 || !totp.verify(row.totp_secret, code) || !(await store.claimTotpCode(req.user.id, code))) {
      return res.status(400).json({
        error: 'الكود غير صحيح أو منتهي الصلاحية'
      });
    }
    const user = await store.disableTotp(req.user.id);
    await store.logActivity({
      userId: req.user.id,
      userName: req.user.name,
      action: 'إلغاء التحقق بخطوتين',
      details: req.user.email
    });
    res.json({ ok: true, user, twoFactorEnabled: false });
  });

  // خطوة التحقق بعد الباسورد مباشرة: مفيش سيشن لسه، فمفيش requireAuth —
  // بدل كده بنتحقق من pendingToken اللي رجعناه من /login أو /google بالذات.
  const totpAttempts = new Map();
  const TOTP_MAX_ATTEMPTS = 5;
  const TOTP_LOCK_MS = 10 * 60 * 1000;
  app.post('/api/auth/2fa/verify-login', authLimiter, async (req, res) => {
    const pendingToken = asText((req.body || {}).pendingToken, 200);
    const code = String((req.body || {}).code || '').replace(/\D/g, '');
    if (!pendingToken || code.length !== 6) return res.status(400).json({
      error: 'بيانات ناقصة'
    });
    const now = Date.now();
    const attempt = totpAttempts.get(pendingToken);
    if (attempt && attempt.lockedUntil > now) return res.status(429).json({ error: 'محاولات كثيرة. حاول بعد دقائق.' });
    if (attempt && attempt.lockedUntil <= now) totpAttempts.delete(pendingToken);
    const user = store.peekAuthToken ? await store.peekAuthToken(pendingToken, 'totp_login') : null;
    if (!user) return res.status(401).json({ error: 'الجلسة المعلّقة غير صالحة أو انتهت — سجّل الدخول من جديد.' });
    const row = await store.getTotpSecret(user.id);
    if (!row || !row.totp_enabled) return res.status(400).json({
      error: 'التحقق بخطوتين مش مفعّل على هذا الحساب'
    });
    if (!totp.verify(row.totp_secret, code) || !(await store.claimTotpCode(user.id, code))) {
      const next = totpAttempts.get(pendingToken) || { count: 0, lockedUntil: 0 };
      next.count += 1;
      if (next.count >= TOTP_MAX_ATTEMPTS) next.lockedUntil = Date.now() + TOTP_LOCK_MS;
      totpAttempts.set(pendingToken, next);
      await noteFailedLogin(user.email);
      return res.status(401).json({ error: next.lockedUntil ? 'تم قفل جلسة التحقق مؤقتًا.' : 'كود التحقق غير صحيح' });
    }
    const consumed = await store.consumeAuthToken(pendingToken, 'totp_login');
    if (!consumed) return res.status(401).json({ error: 'الجلسة المعلّقة غير صالحة أو انتهت — سجّل الدخول من جديد.' });
    totpAttempts.delete(pendingToken);
    await completeLogin(res, consumed);
    return res.json({ ok: true, user: store.sanitizeUser(consumed), mustChangePassword: truthy(consumed.must_change_password), emailVerified: truthy(consumed.email_verified), twoFactorEnabled: true });
  });
};
