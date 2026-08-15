/**
 * مكنسة كاش الصور المحوّلة (AVIF/WebP)
 * -------------------------------------------------------------------------
 * كاش الصور بينمو للأبد: كل صورة بتتحوّل لنسختين (avif/webp)، ولو المنتج
 * اتمسح أو الصورة اتغيّرت النسخة القديمة بتفضل على القرص. على Volume صغير
 * ده كان بيملّي المساحة بالتدريج لحد ما الرفع والنسخ الاحتياطي يفشلوا.
 *
 * المكنسة بتعمل ٣ حاجات بالترتيب:
 *  1) تمسح النسخ اللي أصلها مش موجود خلاص (orphans).
 *  2) تمسح النسخ اللي عدّى عليها IMAGE_CACHE_TTL_DAYS من غير قراءة.
 *  3) لو المجموع لسه فوق IMAGE_CACHE_MAX_MB، تمسح الأقدم لحد ما تنزل تحت الحد.
 *
 * (إصلاح) كل العمليات بقت async (fs.promises) وبتشتغل على دفعات (BATCH_SIZE)
 * مع نقطة "تنفّس" (setImmediate) بين كل دفعة. النسخة القديمة كانت بتستخدم
 * readdirSync/statSync/unlinkSync بالكامل، يعني مع آلاف الملفات في الكاش
 * كانت بتجمّد الـ event loop بالكامل (مفيش أي request تاني بيتخدم) لمدة
 * التنظيف كلها. دلوقتي أي عملية I/O بتسيب فرصة لطلبات المستخدمين تتنفّذ.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { setImmediate: nextTick } = require('timers');

const DEFAULT_MAX_BYTES = Number(process.env.IMAGE_CACHE_MAX_MB || 512) * 1024 * 1024;
const DEFAULT_TTL_MS = Number(process.env.IMAGE_CACHE_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;
const BATCH_SIZE = Number(process.env.IMAGE_CACHE_GC_BATCH || 40);

// نقطة تنفّس: بترجّع التحكم للـ event loop عشان طلبات الـ HTTP المعلّقة تتنفّذ
// بدل ما المسح ياخد الـ event loop لنفسه لحد ما يخلّص بالكامل.
function yieldLoop() {
  return new Promise((resolve) => nextTick(resolve));
}

async function walk(dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (_) { return out; }
  let sinceYield = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile()) {
      try {
        const stat = await fsp.stat(full);
        out.push({ path: full, size: stat.size, at: Math.max(stat.mtimeMs, stat.atimeMs || 0) });
      } catch (_) { /* الملف اتمسح في نفس اللحظة */ }
      if (++sinceYield >= BATCH_SIZE) { sinceYield = 0; await yieldLoop(); }
    }
  }
  return out;
}

// اسم النسخة: <اسم الصورة الأصلي>.<بصمة>.<الصيغة> جوه <cache>/<format>/<مسار نسبي>
function sourceForVariant(file, cacheDir, rootDir) {
  const rel = path.relative(cacheDir, file);
  const parts = rel.split(path.sep);
  if (parts.length < 2) return null;
  const withoutFormat = parts.slice(1);
  const name = withoutFormat[withoutFormat.length - 1];
  const original = name.replace(/\.[^.]+\.[^.]+$/, '');
  if (!original) return null;
  return path.join(rootDir, ...withoutFormat.slice(0, -1), original);
}

async function removeEmptyDirs(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (_) { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirs(path.join(dir, entry.name));
  }
  try {
    const left = await fsp.readdir(dir);
    if (!left.length) await fsp.rmdir(dir);
  } catch (_) { /* لا شيء */ }
}

async function pathExists(target) {
  try { await fsp.access(target); return true; }
  catch (_) { return false; }
}

/**
 * @param {object} options
 * @param {string} options.cacheDir مجلد الكاش
 * @param {string} [options.rootDir] مجلد الصور الأصلي (لكشف النسخ اليتيمة)
 */
async function sweepImageCache({
  cacheDir,
  rootDir = null,
  maxBytes = DEFAULT_MAX_BYTES,
  ttlMs = DEFAULT_TTL_MS,
  logger = console
} = {}) {
  const stats = { scanned: 0, orphans: 0, expired: 0, trimmed: 0, freedBytes: 0, totalBytes: 0 };
  if (!cacheDir || !(await pathExists(cacheDir))) return stats;

  const files = await walk(cacheDir);
  stats.scanned = files.length;
  const now = Date.now();
  const kill = async (file, kind) => {
    try { await fsp.unlink(file.path); stats.freedBytes += file.size; stats[kind] += 1; return true; }
    catch (_) { return false; }
  };

  const survivors = [];
  let sinceYield = 0;
  for (const file of files) {
    let removed = false;
    if (rootDir) {
      const source = sourceForVariant(file.path, cacheDir, rootDir);
      if (source && !(await pathExists(source))) { removed = await kill(file, 'orphans'); }
    }
    if (!removed && ttlMs > 0 && now - file.at > ttlMs) { removed = await kill(file, 'expired'); }
    if (!removed) survivors.push(file);
    if (++sinceYield >= BATCH_SIZE) { sinceYield = 0; await yieldLoop(); }
  }

  let total = survivors.reduce((sum, f) => sum + f.size, 0);
  if (maxBytes > 0 && total > maxBytes) {
    survivors.sort((a, b) => a.at - b.at); // الأقدم استخدامًا الأول
    sinceYield = 0;
    for (const file of survivors) {
      if (total <= maxBytes) break;
      if (await kill(file, 'trimmed')) total -= file.size;
      if (++sinceYield >= BATCH_SIZE) { sinceYield = 0; await yieldLoop(); }
    }
  }
  stats.totalBytes = total;
  await removeEmptyDirs(cacheDir);

  if (stats.orphans || stats.expired || stats.trimmed) {
    logger.log(`[image-cache] تنظيف: يتيمة ${stats.orphans}، منتهية ${stats.expired}، مقصوصة ${stats.trimmed}، اتحرر ${(stats.freedBytes / 1048576).toFixed(1)}MB، المتبقي ${(total / 1048576).toFixed(1)}MB`);
  }
  return stats;
}

module.exports = { sweepImageCache, sourceForVariant, DEFAULT_MAX_BYTES, DEFAULT_TTL_MS };
