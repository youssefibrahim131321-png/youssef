# الهجرة من SQLite لـ Postgres — دليل التشغيل

> ⚠️ **خد backup قبل أول تشغيل حقيقي.** السكربت نفسه بيرفض الكتابة من غير تأكيد.

## 1) نسخة احتياطية إلزامية

```bash
pg_dump "$DATABASE_URL" -Fc -f backup-$(date +%F).dump
# وكمان نسخة من قاعدة SQLite القديمة
cp data/store.db data/store.db.bak
```

الاسترجاع لو حصل أي مشكلة:

```bash
pg_restore --clean --if-exists -d "$DATABASE_URL" backup-YYYY-MM-DD.dump
```

## 2) إنشاء المخطط في Postgres

السكربت **بينقل بيانات بس**، مش بيعمل جداول. لازم تكون الجداول موجودة الأول
(نفس أسماء وأعمدة SQLite). أي عمود موجود في SQLite ومش موجود في Postgres
بيتجاهل، وبيتطبع في التقرير.

## 3) تشغيل تجريبي (بدون أي كتابة)

```bash
SQLITE_PATH=./data/store.db DATABASE_URL=postgres://... \
  node scripts/migrate-sqlite-to-postgres.js --dry-run
```

الـ dry-run بيطبع:

- ترتيب الجداول حسب المفاتيح الأجنبية (الأب قبل الابن).
- عدد الصفوف في كل جدول.
- الجداول اللي مش موجودة في Postgres (هتتخطّى).
- الأعمدة اللي هتتجاهل.

راجع التقرير ده كويس قبل الخطوة اللي بعدها.

## 4) النقل الحقيقي

```bash
SQLITE_PATH=./data/store.db DATABASE_URL=postgres://... \
  node scripts/migrate-sqlite-to-postgres.js --i-have-a-backup
# أو: I_HAVE_A_BACKUP=1 node scripts/migrate-sqlite-to-postgres.js
```

- كل النقل جوّه **transaction واحدة**: أي خطأ = ROLLBACK كامل، مفيش نقل نصّه.
- الإدخال **على دفعات** (افتراضي 500 صف، عدّلها بـ `BATCH_SIZE`).
- `ON CONFLICT DO NOTHING` فالسكربت **idempotent**: تشغيله تاني ما بيكرّرش صفوف.
- بعد كل جدول بيتظبط الـ sequence بتاع `id` عشان الإدخالات الجديدة ما تتعاركش.
- `PGSSL=0` بتوقف SSL (لقاعدة محلية).

## 5) تحقق بعد النقل

```bash
# قارن العدّادات في الجداول المهمة
sqlite3 data/store.db "SELECT COUNT(*) FROM orders;"
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM orders;"
psql "$DATABASE_URL" -c "SELECT MAX(id) FROM orders;"
```

بعدها شغّل التطبيق على Postgres وجرّب: تسجيل دخول، إضافة للسلة، إنشاء أوردر
جديد (للتأكد إن الـ sequences مظبوطة)، ولوحة الأدمن.

## اختبار المنطق في CI

مفيش سيرفر Postgres في بيئة الاختبار، فالمنطق الحسّاس (ترتيب المفاتيح
الأجنبية، بناء جملة الإدخال على دفعات، رفض الأسماء غير الصالحة، ورفض النقل
بدون تأكيد backup) متغطّى في `test/migrate-postgres.test.js` على عميل مزيّف.
الاختبار على قاعدة قديمة حقيقية بيتم يدويًا بخطوة الـ `--dry-run` فوق.
