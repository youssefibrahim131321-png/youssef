# ظبط البريد (تفعيل الحساب + استعادة كلمة المرور)

من غير مزوّد بريد، رسايل التفعيل واستعادة كلمة المرور **مش بتوصل لحد** —
في التطوير بتتطبع في الترمنال، وفي الإنتاج الـ API بيرجّع `no_mail_provider_configured`.
اختار طريقة واحدة من التالت دول، وبعدها اختبرها بأمر واحد.

## الطريقة 1 — Resend (الأسرع، مستحسنة)

1. اعمل حساب على <https://resend.com> (الخطة المجانية تكفي متجر صغير).
2. Domains ← Add Domain ← حط دومينك، وضيف سجلات DNS اللي هيطلبها (SPF + DKIM)
   عند مزوّد الدومين. لو لسه معندكش دومين، تقدر تجرّب بـ `onboarding@resend.dev`
   بس ده بيبعت لبريدك المسجّل بس.
3. API Keys ← Create API Key ← انسخه.
4. ظبّط المتغيرات (Railway ← Variables أو ملف `.env` محليًا):

```
RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
MAIL_FROM=متجر يوسف <no-reply@your-domain.com>
PUBLIC_BASE_URL=https://your-domain.com
```

`MAIL_FROM` لازم يكون على نفس الدومين اللي وثّقته في Resend، وإلا الإرسال هيترفض.

## الطريقة 2 — SMTP (Gmail أو أي بريد عندك)

Gmail محتاج **App Password** (كلمة سر التطبيقات) مش كلمة سر الحساب، ولازم
التحقق بخطوتين مفعّل: <https://myaccount.google.com/apppasswords>

```
SMTP_URL=smtps://your@gmail.com:APP_PASSWORD@smtp.gmail.com:465
MAIL_FROM=متجر يوسف <your@gmail.com>
```

أو بالمتغيرات المفصولة:

```
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_USER=no-reply@your-domain.com
SMTP_PASS=********
SMTP_SECURE=0
```

ملاحظة: Gmail بيحدّد الإرسال بحوالي 500 رسالة/يوم وبيتعامل مع الإرسال الكتير
كـ spam — للإنتاج الجدّي استخدم Resend أو أي مزوّد بريد معاملات.

## الطريقة 3 — Webhook (Zapier / Make / n8n)

```
MAIL_WEBHOOK_URL=https://hooks.zapier.com/hooks/catch/xxx/yyy
MAIL_WEBHOOK_TOKEN=optional-shared-secret
```

السيرفر بيبعت JSON فيه: `from, to, subject, text, link, html` والخدمة بتتصرّف.

## الاختبار

```
npm run mail:test -- you@example.com
# محليًا مع ملف .env:
node --env-file=.env tools/mail-test.js you@example.com
```

الخرج بيقولك المزوّد النشط والنتيجة. `via: console` = مفيش مزوّد متظبط لسه.

## أعطال شائعة

| الرسالة | السبب والحل |
|---|---|
| `Resend responded 403` | `MAIL_FROM` على دومين غير موثّق في Resend |
| `Resend responded 422` | شكل `MAIL_FROM` غلط — لازم `الاسم <mail@domain>` |
| `Invalid login` من SMTP | استخدمت كلمة سر الحساب بدل App Password |
| الرسالة في الـ Spam | ناقص SPF/DKIM على الدومين، أو بتبعت من دومين مجاني |
| `no_mail_provider_configured` | مفيش أي متغير من اللي فوق متظبط في بيئة الإنتاج |

بعد أي تعديل على المتغيرات لازم تعيد تشغيل السيرفر (Railway بيعمل ده لوحده
بعد حفظ الـ Variables).
