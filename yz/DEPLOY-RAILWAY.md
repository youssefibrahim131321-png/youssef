# نشر متجر يوسف على Railway (خطوة بخطوة)

## 1) متغيرات البيئة المطلوبة
افتح المشروع في Railway → **Variables** وحدد الآتي:

| المتغير | القيمة | ليه؟ |
|---|---|---|
| `NODE_ENV` | `production` | يفعّل الكوكيز الآمنة (Secure) وحماية الجلسات. |
| `TRUST_PROXY` | `1` | Railway بروكسي — من غيره الـ rate limiting بيتحايل عليه بسهولة. |
| `SESSION_SECRET` | نص عشوائي طويل | يخلي الجلسات ثابتة بين النشرات. |
| `ADMIN_EMAIL` | بريدك | حساب الأدمن. |
| `ADMIN_PASSWORD` | كلمة مرور قوية | لو مش محدد، بتتولّد عشوائيًا أول تشغيل وتتطبع في اللوج مرة واحدة. |
| `DATA_DIR` | `/data` | مكان قاعدة البيانات (لازم يكون على Volume — انظر خطوة 2). |
| `UPLOADS_DIR` | `/data/uploads/products` | صور المنتجات المرفوعة، عشان ما تضيعش مع كل نشر. |

> السيرفر بيفعّل `trust proxy` تلقائيًا لو اكتشف إنه على Railway، لكن الأفضل تحديد `TRUST_PROXY=1` صراحةً.
> عند الإقلاع بيطبع **فحص إعدادات النشر** ويحذّرك من أي متغير ناقص.

## 2) 🔴 الأهم: Persistent Volume (منع فقدان البيانات)
من غير Volume، أي **redeploy** بيمسح `data/store.db` والصور المرفوعة = المتجر كله يضيع.

1. في Railway: **Service → Settings → Volumes → New Volume**
2. Mount path: `/data`
3. ظبّط `DATA_DIR=/data` و `UPLOADS_DIR=/data/uploads/products`
4. أعد النشر. لو عندك بيانات قديمة، انسخ `data/store.db` القديم جوه الـ Volume قبل التشغيل.

للتحقق: بعد النشر، ادخل لوحة التحكم واضغط "نسخة احتياطية"، بعدين اعمل redeploy وتأكد إن المنتجات لسه موجودة.

## 3) البريد الإلكتروني (لازم يشتغل فعليًا)
اختار مزوّد واحد وحدد متغيراته — والسيرفر هيستخدمه تلقائيًا:

**أ) Resend (الأسهل)**
```
RESEND_API_KEY=re_xxxxxxxx
MAIL_FROM=متجر يوسف <no-reply@yourdomain.com>
```
سجّل الدومين في resend.com وأضف سجلات DNS المطلوبة، وإلا الرسائل هتتحجب.

**ب) SMTP (Gmail / أي مزوّد)**
```
SMTP_URL=smtps://user:app-password@smtp.gmail.com:465
MAIL_FROM=متجر يوسف <you@gmail.com>
```
أو `SMTP_HOST` + `SMTP_PORT` + `SMTP_USER` + `SMTP_PASS` (+ `SMTP_SECURE=1` للمنفذ 465).

**ج) Webhook (Zapier / Make)**
```
MAIL_WEBHOOK_URL=https://hooks.zapier.com/...
MAIL_WEBHOOK_TOKEN=optional
```

من غير أي مزوّد: في التطوير الكود بيتطبع في الـ Console، وفي الإنتاج بيتسجّل خطأ أحمر واضح
`no_mail_provider_configured` بدل الإيهام إن الرسالة وصلت.

## 4) قاعدة البيانات وبناء المشروع
المشروع بيستخدم `better-sqlite3` (وحدة أصلية). Railway بتستخدم صورة فيها أدوات البناء
الأساسية، والمكتبة عندها نسخ مبنية جاهزة (prebuilt) لإصدارات Node المدعومة —
فمعظم الوقت `npm install` بيعدّي من غير تجميع. لو حصلت مشكلة بناء:
- ثبّت إصدار Node على 20 أو 22 (`engines` في `package.json`، أو `NIXPACKS_NODE_VERSION=22`).
- تأكد إن `package-lock.json` مرفوع مع المشروع.

## 5) نسخ احتياطي
النسخ بتتخزن في `${DATA_DIR}/backups/*.db`. نزّلها بشكل دوري من لوحة التحكم —
الـ Volume بيحميك من النشر، مش من الحذف بالغلط.

## تحديث مهم (إصلاحات النسخة الحالية)

- **الإقلاع بيتوقف** لو كنت على Railway وDATA_DIR/UPLOADS_DIR مش على Volume دائم
  (بدل ما يكمّل بتحذير وتضيع البيانات). لو تشغيل تجريبي ومش مهتم بالبيانات:
  `ALLOW_EPHEMERAL_DATA=1`.
- الحدود الحسّاسة (دخول، استعادة كلمة مرور، عمليات الأدمن) بقت متخزّنة في قاعدة
  البيانات: مش بتتصفّر مع كل restart وبتتشارك بين العمليات اللي على نفس الـ Volume.
  لو محتاج instances على أجهزة مختلفة، لازم مخزن مشترك (Redis/Postgres).
- ملكية إيصالات الدفع بقت في جدول `payment_proofs` بدل ملفات `.owner` على الديسك
  (الملفات القديمة بتتهاجر تلقائيًا عند أول عرض).
