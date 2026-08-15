# ربط بوابة الدفع أونلاين (Paymob) — دليل الإعداد

الدفع عند الاستلام والتحويل اليدوي فاضلين شغالين زي ما هم. الإضافة دي بتديك
خيار ثالث: دفع أونلاين حقيقي بالبطاقة أو المحفظة الإلكترونية عبر Paymob.
لو المتغيرات تحت فاضية، خيار الدفع أونلاين بيتخفي أوتوماتيكيًا من صفحة الدفع.

## 1) إنشاء حساب Paymob

سجّل على https://accept.paymob.com/ واختار مصر كدولة التشغيل. الحساب بيبدأ
في وضع **Test Mode** — تقدر تجرب كل حاجة من غير أي أموال حقيقية.

## 2) هات المفاتيح من لوحة التحكم

من قائمة Paymob على اليسار:

- **Settings → Account Info**
  - `Secret Key` (يبدأ بـ `sk_test_...` في وضع التجربة، `sk_live_...` في الإنتاج)
    → حطه في `PAYMOB_SECRET_KEY`
  - `Public Key` (يبدأ بـ `pk_test_...` / `pk_live_...`)
    → حطه في `PAYMOB_PUBLIC_KEY`
  - `HMAC Secret` → حطه في `PAYMOB_HMAC_SECRET` (ده اللي بيثبت إن الإشعارات
    فعلًا جاية من Paymob مش من حد بيحاول يزوّر إشعار دفع ناجح)

- **Developers → Payment Integrations**
  - كل وسيلة دفع (بطاقة، محفظة) بيبقى ليها **Integration ID** (رقم).
  - رقم تكامل البطاقة → `PAYMOB_CARD_INTEGRATION_ID`
  - رقم تكامل المحفظة الإلكترونية (لو مفعّل عندك) → `PAYMOB_WALLET_INTEGRATION_ID`
  - لازم واحد منهم على الأقل يكون موجود عشان الدفع أونلاين يشتغل.

## 3) اضبط رابط الموقع

`PUBLIC_BASE_URL` لازم يكون هو الدومين الحقيقي للموقع بـ https (مثلاً
`https://yourstore.com`) — منه بيتبني رابط الإشعار ورابط الرجوع تلقائيًا.

## 4) سجّل روابط الـ Callbacks في Paymob

من **Developers → Payment Integrations** افتح كل تكامل (Integration) وحط:

| النوع في Paymob | الرابط |
|---|---|
| Transaction Processed Callback (server-to-server، ده الأهم) | `https://YOUR-DOMAIN.com/api/public/paymob/webhook` |
| Transaction Response Callback (رجوع المتصفح بعد الدفع) | `https://YOUR-DOMAIN.com/payment/return` |

**مهم:** التأكيد الحقيقي لحالة الطلب (مدفوع/فشل) بيحصل من الـ webhook الأول
(server-to-server) — لأنه الوحيد المضمون يوصل حتى لو العميل قفل المتصفح بعد
الدفع. صفحة `/payment/return` بس لتجربة استخدام العميل.

## 5) وصّل الراوتس في server.js

الملفات دي (`lib/paymob.js`, `lib/paymob-routes.js`) مستقلة عن `server.js`
ومحتاجة سطر واحد يضيفها. راجع تعليمات الربط في رسالة التسليم/الـ README.

## 6) وضع التجربة (Test Mode)

- في Test Mode تقدر تدفع ببطاقات وهمية موثّقة من Paymob (شوف صفحة
  "Test Cards" في التوثيق الرسمي) — مفيش خصم حقيقي.
- تأكد إن `PAYMOB_SECRET_KEY` و`PAYMOB_PUBLIC_KEY` من نفس الوضع (كلهم test
  أو كلهم live) — خلط بينهم بيدّي خطأ مصادقة.
- لتفعيل الدفع الحقيقي: فعّل حسابك (KYC) من لوحة Paymob، خد مفاتيح live
  الجديدة، وبدّل المتغيرات في بيئة الإنتاج بس (متغيرات Railway/الاستضافة).

## 7) اختبار سريع محلي لتوقيع HMAC

```
node scripts/paymob-selftest.js
```

ده بيتحقق من منطق `verifyHmac` بمثال ثابت من غير أي اتصال حقيقي بـ Paymob.
