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
const TARGETS = [
  ...fs.readdirSync('public/js/store').filter((f) => f.endsWith('.js')).map((f) => `public/js/store/${f}`),
  ...fs.readdirSync('public/js/admin').filter((f) => f.endsWith('.js')).map((f) => `public/js/admin/${f}`), 'public/notify-client.js', 'public/ui-utils.js'];

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

// سياق الملف الحالي: متغيّرات رقمية معرّفة محليًا + خرائط ثوابت نصية آمنة.
let FILE_NUMERIC = new Set();
let FILE_SAFE_MAPS = new Set();

/**
 * متغيّرات محلية مضمونة إنها أرقام: `const x = Number(...)`, `Math.round(...)`,
 * `parseInt/parseFloat`, رقم حرفي، أو حساب على متغيّرات رقمية تانية.
 * ده بيمنع الـ false positives زي ${newPct} و ${v} و ${total} من إيقاف الـ CI،
 * ومن غير ما نفتح الباب لأي قيمة نصية جاية من السيرفر.
 */
function collectNumericLocals(src) {
  const found = new Set();
  const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  const numericInit = /^(?:Number\(|Math\.(?:round|max|min|abs|floor|ceil|pow|sqrt)\(|parseInt\(|parseFloat\(|\+?\d)/;
  // كذا مرور: قيمة رقمية ممكن تعتمد على متغيّر رقمي معرّف قبلها أو بعدها.
  for (let pass = 0; pass < 3; pass += 1) {
    decl.lastIndex = 0;
    let m;
    while ((m = decl.exec(src))) {
      // تعريفات متعددة على نفس السطر: const a = 1, b = a + 2
      for (const part of `${m[1]} = ${m[2]}`.split(/,(?=\s*[A-Za-z_$][\w$]*\s*=)/)) {
        const pm = part.match(/^\s*([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/);
        if (!pm) continue;
        const name = pm[1];
        const init = pm[2].trim();
        if (numericInit.test(init)) { found.add(name); continue; }
        // حساب رقمي بحت على متغيّرات رقمية معروفة.
        if (/^[-+*/%(). \d\s]*[A-Za-z_$][\w$\s\-+*/%().\d]*$/.test(init)) {
          const ids = init.match(/[A-Za-z_$][\w$]*/g) || [];
          if (ids.length && ids.every((id) => found.has(id) || /^(Number|Math)$/.test(id))) found.add(name);
        }
      }
    }
  }
  return found;
}

/** خرائط ثوابت قيمها نصوص حرفية بدون أي HTML — آمنة للطبع مباشرة. */
function collectSafeMaps(src) {
  const found = new Set();
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const body = m[2].trim();
    if (!body) continue;
    const values = body.split(',').map((pair) => pair.split(':').slice(1).join(':').trim()).filter(Boolean);
    if (!values.length) continue;
    if (values.every((v) => /^'[^'<>&"]*'$/.test(v) || /^"[^"<>&']*"$/.test(v))) found.add(m[1]);
  }
  return found;
}

/** يستبدل نداءات رقمية مضمونة (Number(...), Math.x(...), parseInt(...)) بصفر. */
function reduceNumericCalls(expr) {
  let out = expr;
  for (let i = 0; i < 6; i += 1) {
    const next = out.replace(/(?:Number|parseInt|parseFloat|Math\.[a-zA-Z]+)\(([^()]*)\)/g, '0');
    if (next === out) break;
    out = next;
  }
  return out;
}

function isSafeExpression(expr) {
  const e = expr.trim();
  if (!e) return true;
  // علامة تجاوز صريحة لحالات نادرة بعد مراجعة بشرية.
  if (/\/\*\s*safe\s*\*\//.test(e)) return true;
  if (/\/\/\s*xss-safe/.test(e)) return true;
  // قيمة من خريطة ثوابت نصية (أيقونات/تسميات ثابتة) مع بديل حرفي.
  const mapHit = e.match(/^([A-Za-z_$][\w$]*)\s*\[[^\]]*\]\s*(?:\|\|\s*('[^'<>&]*'|"[^"<>&]*"))?$/);
  if (mapHit && FILE_SAFE_MAPS.has(mapHit[1])) return true;
  // نص ثابت مكتوب في الكود (مفيش أي مدخل مستخدم).
  if (/^'[^'`]*'$/.test(e) || /^"[^"`]*"$/.test(e)) return true;
  if (TRUSTED_LOCALS.has(e) || FILE_NUMERIC.has(e)) return true;
  if (SAFE_EXPR.some((re) => re.test(e))) return true;
  // نداء آمن يغطي التعبير كله: esc(...) أو money(...)
  for (const fn of SAFE_CALLS) {
    if (e.startsWith(`${fn}(`) && e.endsWith(')')) return true;
  }
  // بديل افتراضي رقمي/حرفي: Number(x) || 0  ==>  كل جزء يتفحص لوحده.
  if (/\|\|/.test(e)) {
    const parts = splitTopLevel(e, '||');
    if (parts && parts.length > 1 && parts.every((part) => isSafeExpression(part))) return true;
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
  // حساب رقمي بحت: أي جزء ملفوف في Number()/Math.*/parseInt() بيتحوّل لصفر
  // قبل الفحص، فالتعبير كله يبقى أرقام وعمليات حسابية فقط.
  const numericReduced = reduceNumericCalls(e);
  if (numericReduced !== e && /^[-+*/%(). \d\s]+$/.test(numericReduced)) return true;
  // حساب رقمي بحت على متغيّرات موثوقة (إحداثيات الرسوم البيانية مثلًا).
  if (NUMERIC_EXPR.test(e)) {
    const idents = e.match(/[A-Za-z_$][\w$]*/g) || [];
    if (idents.every((id) => TRUSTED_LOCALS.has(id) || FILE_NUMERIC.has(id) || /^\d+$/.test(id))) return true;
  }
  return false;
}

/** تقسيم تعبير على مُعامل معيّن في المستوى الأعلى فقط (خارج الأقواس والنصوص). */
function splitTopLevel(e, op) {
  const parts = [];
  let depth = 0; let inStr = null; let last = 0;
  for (let i = 0; i < e.length; i += 1) {
    const c = e[i];
    if (inStr) { if (c === inStr && e[i - 1] !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if ('([{'.includes(c)) { depth += 1; continue; }
    if (')]}'.includes(c)) { depth -= 1; continue; }
    if (depth === 0 && e.startsWith(op, i)) { parts.push(e.slice(last, i)); i += op.length - 1; last = i + 1; }
  }
  parts.push(e.slice(last));
  return parts.map((x) => x.trim()).filter(Boolean);
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

// بعد تقسيم الملفات لموديولات، خرائط الثوابت (مثلاً PAYMENT_ICONS) بقت في
// ملف labels.js وبتُستورد في ملفات تانية. فبنجمع الخرائط الآمنة من كل الملفات
// المفحوصة مرة واحدة، وبنضمّها لخرائط كل ملف.
const GLOBAL_SAFE_MAPS = new Set();
for (const rel of TARGETS) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) continue;
  collectSafeMaps(fs.readFileSync(f, 'utf8')).forEach((n) => GLOBAL_SAFE_MAPS.add(n));
}

let failures = 0;
for (const rel of TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  FILE_NUMERIC = collectNumericLocals(src);
  FILE_SAFE_MAPS = new Set([...GLOBAL_SAFE_MAPS, ...collectSafeMaps(src)]);
  const srcLines = src.split('\n');
  for (const { line, tpl } of findInnerHtmlTemplates(src)) {
    // تعليق `// xss-safe` على السطر أو السطر اللي قبله = مراجعة بشرية صريحة.
    const near = `${srcLines[line - 2] || ''}\n${srcLines[line - 1] || ''}`;
    if (/\/\/\s*xss-safe/.test(near)) continue;
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
