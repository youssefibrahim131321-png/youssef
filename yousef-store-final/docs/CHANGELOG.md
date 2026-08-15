# سجل التغييرات (CHANGELOG)

كل ملفات "الإصلاحات" المتراكمة (FIXES-v14، V5-FIXES...) اندمجت هنا. من دلوقتي أي
إصلاح بيتضاف في أعلى الملف ده بدل إنشاء ملف جديد لكل نسخة.

## v30-merged — أفضل ما في نسختين مبنيين على v29 (هذا الإصدار)

كان فيه فرعان مبنيين على v29 بأهداف مختلفة، ودُمجا في نسخة واحدة:

- **من فرع "fixed"** (الأساس): تشفير كوكي الجلسة (AES-256-GCM)، Migrations
  مرقّمة (`schema_migrations` + `docs/SCHEMA-MIGRATIONS.md`)، سجل تدقيق أشمل
  لأفعال الأدمن، `REQUIRE_OFFSITE_BACKUP`، ومراجعة كاملة لتقرير الفحص
  (التفاصيل الكاملة في قسم v30 تحت).
- **من فرع "paymob-monitor"** (أُعيد دمجه فوق الأساس): ميزة مراقبة مزامنة
  Paymob وتقرير مصالحة المخزون — `lib/store/paymob-monitor-repo.js` (جدول
  `paymob_events`)، `lib/routes/admin-report-routes.js` (تقارير CSV/PDF
  ولوحة صحة المزامنة `/api/admin/paymob/health`)، `lib/pdf-report.js`.
  ورُبطت بمكنسة `sweepStalePaymobOrders` الأحدث من فرع fixed، وأُضيف تسجيل
  مرحلة `sweeper` في `paymob_events` (كانت معرّفة في `STAGES` بس غير
  مستخدمة فعليًا في النسخة الأصلية — تم سدّ الفجوة دي في الدمج).

تحقّق: 85/85 اختبار ناجح (`npm test`)، `npm run lint` نظيف، وفحص البناء
(`npm run typecheck`) نجح على 112 ملف.

## v30 — إصلاحات تقرير الفحص الشامل (v29)

### 🔴 حرج
- **قاعدة بيانات في الذاكرة بصمت** (`lib/memory-db.js`, `store.js`): `pg-mem`
  بقت بتتفعّل تلقائيًا بس وقت `NODE_ENV=test`. أي استخدام تاني (تطوير محلي من
  غير `DATABASE_URL`) لازم `ALLOW_MEMORY_DB=1` صراحةً، وإلا الإقلاع بيرفض
  برسالة واضحة بدل ما يشتغل بصمت على بيانات بتضيع مع أول Restart.
- **مخزون Paymob محجوز للأبد** (`lib/store/order-status-repo.js`, `server.js`):
  مكنسة جديدة (`sweepStalePaymobOrders`, كل ١٠ دقايق) بتلغي طلبات Paymob لسه
  `pending`/`failed` بعد `PAYMOB_STALE_MINUTES` (افتراضي ٤٥ دقيقة)، وده بيحرّر
  المخزون تلقائيًا (نفس مسار الإلغاء اليدوي، تحت قفل صف الطلب).

### 🟠 متوسطة-عالية
- **Rate limit محلي فقط لـ write/coupon** (`lib/rate-limit.js`): بقوا
  `centralizedScopes` زي `auth` بالظبط — محسوبين ذرّيًا في Postgres.
- **نسخ احتياطي على نفس القرص** (`server.js`): علم جديد
  `REQUIRE_OFFSITE_BACKUP=1` بيوقف الإقلاع في الإنتاج لو `BACKUP_UPLOAD_URL`
  مش مظبوط (زي باقي أعلام `REQUIRE_*`).
- **خطأ JavaScript في 4 صفحات** (`theme.js` + `404/shipping/returns/privacy.html`):
  الصفحات الأربعة بقى فيها `<script src="/ui-utils.js">` قبل `theme.js`،
  وكمان `theme.js` نفسه بقى عنده Fallback آمن لو `window.YousefUI` مش موجودة.
- **Healthcheck ضيق** (`railway.json`): من ٣٠ ثانية لـ ١٠٠.

### 🟡 متوسطة
- **Webhook بيرجّع 500 فعليًا** (`lib/paymob-routes.js`): بقى بيرجّع 200 فعلًا
  زي ما التعليق كان بيقول، عشان يمنع Retry Storm من Paymob.
- **`trustedHtml(trustedHtml(...))` مكرر** في `catalog.js` و`product-modal.js`.
- **`cachedKeySource` غير مستخدم** (`lib/secret-crypto.js`): بقت دالة تشخيصية
  حقيقية `getKeySource()` بدل ما تتمسح بلا فايدة.
- **سجل تدقيق ناقص لبعض أفعال الأدمن**: تعديل كوبون، تصدير الطلبات CSV،
  والتصدير الكامل JSON بقوا مسجّلين في Activity Log زي باقي عمليات الكتابة.
- **لا توجد Migrations مرقمة** (`store.js`): جدول `schema_migrations` جديد +
  مصفوفة `MIGRATIONS` مرقمة (شوف [`docs/SCHEMA-MIGRATIONS.md`](SCHEMA-MIGRATIONS.md)
  لإزاي تضيف هجرة جديدة).
- **`dashboard.html` حماية Client-Side بس** (`server.js`): بقى فيه Redirect من
  السيرفر لغير المسجلين لـ `/account.html?next=dashboard.html`، زي `admin.html`
  بالظبط. `account.html` نفسها اتسابت من غير تعديل عمدًا — هي صفحة تسجيل
  الدخول/التسجيل نفسها، فلازم تفضل 200 للزوار.
- **كوكي الجلسة مقروء كـ Base64 صريح** (`server.js`): محتوى الجلسة بقى مشفّر
  (AES-256-GCM بمفتاح مشتق منفصل)، مش بس موقّع. **ملحوظة تشغيلية:** بعد
  النشر، أي جلسة قديمة هتتطلب دخول تاني (الصيغة القديمة مش قابلة لفك التشفير
  بالمفتاح الجديد) — تسجيل خروج جماعي لمرة واحدة، متوقّع ومقبول.

### ملاحظات لم تُنفَّذ (تحتاج قرار/بيئة غير متاحة هنا)
- `npm audit` وتحديث نسخ `better-sqlite3`/`eslint` (devDependencies) محتاجين
  اتصال إنترنت وتشغيل فعلي — نفّذهم محليًا قبل النشر.
- حجم `server.js` (~1680 سطر) لسه كبير؛ إعادة هيكلته أكبر من إصلاح دفعة واحدة
  وتحتاج مجموعة اختبارات شغّالة فعليًا قبل أي تقسيم كبير.

## v25 — تعدد النسخ + انفجار كاش الصور


### تشغيل على أكتر من نسخة (scaling)
- **قفل مهام دورية في القاعدة** (`lib/instance-lock.js`) بـ `pg_try_advisory_lock`:
  الإشعارات المؤجلة، النسخ الاحتياطي، تنبيه الطلبات المعلّقة (SLA)، وتنظيف
  التوكنات — كلهم بيشتغلوا على نسخة واحدة بس. قبل كده أي `scale` كان معناه
  إشعارات مكرّرة للعميل ونسخ احتياطي متزامن. القفل جلسة-مستوى فبيتحرّر تلقائيًا
  لو النسخة وقعت (مفيش قفل عالق).
- تنظيف عدّاد حدود المعدّل المحلي فاضل في كل نسخة (لازم كده)، بس الكتابة على
  القاعدة بقت جوه القفل.

### كاش الصور
- **مكنسة كاش** (`lib/image-cache-gc.js`) بتشتغل كل ٦ ساعات: بتمسح النسخ اللي
  أصلها اتمسح (orphans)، والنسخ اللي عدّى عليها `IMAGE_CACHE_TTL_DAYS` (٣٠ يوم
  افتراضيًا)، وبتقصّ الأقدم لو الحجم عدّى `IMAGE_CACHE_MAX_MB` (٥١٢MB افتراضيًا).
  قبل كده الكاش كان بينمو للأبد لحد ما الـ Volume يمتلي.
- **تسخين النسخ وقت الرفع** (`warmVariants`): AVIF/WebP بيتولدوا بعد رفع صورة
  المنتج فورًا، فأول زائر ما بيستنّاش التحويل جوه طلبه (صفحة فيها ٢٠ صورة جديدة
  كانت بتضرب الـ CPU وتأخّر أول تحميل).

### كاش المتصفح
- صور `public/` (اللوجو والأيقونات) أسماؤها ثابتة، فـ `immutable` لمدة ٣٠ يوم كان
  بيمنع أي تحديث للوجو من إنه يوصل. بقت `max-age=86400` +
  `stale-while-revalidate` + `must-revalidate` (revalidate رخيص بـ 304).
  الخطوط فضلت `immutable` سنة كاملة.

### جودة
- اختبارات جديدة (`test/image-cache-gc.test.js`) للمكنسة والقفل والتسخين.
- إزالة استيرادات ميتة (`escapeHtml` / `esc` / `trustedHtml` / `showNetworkError`)
  من ١٤ ملف واجهة: التحذيرات دي كانت بتخبّي تحذيرات حقيقية. اللينت بقى نضيف.

### متغيرات بيئة جديدة
| المتغير | الافتراضي | الوظيفة |
| --- | --- | --- |
| `IMAGE_CACHE_MAX_MB` | `512` | الحد الأقصى لحجم كاش الصور المحوّلة |
| `IMAGE_CACHE_TTL_DAYS` | `30` | عمر النسخة المحوّلة من غير استخدام |

## v20 — تشديد أمني + جودة

### أمان
- **كلمة مرور الأدمن مش بتتطبع في اللوج**: بتتكتب بس في ملف `0600` جوه مجلد
  البيانات وبيتمسح أول ما تتغيّر. طباعتها في اللوج بقت خلف
  `ADMIN_PRINT_PASSWORD=1` وممنوعة في `production`.
- **`data/` اتشال من الأرشيف/المستودع** وكل محتواه في `.gitignore` (ما عدا
  `.gitkeep`) — ملف `INITIAL-ADMIN-PASSWORD.txt` مكانش المفروض يتوزّع خالص.
- **webhook باي‌موب**: التحقق من HMAC بقى إجباري بشكل قاطع (fail closed): لو
  `PAYMOB_HMAC_SECRET` مش مظبوط، كل الطلبات بترجع `503` قبل أي معالجة، والتوقيع
  لازم يبقى hex بطول صحيح. المسار معفي من CSRF بالتصميم (نداء سيرفر-لسيرفر)،
  فالتوقيع هو وسيلة المصادقة الوحيدة.
- **CSP**: اتشال `style-src-attr 'unsafe-inline'` (بقى `'none'`)، و`img-src`
  ما بقتش مفتوحة على كل `https:` — بقت `'self' data: blob:` مع إمكانية إضافة CDN
  صريح بـ `IMG_SRC_EXTRA`.

### أداء وكاش
- كل أصول CSS/JS بتتحقن في الـ HTML ببصمة محتوى (`?v=<sha1-10>`) وبتتقدّم بكاش
  `max-age=31536000, immutable` عند طلبها بالبصمة، وبكاش قصير + إعادة تحقق من
  غيرها. ده بيحل ضعف الكاش بدون إدخال خطوة بناء/bundler.
- `sharp` نُقلت من `optionalDependencies` لـ `dependencies`: ضغط الصور بقى سلوك
  محدد مش رهن البيئة (ولسه `REQUIRE_IMAGE_OPTIMIZE=0` بيسمح بتجاوزه صراحةً).

### SEO
- صفحة المنتج بمسار حقيقي `/product/<id>/<slug>` مع حقن `title/description/
  og:*/canonical` و JSON-LD من السيرفر قبل الإرسال (SSR للميتاداتا) + sitemap.

### اختبارات وجودة
- `test/helpers/test-db.js`: كل الاختبارات بقت تشيل `DATABASE_URL` بالقوة وتشتغل
  على PostgreSQL في الذاكرة (pg-mem) معزولة لكل اختبار، وبتفشل برسالة واضحة لو
  المحرك مش متثبت. خلاص مفيش اعتماد على قاعدة متاحة في بيئة التشغيل ولا خطر
  الكتابة في قاعدة حقيقية.
- `test/a11y-perf.test.js`: تغطية جديدة لإمكانية الوصول (lang/dir، h1 واحد، alt
  لكل صورة، تسمية كل حقل)، ورؤوس الأداء/الكاش، وترويسة CSP، وإجبارية HMAC.
- CI على GitHub Actions: `npm run lint` + `npm test` على Node 20 و22.
- الوثائق اتلمّت: كل الأدلة في `docs/`، وسجل الإصلاحات في الملف ده.

## الأرشيف — v14


## 1) رفع إيصال التحويل من الموبايل (المشكلة الأساسية)
- أزرار الاختيار بقت `<label for>` بدل `input.click()` على input مخفي بـ `display:none`
  — ده كان بيمنع فتح معرض الصور في متصفحات الموبايل وتطبيقات فيسبوك/انستجرام.
- الـ input بقى مخفي بصريًا فقط (`.proof-file`) مش `display:none`.
- `accept` بقى بيقبل `image/*` + `.heic/.heif` من غير `capture` على زر المعرض
  (زر الكاميرا لوحده هو اللي فيه `capture`).
- السيرفر بقى بيحدد نوع الصورة من محتواها (magic bytes) بدل ما يثق في
  `Content-Type` بتاع المتصفح — بيصلّح رفض صور أندرويد اللي بتوصل
  `application/octet-stream` وصور الآيفون.
- أي صيغة غير مدعومة بتتحوّل لـ JPEG في المتصفح قبل الرفع، ولو فشل التحويل
  بتظهر رسالة عربية واضحة بدل خطأ عام.
- تفريغ قيمة الـ input قبل المعالجة عشان إعادة اختيار نفس الصورة تشتغل.
- أزرار أكبر (46px) مناسبة للمس + ملاحظة إرشادية للعميل.

## 2) إصلاحات أمنية
- `public/admin.js`: عارض الإيصال بقى بيعدي الرابط على `safeImageUrl()`
  (منع `javascript:` XSS في جلسة الأدمن) + `aria-modal` وإرجاع التركيز.
- حذف الاعتماد على ملفات `.owner` القديمة (كود ميت = سطح هجوم بلا فايدة).
- `mailer.js`: تعقيم نص أخطاء مزوّد البريد قبل تسجيلها في اللوج.

## 3) سلامة البيانات
- `adjustStock` و`updateProduct` داخل معاملة واحدة + تحديث ذرّي للمخزون
  (`stock = MAX(0, stock + ?)`) — منع lost update عند تعديلين متزامنين.
- `updateOrder` بيرفض أي `status`/`payment_status` مش في قائمة مسموحة.

## 4) أداء
- الداشبورد: شيلنا استعلام العناصر لكل طلب (N+1)، وأعلى المنتجات بقى `GROUP BY` في SQL.
- تنظيف الإشعارات كل 100 إشعار بدل كل إشعار.
- شريط السكرول مخنوق بـ `requestAnimationFrame`.
- رفع إصدار كاش الـ Service Worker إلى v8.

## 5) تشغيل
- `email-guard`: فشل الـ DNS المؤقت مابقاش يقفل التسجيل (fail-open).

---

# إصلاحات نسخة v15 (مراجعة أمان وجودة)

## الباك إند
- رفع الصور: الملفات بتنزل أول في مجلد حجر صحي (quarantine) برّه أي مسار عام،
  والتحقق من نوع الصورة بمحتواها (magic bytes) بيحصل هناك؛ الملف الصالح بس
  هو اللي بيتنقل لمجلد المنتجات/الإيصالات، وغيره بيتمسح فورًا.
- إنشاء الطلب: التأكد إن إيصال التحويل المربوط بالطلب مملوك لنفس المستخدم
  (403 لو مش بتاعه) — منع ربط إيصال حد تاني.
- google-auth: قفل in-flight + حد أدنى 60 ثانية لإعادة تحميل JWKS، فمستحيل
  حد يعمل ضغط على جوجل بإرسال kid عشوائي.
- mailer: مابقاش يسجّل نص أخطاء مزوّد البريد (كود الحالة بس) — منع تسريب
  بيانات في اللوج.
- rate-limit: إخلاء الذاكرة مابقاش يمسح عدّادات قفل تسجيل الدخول، ولا ينفع
  حد يصفّر الحدود بفيضان مفاتيح مختلفة.
- store: مسار النسخ الاحتياطي (VACUUM INTO) بيتحقق منه ولازم يكون جوه
  BACKUP_DIR وبدون أي علامات تنصيص.
- مسارات الأدمن: قائمة مسارات محددة بالضبط بدل مطابقة endsWith الفضفاضة.
- تسجيل الدخول: توحيد البريد بـ trim().toLowerCase() زي التسجيل.
- fail-open (فحص MX / تعطّل البريد): بقى بيطبع تحذير واضح في اللوج كل مرة
  عشان الأعطال ما تعديش بصمت.

## الفرونت إند
- forgot-password: رابط الاستعادة بيتبنى بـ createElement/textContent بدل
  innerHTML (سد ثغرة XSS).
- csrf.js: الروابط اللي شكلها //host بقت تُرفض كـ cross-origin، فمفيش توكن
  بيتبعت لدومين خارجي.
- service-worker: إصدار كاش جديد (v9) + admin.css/admin.js/auth.css/
  notify-client.js داخل الكاش + استراتيجية runtime للـ css/js.
- admin.js: عند 401/403 بيتم تفريغ البيانات الحساسة من الشاشة وإيقاف باقي
  الطلبات، وكل تبويب ملفوف في try/catch بيعرض رسالة للمستخدم.
- كل صور المنتجات/الإيصالات بتتحط بـ setAttribute بدل التضمين في innerHTML.
- السلة: تثبيت الكميات المحفوظة على المتاح في المخزون (وحد أقصى 999) قبل أي
  عرض أو حساب، والأسعار دايمًا من بيانات السيرفر.
- canonical و og:url بقوا روابط مطلقة، و manifest فيه id و description.
- قائمة الموبايل المقفولة بقت inert + aria-hidden فمابقتش قابلة للوصول بالـ Tab.
- خانة البحث بقت debounced (250ms).

## الأرشيف — v5


- Disabled admin 2FA/TOTP enforcement completely.
- Admin login no longer asks for a TOTP code, even if an old admin account had 2FA enabled.
- Removed the 2FA section from the admin UI.
- Fixed the wishlist startup error so a wishlist/auth edge case cannot cover the storefront with the red network banner.
- Bumped service-worker cache from v12 to v13 so updated JS/CSS is picked up.
- Added a visual refresh for the storefront and admin panel: glass surfaces, better hover states, gradients, responsive KPI layout, cleaner tables and stronger visual hierarchy.

The existing database is preserved; no destructive data migration is performed.
