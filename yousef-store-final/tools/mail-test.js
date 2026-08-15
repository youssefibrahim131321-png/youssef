#!/usr/bin/env node
/**
 * اختبار مزوّد البريد
 * ---------------------------------------------------------------------------
 * الاستخدام:
 *   node --env-file=.env tools/mail-test.js you@example.com
 *   npm run mail:test -- you@example.com     (لو المتغيرات موجودة في البيئة)
 *
 * السكريبت بيقولك: أي مزوّد شغال، ومن أنهي عنوان بيبعت، والرسالة وصلت ولا لأ.
 * لو رجّع via: console يعني مفيش مزوّد متظبط والرسايل بتتطبع في الترمنال بس.
 */
const { sendMail, activeProvider } = require('../mailer');

const to = process.argv[2];
if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.error('❌ اكتب بريد صالح: node --env-file=.env tools/mail-test.js you@example.com');
  process.exit(1);
}

(async () => {
  const provider = activeProvider();
  console.log(`📮 المزوّد النشط: ${provider}`);
  console.log(`   MAIL_FROM: ${process.env.MAIL_FROM || '(الافتراضي onboarding@resend.dev)'}`);
  if (provider === 'console') {
    console.warn('⚠️  مفيش مزوّد بريد متظبط — ظبّط RESEND_API_KEY أو SMTP_URL أو MAIL_WEBHOOK_URL.');
    console.warn('   شوف ملف MAIL-SETUP.md فيه الخطوات بالتفصيل.');
  }

  const result = await sendMail({
    to,
    subject: 'اختبار بريد متجر يوسف',
    text: 'لو وصلتك الرسالة دي يبقى مزوّد البريد متظبط صح، ورسايل التفعيل واستعادة كلمة المرور هتوصل عادي.',
    link: (process.env.PUBLIC_BASE_URL || 'http://localhost:3000') + '/'
  });

  if (result.delivered && result.via !== 'console') {
    console.log(`✅ اتبعتت عبر ${result.via} — شوف صندوق ${to} (بص في الـ Spam كمان أول مرة).`);
    process.exit(0);
  }
  if (result.via === 'console') {
    console.log('ℹ️  الرسالة اتطبعت فوق فقط (مفيش إرسال حقيقي).');
    process.exit(2);
  }
  console.error(`❌ فشل الإرسال عبر ${result.via} (${result.error}). راجع المفاتيح ودومين الإرسال.`);
  process.exit(1);
})().catch((error) => {
  console.error('❌ خطأ غير متوقع:', error.message);
  process.exit(1);
});
