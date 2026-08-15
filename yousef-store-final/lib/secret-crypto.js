/**
 * تشفير الأسرار الحسّاسة المخزّنة في القاعدة (AES-256-GCM).
 * -------------------------------------------------------------------------
 * (إصلاح S2 في تقرير الفحص v27) سر الـ TOTP كان بيتخزّن نص صريح، يعني أي
 * تسريب لقاعدة البيانات = تجاوز كامل للتحقق بخطوتين. دلوقتي بيتخزّن مشفّر
 * بمفتاح تطبيق منفصل عن SESSION_SECRET.
 *
 * ترتيب اختيار المفتاح:
 *  1. TOTP_ENCRYPTION_KEY (أو DATA_ENCRYPTION_KEY) — لو متحدد، بيتحوّل لمفتاح
 *     32 بايت بـ scrypt. أقوى خيار: مفتاح مستقل تمامًا، مش موجود في القاعدة.
 *  2. مفتاح احتياطي (fallback) بيحدده server.js وقت الإقلاع عبر
 *     configureFallbackKey() — مشتق بـ HKDF من ROOT_SECRET بنفس أسلوب مفاتيح
 *     الجلسة/CSRF (domain separation). أضعف من (1) لو ROOT_SECRET نفسه
 *     مولّد تلقائيًا ومخزّن في القاعدة، لكنه *لسه* أفضل بكتير من نص صريح.
 *  3. لو مفيش ولا واحد من الاتنين (سكريبت مستقل شغّال المكتبة من غير ما يمر
 *     على server.js)، بيرجع للتخزين الصريح كملاذ أخير مع تحذير واضح.
 *
 * الصيغة المخزّنة: enc:v1:<iv-b64>:<tag-b64>:<ciphertext-b64>
 * فك التشفير بيقبل النص الصريح القديم كما هو (توافق خلفي).
 */
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
let cachedKey = null;
let cachedKeySource = null; // 'env' | 'fallback' | null
let fallbackKey = null;
let warned = false;

function rawKey() {
  return process.env.TOTP_ENCRYPTION_KEY || process.env.DATA_ENCRYPTION_KEY || '';
}

/** بينادى عليها من server.js مرة واحدة وقت الإقلاع بمفتاح 32 بايت مشتق (Buffer). */
function configureFallbackKey(keyBuffer) {
  fallbackKey = Buffer.isBuffer(keyBuffer) ? keyBuffer : null;
  cachedKey = null;
  cachedKeySource = null;
}

function getKey() {
  if (cachedKey) return cachedKey;
  const raw = rawKey();
  if (raw) {
    cachedKey = crypto.scryptSync(raw, 'yousef-store:totp:v1', 32);
    cachedKeySource = 'env';
    return cachedKey;
  }
  if (fallbackKey) {
    cachedKey = fallbackKey;
    cachedKeySource = 'fallback';
    return cachedKey;
  }
  return null;
}

function isConfigured() {
  return Boolean(rawKey() || fallbackKey);
}

// (إصلاح) cachedKeySource كانت متسجّلة من غير أي استهلاك — تحذير lint
// no-unused-vars حقيقي، مش false-positive. بدل ما نمسحها بلا فايدة، بنعرضها
// كدالة تشخيصية بسيطة: مفيدة لصفحة/فحص صحة إداري يوضّح هل مفتاح التشفير
// جاي من env صريح ولا من fallback مشتق من ROOT_SECRET (أضعف)، من غير ما
// يسرّب المفتاح نفسه.
function getKeySource() {
  getKey();
  return cachedKeySource;
}

function warnOnce() {
  if (warned) return;
  warned = true;
  console.warn('[secret-crypto] TOTP_ENCRYPTION_KEY مش متظبط ولا فيه مفتاح احتياطي — أسرار الـ 2FA هتتخزّن نص صريح. ظبّط المتغيّر ده في الإنتاج.');
}

/** يشفّر نص. لو مفيش أي مفتاح متاح بيرجّع النص زي ما هو مع تحذير. */
function encryptSecret(plain) {
  if (plain === null || plain === undefined || plain === '') return plain;
  const key = getKey();
  if (!key) { warnOnce(); return String(plain); }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/** يفك التشفير. النص الصريح القديم بيرجع كما هو (توافق خلفي). */
function decryptSecret(stored) {
  if (stored === null || stored === undefined || stored === '') return stored;
  const value = String(stored);
  if (!value.startsWith(PREFIX)) return value;
  const key = getKey();
  if (!key) { warnOnce(); return null; }
  try {
    const [ivB64, tagB64, dataB64] = value.slice(PREFIX.length).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // مفتاح غلط أو بيانات متعدّلة: fail-closed — أحسن من إرجاع سر خاطئ.
    console.error('[secret-crypto] فشل فك تشفير سر مخزّن (مفتاح غلط أو بيانات تالفة).');
    return null;
  }
}

module.exports = { encryptSecret, decryptSecret, isConfigured, configureFallbackKey, getKeySource };
