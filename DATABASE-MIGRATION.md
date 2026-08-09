# قاعدة البيانات (SQLite عبر better-sqlite3)

## اللي اتغيّر
- `data/store.json` (ملف JSON مسطّح) اتستبدل بـ **`data/store.db`** — قاعدة بيانات
  SQL حقيقية فيها جداول منفصلة ومترابطة: `users`, `products`, `orders`,
  `order_items`, `coupons`, `reviews`, `wishlists`, `notifications`,
  `push_subscriptions`, `activity_log`, `site_settings`, `meta`.
- بتستخدم مكتبة **`better-sqlite3`** (مكتبة خارجية مستقرة ومستخدمة في الإنتاج)،
  **مش** وحدة `node:sqlite` المدمجة التجريبية. يعني `npm install` خطوة ضرورية.
- كل الـ Transactions الحساسة (إنشاء طلب، تغيير حالة طلب، تقييم منتج...) جوه
  `BEGIN/COMMIT` حقيقي مع Rollback تلقائي عند أي خطأ.
- الواجهة البرمجية لـ `store.js` متطابقة مع النسخة القديمة المبنية على JSON.

## المتطلبات
- **Node.js 20 أو 22 (LTS)** — `engines: ">=20 <23"` في `package.json`.
  تأكد بـ `node -v`.
- `better-sqlite3` وحدة أصلية (native). عندها نسخ مبنية جاهزة (prebuilt binaries)
  لإصدارات Node الـ LTS، فغالبًا مش محتاجة تجميع. لو نسخة Node عندك غير مدعومة،
  npm هيحاول يبنيها وساعتها هتحتاج أدوات بناء:
  - **Linux**: `python3`, `make`, `g++` (`apt install -y python3 make g++`)
  - **macOS**: Xcode Command Line Tools
  - **Windows**: Visual Studio Build Tools
- على Railway/Nixpacks: ثبّت الإصدار بـ `NIXPACKS_NODE_VERSION=22` وارفع
  `package-lock.json` عشان النسخة المبنية الجاهزة تتحمّل مباشرة.

## مكان الملفات (مهم عند النشر)
- المسار الافتراضي: `./data` جنب الكود.
- يتغير بمتغير البيئة `DATA_DIR` (و`UPLOADS_DIR` لصور المنتجات).
- 🔴 على الاستضافات السحابية لازم يكون على **Persistent Volume**، وإلا كل نشر
  بيمسح المتجر. التفاصيل في `DEPLOY-RAILWAY.md`.

## الهجرة التلقائية
أول تشغيل بعد التحديث: لو لقى `store.json` قديم ومفيش `store.db`، ينقل كل
البيانات تلقائيًا، ويعيد تسمية القديم لـ `store.json.migrated-<timestamp>`
(نسخة احتياطية، مش بيتمسح)، ويطبع تأكيد في الـ Console.
لو فشلت الهجرة، السيرفر بيبدأ بقاعدة فاضية وملف JSON بيفضل زي ما هو.

## التشغيل
```bash
npm install
npm start
```

## النسخ الاحتياطي
زر "نسخة احتياطية" (والنسخة التلقائية كل 6 ساعات) بينسخ قاعدة البيانات بأمان
عبر `VACUUM INTO` في `${DATA_DIR}/backups/` بامتداد `.db`.
للاسترجاع: اقفل السيرفر، خُد نسخة من الحالي، وسمّي ملف الـ backup `store.db`.
