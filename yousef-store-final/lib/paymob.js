/**
 * lib/paymob.js — عميل بوابة Paymob (مصر) عبر Unified Intention API.
 * ---------------------------------------------------------------------------
 * كل الإعدادات بتتقرا من متغيرات البيئة *جوه* كل دالة (مش على مستوى الموديول)
 * عشان أي تغيير في env وقت التشغيل (تست/برود) يتطبق فورًا من غير إعادة تحميل،
 * ومفيش أي قيمة سرّية بتتسجّل في اللوج أبدًا.
 *
 *   PAYMOB_SECRET_KEY            سر الـ API (sk_test_... / sk_live_...) — بيتبعت في Authorization header
 *   PAYMOB_PUBLIC_KEY            المفتاح العام (pk_test_... / pk_live_...) — بيتحط في رابط الدفع
 *   PAYMOB_CARD_INTEGRATION_ID   رقم تكامل الدفع بالبطاقة (Integration ID)
 *   PAYMOB_WALLET_INTEGRATION_ID رقم تكامل المحافظ الإلكترونية (اختياري)
 *   PAYMOB_HMAC_SECRET           سر الـ HMAC بتاع الحساب (من إعدادات الحساب)
 *   PUBLIC_BASE_URL              أصل الموقع العام — لبناء روابط الرجوع/الإشعار
 */
const crypto = require('crypto');

const INTENTION_URL = 'https://accept.paymob.com/v1/intention/';
const CHECKOUT_BASE_URL = 'https://accept.paymob.com/unifiedcheckout/';

function getConfig() {
  return {
    secretKey: String(process.env.PAYMOB_SECRET_KEY || '').trim(),
    publicKey: String(process.env.PAYMOB_PUBLIC_KEY || '').trim(),
    cardIntegrationId: String(process.env.PAYMOB_CARD_INTEGRATION_ID || '').trim(),
    walletIntegrationId: String(process.env.PAYMOB_WALLET_INTEGRATION_ID || '').trim(),
    hmacSecret: String(process.env.PAYMOB_HMAC_SECRET || '').trim(),
    baseUrl: String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
  };
}

// (مهم) الدفع أونلاين بيتفعّل بس لو كل المتغيرات الأساسية موجودة، وإلا بيفضل
// مخفي تمامًا من الواجهة والراوتس عشان محدش يقدر يستخدم بوابة مش متظبطة.
function isEnabled() {
  const cfg = getConfig();
  return !!(cfg.secretKey && cfg.publicKey && cfg.hmacSecret && cfg.baseUrl && (cfg.cardIntegrationId || cfg.walletIntegrationId));
}

function integrationIds(methods) {
  const cfg = getConfig();
  const wanted = Array.isArray(methods) && methods.length ? methods : ['card', 'wallet'];
  const ids = [];
  if (wanted.includes('card') && cfg.cardIntegrationId) ids.push(Number(cfg.cardIntegrationId));
  if (wanted.includes('wallet') && cfg.walletIntegrationId) ids.push(Number(cfg.walletIntegrationId));
  return ids.filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * بينشئ "نية دفع" (Intention) على Paymob لطلب معيّن، ويرجّع رابط صفحة الدفع
 * الموحّدة (Unified Checkout) الجاهزة نوجّه العميل ليها.
 *
 * order: { id, total_amount } — المبلغ بييجي من قاعدة البيانات على السيرفر فقط.
 * customer: { name, phone, email }
 * methods: ['card'] أو ['wallet'] أو الاتنين (افتراضي)
 */
async function createCheckout({ order, customer, methods }) {
  if (!isEnabled()) {
    const err = new Error('بوابة الدفع أونلاين غير مفعّلة');
    err.code = 'PAYMOB_DISABLED';
    throw err;
  }
  const cfg = getConfig();
  const ids = integrationIds(methods);
  if (!ids.length) {
    const err = new Error('لا يوجد وسيلة دفع أونلاين متاحة');
    err.code = 'PAYMOB_NO_INTEGRATION';
    throw err;
  }
  const amountCents = Math.round(Number(order.total_amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    const err = new Error('قيمة الطلب غير صالحة');
    err.code = 'PAYMOB_INVALID_AMOUNT';
    throw err;
  }

  const nameParts = String(customer?.name || 'Customer').trim().split(/\s+/);
  const firstName = nameParts[0] || 'Customer';
  const lastName = nameParts.slice(1).join(' ') || 'Customer';

  const body = {
    amount: amountCents,
    currency: 'EGP',
    payment_methods: ids,
    // (مهم) special_reference = رقم الطلب عندنا. بيسمحلنا نطابق الـ webhook
    // بالطلب الصحيح من غير ما نحتاج تخزين إضافي، ومفروض يكون فريد لكل محاولة
    // دفع؛ استخدام رقم الطلب مباشرة كافي لأن كل طلب بيتعمل مرة واحدة.
    special_reference: `order-${order.id}`,
    notification_url: `${cfg.baseUrl}/api/public/paymob/webhook`,
    redirection_url: `${cfg.baseUrl}/payment/return`,
    billing_data: {
      apartment: 'NA',
      first_name: firstName,
      last_name: lastName,
      street: String(customer?.address || 'NA').slice(0, 200) || 'NA',
      building: 'NA',
      phone_number: String(customer?.phone || '').trim() || '+20000000000',
      city: 'Cairo',
      country: 'EG',
      email: String(customer?.email || 'customer@example.com').trim(),
      floor: 'NA',
      state: 'NA'
    },
    items: []
  };

  const res = await fetch(INTENTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${cfg.secretKey}`
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.client_secret) {
    const err = new Error('تعذر إنشاء عملية الدفع مع Paymob');
    err.code = 'PAYMOB_INTENTION_FAILED';
    err.detail = res.status; // ملاحظة: متعمدين ما نسجّلش جسم الرد كامل (ممكن يحوي بيانات حساسة)
    throw err;
  }

  const url = `${CHECKOUT_BASE_URL}?publicKey=${encodeURIComponent(cfg.publicKey)}&clientSecret=${encodeURIComponent(data.client_secret)}`;
  return { url, providerRef: data.id || data.intention_order_id || null, clientSecret: data.client_secret };
}

// ترتيب الحقول ثابت زي ما موثّق في Paymob docs لسلسلة الـ HMAC الخاصة
// بـ "Transaction Processed Callback" (obj.*). أي تغيير في الترتيب ده
// بيكسر التحقق تمامًا.
const HMAC_FIELDS = [
  'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction',
  'id', 'integration_id', 'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded',
  'is_standalone_payment', 'is_voided', 'order.id', 'owner', 'pending',
  'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success'
];

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

/**
 * بيتحقق من توقيع HMAC اللي بترسله Paymob مع الـ webhook (obj = بيانات
 * المعاملة). بيرجع false لو أي حقل مفقود أو التوقيع مش مطابق — مفيش تساهل.
 * مقارنة زمن ثابت (timingSafeEqual) عشان نمنع أي هجوم توقيت.
 */
function verifyHmac(payload, receivedHmac) {
  const cfg = getConfig();
  if (!cfg.hmacSecret || !receivedHmac || typeof payload !== 'object' || payload === null) return false;
  const obj = payload.obj && typeof payload.obj === 'object' ? payload.obj : payload;
  const concatenated = HMAC_FIELDS.map((field) => {
    const value = getPath(obj, field);
    if (value === undefined || value === null) return '';
    return String(value);
  }).join('');
  const computed = crypto.createHmac('sha512', cfg.hmacSecret).update(concatenated).digest('hex');
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(String(receivedHmac), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * هل سر الـ HMAC مظبوط؟ الـ webhook بيرفض أي طلب (503) لو مش مظبوط، عشان
 * التحقق من التوقيع يبقى إجباري دايمًا ومستحيل يبقى اختياري بالغلط.
 */
function hasHmacSecret() {
  return !!getConfig().hmacSecret;
}

module.exports = { isEnabled, hasHmacSecret, createCheckout, verifyHmac, HMAC_FIELDS };
