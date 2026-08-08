/**
 * (إصلاح 8) ضغط/تصغير الصور المرفوعة.
 * الضغط الأساسي بيحصل في المتصفح قبل الرفع (canvas → WebP بحد أقصى 1600px).
 * على السيرفر بنعمل تحويل إضافي لـ WebP لو مكتبة sharp متوفرة (اختيارية)،
 * ولو مش متوفرة بنكتفي بالتحقق من الأبعاد/الحجم بدل ما نكسر الرفع.
 */
const fs = require('fs');
const path = require('path');

let sharp = null;
let sharpChecked = false;
function loadSharp() {
  if (sharpChecked) return sharp;
  sharpChecked = true;
  try { sharp = require('sharp'); } catch (_) { sharp = null; }
  return sharp;
}

const MAX_DIMENSION = Number(process.env.IMAGE_MAX_DIMENSION || 1600);
const QUALITY = Number(process.env.IMAGE_QUALITY || 80);

/**
 * يرجّع اسم الملف النهائي (ممكن يتغير لـ .webp). آمن تمامًا: أي فشل = الملف الأصلي.
 */
async function optimizeInPlace(dir, filename) {
  const lib = loadSharp();
  if (!lib) return filename;
  const source = path.join(dir, filename);
  const target = path.join(dir, `${path.parse(filename).name}.webp`);
  try {
    await lib(source)
      .rotate()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toFile(target);
    const before = fs.statSync(source).size;
    const after = fs.statSync(target).size;
    if (after >= before) { fs.unlinkSync(target); return filename; }
    fs.unlinkSync(source);
    return path.basename(target);
  } catch (error) {
    try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (_) { /* لا شيء */ }
    console.warn('[image-optimize] تعذر ضغط الصورة:', error.message);
    return filename;
  }
}

module.exports = { optimizeInPlace, isAvailable: () => !!loadSharp(), MAX_DIMENSION, QUALITY };
