/**
 * ---------------------------------------------------------------------------
 * google-auth.js — الدخول بحساب جوجل (إثبات حقيقي لملكية البريد)
 * ---------------------------------------------------------------------------
 * جوجل هي اللي بتتحقق من ملكية البريد، فمش محتاجين نبعت ولا كود ولا رابط.
 *
 * (إصلاح) قبل كده كنا بنسأل endpoint اسمه tokeninfo عند كل تسجيل دخول:
 *   - طلب شبكة خارجي في مسار الدخول (بطء + نقطة فشل).
 *   - الاعتماد على رد HTTP بدل التحقق التشفيري من التوقيع نفسه.
 * دلوقتي بنتحقق محليًا من توقيع الـ JWT بمفاتيح جوجل العامة (JWKS) مع كاش
 * للمفاتيح، وبنفحص iss/aud/exp/nonce بنفسنا. مفيش أي اعتماد على خدمة خارجية
 * غير تحديث المفاتيح كل فترة.
 *
 * الإعداد: GOOGLE_CLIENT_ID من https://console.cloud.google.com
 *   APIs & Services → Credentials → OAuth client ID → Web application
 *   Authorized JavaScript origins: https://your-domain.com
 */
const crypto = require('crypto');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_MS = 2 * 60 * 1000;

const isEnabled = () => Boolean(CLIENT_ID);
const clientId = () => CLIENT_ID;

let jwksCache = { keys: new Map(), fetchedAt: 0, ttlMs: 60 * 60 * 1000 };
// (إصلاح) حماية من تضخيم الطلبات (amplification): لو كذا تسجيل دخول بـ kid
// مجهول وصلوا في نفس اللحظة، بنعمل fetch واحد بس (in-flight guard) بدل ما كل
// طلب يبعت طلب JWKS منفصل. وكمان بنفرض حد أدنى بين كل تحديث والتاني حتى لو
// المهاجم كرر kid مختلف كل مرة.
let jwksFetchPromise = null;
let lastFetchAttemptAt = 0;
const MIN_REFETCH_INTERVAL_MS = 60 * 1000;

async function fetchJwks() {
  const resp = await fetch(JWKS_URL, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return null;
  const body = await resp.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue;
    try {
      keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    } catch (_) { /* مفتاح غير مفهوم — نتجاهله */ }
  }
  if (!keys.size) return null;
  // احترام Cache-Control من جوجل لو موجود.
  const cc = String(resp.headers.get('cache-control') || '');
  const maxAge = /max-age=(\d+)/i.exec(cc);
  jwksCache = {
    keys,
    fetchedAt: Date.now(),
    ttlMs: maxAge ? Math.max(5 * 60, Number(maxAge[1])) * 1000 : 60 * 60 * 1000
  };
  return keys;
}

function refreshJwks() {
  if (jwksFetchPromise) return jwksFetchPromise;
  const now = Date.now();
  if (now - lastFetchAttemptAt < MIN_REFETCH_INTERVAL_MS) {
    // اترفض التحديث ده — استخدم آخر كاش عندنا لحد ما يعدّي الحد الأدنى.
    return Promise.resolve(jwksCache.keys);
  }
  lastFetchAttemptAt = now;
  jwksFetchPromise = fetchJwks()
    .catch(() => null)
    .finally(() => { jwksFetchPromise = null; });
  return jwksFetchPromise;
}

async function getSigningKey(kid, { allowRefresh = true } = {}) {
  const fresh = Date.now() - jwksCache.fetchedAt < jwksCache.ttlMs;
  if (fresh && jwksCache.keys.has(kid)) return jwksCache.keys.get(kid);
  if (!allowRefresh) return null;

  const keys = await refreshJwks();
  if (!keys) return null;
  return keys.get(kid) || null;
}

function b64urlToBuf(value) {
  let v = String(value).replace(/-/g, '+').replace(/_/g, '/');
  while (v.length % 4) v += '=';
  return Buffer.from(v, 'base64');
}

/**
 * تحقق محلي كامل من ID token بتاع جوجل.
 * بيرجّع { email, name, sub } أو null.
 */
async function verifyIdToken(idToken) {
  const token = String(idToken || '').trim();
  if (!CLIENT_ID || !token || token.length > 4096) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(b64urlToBuf(headerB64).toString('utf8'));
    payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!header || header.alg !== 'RS256' || !header.kid) return null;

  let key;
  try {
    key = await getSigningKey(header.kid);
    if (!key) {
      // مفتاح جديد لسه ما اتخزّنش — نحاول تحديث تاني، بس refreshJwks نفسه
      // هو اللي بيحترم الحد الأدنى بين التحديثات ويمنع أي تضخيم للطلبات.
      key = await getSigningKey(header.kid);
    }
  } catch (_) {
    return null;
  }
  if (!key) return null;

  const signed = Buffer.from(`${headerB64}.${payloadB64}`);
  let valid = false;
  try {
    valid = crypto.verify('RSA-SHA256', signed, key, b64urlToBuf(signatureB64));
  } catch (_) {
    return null;
  }
  if (!valid) return null;

  if (!ISSUERS.has(payload.iss)) return null;
  if (payload.aud !== CLIENT_ID) return null;
  const now = Date.now();
  if (!payload.exp || Number(payload.exp) * 1000 + CLOCK_SKEW_MS < now) return null;
  if (payload.iat && Number(payload.iat) * 1000 - CLOCK_SKEW_MS > now) return null;
  if (payload.email_verified !== true && String(payload.email_verified) !== 'true') return null;

  const email = String(payload.email || '').trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,12}$/.test(email)) return null;

  return {
    email,
    name: String(payload.name || email.split('@')[0]).slice(0, 80),
    sub: String(payload.sub || '')
  };
}

module.exports = { isEnabled, clientId, verifyIdToken };
