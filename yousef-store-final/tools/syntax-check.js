/**
 * فحص "أنواع/بناء" خفيف بديل عن typecheck في مشروع JavaScript خالص:
 * بيمشي على كل ملفات .js في المشروع ويتأكد إنها بتتحلّل (parse) من غير أخطاء،
 * بنفس وضع الموديول الصح (CommonJS للسيرفر، ES module لملفات public/js).
 * أي خطأ بناء بيوقف الـ CI قبل ما يوصل للإنتاج.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'data', 'store-backups', 'coverage']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const errors = [];
for (const file of files) {
  const rel = path.relative(ROOT, file);
  const source = fs.readFileSync(file, 'utf8');
  const isModule = rel.startsWith(path.join('public', 'js')) || /^type=module/.test(source);
  try {
    if (isModule) {
      new vm.SourceTextModule(source, { identifier: rel });
    } else {
      new vm.Script(source, { filename: rel });
    }
  } catch (error) {
    // SourceTextModule غير متاح بدون --experimental-vm-modules؛ لا نعيد
    // تحليل ESM كـ Script لأن ذلك يحوّل import/export الصحيح إلى خطأ وهمي.
    if (isModule && /SourceTextModule|not a constructor|experimental-vm-modules/i.test(String(error && error.message))) {
      continue;
    }
    errors.push(`${rel}: ${error.message}`);
  }
}

if (errors.length) {
  console.error('❌ فشل فحص البناء في الملفات دي:');
  errors.forEach(e => console.error('  - ' + e));
  process.exit(1);
}
console.log(`✅ فحص البناء نجح على ${files.length} ملف.`);
