#!/usr/bin/env node
/**
 * ---------------------------------------------------------------------------
 * tools/xss-audit.js — حارس ثابت ضد «نسيت تعمل esc()»
 * ---------------------------------------------------------------------------
 * الواجهة بتتبني بـ innerHTML مع قوالب نصية. ده شغّال وسريع، لكن عيبه إن أول
 * حقل يتنسي فيه escapeHtml بيبقى ثغرة XSS مخزّنة (اسم منتج أو تقييم عميل
 * بيتنفّذ جوّه لوحة الأدمن). الملف ده بيفحص كل `X.innerHTML = \`...\`` ويتأكد
 * إن كل ${...} جوّه القالب إما:
 *   - مغلّفة بدالة تهريب/تنسيق آمنة (esc / escapeHtml / safeImage / money ...)
 *   - أو تعبير رقمي/منطقي مضمون (Number(...) / .length / .id / مقارنات)
 *   - أو قالب متداخل بيتفحص بنفس القواعد
 * أي حاجة تانية = فشل، والـ CI بيقف. بيتشغّل تلقائيًا قبل الاختبارات.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGETS = ['public/storefront.js', 'public/admin.js', 'public/notify-client.js', 'public/ui-utils.js'];

// دوال بتضمن مخرجات آمنة (بتهرّب بنفسها أو بترجع أرقام/نصوص ثابتة).
const SAFE_CALLS = [
  'esc', 'escapeHtml', 'safeImage', 'safeImageUrl', 'safeInternalPath',
  'money', 'fmt', 'formatEGP', 'dateFmt', 'statusChip', 'starString',
  'Number', 'String(Number', 'Math.round', 'Math.max', 'Math.min', 'encodeURIComponent'
];
// تعبيرات مضمونة إنها أرقام أو قيم داخلية ثابتة.
const SAFE_EXPR = [
  /^[a-zA-Z_$][\w$]*\.(id|length|quantity|stock|sold|reviews_count|count|price|total|index)$/,
  /^[a-zA-Z_$][\w$.]*\.length$/,
  /^\d+(\.\d+)?$/,
  /^[a-zA-Z_$][\w$]*\s*\?\s*'[^'{}<>]*'\s*:\s*'[^'{}<>]*'$/
];

/** بيرجع محتوى كل ${...} في قالب (مع مراعاة التداخل والأقواس). */
function extractInterpolations(tpl) {
  const out = [];
  for (let i = 0; i < tpl.length - 1; i += 1) {
    if (tpl[i] === '$' && tpl[i + 1] === '{' && tpl[i - 1] !== '\\') {
      let depth = 1;
      let j = i + 2;
      while (j < tpl.length && depth > 0) {
        if (tpl[j] === '{') depth += 1;
        else if (tpl[j] === '}') depth -= 1;
        j += 1;
      }
      out.push(tpl.slice(i + 2, j - 1));
      i = j - 1;
    }
  }
  return out;
}

// متغيّرات محسوبة داخليًا (أرقام إحداثيات/عدّادات) أو HTML مبني بالفعل جوّه
// نفس الملف وبيتفحص لوحده. أي اسم جديد لازم يتضاف هنا بوعي — الافتراضي هو
// الرفض، فمفيش قيمة جاية من السيرفر بتعدّي بالغلط.
const TRUSTED_LOCALS = new Set([
  'html', 'grid', 'area', 'line', 'arcs', 'items', 'timeline', 'rows', 'body',
  'points', 'legend', 'pad', 'cx', 'cy', 'W', 'H', 'total', 'count', 'sent',
  'PLACEHOLDER_IMAGE'
]);
// أنماط رقمية/منطقية مضمونة (إحداثيات، عدّادات، حسابات).
const NUMERIC_EXPR = /^[-+*/%(). \d\w$?:><=!&|\[\]]*$/;

function isSafeExpression(expr) {
  const e = expr.trim();
  if (!e) return true;
  // علامة تجاوز صريحة لحالات نادرة بعد مراجعة بشرية.
  if (/\/\*\s*safe\s*\*\//.test(e)) return true;
  // نص ثابت مكتوب في الكود (مفيش أي مدخل مستخدم).
  if (/^'[^'`]*'$/.test(e) || /^"[^"`]*"$/.test(e)) return true;
  if (TRUSTED_LOCALS.has(e)) return true;
  if (SAFE_EXPR.some((re) => re.test(e))) return true;
  // نداء آمن يغطي التعبير كله: esc(...) أو money(...)
  for (const fn of SAFE_CALLS) {
    if (e.startsWith(`${fn}(`) && e.endsWith(')')) return true;
  }
  // شرط ثلاثي: كل فرع لازم يكون آمن بنفسه.
  const q = splitTernary(e);
  if (q) return isSafeExpression(q.yes) && isSafeExpression(q.no);
  // قالب متداخل: نفحص جواه بنفس القواعد.
  if (e.startsWith('`') && e.endsWith('`')) {
    return extractInterpolations(e).every(isSafeExpression);
  }
  // سلسلة نصوص/قوالب متجمّعة بـ + : كل جزء لوحده.
  if (e.includes('${') || e.includes('`')) {
    return extractInterpolations(e).every(isSafeExpression);
  }
  // حساب رقمي بحت على متغيّرات موثوقة (إحداثيات الرسوم البيانية مثلًا).
  if (NUMERIC_EXPR.test(e)) {
    const idents = e.match(/[A-Za-z_$][\w$]*/g) || [];
    if (idents.every((id) => TRUSTED_LOCALS.has(id) || /^\d+$/.test(id))) return true;
  }
  return false;
}

/** تقسيم شرط ثلاثي على المستوى الأعلى فقط. */
function splitTernary(e) {
  let depth = 0;
  let inStr = null;
  for (let i = 0; i < e.length; i += 1) {
    const c = e[i];
    if (inStr) { if (c === inStr && e[i - 1] !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === '?' && depth === 0 && e[i + 1] !== '.' && e[i + 1] !== '?') {
      // نلاقي الـ : المقابلة على نفس المستوى
      let d2 = 0;
      let s2 = null;
      for (let j = i + 1; j < e.length; j += 1) {
        const c2 = e[j];
        if (s2) { if (c2 === s2 && e[j - 1] !== '\\') s2 = null; continue; }
        if (c2 === "'" || c2 === '"' || c2 === '`') { s2 = c2; continue; }
        if ('([{'.includes(c2)) d2 += 1;
        else if (')]}'.includes(c2)) d2 -= 1;
        else if (c2 === ':' && d2 === 0) {
          return { yes: e.slice(i + 1, j), no: e.slice(j + 1) };
        }
      }
      return null;
    }
  }
  return null;
}

/** كل قوالب innerHTML في ملف. */
function findInnerHtmlTemplates(src) {
  const results = [];
  const re = /\.innerHTML\s*(?:\+)?=\s*/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    // بنمشي لحد ما نلاقي أول قالب نصي في الجملة
    while (i < src.length && src[i] !== '`' && src[i] !== '\n' && src[i] !== ';') i += 1;
    if (src[i] !== '`') continue;
    let depth = 0;
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`' && depth === 0) break;
      if (src[j] === '$' && src[j + 1] === '{') { depth += 1; j += 2; continue; }
      if (src[j] === '}' && depth > 0) depth -= 1;
      j += 1;
    }
    results.push({ line: src.slice(0, m.index).split('\n').length, tpl: src.slice(i, j + 1) });
  }
  return results;
}

let failures = 0;
for (const rel of TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  for (const { line, tpl } of findInnerHtmlTemplates(src)) {
    for (const expr of extractInterpolations(tpl)) {
      if (!isSafeExpression(expr)) {
        failures += 1;
        console.error(`✗ ${rel}:${line} — قيمة غير مهرّبة داخل innerHTML: \${${expr.trim().slice(0, 120)}}`);
      }
    }
  }
}

if (failures) {
  console.error(`\n⛔ فحص XSS فشل: ${failures} قيمة محتاجة esc()/escapeHtml() أو دالة تنسيق آمنة.`);
  process.exit(1);
}
console.log('✓ فحص XSS: كل القيم داخل innerHTML مهرّبة أو مضمونة.');
