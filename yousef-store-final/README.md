
## الجودة: اختبارات + lint + CI (إصلاح 19)

```bash
npm test        # 26 اختبار (node:test) لـ TOTP والـ pagination والـ slugs والـ rate limit والتخزين وقاعدة البيانات
npm run lint    # ESLint للسيرفر والواجهة
```

وفي `.github/workflows/ci.yml` بيتشغّل `npm ci && npm run lint && npm test` على كل push و pull request.

## متغيرات البيئة المهمة للاستضافة السحابية

| المتغير | الغرض |
| --- | --- |
| `DATA_DIR` | مكان قاعدة البيانات — لازم يكون Volume دائم (مش داخل مجلد المشروع) |
| `UPLOADS_DIR` | مكان صور المنتجات وإيصالات الدفع على الـ Volume |
| `BACKUP_DIR` | مكان النسخ الاحتياطية — يُفضّل قرص/مخزن مختلف عن `DATA_DIR` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | تحديد حساب المسؤول الأول بدل التوليد العشوائي |
| `BACKUP_UPLOAD_URL` | رابط خارجي (S3/R2/Webhook) بترفع عليه النسخة الاحتياطية تلقائيًا خارج السيرفر |
| `BACKUP_UPLOAD_METHOD` / `BACKUP_UPLOAD_TOKEN` | طريقة الرفع (`PUT` افتراضيًا) وتوكن التوثيق للرابط الخارجي |
| `PENDING_ORDER_SLA_HOURS` | بعد كام ساعة يوصل تنبيه للأدمن على أي طلب لسه معلّق (٣ افتراضيًا) |
| `MAIL_*` | إعدادات مزوّد البريد — إلزامية في وضع الإنتاج، والسيرفر بيرفض يقوم من غيرها |

السيرفر بيرفض يشتغل في وضع الإنتاج لو الملفات دي على قرص مؤقت هيتمسح مع كل نشر.

## استعادة حساب المسؤول (إصلاح 3)

```bash
npm run admin:reset-password              # كلمة مرور قوية جديدة تتطبع في التيرمنال
npm run admin:reset-password -- "كلمتك"    # كلمة مرور من عندك
```

الأمر ده بيسجّل خروج كل الأجهزة، ومفيش حاجة بتضيع لو فاتتك الكلمة المطبوعة أول مرة (متخزنة كمان في `DATA_DIR/INITIAL-ADMIN-PASSWORD.txt` لحد أول دخول ناجح).

## التحقق بخطوتين (إصلاح 4)

من لوحة التحكم: إعداد → التحقق بخطوتين. بيتولّد مفتاح TOTP متوافق مع Google Authenticator / Authy، وبعد التفعيل صفحة دخول الأدمن بتطلب كود 6 أرقام، والكود المستهلك ما ينفعش يتعاد استخدامه.

## حمايات الدفع اليدوي (فودافون كاش / إنستاباي)

- كل إيصال بيتحسبله بصمة SHA256، فرفع نفس صورة التحويل تاني بيترفض فورًا (409) قبل ما الطلب يتسجّل.
- رقم عملية التحويل إجباري (٦–٤٠ خانة) وبيظهر للأدمن جنب الإيصال عشان يطابقه بكشف المحفظة.
- الإيصال مربوط بصاحبه: محدش يقدر يستخدم صورة تحويل حد تاني (بيرجع 403).
- أي طلب فاضل معلّق أكتر من `PENDING_ORDER_SLA_HOURS` بيبعت تنبيه لكل حسابات الأدمن.

## فحص XSS الثابت

```bash
npm run audit:xss     # بيتشغّل تلقائيًا قبل npm test
```

بيفحص كل قوالب `innerHTML` في `public/` ويفشل لو فيه قيمة مش مغلّفة بـ `esc()`
أو دالة تنسيق آمنة — ده بيمنع أشهر خطأ في الواجهة (نسيان تهريب حقل واحد).

## قاعدة البيانات (PostgreSQL)

المشروع بقى شغال على Postgres مُدارة (Railway). ظبّط `DATABASE_URL`، والنسخ الاحتياطي بقى مسؤولية Railway (managed backups).

للتجربة المحلية السريعة شغّل `npm install` ثم `npm start`؛ لو `DATABASE_URL`
مش موجودة و`NODE_ENV` ليست `production`، المتجر يستخدم قاعدة مؤقتة في الذاكرة
تلقائيًا. بيانات الوضع المؤقت بتتمسح عند إيقاف السيرفر. التشغيل في الإنتاج يظل
يرفض البدء من غير `DATABASE_URL` حتى لا تُفقد الطلبات والمنتجات.

لنقل بيانات SQLite القديمة:

```bash
SQLITE_PATH=./data/store.db DATABASE_URL=postgres://... node scripts/migrate-sqlite-to-postgres.js
```

## الدفع أونلاين (Paymob)

راجع [PAYMOB-SETUP.md](./PAYMOB-SETUP.md) — الدفع عند الاستلام لسه شغال كمان.


## الوثائق

كل الأدلة اتجمّعت في مجلد `docs/` بدل ملفات متفرقة في الجذر:

- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) — سجل الإصلاحات (بديل FIXES-v14 / V5-FIXES وكل ملفات الإصلاحات القديمة)
- [`docs/MODULES.md`](docs/MODULES.md) — تقسيم الموديولات
- [`docs/DEPLOY-RAILWAY.md`](docs/DEPLOY-RAILWAY.md) — النشر
- [`docs/MIGRATION.md`](docs/MIGRATION.md) — الهجرة من SQLite إلى PostgreSQL وقاعدة البيانات الحالية
- [`docs/PAYMOB-SETUP.md`](docs/PAYMOB-SETUP.md)، [`docs/MAIL-SETUP.md`](docs/MAIL-SETUP.md)، [`docs/EMAIL-VERIFICATION.md`](docs/EMAIL-VERIFICATION.md)

## الاختبارات والـ CI

```bash
npm install      # لازم مرة واحدة (فيها pg-mem لقاعدة الاختبارات)
npm test         # 60+ اختبار، كلها على PostgreSQL في الذاكرة — مفيش قاعدة مطلوبة
npm run lint
```

الاختبارات بتشيل `DATABASE_URL` بالقوة عن طريق `test/helpers/test-db.js`، فمستحيل
تلمس قاعدة بيانات حقيقية. GitHub Actions (`.github/workflows/ci.yml`) بيشغّل
lint + الاختبارات على Node 20 و22 + `npm audit` + فحص XSS.

## متغيرات بيئة أمنية مهمة

| المتغير | الغرض |
| --- | --- |
| `ADMIN_PRINT_PASSWORD=1` | يطبع كلمة مرور الأدمن الأولية في اللوج (تطوير فقط — ممنوع في production) |
| `PAYMOB_HMAC_SECRET` | **إجباري** لتشغيل webhook باي‌موب؛ من غيره كل الطلبات بترجع 503 |
| `IMG_SRC_EXTRA` | دومين CDN صور إضافي يُسمح به في CSP (افتراضيًا `'self' data: blob:` بس) |
| `REQUIRE_IMAGE_OPTIMIZE=0` | يسمح بالتشغيل من غير `sharp` (افتراضيًا مطلوبة في production) |
