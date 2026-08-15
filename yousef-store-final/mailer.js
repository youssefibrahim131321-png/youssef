/**
 * ---------------------------------------------------------------------------
 * إرسال رسائل المصادقة (استعادة كلمة المرور / تفعيل البريد)
 * ---------------------------------------------------------------------------
 * المزوّدات المدعومة — بيتم اختيار أول واحد متظبط بالترتيب ده:
 *
 *  1) Resend  → RESEND_API_KEY (+ MAIL_FROM مثال: "متجر يوسف <no-reply@yourdomain.com>")
 *     أسهل وأسرع طريقة: سجّل دومينك في resend.com، خُد المفتاح، وحطّه في المتغيرات.
 *  2) SMTP    → SMTP_URL (مثال: smtps://user:pass@smtp.gmail.com:465)
 *               أو SMTP_HOST + SMTP_PORT + SMTP_USER + SMTP_PASS (+ SMTP_SECURE=1)
 *     بيستخدم مكتبة nodemailer المضافة في package.json.
 *  3) Webhook → MAIL_WEBHOOK_URL (Zapier / Make / أي خدمة) + MAIL_WEBHOOK_TOKEN اختياري.
 *  4) لا شيء  → الرسالة بتتطبع في الـ Console (وضع التطوير فقط).
 *
 * في الإنتاج (NODE_ENV=production) لو مفيش أي مزوّد متظبط، بنطبع تحذير أحمر
 * واضح وبنرجّع delivered:false — عشان ما نفضلش فاكرين إن البريد بيوصل وهو لأ.
 *
 * مهم أمنيًا: الرابط/الكود **لا يُرجَّع أبدًا** في رد الـ API في الإنتاج.
 */
const MAIL_FROM = process.env.MAIL_FROM || 'متجر يوسف <onboarding@resend.dev>';
const IS_PROD = process.env.NODE_ENV === 'production';
// مهلة قصوى لأي نداء شبكة على مزوّد البريد: من غيرها طلب واحد بايت ممكن
// يعلّق الـ request بتاع العميل لدقايق.
const MAIL_TIMEOUT_MS = Number(process.env.MAIL_TIMEOUT_MS || 10000);

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAIL_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// إعادة محاولة واحدة على الأخطاء المؤقتة فقط (429 / 5xx / انقطاع شبكة).
// أخطاء الإعداد (401/403/422) مش بتتكرر — إعادتها مضيعة وقت وبتتعب العميل.
function isRetryable(error) {
  if (error && error.name === 'AbortError') return true;
  const status = error && error.status;
  if (!status) return true;
  return status === 429 || status >= 500;
}

async function withRetry(task) {
  try {
    return await task();
  } catch (error) {
    if (!isRetryable(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 800));
    return task();
  }
}

function activeProvider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_URL || process.env.SMTP_HOST) return 'smtp';
  if (process.env.MAIL_WEBHOOK_URL) return 'webhook';
  return 'console';
}

// بنرجّع الكود/الرابط في الرد بس في التطوير ومن غير أي مزوّد بريد حقيقي.
function shouldExposeLink() {
  return !IS_PROD && activeProvider() === 'console';
}

function htmlBody({ subject, text, link }) {
  const safe = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
  return `<!doctype html><html dir="rtl" lang="ar"><body style="font-family:Tahoma,Arial,sans-serif;background:#f6f7fb;padding:24px">
  <div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;padding:24px;border:1px solid #e6e8f0">
    <h2 style="margin:0 0 12px;color:#111">${safe(subject)}</h2>
    <p style="font-size:16px;line-height:1.9;color:#333;margin:0">${safe(text)}</p>
    ${link ? `<p style="margin:24px 0"><a href="${safe(link)}" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">افتح الرابط</a></p>
    <p style="font-size:12px;color:#888;word-break:break-all">${safe(link)}</p>` : ''}
    <p style="font-size:12px;color:#888;margin-top:24px">لو مش إنت اللي طلبت الرسالة دي، تجاهلها ببساطة.</p>
  </div></body></html>`;
}

async function sendViaResend({ to, subject, text, link }) {
  const res = await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject,
      text: link ? `${text}\n\n${link}` : text,
      html: htmlBody({ subject, text, link })
    })
  });
  if (!res.ok) {
    // (إصلاح) الرد ممكن يحتوي بيانات حساسة (تفاصيل الرسالة، مفاتيح، إلخ).
    // بنستهلك الجسم عشان نقفل الاتصال بس من غير ما نلوّج أي محتوى منه.
    await res.text().catch(() => '');
    const error = new Error(`Resend responded ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return { delivered: true, via: 'resend' };
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  // require كسول عشان المشروع يفضل شغال حتى لو المكتبة مش متركّبة.
  const nodemailer = require('nodemailer');
  if (process.env.SMTP_URL) {
    transporter = nodemailer.createTransport(process.env.SMTP_URL, {
      connectionTimeout: MAIL_TIMEOUT_MS,
      greetingTimeout: MAIL_TIMEOUT_MS,
      socketTimeout: MAIL_TIMEOUT_MS
    });
  } else {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === '1' || port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      connectionTimeout: MAIL_TIMEOUT_MS,
      greetingTimeout: MAIL_TIMEOUT_MS,
      socketTimeout: MAIL_TIMEOUT_MS
    });
  }
  return transporter;
}

async function sendViaSmtp({ to, subject, text, link }) {
  await getTransporter().sendMail({
    from: MAIL_FROM,
    to,
    subject,
    text: link ? `${text}\n\n${link}` : text,
    html: htmlBody({ subject, text, link })
  });
  return { delivered: true, via: 'smtp' };
}

async function sendViaWebhook({ to, subject, text, link }) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.MAIL_WEBHOOK_TOKEN) headers.Authorization = `Bearer ${process.env.MAIL_WEBHOOK_TOKEN}`;
  const res = await fetchWithTimeout(process.env.MAIL_WEBHOOK_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ from: MAIL_FROM, to, subject, text, link, html: htmlBody({ subject, text, link }) })
  });
  if (!res.ok) {
    const error = new Error(`webhook responded ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return { delivered: true, via: 'webhook' };
}

async function sendMail({ to, subject, text, link }) {
  const provider = activeProvider();
  try {
    if (provider === 'resend') return await withRetry(() => sendViaResend({ to, subject, text, link }));
    if (provider === 'smtp') return await withRetry(() => sendViaSmtp({ to, subject, text, link }));
    if (provider === 'webhook') return await withRetry(() => sendViaWebhook({ to, subject, text, link }));
  } catch (error) {
    // (إصلاح) بنلوّج كود/نوع الخطأ بس، مش نص رسالة المزوّد اللي ممكن تحمل
    // تفاصيل حساسة (headers، توكنات، محتوى إيميل...). رسالة عامة فقط في اللوج.
    console.error(`[mailer] ❌ فشل إرسال البريد عبر ${provider} (status: ${error.status || 'unknown'})`);
    return { delivered: false, via: provider, error: 'send_failed' };
  }

  if (IS_PROD) {
    console.error('\x1b[31m[mailer] ❌ مفيش مزوّد بريد متظبط في الإنتاج — الرسالة مش هتوصل للعميل.');
    console.error('   ظبّط RESEND_API_KEY أو SMTP_URL أو MAIL_WEBHOOK_URL في متغيرات البيئة (شوف MAIL-SETUP.md).\x1b[0m');
    return { delivered: false, via: 'none', error: 'no_mail_provider_configured' };
  }

  console.warn('\n\x1b[36m📧 [بريد صادر — وضع التطوير: مفيش مزوّد بريد متحدد]');
  console.warn(`   إلى: ${to}`);
  console.warn(`   الموضوع: ${subject}`);
  console.warn(`   ${text}`);
  if (link) console.warn(`   الرابط: ${link}`);
  console.warn('\x1b[0m');
  return { delivered: true, via: 'console' };
}

module.exports = { sendMail, shouldExposeLink, activeProvider };
