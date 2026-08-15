/**
 * تحويل الصور تلقائيًا لـ AVIF/WebP وقت التقديم (Content Negotiation).
 *
 * الفكرة: نفس رابط الصورة (/uploads/products/x.jpg) بيرجّع AVIF للمتصفحات
 * اللي بتدعمها، وWebP للباقي، والأصل لو مفيش دعم أو لو sharp مش متاحة.
 * النسخ المحوّلة بتتخزن في مجلد كاش على القرص فبتتعمل مرة واحدة بس.
 *
 * مفعّل تلقائيًا في الإنتاج (NODE_ENV=production) ويمكن التحكم فيه بـ
 * IMAGE_AUTO_FORMAT=on|off.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let sharp = null;
let sharpChecked = false;
function loadSharp() {
  if (sharpChecked) return sharp;
  sharpChecked = true;
  try { sharp = require('sharp'); } catch (_) { sharp = null; }
  return sharp;
}

const SOURCE_EXT = /\.(jpe?g|png|webp)$/i;
const AVIF_QUALITY = Number(process.env.IMAGE_AVIF_QUALITY || 50);
const WEBP_QUALITY = Number(process.env.IMAGE_WEBP_QUALITY || 80);
const MAX_SOURCE_BYTES = Number(process.env.IMAGE_MAX_SOURCE_BYTES || 12 * 1024 * 1024);
// (إصلاح دفاع بالعمق) نفس حد البكسلات المستخدم في lib/image-optimize.js —
// بيمنع "decompression bomb" (صورة صغيرة الحجم بأبعاد ضخمة تستهلك كل
// الذاكرة) على مسار التقديم الفوري (on-the-fly) برضه، مش بس مسار الرفع.
const MAX_INPUT_PIXELS = Number(process.env.IMAGE_MAX_INPUT_PIXELS || 50_000_000);
// أسماء صور المنتجات فريدة (بتتغيّر مع كل رفع)، فالكاش الطويل + immutable آمن.
const CACHE_MAX_AGE = Number(process.env.IMAGE_CACHE_MAX_AGE || 31536000);
const CACHE_CONTROL = process.env.IMAGE_CACHE_CONTROL
  || `public, max-age=${CACHE_MAX_AGE}, immutable, stale-while-revalidate=604800`;
// كاش ميتاداتا في الذاكرة عشان ما نعملش statSync لكل طلب صورة.
const META_TTL_MS = Number(process.env.IMAGE_META_TTL_MS || 60000);
const META_MAX_ENTRIES = 500;
const metaCache = new Map();

function readMeta(key, resolver) {
  const now = Date.now();
  const hit = metaCache.get(key);
  if (hit && now - hit.at < META_TTL_MS) return hit.value;
  const value = resolver();
  metaCache.set(key, { at: now, value });
  if (metaCache.size > META_MAX_ENTRIES) {
    const oldest = metaCache.keys().next().value;
    metaCache.delete(oldest);
  }
  return value;
}

function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some(part => {
    const value = part.trim().replace(/^W\//, '');
    return value === etag || value === `W/${etag}` || value === etag.replace(/^W\//, '');
  });
}

function notModifiedByDate(header, mtimeMs) {
  if (!header) return false;
  const since = Date.parse(header);
  if (Number.isNaN(since)) return false;
  return Math.floor(mtimeMs / 1000) * 1000 <= since;
}

// بنمسح النسخ القديمة لنفس الصورة (بصمة مختلفة) عشان الكاش ما يتضخّمش.
function prunePreviousVariants(dir, base, keepName) {
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry !== keepName && entry.startsWith(`${base}.`)) {
        fs.unlink(path.join(dir, entry), () => {});
      }
    }
  } catch (_) { /* لا شيء */ }
}


function isEnabled() {
  const flag = String(process.env.IMAGE_AUTO_FORMAT || '').toLowerCase();
  if (flag === 'off' || flag === '0' || flag === 'false') return false;
  if (flag === 'on' || flag === '1' || flag === 'true') return true;
  return process.env.NODE_ENV === 'production';
}

function pickFormat(accept, ext) {
  const value = String(accept || '');
  if (ext === '.webp') return value.includes('image/avif') ? 'avif' : null;
  if (value.includes('image/avif')) return 'avif';
  if (value.includes('image/webp')) return 'webp';
  return null;
}

const inflight = new Map();

async function buildVariant(lib, sourcePath, targetPath, format) {
  const key = targetPath;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const tmp = `${targetPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const pipeline = lib(sourcePath, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
    if (format === 'avif') await pipeline.avif({ quality: AVIF_QUALITY, effort: 4 }).toFile(tmp);
    else await pipeline.webp({ quality: WEBP_QUALITY }).toFile(tmp);
    fs.renameSync(tmp, targetPath);
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

// مسار النسخة المحوّلة — لازم يطابق اللي بيستخدمه الـ middleware بالحرف.
function variantPath({ cacheDir, relative, stat, format }) {
  const fingerprint = `${Math.floor(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}`;
  const variantName = `${path.basename(relative)}.${fingerprint}.${format}`;
  return path.join(path.resolve(cacheDir), format, path.dirname(relative), variantName);
}

/**
 * تسخين الكاش وقت الرفع: بنولّد AVIF/WebP فورًا بعد ما الصورة تتخزن، عشان أول
 * زائر ما يستنّاش التحويل جوه الطلب (صفحة فيها ٢٠ صورة جديدة كانت بتضرب الـ CPU).
 * بترجع بهدوء لو sharp مش متاحة أو الملف مش صورة مدعومة — التحويل وقت التقديم
 * فاضل موجود كشبكة أمان.
 */
async function warmVariants({ rootDir, cacheDir, relative, formats = ['avif', 'webp'], logger = console }) {
  const lib = loadSharp();
  if (!lib) return { warmed: 0, skipped: 'no-sharp' };
  const root = path.resolve(rootDir);
  const sourcePath = path.join(root, relative);
  if (!sourcePath.startsWith(root + path.sep)) return { warmed: 0, skipped: 'outside-root' };
  if (!SOURCE_EXT.test(sourcePath)) return { warmed: 0, skipped: 'unsupported-ext' };
  let stat;
  try { stat = fs.statSync(sourcePath); } catch (_) { return { warmed: 0, skipped: 'missing' }; }
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return { warmed: 0, skipped: 'too-large' };

  let warmed = 0;
  for (const format of formats) {
    const targetPath = variantPath({ cacheDir, relative, stat, format });
    try {
      if (fs.existsSync(targetPath)) { warmed += 1; continue; }
      await buildVariant(lib, sourcePath, targetPath, format);
      prunePreviousVariants(path.dirname(targetPath), path.basename(relative), path.basename(targetPath));
      warmed += 1;
    } catch (error) {
      logger.warn(`[image-serve] تعذر تسخين ${format}:`, error.message);
    }
  }
  // بنمسح الميتاداتا المخزّنة عشان الطلب الجاي يقرا الحالة الجديدة فورًا.
  metaCache.delete(`src:${sourcePath}`);
  return { warmed };
}



/**
 * @param {object} options
 * @param {string} options.mount   بادئة المسار (مثال: /uploads/products)
 * @param {string} options.rootDir مجلد الصور الأصلي على القرص
 * @param {string} options.cacheDir مجلد كاش النسخ المحوّلة
 */
function createImageFormatMiddleware({ mount, rootDir, cacheDir, logger = console }) {
  const prefix = mount.endsWith('/') ? mount.slice(0, -1) : mount;
  const root = path.resolve(rootDir);
  const cache = path.resolve(cacheDir);

  return async function imageFormatMiddleware(req, res, next) {
    if (!isEnabled()) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const lib = loadSharp();
    if (!lib) return next();

    let pathname;
    try { pathname = decodeURIComponent(req.path); } catch (_) { return next(); }
    if (pathname.includes('\0') || pathname.includes('..')) return next();
    if (prefix && !pathname.startsWith(prefix + '/')) return next();
    const ext = path.extname(pathname).toLowerCase();
    if (!SOURCE_EXT.test(pathname)) return next();

    const format = pickFormat(req.headers.accept, ext);
    // Vary لازم يتحط حتى لو رجّعنا الأصل، عشان الكاش الوسيط ما يخلطش النسخ.
    res.setHeader('Vary', 'Accept');
    if (!format) return next();

    const relative = prefix ? pathname.slice(prefix.length + 1) : pathname.replace(/^\//, '');
    const sourcePath = path.join(root, relative);
    if (!sourcePath.startsWith(root + path.sep)) return next();

    let stat;
    try {
      stat = readMeta(`src:${sourcePath}`, () => fs.statSync(sourcePath));
    } catch (_) { return next(); }
    if (!stat || !stat.isFile() || stat.size > MAX_SOURCE_BYTES) return next();

    const fingerprint = `${Math.floor(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}`;
    const variantName = `${path.basename(relative)}.${fingerprint}.${format}`;
    const targetPath = path.join(cache, format, path.dirname(relative), variantName);
    if (!targetPath.startsWith(cache + path.sep)) return next();

    // ETag قوي: بيتغيّر مع الصورة الأصلية والصيغة وحجم الناتج، فالمتصفح
    // بيقدر يعمل revalidate برخص ويستقبل 304 بدل تحميل الصورة تاني.
    const baseEtag = `"${format}-${fingerprint}"`;
    const lastModified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toUTCString();
    res.setHeader('Content-Type', `image/${format}`);
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.setHeader('ETag', baseEtag);
    res.setHeader('Last-Modified', lastModified);
    res.setHeader('X-Image-Format', format);
    res.setHeader('Accept-Ranges', 'none');

    // ردّ 304 من غير ما نلمس القرص أو نحوّل أي حاجة.
    if (etagMatches(req.headers['if-none-match'], baseEtag)
      || (!req.headers['if-none-match'] && notModifiedByDate(req.headers['if-modified-since'], stat.mtimeMs))) {
      return res.status(304).end();
    }

    try {
      let out = null;
      try { out = fs.statSync(targetPath); } catch (_) { out = null; }
      if (!out) {
        await buildVariant(lib, sourcePath, targetPath, format);
        out = fs.statSync(targetPath);
        prunePreviousVariants(path.dirname(targetPath), path.basename(relative), variantName);
      }
      // لو النسخة المحوّلة مش أصغر، بنرجّع الأصل (ونشيل ترويسات النسخة).
      if (out.size >= stat.size) {
        res.removeHeader('Content-Type');
        res.removeHeader('ETag');
        res.removeHeader('X-Image-Format');
        res.removeHeader('Accept-Ranges');
        return next();
      }
      res.setHeader('Content-Length', String(out.size));
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(targetPath).on('error', () => next()).pipe(res);
    } catch (error) {
      logger.warn('[image-serve] تعذر تحويل الصورة:', error.message);
      res.removeHeader('Content-Type');
      res.removeHeader('ETag');
      res.removeHeader('X-Image-Format');
      res.removeHeader('Accept-Ranges');
      return next();
    }

  };
}

module.exports = { createImageFormatMiddleware, isEnabled, loadSharp, warmVariants, variantPath };
